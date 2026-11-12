// Coordinator-only module. Never import this module from browser application code.
import { createHash } from 'node:crypto';
import { open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const statuses = new Set(['reserved', 'accepted', 'uncertain', 'failed']);
export function smtpOptions(password) {
  return {
    host: 'mail-eu.smtp2go.com', port: 587, secure: false, requireTLS: true,
    auth: { user: 'organiser', pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'mail-eu.smtp2go.com' },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    logger: false, debug: false, pool: false,
  };
}

export function validateBatch(batch) {
  if (batch?.version !== 1 || typeof batch.electionId !== 'string' || !batch.electionId.trim()
    || batch.electionId.length > 200 || /[\r\n\x00]/.test(batch.electionId)
    || !Array.isArray(batch.invitations) || batch.invitations.length < 1 || batch.invitations.length > 10_000) {
    throw new Error('Invalid invitation batch.');
  }
  const ids = new Set(), numbers = new Set();
  for (const row of batch.invitations) {
    if (!Number.isSafeInteger(row?.mastersListNumber) || row.mastersListNumber <= 0
      || typeof row.email !== 'string' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.email)
      || row.email.length > 254 || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id)
      || typeof row.inviteUrl !== 'string' || row.inviteUrl.length > 8192 || /[^\x21-\x7e]/.test(row.inviteUrl)
      || (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 300))) {
      throw new Error('Invalid invitation row.');
    }
    let url;
    try { url = new URL(row.inviteUrl); } catch { throw new Error('Invalid invitation URL.'); }
    const code = new URLSearchParams(url.hash.slice(1)).get('invite_code');
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-f0-9]{40}$/.test(code ?? '')
      || url.searchParams.get('q') !== batch.electionId || hash(code) !== row.id
      || ids.has(row.id) || numbers.has(row.mastersListNumber)) {
      throw new Error('Invalid, mismatched or duplicate invitation.');
    }
    ids.add(row.id); numbers.add(row.mastersListNumber);
  }
  return batch;
}

async function privateFile(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077)) {
    throw new Error('Private files must be regular, owned by this user and mode 600.');
  }
}
export async function readPrivateFile(path) {
  await privateFile(path);
  return readFile(path, 'utf8');
}
async function persist(path, value) {
  const temporary = `${path}.next`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function failure(error) {
  // Only allowlisted pre-DATA failures are safe to retry. Do not emit server text.
  const command = String(error?.command ?? '').toUpperCase();
  const preData = /^(CONN|EHLO|HELO|STARTTLS|AUTH(?: |$)|MAIL FROM|RCPT TO)/.test(command);
  const auth = error?.code === 'EAUTH';
  const retry = preData && !auth && Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 500;
  return {
    status: preData || auth ? 'failed' : 'uncertain', retry,
    detail: auth ? 'SMTP authentication failed. Check private credentials.'
      : preData ? `SMTP rejected or failed before message data${retry ? ' (transient)' : ''}.`
        : 'SMTP outcome uncertain. Do not resend; reconcile with the provider.',
  };
}

export async function deliverBatch({ batch, ledgerPath, month, baseline, transport, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validateBatch(batch);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '') || !Number.isInteger(baseline) || baseline < 0 || baseline > 250) {
    throw new Error('Set a valid quota month and baseline (0..250), including prior tests and other sends.');
  }
  const directory = await lstat(dirname(ledgerPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
    throw new Error('Ledger directory must be owned by this user and mode 700.');
  }
  let lock;
  try { lock = await open(`${ledgerPath}.lock`, 'wx', 0o600); }
  catch { throw new Error('Delivery ledger is locked. Check for an active sender or interrupted run.'); }
  try {
    let ledger;
    try { ledger = JSON.parse(await readPrivateFile(ledgerPath)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read valid private delivery ledger.');
      ledger = { version: 1, months: {}, entries: {} };
    }
    if (ledger?.version !== 1 || typeof ledger.months !== 'object' || !ledger.months || Array.isArray(ledger.months)
      || typeof ledger.entries !== 'object' || !ledger.entries || Array.isArray(ledger.entries)
      || Object.values(ledger.months).some(v => !Number.isInteger(v?.baseline) || v.baseline < 0 || !Number.isInteger(v?.attempts) || v.attempts < 0)
      || Object.values(ledger.entries).some(v => !statuses.has(v?.status) || !/^[a-f0-9]{64}$/.test(v?.fingerprint ?? ''))) {
      throw new Error('Invalid delivery ledger; refusing to reset quota or duplicate protection.');
    }
    ledger.months[month] ??= { baseline, attempts: 0 };
    const quota = ledger.months[month];
    if (quota.baseline !== baseline) throw new Error('Quota baseline conflicts with the existing ledger. Reconcile manually.');
    const results = [];
    // Check conflicts across the whole batch before sending anything.
    for (const row of batch.invitations) {
      const fingerprint = hash(JSON.stringify([batch.electionId, row.email, row.name ?? '', row.inviteUrl]));
      if (ledger.entries[row.id] && ledger.entries[row.id].fingerprint !== fingerprint) throw new Error('Invitation delivery content conflict; no messages sent.');
    }
    await persist(ledgerPath, ledger);
    for (const row of batch.invitations) {
      const fingerprint = hash(JSON.stringify([batch.electionId, row.email, row.name ?? '', row.inviteUrl]));
      let entry = ledger.entries[row.id];
      if (entry?.status === 'reserved') {
        entry.status = 'uncertain';
        entry.detail = 'Interrupted attempt. Reconcile with provider; never automatically resend.';
        await persist(ledgerPath, ledger);
      }
      if (!entry) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (quota.baseline + quota.attempts >= 250) {
            entry = { status: 'quota_exhausted', detail: 'Monthly 250-email budget exhausted. No attempt made.' };
            break;
          }
          quota.attempts++;
          entry = { fingerprint, status: 'reserved', detail: 'Attempt reserved; outcome not yet known.' };
          ledger.entries[row.id] = entry;
          await persist(ledgerPath, ledger);
          let retry = false;
          try {
            const receipt = await transport.sendMail({
              from: { name: 'Auditable Voting', address: 'organiser@voting.bitsbytom.com' },
              to: row.email, subject: 'Your Auditable Voting questionnaire invitation',
              text: `You have been invited to questionnaire ${batch.electionId}.\n\nOpen your private, single-use invitation:\n${row.inviteUrl}\n\nKeep this link private. Anyone holding it can claim access. Opening it in a browser can automatically request a separate blind voting credential and redeem the invitation. Do not forward it or open it on someone else's behalf.\n\nEmail receipt is not proof of eligibility or proof of voting. This sending address has no receiving inbox; do not reply.\n`,
              disableFileAccess: true, disableUrlAccess: true,
            });
            const accepted = receipt?.accepted?.some(address => String(address).toLowerCase() === row.email.toLowerCase());
            entry.status = accepted ? 'accepted' : 'uncertain';
            entry.detail = accepted ? 'Accepted by email provider. Inbox delivery is not confirmed.' : 'Provider acceptance not confirmed. Reconcile before resending.';
          } catch (error) {
            const outcome = failure(error);
            entry.status = outcome.status; entry.detail = outcome.detail; retry = outcome.retry;
          }
          await persist(ledgerPath, ledger);
          if (!retry || attempt === 1) break;
          await sleep(2_000);
        }
      }
      results.push({ id: row.id, mastersListNumber: row.mastersListNumber, status: entry.status, detail: entry.detail });
      // Authentication/configuration failures should not burn the rest of a batch's budget.
      if (entry.status === 'failed' || entry.status === 'uncertain' || entry.status === 'quota_exhausted') break;
    }
    return { version: 1, electionId: batch.electionId, month, used: quota.baseline + quota.attempts, limit: 250, results };
  } finally {
    await lock.close();
    await unlink(`${ledgerPath}.lock`);
  }
}
