import { expect, it } from 'vitest';
import { invitationStatus } from './invitationStatus';
import type { BearerInviteCodeEntry, BlindBallotIssuance } from '../questionnaireOptionA';
const entry: BearerInviteCodeEntry = { electionId: 'q-test', codeHash: 'a'.repeat(64), state: 'available', createdAt: '2026-11-12T00:00:00Z' };
const issued = { electionId: 'q-test', invitedNpub: 'npub-voter' } as BlindBallotIssuance;
it('requires actual admission and matching issuance evidence', () => {
  expect(invitationStatus(entry, {})).toBe('Generated');
  expect(invitationStatus({ ...entry, state: 'redeemed', redeemedNpub: 'npub-voter' }, {})).toBe('Redeemed');
  expect(invitationStatus({ ...entry, state: 'redeemed', redeemedNpub: 'npub-voter' }, { request: issued })).toBe('Blind credential issued');
  expect(invitationStatus({ ...entry, state: 'redeemed', redeemedNpub: 'npub-voter' }, { request: { ...issued, electionId: 'other' } })).toBe('Redeemed');
  expect(invitationStatus({ ...entry, state: 'redeemed', redeemedNpub: 'npub-voter' }, { request: { ...issued, invitedNpub: 'other' } })).toBe('Redeemed');
  expect(invitationStatus({ ...entry, state: 'revoked', redeemedNpub: 'npub-voter' }, { request: issued })).toBe('Revoked');
});
