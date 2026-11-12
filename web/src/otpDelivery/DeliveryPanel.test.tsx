// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import DeliveryPanel, { type ResidentInvitation } from './DeliveryPanel';
import { hashQuestionnaireInviteCode } from '../questionnaireInviteCode';

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const code = 'a'.repeat(40);
const inviteUrl = `https://example.org/vote.html?q=election-test#invite_code=${code}`;
const csv = 'masters_list_number,email,phone,name\n101,alice@example.org,,Alice\n102,bob@example.org,,Bob';
async function upload() {
  await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), new File([csv], 'residents.csv', { type: 'text/csv' }));
}
function Harness({ createInvitation = vi.fn(async () => ({ id: await hashQuestionnaireInviteCode(code), inviteUrl })), lifecycle = {}, isRegistered = () => true }: {
  createInvitation?: () => Promise<{ id: string; inviteUrl: string }>;
  lifecycle?: Record<string, string>;
  isRegistered?: (id: string) => boolean;
}) {
  const [rows, setRows] = useState<ResidentInvitation[]>([]);
  return <DeliveryPanel electionId='election-test' rows={rows} onRowsChange={setRows} createInvitation={createInvitation} lifecycle={lifecycle} isRegistered={isRegistered} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe('shared resident invitations', () => {
  it('has one contact upload; generation registers once and secrets start hidden', async () => {
    const createInvitation = vi.fn(async () => ({ id: await hashQuestionnaireInviteCode(code), inviteUrl }));
    render(<Harness createInvitation={createInvitation} />);
    expect(screen.getAllByLabelText('Residents CSV or saved invitation batch')).toHaveLength(1);
    await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    await waitFor(() => expect(screen.getByText('Generated')).toBeTruthy());
    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(inviteUrl)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reveal invitation for resident 101' }));
    expect(screen.getByText(inviteUrl)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate invitation for resident 101' })).toBeNull();
  });
  it('exports the exact registered URL, email and invitation identity', async () => {
    const capture = vi.fn(() => 'blob:batch');
    Object.defineProperty(URL, 'createObjectURL', { value: capture, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Harness />); await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download private email batch' }));
    const batch = JSON.parse(await (capture.mock.calls[0] as unknown as [Blob])[0].text());
    expect(batch.invitations[0]).toEqual(expect.objectContaining({ email: 'alice@example.org', inviteUrl, id: await hashQuestionnaireInviteCode(code) }));
    expect(batch.pendingResidents).toEqual([{ mastersListNumber: 102, email: 'bob@example.org', name: 'Bob' }]);
  });
  it('does not claim generation when registration fails', async () => {
    render(<Harness createInvitation={async () => { throw new Error('Guardian configuration not ready'); }} />);
    await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Guardian configuration not ready');
    expect(screen.queryByText('Generated')).toBeNull();
  });
  it('uses authoritative redemption/issuance lifecycle, never delivery as proof of voting', async () => {
    const id = await hashQuestionnaireInviteCode(code);
    render(<Harness lifecycle={{ [id]: 'Blind credential issued' }} />); await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    expect(await screen.findByText('Blind credential issued')).toBeTruthy();
    expect(screen.queryByText('Redeemed')).toBeNull();
  });
  it('blocks replacing contacts after invitations have been registered', async () => {
    render(<Harness />); await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    expect((screen.getByLabelText('Residents CSV or saved invitation batch') as HTMLInputElement).disabled).toBe(true);
  });
  it('imports provider results only for the same election and invitation', async () => {
    render(<Harness />); await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    const id = await hashQuestionnaireInviteCode(code);
    await userEvent.upload(screen.getByLabelText('Email delivery results JSON'), new File([JSON.stringify({ version: 1, electionId: 'election-test', results: [{ id, mastersListNumber: 101, status: 'accepted', detail: 'accepted' }] })], 'results.json', { type: 'application/json' }));
    expect(await screen.findByText('Accepted by email provider')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Resident invitations' })).queryByText('Sent')).toBeNull();
  });
  it('restores the same registered invitation without generating a replacement', async () => {
    const createInvitation = vi.fn();
    const id = await hashQuestionnaireInviteCode(code);
    render(<Harness createInvitation={createInvitation} lifecycle={{ [id]: 'Redeemed' }} />);
    await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), new File([JSON.stringify({ version: 1, electionId: 'election-test', invitations: [{ mastersListNumber: 101, email: 'alice@example.org', id, inviteUrl }] })], 'saved.json', { type: 'application/json' }));
    expect(await screen.findByText('Redeemed')).toBeTruthy();
    expect(screen.queryByText(inviteUrl)).toBeNull();
    expect(createInvitation).not.toHaveBeenCalled();
  });
  it('rejects a saved batch that is not in the admission registry', async () => {
    const id = await hashQuestionnaireInviteCode(code);
    render(<Harness isRegistered={() => false} />);
    await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), new File([JSON.stringify({ version: 1, electionId: 'election-test', invitations: [{ mastersListNumber: 101, email: 'alice@example.org', id, inviteUrl }] })], 'saved.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Batch contains an invalid or unregistered invitation. Restore organiser state first.');
    expect(screen.queryByText('Generated')).toBeNull();
  });
  it('restores residents still awaiting generation after a partial batch', async () => {
    render(<Harness />);
    const id = await hashQuestionnaireInviteCode(code);
    await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), new File([JSON.stringify({ version: 1, electionId: 'election-test', invitations: [{ mastersListNumber: 101, email: 'alice@example.org', id, inviteUrl }], pendingResidents: [{ mastersListNumber: 102, email: 'bob@example.org', name: 'Bob' }] })], 'partial.json', { type: 'application/json' }));
    expect(await screen.findByRole('button', { name: 'Generate invitation for resident 102' })).toBeTruthy();
    expect(screen.getByText('Generated')).toBeTruthy();
  });
  it('accepts bounded recovery JSON larger than the CSV upload limit', async () => {
    render(<Harness />);
    const file = new File([JSON.stringify({ version: 1, electionId: 'election-test', invitations: [{ mastersListNumber: 101, email: 'alice@example.org', id: await hashQuestionnaireInviteCode(code), inviteUrl }] })], 'large-recovery.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 6_067_884 });
    await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), file);
    expect(await screen.findByText('Generated')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('rejects another election results without changing current delivery status', async () => {
    render(<Harness />); await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Generate invitation for resident 101' }));
    await userEvent.upload(screen.getByLabelText('Email delivery results JSON'), new File([JSON.stringify({ version: 1, electionId: 'wrong', results: [{ id: await hashQuestionnaireInviteCode(code), mastersListNumber: 101, status: 'accepted' }] })], 'results.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Accepted by email provider')).toBeNull();
  });
  it.each([
    '9007199254740992,alice@example.org,,Alice',
    `101,alice@example.org,,${'A'.repeat(301)}`,
  ])('rejects a CSV contact incompatible with sender/recovery before registration: %s', async row => {
    const createInvitation = vi.fn();
    render(<Harness createInvitation={createInvitation} />);
    await userEvent.upload(screen.getByLabelText('Residents CSV or saved invitation batch'), new File([`masters_list_number,email,phone,name\n${row}`], 'bad.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Resident invitations' })).toBeNull();
    expect(createInvitation).not.toHaveBeenCalled();
  });
});
