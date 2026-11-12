import type { BearerInviteCodeEntry, BlindBallotIssuance } from '../questionnaireOptionA';

export function invitationStatus(entry: BearerInviteCodeEntry, issued: Record<string, BlindBallotIssuance> = {}) {
  if (entry.state === 'revoked') return 'Revoked';
  if (entry.redeemedNpub && Object.values(issued).some(issuance => issuance.invitedNpub === entry.redeemedNpub && issuance.electionId === entry.electionId)) return 'Blind credential issued';
  if (entry.state === 'redeemed' || entry.redeemedNpub) return 'Redeemed';
  return 'Generated';
}
