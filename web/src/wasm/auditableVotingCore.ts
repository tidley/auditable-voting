import {
  build_actor_relay_set as buildActorRelaySetWasm,
  build_conversation_relay_set as buildConversationRelaySetWasm,
  build_coordinator_follower_rows as buildCoordinatorFollowerRowsWasm,
  build_simple_vote_ticket_rows as buildSimpleVoteTicketRowsWasm,
  build_voter_coordinator_diagnostics as buildVoterCoordinatorDiagnosticsWasm,
  derive_actor_display_id as deriveActorDisplayIdWasm,
  derive_token_id_from_proof_secrets as deriveTokenIdFromProofSecretsWasm,
  extract_npub_from_scan as extractNpubFromScanWasm,
  merge_simple_followers as mergeSimpleFollowersWasm,
  normalize_coordinator_npubs as normalizeCoordinatorNpubsWasm,
  select_follow_retry_targets as selectFollowRetryTargetsWasm,
  select_request_retry_keys as selectRequestRetryKeysWasm,
  select_ticket_retry_targets as selectTicketRetryTargetsWasm,
  sha256_hex as sha256HexWasm,
  normalize_relays as normalizeRelaysWasm,
  sort_records_by_created_at_desc as sortRecordsByCreatedAtDescWasm,
  sort_simple_votes_canonical as sortSimpleVotesCanonicalWasm,
  token_id_label as tokenIdLabelWasm,
  token_pattern_cells as tokenPatternCellsWasm,
  token_pattern_detail as tokenPatternDetailWasm,
  token_qr_payload as tokenQrPayloadWasm,
} from "./auditable_voting_core/pkg/auditable_voting_rust_core";

export type RustDeliveryState = {
  status?: string | null;
  eventId?: string | null;
  attempts?: number | null;
  lastAttemptAt?: string | null;
};

export type RustAckSummary = {
  actorNpub: string;
  ackedAction: string;
  ackedEventId: string;
};

export type VoterCoordinatorDiagnosticRust = {
  coordinatorNpub: string;
  coordinatorIndex: number;
  follow: { tone: string; text: string };
  round: { tone: string; text: string };
  blindKey: { tone: string; text: string };
  request: { tone: string; text: string };
  ticket: { tone: string; text: string };
};

export type CoordinatorFollowerRowRust = {
  id: string;
  voterNpub: string;
  voterId: string;
  followingText: string;
  canSendTicket: boolean;
  sendLabel: string;
  follow: { tone: string; text: string };
  pendingRequest: { tone: string; text: string };
  ticket: { tone: string; text: string };
  receipt?: { tone: string; text: string } | null;
};

export function normalizeCoordinatorNpubsRust(values: string[]) {
  return normalizeCoordinatorNpubsWasm(values) as string[];
}

export function normalizeRelaysRust(values: string[]) {
  return normalizeRelaysWasm(values) as string[];
}

export function buildActorRelaySetRust(input: {
  preferredRelays?: string[];
  fallbackRelays: string[];
  extraRelays?: string[];
}) {
  return buildActorRelaySetWasm({
    preferredRelays: input.preferredRelays ?? [],
    fallbackRelays: input.fallbackRelays,
    extraRelays: input.extraRelays ?? [],
  }) as string[];
}

export function buildConversationRelaySetRust(input: {
  recipientInboxRelays: string[];
  senderOutboxRelays?: string[];
  fallbackRelays: string[];
}) {
  return buildConversationRelaySetWasm({
    recipientInboxRelays: input.recipientInboxRelays,
    senderOutboxRelays: input.senderOutboxRelays ?? [],
    fallbackRelays: input.fallbackRelays,
  }) as string[];
}

export function deriveActorDisplayIdRust(value: string) {
  return deriveActorDisplayIdWasm(value);
}

export function extractNpubFromScanRust(value: string) {
  return extractNpubFromScanWasm(value) ?? null;
}

export function sha256HexRust(input: string) {
  return sha256HexWasm(input);
}

export function deriveTokenIdFromProofSecretsRust(proofSecrets: string[], length: number) {
  return deriveTokenIdFromProofSecretsWasm(proofSecrets, length);
}

export function tokenIdLabelRust(tokenId: string | null | undefined) {
  return tokenIdLabelWasm(tokenId ?? undefined);
}

export function tokenPatternDetailRust(tokenId: string, size: number) {
  return tokenPatternDetailWasm(tokenId, size) as {
    filled: boolean;
    colorIndex: number;
  }[];
}

export function tokenPatternCellsRust(tokenId: string, size: number) {
  return tokenPatternCellsWasm(tokenId, size) as boolean[];
}

export function tokenQrPayloadRust(tokenId: string) {
  return tokenQrPayloadWasm(tokenId);
}

export function sortSimpleVotesCanonicalRust<T extends { createdAt: string; eventId: string }>(
  votes: T[],
) {
  return sortSimpleVotesCanonicalWasm(votes) as T[];
}

export function sortRecordsByCreatedAtDescRust<T extends { createdAt: string }>(values: T[]) {
  return sortRecordsByCreatedAtDescWasm(values) as T[];
}

export function buildSimpleVoteTicketRowsRust<
  T extends {
    votingId: string;
    prompt: string;
    createdAt: string;
    thresholdT?: number;
    thresholdN?: number;
    coordinatorNpub: string;
  },
>(entries: T[], configuredCoordinatorTargets: string[]) {
  return (buildSimpleVoteTicketRowsWasm(entries, configuredCoordinatorTargets) as Array<{
    votingId: string;
    prompt: string;
    createdAt: string;
    thresholdT?: number;
    thresholdN?: number;
    countsByCoordinator: Record<string, number> | Map<string, number>;
  }>).map((row) => ({
    ...row,
    countsByCoordinator: row.countsByCoordinator instanceof Map
      ? Object.fromEntries(row.countsByCoordinator.entries())
      : row.countsByCoordinator,
  }));
}

export function buildVoterCoordinatorDiagnosticsRust(input: {
  configuredCoordinatorTargets: string[];
  activeVotingId?: string | null;
  discoveredRoundSources: Array<{ coordinatorNpub: string; votingId: string }>;
  knownBlindKeyIds: string[];
  followDeliveries: Record<string, RustDeliveryState>;
  requestDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  ticketReceivedCoordinatorNpubs: string[];
}) {
  return buildVoterCoordinatorDiagnosticsWasm(input) as VoterCoordinatorDiagnosticRust[];
}

export function selectFollowRetryTargetsRust(input: {
  configuredCoordinatorTargets: string[];
  followDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  nowMs: number;
  minRetryAgeMs: number;
  maxAttempts: number;
}) {
  return selectFollowRetryTargetsWasm(input) as string[];
}

export function selectRequestRetryKeysRust(input: {
  pendingRequests: Array<{ key: string; requestId: string }>;
  requestDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  receivedRequestIds: string[];
  nowMs: number;
  minRetryAgeMs: number;
  maxAttempts: number;
}) {
  return selectRequestRetryKeysWasm(input) as string[];
}

export function mergeSimpleFollowersRust<T extends { voterNpub: string; createdAt: string }>(
  current: T[],
  next: T[],
) {
  return mergeSimpleFollowersWasm(current, next) as T[];
}

export function buildCoordinatorFollowerRowsRust(input: {
  followers: Array<{
    id: string;
    voterNpub: string;
    voterId: string;
    votingId?: string | null;
    createdAt: string;
  }>;
  selectedPublishedVotingId?: string | null;
  pendingRequests: Array<{ voterNpub: string; votingId: string; createdAt: string }>;
  ticketDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  canIssueTickets: boolean;
}) {
  return buildCoordinatorFollowerRowsWasm(input) as CoordinatorFollowerRowRust[];
}

export function selectTicketRetryTargetsRust(input: {
  followers: Array<{
    id: string;
    voterNpub: string;
    voterId: string;
    votingId?: string | null;
    createdAt: string;
  }>;
  selectedPublishedVotingId?: string | null;
  ticketDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  nowMs: number;
  minRetryAgeMs: number;
  maxAttempts: number;
}) {
  return selectTicketRetryTargetsWasm(input) as string[];
}
