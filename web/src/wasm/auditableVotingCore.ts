import {
  build_simple_vote_ticket_rows as buildSimpleVoteTicketRowsWasm,
  derive_actor_display_id as deriveActorDisplayIdWasm,
  derive_token_id_from_proof_secrets as deriveTokenIdFromProofSecretsWasm,
  extract_npub_from_scan as extractNpubFromScanWasm,
  sha256_hex as sha256HexWasm,
  sort_records_by_created_at_desc as sortRecordsByCreatedAtDescWasm,
  sort_simple_votes_canonical as sortSimpleVotesCanonicalWasm,
  token_id_label as tokenIdLabelWasm,
  token_pattern_cells as tokenPatternCellsWasm,
  token_pattern_detail as tokenPatternDetailWasm,
  token_qr_payload as tokenQrPayloadWasm,
} from "./auditable_voting_core/pkg/auditable_voting_rust_core";

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
