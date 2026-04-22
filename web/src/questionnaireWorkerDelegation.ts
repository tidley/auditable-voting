import { finalizeEvent, getPublicKey, nip19, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";
import { getSharedNostrPool } from "./sharedNostrPool";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import { mapRelayPublishResult } from "./nostrPublishResult";
import { decodeNsec } from "./nostrIdentity";
import { SIMPLE_PUBLIC_RELAYS } from "./simpleVotingSession";

export const OPTIONA_WORKER_DELEGATION_KIND = 31994;
export const OPTIONA_WORKER_DELEGATION_REVOCATION_KIND = 31995;

const OPTIONA_WORKER_DELEGATION_STORAGE_KEY = "optiona:worker:delegations:v1";
const OPTIONA_WORKER_EVENT_MAX_WAIT_MS = 1500;
const OPTIONA_WORKER_EVENT_STAGGER_MS = 250;
const OPTIONA_WORKER_EVENT_MIN_INTERVAL_MS = 300;

export type WorkerCapability =
  | "issue_blind_tokens"
  | "verify_public_submissions"
  | "publish_submission_decisions"
  | "publish_result_summary";

export type WorkerDelegationState = "pending_activation" | "active" | "revoked" | "expired";

export type WorkerStatusState = "online" | "active" | "idle";

export type WorkerDelegationCertificate = {
  type: "worker_delegation";
  schemaVersion: 1;
  delegationId: string;
  electionId: string;
  coordinatorNpub: string;
  workerNpub: string;
  capabilities: WorkerCapability[];
  controlRelays: string[];
  issuedAt: string;
  expiresAt: string;
};

export type WorkerDelegationRevocation = {
  type: "worker_delegation_revocation";
  schemaVersion: 1;
  delegationId: string;
  electionId: string;
  coordinatorNpub: string;
  workerNpub: string;
  revokedAt: string;
  reason?: string;
};

export type WorkerStatusSnapshot = {
  type: "worker_status";
  schemaVersion: 1;
  workerNpub: string;
  coordinatorNpub: string;
  workerVersion?: string;
  state: WorkerStatusState;
  heartbeatAt: string;
  activeElectionId?: string | null;
  delegationId?: string | null;
  delegationState?: WorkerDelegationState;
  lastBlindIssuanceAt?: string | null;
  lastVoteVerificationAt?: string | null;
  lastDecisionPublishAt?: string | null;
  supportedCapabilities?: WorkerCapability[];
  advertisedRelays?: string[];
};

export type StoredWorkerDelegation = {
  electionId: string;
  mode: "browser_only" | "delegated_worker";
  activeDelegation: WorkerDelegationCertificate | null;
  lastRevocation: WorkerDelegationRevocation | null;
  lastUpdatedAt: string;
};

type WorkerDelegationStore = Record<string, StoredWorkerDelegation>;

function storageKey() {
  return buildSimpleNamespacedLocalStorageKey(OPTIONA_WORKER_DELEGATION_STORAGE_KEY);
}

function readStore(): WorkerDelegationStore {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as WorkerDelegationStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(next: WorkerDelegationStore) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(storageKey(), JSON.stringify(next));
}

export function loadStoredWorkerDelegation(electionId: string): StoredWorkerDelegation | null {
  const id = electionId.trim();
  if (!id) {
    return null;
  }
  return readStore()[id] ?? null;
}

export function upsertStoredWorkerDelegation(input: StoredWorkerDelegation) {
  const electionId = input.electionId.trim();
  if (!electionId) {
    return;
  }
  const store = readStore();
  store[electionId] = {
    ...input,
    electionId,
    lastUpdatedAt: input.lastUpdatedAt || new Date().toISOString(),
  };
  writeStore(store);
}

export function isDelegatedWorkerCapabilityEnabled(input: {
  electionId: string;
  capability: WorkerCapability;
  now?: Date;
}) {
  const state = loadStoredWorkerDelegation(input.electionId);
  if (!state || state.mode !== "delegated_worker" || !state.activeDelegation) {
    return false;
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const expiresAtMs = Date.parse(state.activeDelegation.expiresAt);
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) {
    return false;
  }
  if (state.lastRevocation && state.lastRevocation.delegationId === state.activeDelegation.delegationId) {
    return false;
  }
  return state.activeDelegation.capabilities.includes(input.capability);
}

export function createWorkerDelegationCertificate(input: {
  electionId: string;
  coordinatorNpub: string;
  workerNpub: string;
  capabilities: WorkerCapability[];
  controlRelays: string[];
  expiresAt: string;
}): WorkerDelegationCertificate {
  const randomPart = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`)
    .replace(/-/g, "")
    .slice(0, 24);
  return {
    type: "worker_delegation",
    schemaVersion: 1,
    delegationId: `delegation_${randomPart}`,
    electionId: input.electionId.trim(),
    coordinatorNpub: input.coordinatorNpub.trim(),
    workerNpub: input.workerNpub.trim(),
    capabilities: [...new Set(input.capabilities)],
    controlRelays: normalizeRelaysRust(input.controlRelays),
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
}

export function createWorkerDelegationRevocation(input: {
  delegationId: string;
  electionId: string;
  coordinatorNpub: string;
  workerNpub: string;
  reason?: string;
}): WorkerDelegationRevocation {
  return {
    type: "worker_delegation_revocation",
    schemaVersion: 1,
    delegationId: input.delegationId.trim(),
    electionId: input.electionId.trim(),
    coordinatorNpub: input.coordinatorNpub.trim(),
    workerNpub: input.workerNpub.trim(),
    revokedAt: new Date().toISOString(),
    reason: input.reason?.trim() || undefined,
  };
}

function toHexPubkey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return trimmed;
}

async function publishWorkerControlEvent(input: {
  coordinatorNsec: string;
  kind: number;
  tags: string[][];
  content: string;
  relays?: string[];
  channel: string;
}) {
  const secretKey = decodeNsec(input.coordinatorNsec);
  if (!secretKey) {
    throw new Error("Invalid coordinator nsec.");
  }
  const event = finalizeEvent({
    kind: input.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: input.tags,
    content: input.content,
  }, secretKey);
  const relays = normalizeRelaysRust([...(input.relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: OPTIONA_WORKER_EVENT_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: OPTIONA_WORKER_EVENT_STAGGER_MS },
    ),
    {
      channel: input.channel,
      minIntervalMs: OPTIONA_WORKER_EVENT_MIN_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => mapRelayPublishResult(result, relays[index]));
  return {
    event,
    eventId: event.id,
    relayResults,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    coordinatorNpub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

export async function publishWorkerDelegationCertificate(input: {
  coordinatorNsec: string;
  delegation: WorkerDelegationCertificate;
  relays?: string[];
}) {
  const delegation = input.delegation;
  return publishWorkerControlEvent({
    coordinatorNsec: input.coordinatorNsec,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    tags: [
      ["t", "optiona_worker_delegation"],
      ["election-id", delegation.electionId],
      ["delegation-id", delegation.delegationId],
      ["worker", delegation.workerNpub],
      ["coordinator", delegation.coordinatorNpub],
      ["expires-at", delegation.expiresAt],
    ],
    content: JSON.stringify(delegation),
    relays: input.relays,
    channel: `optiona-worker-delegation:${delegation.electionId}:${delegation.delegationId}`,
  });
}

export async function publishWorkerDelegationRevocation(input: {
  coordinatorNsec: string;
  revocation: WorkerDelegationRevocation;
  relays?: string[];
}) {
  const revocation = input.revocation;
  return publishWorkerControlEvent({
    coordinatorNsec: input.coordinatorNsec,
    kind: OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
    tags: [
      ["t", "optiona_worker_delegation_revocation"],
      ["election-id", revocation.electionId],
      ["delegation-id", revocation.delegationId],
      ["worker", revocation.workerNpub],
      ["coordinator", revocation.coordinatorNpub],
    ],
    content: JSON.stringify(revocation),
    relays: input.relays,
    channel: `optiona-worker-revocation:${revocation.electionId}:${revocation.delegationId}`,
  });
}

export function parseWorkerDelegationEvent(event: Pick<NostrEvent, "kind" | "content">): WorkerDelegationCertificate | null {
  if (event.kind !== OPTIONA_WORKER_DELEGATION_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as WorkerDelegationCertificate;
    if (
      parsed?.type !== "worker_delegation"
      || parsed.schemaVersion !== 1
      || typeof parsed.delegationId !== "string"
      || typeof parsed.electionId !== "string"
      || typeof parsed.coordinatorNpub !== "string"
      || typeof parsed.workerNpub !== "string"
      || !Array.isArray(parsed.capabilities)
      || !Array.isArray(parsed.controlRelays)
      || typeof parsed.issuedAt !== "string"
      || typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseWorkerDelegationRevocationEvent(event: Pick<NostrEvent, "kind" | "content">): WorkerDelegationRevocation | null {
  if (event.kind !== OPTIONA_WORKER_DELEGATION_REVOCATION_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as WorkerDelegationRevocation;
    if (
      parsed?.type !== "worker_delegation_revocation"
      || parsed.schemaVersion !== 1
      || typeof parsed.delegationId !== "string"
      || typeof parsed.electionId !== "string"
      || typeof parsed.coordinatorNpub !== "string"
      || typeof parsed.workerNpub !== "string"
      || typeof parsed.revokedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function normaliseWorkerNpub(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("npub1")) {
    return trimmed;
  }
  return nip19.npubEncode(toHexPubkey(trimmed));
}
