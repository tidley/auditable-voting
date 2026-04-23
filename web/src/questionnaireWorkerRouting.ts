import type { ElectionInviteMessage, ElectionSummary, IssueBlindTokensWorkerRouting } from "./questionnaireOptionA";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

export function buildIssueBlindTokensWorkerRouting(input: {
  delegationId: string;
  workerNpub: string;
  controlRelays?: string[];
  expiresAt?: string | null;
}): IssueBlindTokensWorkerRouting {
  return {
    delegationId: input.delegationId.trim(),
    workerNpub: input.workerNpub.trim(),
    controlRelays: normalizeRelaysRust(input.controlRelays ?? []),
    expiresAt: input.expiresAt?.trim() || null,
  };
}

export function isIssueBlindTokensWorkerRoutingActive(routing: IssueBlindTokensWorkerRouting | null | undefined) {
  if (!routing?.workerNpub?.trim()) {
    return false;
  }
  const expiresAtMs = Date.parse(routing.expiresAt ?? "");
  return !Number.isFinite(expiresAtMs) || expiresAtMs > Date.now();
}

export function selectIssueBlindTokensWorkerRouting(input: {
  invite?: ElectionInviteMessage | null;
  summary?: ElectionSummary | null;
}) {
  const inviteRouting = input.invite?.issueBlindTokensWorker ?? null;
  if (isIssueBlindTokensWorkerRoutingActive(inviteRouting)) {
    return inviteRouting;
  }
  const summaryRouting = input.summary?.issueBlindTokensWorker ?? null;
  if (isIssueBlindTokensWorkerRoutingActive(summaryRouting)) {
    return summaryRouting;
  }
  return null;
}

export function mergeBlindRequestRoutingRelays(baseRelays: string[], routing: IssueBlindTokensWorkerRouting | null | undefined) {
  return normalizeRelaysRust([...(routing?.controlRelays ?? []), ...baseRelays]);
}
