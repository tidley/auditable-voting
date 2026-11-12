import { useRef, useState, type ChangeEvent } from 'react';
import { parseResidentCsv, type ResidentEntry } from '../residentRegister';
import { hashQuestionnaireInviteCode } from '../questionnaireInviteCode';
import { tryWriteClipboard } from '../clipboard';
import { useTransientCopiedLabel } from '../useTransientCopiedLabel';
import { DELIVERY_CHANNELS } from './channels';
import { loadSelectedChannel, saveSelectedChannel } from './selectorStorage';
import type { DeliveryChannel } from './types';

export interface ResidentInvitation extends ResidentEntry {
  id?: string;
  inviteUrl?: string;
  deliveryStatus?: string;
}
interface DeliveryPanelProps {
  electionId: string;
  rows: ResidentInvitation[];
  onRowsChange: (rows: ResidentInvitation[]) => void;
  createInvitation: () => Promise<{ id: string; inviteUrl: string }>;
  lifecycle: Record<string, string>;
  isRegistered?: (id: string) => boolean;
  disabled?: boolean;
}
const deliveryLabels: Record<string, string> = {
  accepted: 'Accepted by email provider', failed: 'Email failed', uncertain: 'Email outcome uncertain — do not resend',
  quota_exhausted: 'Monthly email budget exhausted',
};

export default function DeliveryPanel({ electionId, rows, onRowsChange, createInvitation, lifecycle, isRegistered, disabled }: DeliveryPanelProps) {
  const [channel, setChannel] = useState<DeliveryChannel['id']>(() => {
    const stored = loadSelectedChannel(electionId);
    return DELIVERY_CHANNELS.some(item => item.id === stored) ? stored : 'manual';
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const lock = useRef(false);
  const fileVersion = useRef(0);
  const { isCopied, showCopied } = useTransientCopiedLabel();
  const generated = rows.filter(row => row.id && row.inviteUrl);

  async function importResidents(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || lock.current || generated.length) return;
    const version = ++fileVersion.current;
    setError('');
    try {
      const recoveryFile = file.name.toLowerCase().endsWith('.json');
      // Recovery includes URL/hash/formatting overhead for up to 10,000 rows.
      if (file.size > (recoveryFile ? 128_000_000 : 5_000_000)) throw new Error(recoveryFile ? 'Choose a recovery batch smaller than 128 MB.' : 'Choose a CSV smaller than 5 MB.');
      const text = await file.text();
      let next: ResidentInvitation[];
      if (recoveryFile) {
        const batch = JSON.parse(text);
        if (batch.version !== 1 || batch.electionId !== electionId || !Array.isArray(batch.invitations) || !batch.invitations.length || batch.invitations.length > 10_000) throw new Error('Choose a saved batch for this questionnaire.');
        const seen = new Set(), numbers = new Set();
        next = [];
        for (const row of batch.invitations) {
          if (typeof row.inviteUrl !== 'string' || row.inviteUrl.length > 8192 || /[^\x21-\x7e]/.test(row.inviteUrl)) throw new Error('Invalid invitation URL.');
          const url = new URL(row.inviteUrl);
          const code = new URLSearchParams(url.hash.slice(1)).get('invite_code');
          if (!Number.isSafeInteger(row.mastersListNumber) || row.mastersListNumber <= 0 || typeof row.email !== 'string' || row.email.length > 254
            || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.email)
            || (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 300))
            || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || url.searchParams.get('q') !== electionId || !/^[a-f0-9]{40}$/.test(code ?? '')
            || await hashQuestionnaireInviteCode(code ?? '') !== row.id || !isRegistered?.(row.id)
            || seen.has(row.id) || numbers.has(row.mastersListNumber)) throw new Error('Batch contains an invalid or unregistered invitation. Restore organiser state first.');
          seen.add(row.id); numbers.add(row.mastersListNumber);
          next.push({ mastersListNumber: row.mastersListNumber, email: row.email, name: row.name, id: row.id, inviteUrl: row.inviteUrl });
        }
        if (batch.pendingResidents !== undefined) {
          if (!Array.isArray(batch.pendingResidents) || next.length + batch.pendingResidents.length > 10_000) throw new Error('Invalid pending resident list.');
          for (const row of batch.pendingResidents) {
            if (!Number.isSafeInteger(row?.mastersListNumber) || row.mastersListNumber <= 0 || numbers.has(row.mastersListNumber)
              || typeof row.email !== 'string' || row.email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.email)
              || (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 300))) throw new Error('Invalid pending resident contact.');
            numbers.add(row.mastersListNumber);
            next.push({ mastersListNumber: row.mastersListNumber, email: row.email, name: row.name });
          }
        }
      } else {
        const parsed = parseResidentCsv(text);
        if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
        if (parsed.residents.length > 10_000) throw new Error('Import at most 10,000 residents.');
        if (parsed.residents.some(row => !Number.isSafeInteger(row.mastersListNumber) || row.email.length > 254 || (row.name?.length ?? 0) > 300
          || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.email))) throw new Error('Use safe positive integer resident numbers, email addresses up to 254 characters and names up to 300 characters.');
        next = parsed.residents;
      }
      if (version === fileVersion.current && !lock.current) { onRowsChange(next); setRevealed({}); }
    } catch (cause) {
      if (version === fileVersion.current) setError(cause instanceof SyntaxError ? 'The saved batch is not valid JSON.' : cause instanceof Error ? cause.message : 'The file could not be read.');
    } finally { input.value = ''; }
  }

  async function generate(numbers: number[]) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setError(''); ++fileVersion.current;
    let next = [...rows];
    try {
      for (const number of numbers) {
        if (next.find(row => row.mastersListNumber === number)?.id) continue;
        const invitation = await createInvitation();
        next = next.map(row => row.mastersListNumber === number ? { ...row, ...invitation } : row);
        onRowsChange(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invitation registration failed. No email was sent.'); }
    finally { lock.current = false; setBusy(false); }
  }

  function exportBatch() {
    const invitations = generated.map(({ mastersListNumber, email, name, id, inviteUrl }) => ({ mastersListNumber, email, name, id, inviteUrl }));
    const pendingResidents = rows.filter(row => !row.id).map(({ mastersListNumber, email, name }) => ({ mastersListNumber, email, name }));
    const blob = new Blob([JSON.stringify({ version: 1, electionId, invitations, pendingResidents }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'private-invitations.json'; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importResults(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget, file = input.files?.[0];
    if (!file || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (file.size > 5_000_000) throw new Error('Choose a results file smaller than 5 MB.');
      const data = JSON.parse(await file.text());
      if (data.version !== 1 || data.electionId !== electionId || !Array.isArray(data.results)) throw new Error('Choose results for this questionnaire.');
      const statuses = new Map<string, string>();
      for (const result of data.results) {
        if (!deliveryLabels[result.status] || statuses.has(result.id) || !rows.some(row => row.id === result.id && row.mastersListNumber === result.mastersListNumber)) throw new Error('Results contain an unknown or duplicate invitation/status.');
        statuses.set(result.id, result.status);
      }
      onRowsChange(rows.map(row => ({ ...row, deliveryStatus: statuses.get(row.id ?? '') ?? row.deliveryStatus })));
    } catch { setError('Results could not be imported. Use the coordinator JSON results for these invitations.'); }
    finally { input.value = ''; lock.current = false; setBusy(false); }
  }

  return <section className='simple-voter-section simple-delivery-panel' aria-label='Resident invitation delivery'>
    <h3 className='simple-voter-question'>Invite residents from CSV</h3>
    <p className='simple-voter-note'>Upload once: masters_list_number,email,phone,name. Each invitation uses the existing single-use admission registry. No email is sent by uploading or generating links.</p>
    <input type='file' accept='.csv,.json,text/csv,application/json' aria-label='Residents CSV or saved invitation batch' disabled={busy || generated.length > 0} onChange={event => void importResidents(event)} />
    <p className='simple-voter-note'>Save the private batch before leaving or reloading. To resume, restore that JSON batch here with the same organiser state; do not generate replacement invitations. Contact details and link secrets are not automatically saved by this panel.</p>
    <label className='simple-questionnaire-form-field'>Delivery channel
      <select className='simple-voter-input' aria-label='Delivery channel' value={channel} onChange={event => {
        const id = event.target.value as DeliveryChannel['id']; setChannel(id); saveSelectedChannel(electionId, id);
      }}>{DELIVERY_CHANNELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
    </label>
    {channel === 'email-smtp2go' ? <div className='simple-voter-note'>
      <p>Download the private batch, run the SMTP2GO sender on the trusted coordinator machine, then import its results below. This tab never receives SMTP credentials. Limit: 250 emails per month, including tests and retries.</p>
      <a href='./email-delivery.html' target='_blank' rel='noreferrer'>Email setup and sending instructions</a>
      <p>Provider acceptance is not confirmed inbox delivery. Failed or uncertain attempts need review; do not generate a new link to retry.</p>
    </div> : null}
    <p className='simple-voter-note'>Invitation codes are hidden to reduce accidental exposure, not to hide them from the coordinator. Anyone with a link can claim it. These are admission links, not anonymous ballot credentials.</p>
    {error ? <p role='alert' className='simple-voter-note'>{error}</p> : null}
    {disabled ? <p className='simple-voter-note'>Publish a questionnaire with its original signing key before generating invitations.</p> : null}
    {rows.length ? <>
      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <button type='button' className='simple-voter-secondary' disabled={busy || disabled || rows.every(row => row.id)} onClick={() => void generate(rows.map(row => row.mastersListNumber))}>{busy ? 'Registering invitations…' : 'Generate missing invitations'}</button>
        <button type='button' className='simple-voter-secondary' disabled={busy || generated.length === 0} onClick={exportBatch}>Download private email batch</button>
      </div>
      <div className='simple-resident-invitation-table'><table className='simple-resident-table' aria-label='Resident invitations'>
        <thead><tr><th scope='col'>Resident</th><th scope='col'>Email</th><th scope='col'>Admission</th><th scope='col'>Delivery</th><th scope='col'>Private invitation</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.mastersListNumber}>
          <td>{row.mastersListNumber} — {row.name}</td><td>{row.email}</td>
          <td>{row.id ? lifecycle[row.id] ?? 'Generated' : 'Not generated'}</td>
          <td>{row.deliveryStatus ? deliveryLabels[row.deliveryStatus] : 'Not submitted to email provider'}</td>
          <td>{row.inviteUrl ? <>
            {channel === 'manual' ? <div className='simple-voter-action-row simple-voter-action-row-inline'>
              <button type='button' className='simple-voter-secondary' aria-label={`${revealed[row.mastersListNumber] ? 'Hide' : 'Reveal'} invitation for resident ${row.mastersListNumber}`} onClick={() => setRevealed(current => ({ ...current, [row.mastersListNumber]: !current[row.mastersListNumber] }))}>{revealed[row.mastersListNumber] ? 'Hide' : 'Reveal'}</button>
              <button type='button' className='simple-voter-secondary' aria-label={`Copy invitation for resident ${row.mastersListNumber}`} onClick={() => void tryWriteClipboard(row.inviteUrl!).then(ok => { if (ok) showCopied(String(row.mastersListNumber)); else setError('Could not copy. Reveal the invitation and copy it manually.'); })}>{isCopied(String(row.mastersListNumber)) ? 'Copied' : 'Copy'}</button>
            </div> : 'Included in private batch'}
            {channel === 'manual' && revealed[row.mastersListNumber] ? <code className='simple-resident-invite-secret'>{row.inviteUrl}</code> : null}
          </> : <button type='button' className='simple-voter-secondary' disabled={busy || disabled} aria-label={`Generate invitation for resident ${row.mastersListNumber}`} onClick={() => void generate([row.mastersListNumber])}>Generate invitation</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </> : null}
    <label className='simple-questionnaire-form-field'>Import email delivery results (JSON)
      <input type='file' accept='.json,application/json' aria-label='Email delivery results JSON' disabled={busy || generated.length === 0} onChange={event => void importResults(event)} />
    </label>
    <p className='simple-voter-note'>Admission shows Generated, Redeemed or Blind credential issued only when supported by the invitation registry and issuance records. It never reports how a resident voted.</p>
  </section>;
}
