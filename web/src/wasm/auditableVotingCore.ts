import * as auditableVotingRustCoreWasm from "./auditable_voting_core/pkg/auditable_voting_rust_core_bg.js";
import initAuditableVotingRustCore from "./auditable_voting_core/pkg/auditable_voting_rust_core_bg.wasm?init";

const auditableVotingRustCoreInstance = await initAuditableVotingRustCore({
  "./auditable_voting_rust_core_bg.js": auditableVotingRustCoreWasm,
});
const auditableVotingRustCore =
  auditableVotingRustCoreInstance instanceof WebAssembly.Instance
    ? auditableVotingRustCoreInstance.exports
    : auditableVotingRustCoreInstance;

auditableVotingRustCoreWasm.__wbg_set_wasm(auditableVotingRustCore);
if ("__wbindgen_start" in auditableVotingRustCore && typeof auditableVotingRustCore.__wbindgen_start === "function") {
  auditableVotingRustCore.__wbindgen_start();
}

export function deriveActorDisplayIdRust(value: string) {
  return auditableVotingRustCoreWasm.derive_actor_display_id(value);
}

export function extractNpubFromScanRust(value: string) {
  return auditableVotingRustCoreWasm.extract_npub_from_scan(value) ?? null;
}

export function sha256HexRust(input: string) {
  return auditableVotingRustCoreWasm.sha256_hex(input);
}

export function deriveTokenIdFromProofSecretsRust(proofSecrets: string[], length: number) {
  return auditableVotingRustCoreWasm.derive_token_id_from_proof_secrets(proofSecrets, length);
}

export function tokenIdLabelRust(tokenId: string | null | undefined) {
  return auditableVotingRustCoreWasm.token_id_label(tokenId ?? undefined);
}

export function tokenPatternDetailRust(tokenId: string, size: number) {
  return auditableVotingRustCoreWasm.token_pattern_detail(tokenId, size) as {
    filled: boolean;
    colorIndex: number;
  }[];
}

export function tokenPatternCellsRust(tokenId: string, size: number) {
  return auditableVotingRustCoreWasm.token_pattern_cells(tokenId, size) as boolean[];
}

export function tokenQrPayloadRust(tokenId: string) {
  return auditableVotingRustCoreWasm.token_qr_payload(tokenId);
}

export function sortSimpleVotesCanonicalRust<T extends { createdAt: string; eventId: string }>(
  votes: T[],
) {
  return auditableVotingRustCoreWasm.sort_simple_votes_canonical(votes) as T[];
}

export function sortRecordsByCreatedAtDescRust<T extends { createdAt: string }>(values: T[]) {
  return auditableVotingRustCoreWasm.sort_records_by_created_at_desc(values) as T[];
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
  return (auditableVotingRustCoreWasm.build_simple_vote_ticket_rows(
    entries,
    configuredCoordinatorTargets,
  ) as Array<{
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
