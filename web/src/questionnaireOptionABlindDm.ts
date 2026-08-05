import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44, type Filter, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { questionnaireDefinitionHash } from "./questionnaireDefinitionReference";
import {
  sanitiseBlindBallotIssuance,
  sanitiseBlindBallotRequest,
  type BallotAcceptanceResult,
  type BallotSubmission,
  type BearerInviteCodeEntry,
  type BlindBallotIssuance,
  type BlindBallotPlan,
  sanitiseBlindBallotPlan,
  type BlindBallotRequest,
  type CoordinatorElectionState,
  type VoterElectionLocalState,
} from "./questionnaireOptionA";
import type {
  QuestionnaireBlindPrivateKey,
} from "./questionnaireBlindSignature";
import type { QuestionnaireDefinition, QuestionnaireDefinitionReference } from "./questionnaireProtocol";
import type { SignerService } from "./services/signerService";
import type {
  WorkerDelegationCertificate,
  WorkerDelegationRevocation,
  WorkerStatusSnapshot,
} from "./questionnaireWorkerDelegation";
import { getSharedNostrPool } from "./sharedNostrPool";
import { DEFAULT_NOSTR_DM_RELAYS as SIMPLE_DM_RELAYS } from "./nostrRelayConfig";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import { mapRelayPublishResult } from "./nostrPublishResult";
import {
  recordRelayCloseReasons,
  recordRelayOutcome,
  selectRelaysWithBackoff,
} from "./relayBackoff";

const OPTION_A_BLIND_DM_RELAYS_MAX = 4;
const OPTION_A_BLIND_DM_READ_RELAYS_MAX = 4;
const OPTION_A_BLIND_DM_READ_RELAYS_FALLBACK_MAX = 5;
const OPTION_A_BLIND_DM_HINT_RELAYS_MAX = 4;
const OPTION_A_BLIND_DM_MAX_WAIT_MS = 1500;
const OPTION_A_BLIND_DM_STAGGER_MS = 250;
const OPTION_A_BLIND_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const ONE_DAY_SECONDS = 24 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS = SEVEN_DAYS_SECONDS;
const OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT = 40;
const KIND_SEAL = 13;
const KIND_RUMOR_MESSAGE = 14;
const KIND_GIFT_WRAP = 1059;
const KIND_NIP17_RELAY_LIST = 10050;
const OPTION_A_BLIND_DM_QUERY_MAX_CONCURRENCY = 1;
const OPTION_A_BLIND_DM_QUERY_TIMEOUT_MS = 8_000;
const OPTION_A_BLIND_DM_RELAY_BACKOFF_MS = 60 * 1000;
const OPTION_A_BLIND_DM_SIGNER_DECODE_CACHE_LIMIT = 512;
const OPTION_A_BLIND_DM_BACKFILL_PAGE_LIMIT = 40;
const OPTION_A_BLIND_DM_BACKFILL_MAX_PAGES = 8;
const OPTION_A_BLIND_DM_BACKFILL_TIME_BUDGET_MS = 6_000;
const OPTION_A_DM_EXISTENCE_CHECK_MAX_RELAYS = 6;
const OPTION_A_COMPRESSED_BUNDLE_TYPE = "optiona_compressed_bundle_dm";
const OPTION_A_COMPRESSED_BUNDLE_ENCODING = "gzip+base64url";
const OPTION_A_BUNDLE_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
const OPTION_A_COMPRESSED_BUNDLE_MAX_BYTES = 256 * 1024;
const OPTION_A_UNCOMPRESSED_BUNDLE_MAX_BYTES = 1024 * 1024;
const OPTION_A_BLIND_DM_READ_PRIORITY_RELAYS = [
  "wss://vm-1734.lnvps.cloud/",
  "wss://relay.nostr.net",
];
const OPTION_A_BLIND_DM_REJECTING_RELAYS = new Set([
  "wss://relay.nostr.info",
]);
const OPTION_A_BLIND_DM_AUTH_REQUIRED_READ_RELAYS = new Set([
  "wss://nip17.com",
]);
const OPTION_A_BLIND_DM_READ_UNINDEXED_TAG_RELAYS = new Set([
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.wine",
  "wss://nostr.mom",
]);

const optionABlindDmRelayCooldownUntil = new Map<string, number>();
const optionABlindDmInFlightQueries = new Map<string, Promise<NostrEvent[]>>();
let optionABlindDmActiveQueryCount = 0;
const optionABlindDmQueryWaiters: Array<() => void> = [];
const SHARED_GIFT_WRAP_SEEN_EVENT_LIMIT = 512;
const optionABlindDmSignerDecodeCache = new Map<string, Promise<{ rumorContent: string; sealPubkey: string } | null>>();

type BlindRequestDmEnvelope = {
  type: "optiona_blind_request_dm";
  schemaVersion: 1;
  request: BlindBallotRequest;
  sentAt: string;
};

type BlindRequestBundleDmEnvelope = {
  type: "optiona_blind_request_bundle_dm";
  schemaVersion: 1;
  requests: BlindBallotRequest[];
  sentAt: string;
};

type BlindIssuanceDmEnvelope = {
  type: "optiona_blind_issuance_dm";
  schemaVersion: 1;
  issuance: BlindBallotIssuance;
  sentAt: string;
};

type BlindIssuanceBundleDmEnvelope = {
  type: "optiona_blind_issuance_bundle_dm";
  schemaVersion: 1;
  definitionHash?: string | null;
  definitionEventId?: string | null;
  /** Legacy bundle-level definition. New bundles carry definitionHash / definitionEventId instead. */
  definition?: QuestionnaireDefinition | null;
  issuances: BlindBallotIssuance[];
  sentAt: string;
};

type BlindBallotPlanDmEnvelope = {
  type: "optiona_blind_ballot_plan_dm";
  schemaVersion: 1;
  plan: BlindBallotPlan;
  sentAt: string;
};

export type BlindIssuanceAck = {
  type: "blind_ballot_issuance_ack";
  schemaVersion: 1;
  electionId: string;
  requestId: string;
  issuanceId: string;
  invitedNpub: string;
  ackedAt: string;
};

export type BlindRequestAck = {
  type: "blind_ballot_request_ack";
  schemaVersion: 1;
  electionId: string;
  requestId: string;
  invitedNpub: string;
  ackedAt: string;
};

export type BallotSubmissionAck = {
  type: "ballot_submission_ack";
  schemaVersion: 1;
  electionId: string;
  submissionId: string;
  responseNpub: string;
  ackedAt: string;
};

type BlindIssuanceAckDmEnvelope = {
  type: "optiona_blind_issuance_ack_dm";
  schemaVersion: 1;
  ack: BlindIssuanceAck;
  sentAt: string;
};

type BlindRequestAckDmEnvelope = {
  type: "optiona_blind_request_ack_dm";
  schemaVersion: 1;
  ack: BlindRequestAck;
  sentAt: string;
};

type BallotSubmissionDmEnvelope = {
  type: "optiona_ballot_submission_dm";
  schemaVersion: 1;
  submission: BallotSubmission;
  sentAt: string;
};

type BallotSubmissionAckDmEnvelope = {
  type: "optiona_ballot_submission_ack_dm";
  schemaVersion: 1;
  ack: BallotSubmissionAck;
  sentAt: string;
};

type BallotAcceptanceDmEnvelope = {
  type: "optiona_ballot_acceptance_dm";
  schemaVersion: 1;
  acceptance: BallotAcceptanceResult;
  sentAt: string;
};

export type OptionAVoterStateSnapshot = {
  type: "voter_state_snapshot";
  schemaVersion: 1;
  electionId: string;
  invitedNpub: string;
  coordinatorNpub: string;
  loginVerified: boolean;
  loginVerifiedAt?: string | null;
  blindRequest?: BlindBallotRequest | null;
  blindRequests?: VoterElectionLocalState["blindRequests"];
  blindRequestSent: boolean;
  blindRequestSentAt?: string | null;
  blindIssuance?: BlindBallotIssuance | null;
  blindIssuances?: VoterElectionLocalState["blindIssuances"];
  blindTokenSecret?: VoterElectionLocalState["blindTokenSecret"];
  blindTokenSecrets?: VoterElectionLocalState["blindTokenSecrets"];
  credentialReady: boolean;
  responseNpub?: string | null;
  draftResponses?: BallotSubmission["payload"]["responses"];
  submission?: BallotSubmission | null;
  submissions?: Record<string, BallotSubmission>;
  submissionAccepted?: boolean | null;
  submissionAcceptedAt?: string | null;
  submissionDecisions?: Record<string, {
    submissionId: string;
    accepted: boolean;
    decidedAt: string;
    reason?: string | null;
  }>;
  lastUpdatedAt: string;
};

export type OptionACoordinatorStateSnapshot = {
  type: "coordinator_state_snapshot";
  schemaVersion: 1;
  electionId: string;
  coordinatorNpub: string;
  state: Omit<CoordinatorElectionState, "blindSigningPrivateKey">;
  pendingAuthorizationsByNpub?: Record<string, BlindBallotRequest[]>;
  pendingParticipantStatusesByNpub?: Record<string, OptionAParticipantStatus[]>;
  lastUpdatedAt: string;
};

type VoterStateDmEnvelope = {
  type: "optiona_voter_state_dm";
  schemaVersion: 1;
  snapshot: OptionAVoterStateSnapshot;
  sentAt: string;
};

type CoordinatorStateDmEnvelope = {
  type: "optiona_coordinator_state_dm";
  schemaVersion: 1;
  snapshot: OptionACoordinatorStateSnapshot;
  sentAt: string;
};

type WorkerStatusDmEnvelope = {
  type: "optiona_worker_status_dm";
  schemaVersion: 1;
  snapshot: WorkerStatusSnapshot;
  sentAt: string;
};

export type OptionAParticipantStatus = {
  type: "participant_status";
  schemaVersion: 1;
  electionId: string;
  invitedNpub: string;
  source: "voter" | "issuer_proxy";
  state: "voter_live" | "ballot_requested" | "ballot_issued" | "ballot_received";
  observedAt: string;
  requestId?: string;
  issuanceId?: string;
};

type ParticipantStatusDmEnvelope = {
  type: "optiona_participant_status_dm";
  schemaVersion: 1;
  status: OptionAParticipantStatus;
  sentAt: string;
};

type WorkerDelegationDmEnvelope = {
  type: "optiona_worker_delegation_dm";
  schemaVersion: 1;
  delegation: WorkerDelegationCertificate;
  sentAt: string;
};

type WorkerDelegationRevocationDmEnvelope = {
  type: "optiona_worker_delegation_revocation_dm";
  schemaVersion: 1;
  revocation: WorkerDelegationRevocation;
  sentAt: string;
};

export type WorkerElectionConfigSnapshot = {
  type: "worker_election_config";
  schemaVersion: 1;
  electionId: string;
  delegationId: string;
  configVersion: number;
  coordinatorNpub: string;
  workerNpub: string;
  expectedInviteeCount?: number;
  whitelistNpubs?: string[];
  proxyVoterNpubs?: string[];
  ballotGroupsByNpub?: Record<string, string>;
  bearerInviteCodes?: BearerInviteCodeEntry[];
  eligibilityRequired?: boolean;
  blindSigningPrivateKey?: QuestionnaireBlindPrivateKey | null;
  definitionReference?: QuestionnaireDefinitionReference | null;
  /** The worker only accepts the definition supplied in this authenticated configuration DM. */
  definition?: QuestionnaireDefinition | null;
  sentAt: string;
};

type WorkerElectionConfigDmEnvelope = {
  type: "optiona_worker_election_config_dm";
  schemaVersion: 1;
  snapshot: WorkerElectionConfigSnapshot;
  sentAt: string;
};

type CompressedBundleDmEnvelope = {
  type: typeof OPTION_A_COMPRESSED_BUNDLE_TYPE;
  schemaVersion: 1;
  encoding: typeof OPTION_A_COMPRESSED_BUNDLE_ENCODING;
  innerType: string;
  payload: string;
  originalLength: number;
  compressedLength: number;
  sentAt: string;
};

type OptionABlindDmEnvelope =
  | BlindRequestDmEnvelope
  | BlindRequestBundleDmEnvelope
  | BlindIssuanceDmEnvelope
  | BlindIssuanceBundleDmEnvelope
  | BlindBallotPlanDmEnvelope
  | BlindRequestAckDmEnvelope
  | BlindIssuanceAckDmEnvelope
  | BallotSubmissionDmEnvelope
  | BallotSubmissionAckDmEnvelope
  | BallotAcceptanceDmEnvelope
  | VoterStateDmEnvelope
  | CoordinatorStateDmEnvelope
  | WorkerStatusDmEnvelope
  | ParticipantStatusDmEnvelope
  | WorkerDelegationDmEnvelope
  | WorkerDelegationRevocationDmEnvelope
  | WorkerElectionConfigDmEnvelope;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isCompressibleBundleEnvelope(envelope: Pick<OptionABlindDmEnvelope, "type">) {
  return envelope.type === "optiona_blind_request_bundle_dm"
    || envelope.type === "optiona_blind_issuance_bundle_dm";
}

export function encodeOptionADmEnvelopeContent(envelope: OptionABlindDmEnvelope) {
  const plainContent = JSON.stringify(envelope);
  if (!isCompressibleBundleEnvelope(envelope)) {
    return plainContent;
  }
  const plainBytes = strToU8(plainContent);
  if (plainBytes.length < OPTION_A_BUNDLE_COMPRESSION_THRESHOLD_BYTES) {
    return plainContent;
  }
  const compressed = gzipSync(plainBytes, { level: 6 });
  const wrapper: CompressedBundleDmEnvelope = {
    type: OPTION_A_COMPRESSED_BUNDLE_TYPE,
    schemaVersion: 1,
    encoding: OPTION_A_COMPRESSED_BUNDLE_ENCODING,
    innerType: envelope.type,
    payload: bytesToBase64Url(compressed),
    originalLength: plainBytes.length,
    compressedLength: compressed.length,
    sentAt: envelope.sentAt,
  };
  const wrappedContent = JSON.stringify(wrapper);
  return strToU8(wrappedContent).length < plainBytes.length ? wrappedContent : plainContent;
}

export function parseOptionADmEnvelopeContent(content: string): unknown {
  const parsed = JSON.parse(content) as Partial<CompressedBundleDmEnvelope> | unknown;
  if (
    parsed
    && typeof parsed === "object"
    && (parsed as Partial<CompressedBundleDmEnvelope>).type === OPTION_A_COMPRESSED_BUNDLE_TYPE
  ) {
    const wrapper = parsed as Partial<CompressedBundleDmEnvelope>;
    if (
      wrapper.schemaVersion !== 1
      || wrapper.encoding !== OPTION_A_COMPRESSED_BUNDLE_ENCODING
      || typeof wrapper.innerType !== "string"
      || typeof wrapper.payload !== "string"
      || typeof wrapper.originalLength !== "number"
      || typeof wrapper.compressedLength !== "number"
    ) {
      throw new Error("Invalid compressed bundle envelope.");
    }
    if (
      wrapper.compressedLength > OPTION_A_COMPRESSED_BUNDLE_MAX_BYTES
      || wrapper.originalLength > OPTION_A_UNCOMPRESSED_BUNDLE_MAX_BYTES
      || wrapper.payload.length > OPTION_A_COMPRESSED_BUNDLE_MAX_BYTES * 2
    ) {
      throw new Error("Compressed bundle exceeds the supported size.");
    }
    const compressed = base64UrlToBytes(wrapper.payload);
    if (compressed.length !== wrapper.compressedLength) {
      throw new Error("Compressed bundle length mismatch.");
    }
    const uncompressed = strFromU8(gunzipSync(compressed));
    if (strToU8(uncompressed).length !== wrapper.originalLength) {
      throw new Error("Compressed bundle original length mismatch.");
    }
    const inner = JSON.parse(uncompressed) as { type?: unknown };
    if (inner?.type !== wrapper.innerType) {
      throw new Error("Compressed bundle inner type mismatch.");
    }
    return inner;
  }
  return parsed;
}

function optionABlindDmDebugLoggingEnabled() {
  const globalDebug = (globalThis as typeof globalThis & { __AUDITABLE_VOTING_DEBUG_OPTION_A?: unknown })
    .__AUDITABLE_VOTING_DEBUG_OPTION_A;
  if (globalDebug === true) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("debug_option_a") === "1"
      || window.localStorage.getItem("auditable-voting:debug:option-a") === "1";
  } catch {
    return false;
  }
}

function optionABlindDmLog(stage: string, details?: Record<string, unknown>) {
  if (!optionABlindDmDebugLoggingEnabled()) {
    return;
  }
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.debug(`[OptionA][DM] ${stage}${payload}`);
}

function incrementReason(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

function shouldBackoffBlindDmRelay(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("too many concurrent req")
    || lower.includes("rate")
    || lower.includes("throttle")
    || lower.includes("429");
}

function applyBlindDmRelayBackoff(relays: string[], reason: string) {
  for (const relay of relays) {
    recordRelayOutcome(relay, false, reason);
  }
  if (!shouldBackoffBlindDmRelay(reason)) {
    return;
  }
  const until = Date.now() + OPTION_A_BLIND_DM_RELAY_BACKOFF_MS;
  for (const relay of relays) {
    optionABlindDmRelayCooldownUntil.set(relay, until);
  }
  optionABlindDmLog("relay_backoff_applied", {
    relayCount: relays.length,
    reason,
    backoffMs: OPTION_A_BLIND_DM_RELAY_BACKOFF_MS,
  });
}

function filterBlindDmReadRelays(relays: string[]) {
  const now = Date.now();
  const ordered = orderBlindDmReadRelays(relays);
  const readable = ordered.filter((relay) => {
    return !OPTION_A_BLIND_DM_REJECTING_RELAYS.has(relay)
      && !OPTION_A_BLIND_DM_AUTH_REQUIRED_READ_RELAYS.has(relay);
  });
  const fallback = readable.length > 0
    ? readable
    : ordered.filter((relay) => !OPTION_A_BLIND_DM_REJECTING_RELAYS.has(relay));
  const available = ordered.filter((relay) => {
    const until = optionABlindDmRelayCooldownUntil.get(relay) ?? 0;
    return until <= now && fallback.includes(relay);
  });
  if (available.length > 0) {
    return selectRelaysWithBackoff(available, available.length);
  }
  return selectRelaysWithBackoff(
    fallback.length > 0 ? fallback : ordered,
    Math.max(1, Math.min(2, fallback.length || ordered.length)),
  );
}

async function withBlindDmQuerySlot<T>(task: () => Promise<T>): Promise<T> {
  if (optionABlindDmActiveQueryCount >= OPTION_A_BLIND_DM_QUERY_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      optionABlindDmQueryWaiters.push(resolve);
    });
  }
  optionABlindDmActiveQueryCount += 1;
  try {
    return await task();
  } finally {
    optionABlindDmActiveQueryCount = Math.max(0, optionABlindDmActiveQueryCount - 1);
    const next = optionABlindDmQueryWaiters.shift();
    next?.();
  }
}

async function withBlindDmTimeout<T>(task: Promise<T>, timeoutMs = OPTION_A_BLIND_DM_QUERY_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error(`blind DM relay query timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      globalThis.clearTimeout(timer);
    }
  }
}

async function queryBlindDmSync(relays: string[], filter: Filter) {
  const queryRelays = filterBlindDmReadRelays(normalizeRelaysRust(relays));
  const key = JSON.stringify({ relays: queryRelays, filter });
  const existing = optionABlindDmInFlightQueries.get(key);
  if (existing) {
    return existing;
  }
  const run = withBlindDmQuerySlot(async () => {
    const pool = getSharedNostrPool();
    try {
      const events = await withBlindDmTimeout(pool.querySync(queryRelays, filter));
      for (const relay of queryRelays) {
        recordRelayOutcome(relay, true);
      }
      return events;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyBlindDmRelayBackoff(queryRelays, message);
      throw error;
    }
  });
  optionABlindDmInFlightQueries.set(key, run);
  try {
    return await run;
  } finally {
    optionABlindDmInFlightQueries.delete(key);
  }
}

export type OptionABlindRequestFetchDiagnostics = {
  relayCount: number;
  scannedCount: number;
  parsedCount: number;
  dedupedCount: number;
  rejectReasons: Record<string, number>;
  since?: number;
};

type BlindDmBackfillOptions = {
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  stopAfterPage?: (pageEvents: NostrEvent[], collectedEvents: NostrEvent[]) => boolean | Promise<boolean>;
};

export type OptionADmEventCopyCheckResult = {
  eventId: string;
  confirmedCopies: number;
  confirmedRelays: string[];
  checkedRelays: string[];
};

function toHexPubkey(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return value;
}

function decodeNsecSecretKey(nsec: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Expected nsec.");
  }
  return decoded.data as Uint8Array;
}

function randomNow() {
  const now = Math.round(Date.now() / 1000);
  return Math.round(now - (Math.random() * ONE_DAY_SECONDS));
}

function toNpub(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    return value;
  }
  return nip19.npubEncode(value);
}

function buildRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_DM_RELAYS]);
}

function selectReadRelays(relays: string[], maxRelays = OPTION_A_BLIND_DM_READ_RELAYS_MAX) {
  const ordered = filterBlindDmReadRelays(relays);
  return selectRelaysWithBackoff(ordered, Math.min(maxRelays, ordered.length));
}

function orderBlindDmReadRelays(relays: string[]) {
  const normalized = normalizeRelaysRust(relays);
  const relaySet = new Set(normalized);
  const ordered: string[] = [];
  const add = (relay: string) => {
    if (relaySet.has(relay) && !ordered.includes(relay)) {
      ordered.push(relay);
    }
  };

  for (const relay of OPTION_A_BLIND_DM_READ_PRIORITY_RELAYS) {
    add(relay);
  }
  for (const relay of normalized) {
    if (!OPTION_A_BLIND_DM_READ_UNINDEXED_TAG_RELAYS.has(relay)) {
      add(relay);
    }
  }
  return ordered;
}

function selectPublishRelays(relays: string[]) {
  const compatibleRelays = relays.filter((relay) => !OPTION_A_BLIND_DM_REJECTING_RELAYS.has(relay));
  return selectRelaysWithBackoff(
    compatibleRelays,
    Math.min(OPTION_A_BLIND_DM_RELAYS_MAX, compatibleRelays.length),
  );
}

function selectHintRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_BLIND_DM_HINT_RELAYS_MAX, relays.length));
}

function mixRecipientAndFallbackRelays(recipientRelays: string[], fallbackRelays: string[]) {
  const mixed: string[] = [];
  const add = (relay?: string) => {
    const value = relay?.trim();
    if (value && !mixed.includes(value)) {
      mixed.push(value);
    }
  };

  recipientRelays.slice(0, 2).forEach(add);
  fallbackRelays.slice(0, 2).forEach(add);
  recipientRelays.slice(2).forEach(add);
  fallbackRelays.slice(2).forEach(add);
  return normalizeRelaysRust(mixed);
}

type SharedGiftWrapListener = {
  id: string;
  onEvent: (event: NostrEvent) => void;
  onError?: (error: Error) => void;
};

type SharedGiftWrapInbox = {
  recipientNpub: string;
  recipientHex: string;
  relays: string[];
  listeners: Map<string, SharedGiftWrapListener>;
  seenEventIds: Set<string>;
  seenEventOrder: string[];
  subscription: { close: (reason?: string) => Promise<void> | void } | null;
  startPromise: Promise<void> | null;
  restartTimer: ReturnType<typeof globalThis.setTimeout> | null;
};

const sharedGiftWrapInboxes = new Map<string, SharedGiftWrapInbox>();
const SHARED_GIFT_WRAP_RESTART_MS = 2000;

function relayListsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((relay, index) => relay === right[index]);
}

function scheduleSharedGiftWrapInboxRestart(recipientHex: string) {
  const inbox = sharedGiftWrapInboxes.get(recipientHex);
  if (!inbox || inbox.listeners.size === 0 || inbox.restartTimer || inbox.startPromise || inbox.subscription) {
    return;
  }
  inbox.restartTimer = globalThis.setTimeout(() => {
    const current = sharedGiftWrapInboxes.get(recipientHex);
    if (!current) {
      return;
    }
    current.restartTimer = null;
    void ensureSharedGiftWrapInboxStarted(current).catch((error) => {
      if (error instanceof Error) {
        for (const listener of current.listeners.values()) {
          listener.onError?.(error);
        }
      }
    });
  }, SHARED_GIFT_WRAP_RESTART_MS);
}

async function ensureSharedGiftWrapInboxStarted(inbox: SharedGiftWrapInbox) {
  if (inbox.subscription || inbox.startPromise) {
    return inbox.startPromise ?? Promise.resolve();
  }
  inbox.startPromise = (async () => {
    const pool = getSharedNostrPool();
    optionABlindDmLog("shared_recipient_inbox_subscribe_started", {
      recipientNpub: inbox.recipientNpub,
      relayCount: inbox.relays.length,
    });
    const nextSubscription = pool.subscribeMany(inbox.relays, {
      kinds: [KIND_GIFT_WRAP],
      "#p": [inbox.recipientHex],
      since: Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    }, {
      onevent: (event) => {
        const current = sharedGiftWrapInboxes.get(inbox.recipientHex);
        if (!current) {
          return;
        }
        const eventId = typeof event.id === "string" ? event.id.trim() : "";
        if (eventId) {
          if (current.seenEventIds.has(eventId)) {
            return;
          }
          current.seenEventIds.add(eventId);
          current.seenEventOrder.push(eventId);
          while (current.seenEventOrder.length > SHARED_GIFT_WRAP_SEEN_EVENT_LIMIT) {
            const expired = current.seenEventOrder.shift();
            if (expired) {
              current.seenEventIds.delete(expired);
            }
          }
        }
        for (const listener of current.listeners.values()) {
          listener.onEvent(event as NostrEvent);
        }
      },
      onclose: (reasons) => {
        const current = sharedGiftWrapInboxes.get(inbox.recipientHex);
        if (!current) {
          return;
        }
        current.subscription = null;
        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller") && !reason.startsWith("shared inbox restarting"));
        if (errors.length > 0) {
          recordRelayCloseReasons(errors);
          const error = new Error(errors.join("; "));
          for (const listener of current.listeners.values()) {
            listener.onError?.(error);
          }
          scheduleSharedGiftWrapInboxRestart(inbox.recipientHex);
        }
      },
    });
    const current = sharedGiftWrapInboxes.get(inbox.recipientHex);
    if (!current) {
      void nextSubscription.close("closed by caller");
      return;
    }
    current.subscription = nextSubscription;
  })().finally(() => {
    const current = sharedGiftWrapInboxes.get(inbox.recipientHex);
    if (current) {
      current.startPromise = null;
    }
  });
  return inbox.startPromise;
}

async function attachSharedGiftWrapInbox(input: {
  recipientNpub: string;
  recipientHex: string;
  relays: string[];
  listener: SharedGiftWrapListener;
}) {
  const key = input.recipientHex;
  let inbox = sharedGiftWrapInboxes.get(key);
  if (!inbox) {
    inbox = {
      recipientNpub: input.recipientNpub,
      recipientHex: input.recipientHex,
      relays: normalizeRelaysRust(input.relays),
      listeners: new Map(),
      seenEventIds: new Set(),
      seenEventOrder: [],
      subscription: null,
      startPromise: null,
      restartTimer: null,
    };
    sharedGiftWrapInboxes.set(key, inbox);
  } else {
    inbox.recipientNpub = input.recipientNpub;
    const mergedRelays = normalizeRelaysRust([...input.relays, ...inbox.relays]);
    if (!relayListsEqual(mergedRelays, inbox.relays)) {
      inbox.relays = mergedRelays;
      if (inbox.subscription) {
        const previous = inbox.subscription;
        inbox.subscription = null;
        void previous.close("shared inbox restarting");
      }
    }
  }
  inbox.listeners.set(input.listener.id, input.listener);
  if (inbox.restartTimer) {
    globalThis.clearTimeout(inbox.restartTimer);
    inbox.restartTimer = null;
  }
  await ensureSharedGiftWrapInboxStarted(inbox);
  return () => {
    const current = sharedGiftWrapInboxes.get(key);
    if (!current) {
      return;
    }
    current.listeners.delete(input.listener.id);
    if (current.listeners.size > 0) {
      return;
    }
    if (current.restartTimer) {
      globalThis.clearTimeout(current.restartTimer);
      current.restartTimer = null;
    }
    sharedGiftWrapInboxes.delete(key);
    if (current.subscription) {
      void current.subscription.close("closed by caller");
      current.subscription = null;
    }
  };
}

function parseNip17RelayListEvent(event: { kind?: number; tags?: string[][] }) {
  if (event.kind !== KIND_NIP17_RELAY_LIST || !Array.isArray(event.tags)) {
    return [] as string[];
  }
  return event.tags
    .filter((tag) => tag[0] === "relay" || tag[0] === "r")
    .map((tag) => tag[1]?.trim() ?? "")
    .filter((relay) => relay.startsWith("ws://") || relay.startsWith("wss://"));
}

async function fetchRecipientNip17Relays(input: {
  recipientHex: string;
  discoveryRelays: string[];
}) {
  try {
    const events = await queryBlindDmSync(input.discoveryRelays, {
      kinds: [KIND_NIP17_RELAY_LIST],
      authors: [input.recipientHex],
      limit: 5,
    });
    return normalizeRelaysRust(
      [...events]
        .sort((left, right) => Number(right.created_at ?? 0) - Number(left.created_at ?? 0))
        .flatMap((event) => parseNip17RelayListEvent(event)),
    );
  } catch {
    return [] as string[];
  }
}

async function resolveRecipientPublishRelays(recipientHex: string, fallbackRelays: string[]) {
  void recipientHex;
  return selectPublishRelays(fallbackRelays);
}

async function resolveRecipientReadRelayCandidates(recipientHex: string, fallbackRelays: string[]) {
  void recipientHex;
  return fallbackRelays;
}

async function resolveRecipientReadRelays(recipientHex: string, fallbackRelays: string[]) {
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, fallbackRelays);
  return selectReadRelays(relayCandidates);
}

function sortGiftWrapEventsNewestFirst(events: NostrEvent[]) {
  return [...events].sort((left, right) => {
    const createdDelta = Number(right.created_at ?? 0) - Number(left.created_at ?? 0);
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return String(right.id ?? "").localeCompare(String(left.id ?? ""));
  });
}

async function queryBlindDmSyncPaginated(
  relays: string[],
  filter: Filter,
  options?: BlindDmBackfillOptions,
) {
  const rawLimit = Number(filter.limit ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const requestedLimit = Math.max(1, Number.isFinite(rawLimit) ? rawLimit : OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const pageLimit = Math.max(1, Math.min(
    options?.pageLimit ?? OPTION_A_BLIND_DM_BACKFILL_PAGE_LIMIT,
    requestedLimit,
  ));
  const maxPages = Math.max(1, options?.maxPages ?? Math.ceil(requestedLimit / pageLimit));
  const timeBudgetMs = Math.max(250, options?.timeBudgetMs ?? OPTION_A_BLIND_DM_BACKFILL_TIME_BUDGET_MS);
  const startedAt = Date.now();
  const eventsById = new Map<string, NostrEvent>();
  let until = typeof filter.until === "number" ? filter.until : undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (Date.now() - startedAt > timeBudgetMs) {
      break;
    }
    const pageEvents = await queryBlindDmSync(relays, {
      ...filter,
      ...(until ? { until } : {}),
      limit: pageLimit,
    });
    const sortedPage = sortGiftWrapEventsNewestFirst(pageEvents);
    let added = 0;
    for (const event of sortedPage) {
      if (!eventsById.has(event.id)) {
        added += 1;
      }
      eventsById.set(event.id, event);
    }
    if (options?.stopAfterPage) {
      const shouldStop = await options.stopAfterPage(sortedPage, sortGiftWrapEventsNewestFirst([...eventsById.values()]));
      if (shouldStop) {
        break;
      }
    }
    if (sortedPage.length < pageLimit || added === 0) {
      break;
    }
    const oldestCreatedAt = Math.min(...sortedPage.map((event) => Number(event.created_at ?? 0)).filter((value) => value > 0));
    if (!Number.isFinite(oldestCreatedAt) || oldestCreatedAt <= 0) {
      break;
    }
    until = Math.min(until ?? oldestCreatedAt, oldestCreatedAt) - 1;
  }

  return sortGiftWrapEventsNewestFirst([...eventsById.values()]).slice(0, requestedLimit);
}

async function queryBlindDmSyncWithFallback(relayCandidates: string[], filter: Filter) {
  const primaryRelays = selectReadRelays(relayCandidates, OPTION_A_BLIND_DM_READ_RELAYS_MAX);
  const primaryEvents = await queryBlindDmSync(primaryRelays, filter);
  const shouldFallbackRead = primaryEvents.length === 0
    && relayCandidates.length > primaryRelays.length;
  const fallbackRelays = shouldFallbackRead
    ? selectReadRelays(relayCandidates, OPTION_A_BLIND_DM_READ_RELAYS_FALLBACK_MAX)
    : [];
  const fallbackEvents = shouldFallbackRead
    ? await queryBlindDmSync(fallbackRelays, filter).catch(() => [] as NostrEvent[])
    : [];
  return {
    relays: shouldFallbackRead ? fallbackRelays : primaryRelays,
    events: [...primaryEvents, ...fallbackEvents],
  };
}

async function queryBlindDmSyncWithFallbackPaginated(
  relayCandidates: string[],
  filter: Filter,
  options?: BlindDmBackfillOptions,
) {
  const primaryRelays = selectReadRelays(relayCandidates, OPTION_A_BLIND_DM_READ_RELAYS_MAX);
  let primaryTargetFound = false;
  const primaryOptions = options?.stopAfterPage
    ? {
      ...options,
      stopAfterPage: async (...args: Parameters<NonNullable<BlindDmBackfillOptions["stopAfterPage"]>>) => {
        const found = await options.stopAfterPage?.(...args) ?? false;
        primaryTargetFound ||= found;
        return found;
      },
    }
    : options;
  const primaryEvents = await queryBlindDmSyncPaginated(primaryRelays, filter, primaryOptions);
  const shouldFallbackRead = (!primaryTargetFound && (primaryEvents.length === 0 || Boolean(options?.stopAfterPage)))
    && relayCandidates.length > primaryRelays.length;
  const fallbackRelays = shouldFallbackRead
    ? selectReadRelays(relayCandidates, OPTION_A_BLIND_DM_READ_RELAYS_FALLBACK_MAX)
    : [];
  const fallbackEvents = shouldFallbackRead
    ? await queryBlindDmSyncPaginated(fallbackRelays, filter, options).catch(() => [] as NostrEvent[])
    : [];
  return {
    relays: shouldFallbackRead ? fallbackRelays : primaryRelays,
    events: sortGiftWrapEventsNewestFirst([...primaryEvents, ...fallbackEvents]),
  };
}

function isValidBlindRequestPayload(request: BlindBallotRequest | null | undefined): request is BlindBallotRequest {
  return Boolean(
    request?.type === "blind_ballot_request"
    && request.schemaVersion === 1
    && typeof request.electionId === "string"
    && typeof request.requestId === "string"
    && typeof request.invitedNpub === "string",
  );
}

function isValidBlindIssuancePayload(issuance: BlindBallotIssuance | null | undefined): issuance is BlindBallotIssuance {
  return Boolean(
    issuance?.type === "blind_ballot_response"
    && issuance.schemaVersion === 1
    && typeof issuance.electionId === "string"
    && typeof issuance.requestId === "string"
    && typeof issuance.invitedNpub === "string",
  );
}

function parseBlindRequestDmContent(content: string): BlindBallotRequest[] | null {
  try {
    const parsed = parseOptionADmEnvelopeContent(content) as Partial<BlindRequestDmEnvelope | BlindRequestBundleDmEnvelope> | BlindBallotRequest;
    const requests = (parsed as BlindRequestBundleDmEnvelope).type === "optiona_blind_request_bundle_dm"
      ? (parsed as BlindRequestBundleDmEnvelope).requests
      : (parsed as BlindRequestDmEnvelope).type === "optiona_blind_request_dm"
        ? [(parsed as BlindRequestDmEnvelope).request]
        : [parsed as BlindBallotRequest];
    if (!Array.isArray(requests)) {
      return null;
    }
    const valid = requests
      .filter(isValidBlindRequestPayload)
      .map((request) => sanitiseBlindBallotRequest(request));
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function parseBlindIssuanceDmContent(content: string): BlindBallotIssuance[] | null {
  try {
    const parsed = parseOptionADmEnvelopeContent(content) as Partial<BlindIssuanceDmEnvelope | BlindIssuanceBundleDmEnvelope> | BlindBallotIssuance;
    let issuances: BlindBallotIssuance[];
    if ((parsed as BlindIssuanceBundleDmEnvelope).type === "optiona_blind_issuance_bundle_dm") {
      const bundle = parsed as BlindIssuanceBundleDmEnvelope;
      const sharedDefinition = bundle.definition ?? null;
      issuances = Array.isArray(bundle.issuances)
        ? bundle.issuances.map((issuance) => (
          {
            ...issuance,
            definitionHash: issuance.definitionHash ?? bundle.definitionHash ?? (
              sharedDefinition ? questionnaireDefinitionHash(sharedDefinition) : null
            ),
            definitionEventId: issuance.definitionEventId ?? bundle.definitionEventId ?? null,
            ...(sharedDefinition && !issuance.definition ? { definition: sharedDefinition } : {}),
          }
        ))
        : [];
    } else if ((parsed as BlindIssuanceDmEnvelope).type === "optiona_blind_issuance_dm") {
      issuances = [(parsed as BlindIssuanceDmEnvelope).issuance];
    } else {
      issuances = [parsed as BlindBallotIssuance];
    }
    if (!Array.isArray(issuances)) {
      return null;
    }
    const valid = issuances
      .filter(isValidBlindIssuancePayload)
      .map((issuance) => sanitiseBlindBallotIssuance(issuance));
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export function parseBlindBallotPlanDmContent(content: string): BlindBallotPlan | null {
  try {
    const parsed = parseOptionADmEnvelopeContent(content) as Partial<BlindBallotPlanDmEnvelope> | BlindBallotPlan;
    const plan = (parsed as BlindBallotPlanDmEnvelope).type === "optiona_blind_ballot_plan_dm"
      ? (parsed as BlindBallotPlanDmEnvelope).plan
      : parsed as BlindBallotPlan;
    return sanitiseBlindBallotPlan(plan);
  } catch {
    return null;
  }
}

function parseBlindRequestAckDmContent(content: string): BlindRequestAck | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindRequestAckDmEnvelope> | BlindRequestAck;
    const ack = (parsed as BlindRequestAckDmEnvelope).type === "optiona_blind_request_ack_dm"
      ? (parsed as BlindRequestAckDmEnvelope).ack
      : parsed as BlindRequestAck;
    if (
      ack?.type !== "blind_ballot_request_ack"
      || ack.schemaVersion !== 1
      || typeof ack.electionId !== "string"
      || typeof ack.requestId !== "string"
      || typeof ack.invitedNpub !== "string"
      || typeof ack.ackedAt !== "string"
    ) {
      return null;
    }
    return ack;
  } catch {
    return null;
  }
}

function parseBallotSubmissionDmContent(content: string): BallotSubmission | null {
  try {
    const parsed = JSON.parse(content) as Partial<BallotSubmissionDmEnvelope> | BallotSubmission;
    const submission = (parsed as BallotSubmissionDmEnvelope).type === "optiona_ballot_submission_dm"
      ? (parsed as BallotSubmissionDmEnvelope).submission
      : parsed as BallotSubmission;
    if (
      submission?.type !== "ballot_submission"
      || submission.schemaVersion !== 1
      || typeof submission.electionId !== "string"
      || typeof submission.submissionId !== "string"
      || typeof submission.invitedNpub !== "string"
    ) {
      return null;
    }
    return submission;
  } catch {
    return null;
  }
}

function parseBallotSubmissionAckDmContent(content: string): BallotSubmissionAck | null {
  try {
    const parsed = JSON.parse(content) as Partial<BallotSubmissionAckDmEnvelope> | BallotSubmissionAck;
    const ack = (parsed as BallotSubmissionAckDmEnvelope).type === "optiona_ballot_submission_ack_dm"
      ? (parsed as BallotSubmissionAckDmEnvelope).ack
      : parsed as BallotSubmissionAck;
    if (
      ack?.type !== "ballot_submission_ack"
      || ack.schemaVersion !== 1
      || typeof ack.electionId !== "string"
      || typeof ack.submissionId !== "string"
      || typeof ack.responseNpub !== "string"
      || typeof ack.ackedAt !== "string"
    ) {
      return null;
    }
    return ack;
  } catch {
    return null;
  }
}

function parseBallotAcceptanceDmContent(content: string): BallotAcceptanceResult | null {
  try {
    const parsed = JSON.parse(content) as Partial<BallotAcceptanceDmEnvelope> | BallotAcceptanceResult;
    const acceptance = (parsed as BallotAcceptanceDmEnvelope).type === "optiona_ballot_acceptance_dm"
      ? (parsed as BallotAcceptanceDmEnvelope).acceptance
      : parsed as BallotAcceptanceResult;
    if (
      acceptance?.type !== "ballot_acceptance_result"
      || acceptance.schemaVersion !== 1
      || typeof acceptance.electionId !== "string"
      || typeof acceptance.submissionId !== "string"
      || typeof acceptance.accepted !== "boolean"
    ) {
      return null;
    }
    return acceptance;
  } catch {
    return null;
  }
}

function parseBlindIssuanceAckDmContent(content: string): BlindIssuanceAck | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindIssuanceAckDmEnvelope> | BlindIssuanceAck;
    const ack = (parsed as BlindIssuanceAckDmEnvelope).type === "optiona_blind_issuance_ack_dm"
      ? (parsed as BlindIssuanceAckDmEnvelope).ack
      : parsed as BlindIssuanceAck;
    if (
      ack?.type !== "blind_ballot_issuance_ack"
      || ack.schemaVersion !== 1
      || typeof ack.electionId !== "string"
      || typeof ack.requestId !== "string"
      || typeof ack.issuanceId !== "string"
      || typeof ack.invitedNpub !== "string"
      || typeof ack.ackedAt !== "string"
    ) {
      return null;
    }
    return ack;
  } catch {
    return null;
  }
}

function parseVoterStateDmContent(content: string): OptionAVoterStateSnapshot | null {
  try {
    const parsed = JSON.parse(content) as Partial<VoterStateDmEnvelope> | OptionAVoterStateSnapshot;
    const snapshot = (parsed as VoterStateDmEnvelope).type === "optiona_voter_state_dm"
      ? (parsed as VoterStateDmEnvelope).snapshot
      : parsed as OptionAVoterStateSnapshot;
    if (
      snapshot?.type !== "voter_state_snapshot"
      || snapshot.schemaVersion !== 1
      || typeof snapshot.electionId !== "string"
      || typeof snapshot.invitedNpub !== "string"
      || typeof snapshot.coordinatorNpub !== "string"
      || typeof snapshot.loginVerified !== "boolean"
      || typeof snapshot.blindRequestSent !== "boolean"
      || typeof snapshot.credentialReady !== "boolean"
      || typeof snapshot.lastUpdatedAt !== "string"
    ) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function parseCoordinatorStateDmContent(content: string): OptionACoordinatorStateSnapshot | null {
  try {
    const parsed = JSON.parse(content) as Partial<CoordinatorStateDmEnvelope> | OptionACoordinatorStateSnapshot;
    const snapshot = (parsed as CoordinatorStateDmEnvelope).type === "optiona_coordinator_state_dm"
      ? (parsed as CoordinatorStateDmEnvelope).snapshot
      : parsed as OptionACoordinatorStateSnapshot;
    if (
      snapshot?.type !== "coordinator_state_snapshot"
      || snapshot.schemaVersion !== 1
      || typeof snapshot.electionId !== "string"
      || typeof snapshot.coordinatorNpub !== "string"
      || typeof snapshot.lastUpdatedAt !== "string"
      || !snapshot.state
      || typeof snapshot.state !== "object"
      || typeof snapshot.state.lastUpdatedAt !== "string"
    ) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function parseWorkerStatusDmContent(content: string): WorkerStatusSnapshot | null {
  try {
    const parsed = JSON.parse(content) as Partial<WorkerStatusDmEnvelope> | WorkerStatusSnapshot;
    const snapshot = (parsed as WorkerStatusDmEnvelope).type === "optiona_worker_status_dm"
      ? (parsed as WorkerStatusDmEnvelope).snapshot
      : parsed as WorkerStatusSnapshot;
    if (
      snapshot?.type !== "worker_status"
      || snapshot.schemaVersion !== 1
      || typeof snapshot.workerNpub !== "string"
      || typeof snapshot.coordinatorNpub !== "string"
      || typeof snapshot.state !== "string"
      || typeof snapshot.heartbeatAt !== "string"
    ) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function parseOptionAParticipantStatusDmContent(content: string): OptionAParticipantStatus | null {
  try {
    const envelope = JSON.parse(content) as Partial<ParticipantStatusDmEnvelope>;
    const status = envelope.status;
    if (
      envelope.type !== "optiona_participant_status_dm"
      || envelope.schemaVersion !== 1
      || typeof envelope.sentAt !== "string"
      || status?.type !== "participant_status"
      || status.schemaVersion !== 1
      || typeof status.electionId !== "string"
      || typeof status.invitedNpub !== "string"
      || (status.source !== "voter" && status.source !== "issuer_proxy")
      || !["voter_live", "ballot_requested", "ballot_issued", "ballot_received"].includes(status.state)
      || (status.source === "voter" && status.state !== "voter_live" && status.state !== "ballot_received")
      || (status.source === "issuer_proxy" && status.state !== "ballot_requested" && status.state !== "ballot_issued")
      || typeof status.observedAt !== "string"
      || (status.requestId !== undefined && typeof status.requestId !== "string")
      || (status.issuanceId !== undefined && typeof status.issuanceId !== "string")
      || Object.prototype.hasOwnProperty.call(status, "submissionId")
    ) {
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

function isAuthenticatedParticipantStatusSender(
  status: OptionAParticipantStatus,
  sealPubkey: string,
  workerNpub?: string,
) {
  const senderNpub = toNpub(sealPubkey);
  if (status.source === "voter") {
    return senderNpub === status.invitedNpub;
  }
  const workerFilter = workerNpub?.trim();
  return Boolean(workerFilter && senderNpub === toNpub(workerFilter));
}

function parseWorkerDelegationDmContent(content: string): WorkerDelegationCertificate | null {
  try {
    const parsed = JSON.parse(content) as Partial<WorkerDelegationDmEnvelope> | WorkerDelegationCertificate;
    const delegation = (parsed as WorkerDelegationDmEnvelope).type === "optiona_worker_delegation_dm"
      ? (parsed as WorkerDelegationDmEnvelope).delegation
      : parsed as WorkerDelegationCertificate;
    if (
      delegation?.type !== "worker_delegation"
      || delegation.schemaVersion !== 1
      || typeof delegation.delegationId !== "string"
      || typeof delegation.electionId !== "string"
      || typeof delegation.coordinatorNpub !== "string"
      || typeof delegation.workerNpub !== "string"
      || !Array.isArray(delegation.capabilities)
      || !Array.isArray(delegation.controlRelays)
      || typeof delegation.issuedAt !== "string"
      || typeof delegation.expiresAt !== "string"
    ) {
      return null;
    }
    return delegation;
  } catch {
    return null;
  }
}

function parseWorkerDelegationRevocationDmContent(content: string): WorkerDelegationRevocation | null {
  try {
    const parsed = JSON.parse(content) as Partial<WorkerDelegationRevocationDmEnvelope> | WorkerDelegationRevocation;
    const revocation = (parsed as WorkerDelegationRevocationDmEnvelope).type === "optiona_worker_delegation_revocation_dm"
      ? (parsed as WorkerDelegationRevocationDmEnvelope).revocation
      : parsed as WorkerDelegationRevocation;
    if (
      revocation?.type !== "worker_delegation_revocation"
      || revocation.schemaVersion !== 1
      || typeof revocation.delegationId !== "string"
      || typeof revocation.electionId !== "string"
      || typeof revocation.coordinatorNpub !== "string"
      || typeof revocation.workerNpub !== "string"
      || typeof revocation.revokedAt !== "string"
    ) {
      return null;
    }
    return revocation;
  } catch {
    return null;
  }
}

function parseWorkerElectionConfigDmContent(content: string): WorkerElectionConfigSnapshot | null {
  try {
    const parsed = parseOptionADmEnvelopeContent(content) as Partial<WorkerElectionConfigDmEnvelope> | WorkerElectionConfigSnapshot;
    const snapshot = (parsed as WorkerElectionConfigDmEnvelope).type === "optiona_worker_election_config_dm"
      ? (parsed as WorkerElectionConfigDmEnvelope).snapshot
      : parsed as WorkerElectionConfigSnapshot;
    if (
      snapshot?.type !== "worker_election_config"
      || snapshot.schemaVersion !== 1
      || typeof snapshot.electionId !== "string"
      || typeof snapshot.delegationId !== "string"
      || typeof snapshot.coordinatorNpub !== "string"
      || typeof snapshot.workerNpub !== "string"
      || typeof snapshot.sentAt !== "string"
    ) {
      return null;
    }
    if (
      snapshot.expectedInviteeCount !== undefined
      && (!Number.isFinite(snapshot.expectedInviteeCount) || snapshot.expectedInviteeCount < 0)
    ) {
      return null;
    }
    if (
      snapshot.whitelistNpubs !== undefined
      && (!Array.isArray(snapshot.whitelistNpubs) || snapshot.whitelistNpubs.some((entry) => typeof entry !== "string"))
    ) {
      return null;
    }
    if (
      snapshot.proxyVoterNpubs !== undefined
      && (!Array.isArray(snapshot.proxyVoterNpubs) || snapshot.proxyVoterNpubs.some((entry) => typeof entry !== "string"))
    ) {
      return null;
    }
    if (
      snapshot.ballotGroupsByNpub !== undefined
      && (
        typeof snapshot.ballotGroupsByNpub !== "object"
        || snapshot.ballotGroupsByNpub === null
        || Array.isArray(snapshot.ballotGroupsByNpub)
        || Object.entries(snapshot.ballotGroupsByNpub).some(([npub, group]) => typeof npub !== "string" || typeof group !== "string")
      )
    ) {
      return null;
    }
    if (
      snapshot.bearerInviteCodes !== undefined
      && (!Array.isArray(snapshot.bearerInviteCodes) || snapshot.bearerInviteCodes.some((entry) => (
        typeof entry?.codeHash !== "string"
        || typeof entry?.state !== "string"
      )))
    ) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function optionABlindDmSubject(
  envelope: OptionABlindDmEnvelope,
) {
  switch (envelope.type) {
    case "optiona_blind_request_dm":
      return "Auditable Voting blind request";
    case "optiona_blind_request_bundle_dm":
      return "Auditable Voting blind request bundle";
    case "optiona_blind_issuance_dm":
      return "Auditable Voting blind issuance";
    case "optiona_blind_issuance_bundle_dm":
      return "Auditable Voting blind issuance bundle";
    case "optiona_blind_ballot_plan_dm":
      return "Auditable Voting ballot plan";
    case "optiona_blind_request_ack_dm":
      return "Auditable Voting blind request ack";
    case "optiona_blind_issuance_ack_dm":
      return "Auditable Voting blind issuance ack";
    case "optiona_ballot_submission_dm":
      return "Auditable Voting ballot submission";
    case "optiona_ballot_submission_ack_dm":
      return "Auditable Voting ballot submission ack";
    case "optiona_ballot_acceptance_dm":
      return "Auditable Voting ballot acceptance";
    case "optiona_voter_state_dm":
      return "Auditable Voting voter state";
    case "optiona_coordinator_state_dm":
      return "Auditable Voting organiser state";
    case "optiona_worker_status_dm":
      return "Auditable Voting worker status";
    case "optiona_participant_status_dm":
      return "Auditable Voting participant status";
    case "optiona_worker_delegation_dm":
      return "Auditable Voting worker delegation";
    case "optiona_worker_delegation_revocation_dm":
      return "Auditable Voting worker delegation revocation";
    case "optiona_worker_election_config_dm":
      return "Auditable Voting worker election config";
  }
}

function createRumor(input: {
  senderHex: string;
  recipientHex: string;
  relayUrl?: string;
  subject: string;
  envelope: OptionABlindDmEnvelope;
}) {
  const rumor = {
    kind: KIND_RUMOR_MESSAGE,
    created_at: Math.round(Date.now() / 1000),
    tags: [
      input.relayUrl ? ["p", input.recipientHex, input.relayUrl] : ["p", input.recipientHex],
      ["subject", input.subject],
    ],
    content: encodeOptionADmEnvelopeContent(input.envelope),
    pubkey: input.senderHex,
  };
  return {
    ...rumor,
    id: getEventHash(rumor),
  };
}

function parseGiftWrapPayload(payload: string): NostrEvent | null {
  try {
    const parsed = JSON.parse(payload) as NostrEvent;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.kind !== KIND_SEAL
      || typeof parsed.pubkey !== "string"
      || typeof parsed.content !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getSignerGiftWrapCacheKey(event: NostrEvent) {
  if (typeof event.id === "string" && event.id.trim()) {
    return event.id;
  }
  return [
    typeof event.pubkey === "string" ? event.pubkey : "",
    typeof event.created_at === "number" ? String(event.created_at) : "",
    typeof event.content === "string" ? event.content : "",
  ].join(":");
}

function setSignerGiftWrapDecodeCache(
  key: string,
  value: Promise<{ rumorContent: string; sealPubkey: string } | null>,
) {
  optionABlindDmSignerDecodeCache.delete(key);
  optionABlindDmSignerDecodeCache.set(key, value);
  while (optionABlindDmSignerDecodeCache.size > OPTION_A_BLIND_DM_SIGNER_DECODE_CACHE_LIMIT) {
    const oldestKey = optionABlindDmSignerDecodeCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    optionABlindDmSignerDecodeCache.delete(oldestKey);
  }
}

async function decodeGiftWrapWithSigner(input: {
  signer: SignerService;
  event: NostrEvent;
}) {
  if (!input.signer.nip44Decrypt) {
    return null;
  }
  const wrapPubkey = typeof input.event.pubkey === "string" ? input.event.pubkey : "";
  if (!wrapPubkey || typeof input.event.content !== "string" || !input.event.content.trim()) {
    return null;
  }
  const cacheKey = getSignerGiftWrapCacheKey(input.event);
  const cached = optionABlindDmSignerDecodeCache.get(cacheKey);
  if (cached) {
    setSignerGiftWrapDecodeCache(cacheKey, cached);
    return cached;
  }
  const decodePromise = (async () => {
    const sealPayload = await input.signer.nip44Decrypt!(wrapPubkey, input.event.content);
    const sealEvent = parseGiftWrapPayload(sealPayload);
    if (!sealEvent) {
      return null;
    }
    const rumorPayload = await input.signer.nip44Decrypt!(sealEvent.pubkey, sealEvent.content);
    const rumor = JSON.parse(rumorPayload) as { content?: string };
    if (!rumor || typeof rumor.content !== "string") {
      return null;
    }
    return {
      rumorContent: rumor.content,
      sealPubkey: sealEvent.pubkey,
    };
  })();
  setSignerGiftWrapDecodeCache(cacheKey, decodePromise);
  try {
    const decoded = await decodePromise;
    if (!decoded) {
      optionABlindDmSignerDecodeCache.delete(cacheKey);
    }
    return decoded;
  } catch (error) {
    optionABlindDmSignerDecodeCache.delete(cacheKey);
    throw error;
  }
}

function decodeGiftWrapWithSecretKey(input: {
  secretKey: Uint8Array;
  event: NostrEvent;
}) {
  const wrapPubkey = typeof input.event.pubkey === "string" ? input.event.pubkey : "";
  if (!wrapPubkey || typeof input.event.content !== "string" || !input.event.content.trim()) {
    return null;
  }
  const sealConversationKey = nip44.v2.utils.getConversationKey(input.secretKey, wrapPubkey);
  const sealPayload = nip44.v2.decrypt(input.event.content, sealConversationKey);
  const sealEvent = parseGiftWrapPayload(sealPayload);
  if (!sealEvent) {
    return null;
  }
  const rumorConversationKey = nip44.v2.utils.getConversationKey(input.secretKey, sealEvent.pubkey);
  const rumorPayload = nip44.v2.decrypt(sealEvent.content, rumorConversationKey);
  const rumor = JSON.parse(rumorPayload) as { content?: string };
  if (!rumor || typeof rumor.content !== "string") {
    return null;
  }
  return {
    rumorContent: rumor.content,
    sealPubkey: sealEvent.pubkey,
  };
}

async function pageContainsSignerDm<T>(input: {
  pageEvents: NostrEvent[];
  signer: SignerService;
  parse: (content: string) => T | T[] | null;
  matches: (entry: T) => boolean;
}) {
  for (const event of input.pageEvents) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const parsed = input.parse(decoded.rumorContent);
      const values = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      if (values.some((entry) => input.matches(entry))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function pageContainsSecretKeyDm<T>(input: {
  pageEvents: NostrEvent[];
  secretKey: Uint8Array;
  parse: (content: string) => T | T[] | null;
  matches: (entry: T) => boolean;
}) {
  for (const event of input.pageEvents) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({
        secretKey: input.secretKey,
        event,
      });
      if (!decoded) {
        continue;
      }
      const parsed = input.parse(decoded.rumorContent);
      const values = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      if (values.some((entry) => input.matches(entry))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function createSignerGiftWrapSubscription<T>(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  stage: string;
  parse: (content: string) => T | T[] | null;
  keyOf: (value: T) => string;
  onValue: (value: T) => void;
  onError?: (error: Error) => void;
  validate?: (value: T, decoded: { rumorContent: string; sealPubkey: string }) => boolean;
}) {
  if (!input.signer.nip44Decrypt) {
    return () => undefined;
  }
  let closed = false;
  let detachSharedInbox: (() => void) | null = null;
  const seenKeys = new Set<string>();

  const close = () => {
    closed = true;
    if (detachSharedInbox) {
      detachSharedInbox();
      detachSharedInbox = null;
    }
  };

  const handleEvent = async (event: NostrEvent) => {
    if (closed) {
      return;
    }
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        return;
      }
      const parsed = input.parse(decoded.rumorContent);
      const values = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      if (values.length === 0) {
        return;
      }
      const electionId = input.electionId?.trim();
      for (const value of values) {
        if (electionId && typeof (value as { electionId?: string }).electionId === "string" && (value as { electionId: string }).electionId !== electionId) {
          continue;
        }
        if (input.validate && !input.validate(value, decoded)) {
          continue;
        }
        const key = input.keyOf(value);
        if (!key || seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        optionABlindDmLog(`${input.stage}_event`, { key });
        input.onValue(value);
      }
    } catch (error) {
      if (error instanceof Error) {
        input.onError?.(error);
      }
    }
  };

  void (async () => {
    try {
      const recipientRaw = await input.signer.getPublicKey();
      const recipientNpub = toNpub(recipientRaw);
      const recipientHex = toHexPubkey(recipientRaw);
      const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
      if (closed) {
        return;
      }
      optionABlindDmLog(`${input.stage}_listener_attached`, {
        recipientNpub,
        relayCount: relays.length,
      });
      detachSharedInbox = await attachSharedGiftWrapInbox({
        recipientNpub,
        recipientHex,
        relays,
        listener: {
          id: `${input.stage}:${recipientHex}:${crypto.randomUUID()}`,
          onEvent: (event) => {
            void handleEvent(event);
          },
          onError: input.onError,
        },
      });
      if (closed) {
        detachSharedInbox();
        detachSharedInbox = null;
      }
    } catch (error) {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    }
  })();

  return close;
}

function createSecretKeyGiftWrapSubscription<T>(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  stage: string;
  parse: (content: string) => T | T[] | null;
  keyOf: (value: T) => string;
  onValue: (value: T) => void;
  onError?: (error: Error) => void;
  validate?: (value: T, decoded: { rumorContent: string; sealPubkey: string }) => boolean;
}) {
  let secretKey: Uint8Array;
  try {
    secretKey = decodeNsecSecretKey(input.nsec);
  } catch (error) {
    if (error instanceof Error) {
      input.onError?.(error);
    }
    return () => undefined;
  }
  const recipientHex = getPublicKey(secretKey);
  const recipientNpub = nip19.npubEncode(recipientHex);
  let closed = false;
  let detachSharedInbox: (() => void) | null = null;
  const seenKeys = new Set<string>();

  const close = () => {
    closed = true;
    if (detachSharedInbox) {
      detachSharedInbox();
      detachSharedInbox = null;
    }
  };

  const handleEvent = (event: NostrEvent) => {
    if (closed) {
      return;
    }
    try {
      const decoded = decodeGiftWrapWithSecretKey({
        secretKey,
        event,
      });
      if (!decoded) {
        return;
      }
      const parsed = input.parse(decoded.rumorContent);
      const values = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      if (values.length === 0) {
        return;
      }
      const electionId = input.electionId?.trim();
      for (const value of values) {
        if (electionId && typeof (value as { electionId?: string }).electionId === "string" && (value as { electionId: string }).electionId !== electionId) {
          continue;
        }
        if (input.validate && !input.validate(value, decoded)) {
          continue;
        }
        const key = input.keyOf(value);
        if (!key || seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        optionABlindDmLog(`${input.stage}_event`, { key });
        input.onValue(value);
      }
    } catch (error) {
      if (error instanceof Error) {
        input.onError?.(error);
      }
    }
  };

  void (async () => {
    try {
      const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
      if (closed) {
        return;
      }
      optionABlindDmLog(`${input.stage}_listener_attached`, {
        recipientNpub,
        relayCount: relays.length,
      });
      detachSharedInbox = await attachSharedGiftWrapInbox({
        recipientNpub,
        recipientHex,
        relays,
        listener: {
          id: `${input.stage}:${recipientHex}:${crypto.randomUUID()}`,
          onEvent: handleEvent,
          onError: input.onError,
        },
      });
      if (closed) {
        detachSharedInbox();
        detachSharedInbox = null;
      }
    } catch (error) {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    }
  })();

  return close;
}

async function publishEnvelope(input: {
  signer: SignerService;
  recipientNpub: string;
  envelope: OptionABlindDmEnvelope;
  fallbackNsec?: string;
  relays?: string[];
  channel: string;
}) {
  const recipientHex = toHexPubkey(input.recipientNpub);
  const relays = await resolveRecipientPublishRelays(recipientHex, buildRelays(input.relays));
  optionABlindDmLog("publish_started", {
    channel: input.channel,
    recipientNpub: input.recipientNpub,
    relayCount: relays.length,
  });
  let senderHex = "";
  let signedSeal: NostrEvent | null = null;
  const fallbackSecret = input.fallbackNsec?.trim() ? decodeNsecSecretKey(input.fallbackNsec) : null;
  const trySignerFirst = !fallbackSecret;
  const signerAttempts: Array<"signer" | "fallback"> = trySignerFirst ? ["signer", "fallback"] : ["fallback", "signer"];
  let lastError: unknown = null;

  for (const attempt of signerAttempts) {
    try {
      if (attempt === "fallback") {
        if (!fallbackSecret) {
          continue;
        }
        senderHex = getPublicKey(fallbackSecret);
        const rumor = createRumor({
          senderHex,
          recipientHex,
          relayUrl: relays[0],
          subject: optionABlindDmSubject(input.envelope),
          envelope: input.envelope,
        });
        const sealConversationKey = nip44.v2.utils.getConversationKey(fallbackSecret, recipientHex);
        const sealCiphertext = nip44.v2.encrypt(JSON.stringify(rumor), sealConversationKey);
        signedSeal = finalizeEvent({
          kind: KIND_SEAL,
          created_at: randomNow(),
          tags: [],
          content: sealCiphertext,
        }, fallbackSecret);
        break;
      }

      if (!input.signer.nip44Encrypt) {
        throw new Error("Signer does not support NIP-44 encryption.");
      }
      const senderRaw = await input.signer.getPublicKey();
      senderHex = toHexPubkey(senderRaw);
      const rumor = createRumor({
        senderHex,
        recipientHex,
        relayUrl: relays[0],
        subject: optionABlindDmSubject(input.envelope),
        envelope: input.envelope,
      });
      const sealCiphertext = await input.signer.nip44Encrypt(recipientHex, JSON.stringify(rumor));
      const signed = await input.signer.signEvent({
        kind: KIND_SEAL,
        created_at: randomNow(),
        tags: [],
        content: sealCiphertext,
      });
      signedSeal = signed as unknown as NostrEvent;
      break;
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (!senderHex || !signedSeal) {
    throw lastError instanceof Error ? lastError : new Error("Could not sign Option A blind DM.");
  }

  const giftWrapSecret = generateSecretKey();
  const giftWrapConversationKey = nip44.v2.utils.getConversationKey(giftWrapSecret, recipientHex);
  const wrappedSeal = nip44.v2.encrypt(JSON.stringify(signedSeal), giftWrapConversationKey);
  const giftWrapEvent = finalizeEvent({
    kind: KIND_GIFT_WRAP,
    created_at: randomNow(),
    tags: [["p", recipientHex]],
    content: wrappedSeal,
  }, giftWrapSecret);

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], giftWrapEvent, { maxWait: OPTION_A_BLIND_DM_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: OPTION_A_BLIND_DM_STAGGER_MS },
    ),
    {
      channel: input.channel,
      minIntervalMs: OPTION_A_BLIND_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );

  const relayResults = results.map((result, index) => mapRelayPublishResult(result, relays[index]));
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }
  optionABlindDmLog("publish_finished", {
    channel: input.channel,
    recipientNpub: input.recipientNpub,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
  });
  return {
    eventId: giftWrapEvent.id,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    relayResults,
  };
}

export async function publishOptionABlindRequestDm(input: {
  signer: SignerService;
  recipientNpub: string;
  request: BlindBallotRequest;
  fallbackNsec?: string;
  relays?: string[];
}) {
  const request = sanitiseBlindBallotRequest(input.request);
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-request:${request.electionId}:${request.requestId}`,
    envelope: {
      type: "optiona_blind_request_dm",
      schemaVersion: 1,
      request,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABlindRequestBundleDm(input: {
  signer: SignerService;
  recipientNpub: string;
  requests: BlindBallotRequest[];
  fallbackNsec?: string;
  relays?: string[];
}) {
  const first = input.requests[0];
  if (!first) {
    throw new Error("Blind request bundle is empty.");
  }
  const requests = input.requests.map((request) => sanitiseBlindBallotRequest(request));
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-request-bundle:${requests[0]!.electionId}:${requests[0]!.invitedNpub}:${requests.length}`,
    envelope: {
      type: "optiona_blind_request_bundle_dm",
      schemaVersion: 1,
      requests,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABlindIssuanceDm(input: {
  signer: SignerService;
  recipientNpub: string;
  issuance: BlindBallotIssuance;
  fallbackNsec?: string;
  relays?: string[];
}) {
  const inputIssuance = sanitiseBlindBallotIssuance(input.issuance);
  const legacyDefinition = inputIssuance.definition ?? null;
  const issuance = {
    ...inputIssuance,
    definition: undefined,
    definitionHash: inputIssuance.definitionHash ?? (legacyDefinition ? questionnaireDefinitionHash(legacyDefinition) : null),
    definitionEventId: inputIssuance.definitionEventId ?? null,
  };
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-issuance:${issuance.electionId}:${issuance.requestId}`,
    envelope: {
      type: "optiona_blind_issuance_dm",
      schemaVersion: 1,
      issuance,
      sentAt: new Date().toISOString(),
    },
  });
}

export function buildOptionABlindIssuanceBundleEnvelope(input: {
  issuances: BlindBallotIssuance[];
  definition?: QuestionnaireDefinition | null;
  definitionHash?: string | null;
  definitionEventId?: string | null;
  sentAt?: string;
}): BlindIssuanceBundleDmEnvelope {
  const inputIssuances = input.issuances.map((issuance) => sanitiseBlindBallotIssuance(issuance));
  const sharedDefinition = input.definition ?? inputIssuances.find((issuance) => issuance.definition)?.definition ?? null;
  const definitionHash = input.definitionHash
    ?? inputIssuances.find((issuance) => issuance.definitionHash)?.definitionHash
    ?? (sharedDefinition ? questionnaireDefinitionHash(sharedDefinition) : null);
  const definitionEventId = input.definitionEventId
    ?? inputIssuances.find((issuance) => issuance.definitionEventId)?.definitionEventId
    ?? null;
  const bundledIssuances = sharedDefinition
    ? inputIssuances.map((issuance) => ({
      ...issuance,
      definition: undefined,
      definitionHash: issuance.definitionHash ?? definitionHash,
      definitionEventId: issuance.definitionEventId ?? definitionEventId,
    }))
    : inputIssuances.map((issuance) => ({
      ...issuance,
      definitionHash: issuance.definitionHash ?? definitionHash,
      definitionEventId: issuance.definitionEventId ?? definitionEventId,
    }));
  return {
    type: "optiona_blind_issuance_bundle_dm",
    schemaVersion: 1,
    definitionHash,
    definitionEventId,
    issuances: bundledIssuances,
    sentAt: input.sentAt ?? new Date().toISOString(),
  };
}

export async function publishOptionABlindIssuanceBundleDm(input: {
  signer: SignerService;
  recipientNpub: string;
  issuances: BlindBallotIssuance[];
  definition?: QuestionnaireDefinition | null;
  definitionHash?: string | null;
  definitionEventId?: string | null;
  fallbackNsec?: string;
  relays?: string[];
}) {
  const issuances = input.issuances.map((issuance) => sanitiseBlindBallotIssuance(issuance));
  const first = issuances[0];
  if (!first) {
    throw new Error("Blind issuance bundle is empty.");
  }
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-issuance-bundle:${first.electionId}:${first.invitedNpub}:${issuances.length}`,
    envelope: buildOptionABlindIssuanceBundleEnvelope({
      issuances,
      definition: input.definition,
      definitionHash: input.definitionHash,
      definitionEventId: input.definitionEventId,
    }),
  });
}

export async function publishOptionABlindRequestAckDm(input: {
  signer: SignerService;
  recipientNpub: string;
  ack: BlindRequestAck;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-request-ack:${input.ack.electionId}:${input.ack.requestId}`,
    envelope: {
      type: "optiona_blind_request_ack_dm",
      schemaVersion: 1,
      ack: input.ack,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABallotSubmissionDm(input: {
  signer: SignerService;
  recipientNpub: string;
  submission: BallotSubmission;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-ballot-submission:${input.submission.electionId}:${input.submission.submissionId}`,
    envelope: {
      type: "optiona_ballot_submission_dm",
      schemaVersion: 1,
      submission: input.submission,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABallotSubmissionAckDm(input: {
  signer: SignerService;
  recipientNpub: string;
  ack: BallotSubmissionAck;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-ballot-submission-ack:${input.ack.electionId}:${input.ack.submissionId}`,
    envelope: {
      type: "optiona_ballot_submission_ack_dm",
      schemaVersion: 1,
      ack: input.ack,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABallotAcceptanceDm(input: {
  signer: SignerService;
  recipientNpub: string;
  acceptance: BallotAcceptanceResult;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-ballot-acceptance:${input.acceptance.electionId}:${input.acceptance.submissionId}`,
    envelope: {
      type: "optiona_ballot_acceptance_dm",
      schemaVersion: 1,
      acceptance: input.acceptance,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABlindIssuanceAckDm(input: {
  signer: SignerService;
  recipientNpub: string;
  ack: BlindIssuanceAck;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-issuance-ack:${input.ack.electionId}:${input.ack.requestId}`,
    envelope: {
      type: "optiona_blind_issuance_ack_dm",
      schemaVersion: 1,
      ack: input.ack,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAVoterStateDm(input: {
  signer: SignerService;
  recipientNpub: string;
  snapshot: OptionAVoterStateSnapshot;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-voter-state:${input.snapshot.electionId}:${input.snapshot.invitedNpub}`,
    envelope: {
      type: "optiona_voter_state_dm",
      schemaVersion: 1,
      snapshot: input.snapshot,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionACoordinatorStateDm(input: {
  signer: SignerService;
  recipientNpub: string;
  snapshot: OptionACoordinatorStateSnapshot;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-coordinator-state:${input.snapshot.electionId}:${input.snapshot.coordinatorNpub}`,
    envelope: {
      type: "optiona_coordinator_state_dm",
      schemaVersion: 1,
      snapshot: input.snapshot,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAWorkerStatusDm(input: {
  signer: SignerService;
  recipientNpub: string;
  snapshot: WorkerStatusSnapshot;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-worker-status:${input.snapshot.workerNpub}:${input.snapshot.coordinatorNpub}`,
    envelope: {
      type: "optiona_worker_status_dm",
      schemaVersion: 1,
      snapshot: input.snapshot,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAParticipantStatusDm(input: {
  signer: SignerService;
  recipientNpub: string;
  status: OptionAParticipantStatus;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-participant-status:${input.status.electionId}:${input.status.invitedNpub}:${input.status.state}`,
    envelope: {
      type: "optiona_participant_status_dm",
      schemaVersion: 1,
      status: input.status,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAWorkerDelegationDm(input: {
  signer: SignerService;
  recipientNpub: string;
  delegation: WorkerDelegationCertificate;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-worker-delegation:${input.delegation.electionId}:${input.delegation.delegationId}`,
    envelope: {
      type: "optiona_worker_delegation_dm",
      schemaVersion: 1,
      delegation: input.delegation,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAWorkerDelegationRevocationDm(input: {
  signer: SignerService;
  recipientNpub: string;
  revocation: WorkerDelegationRevocation;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-worker-revocation:${input.revocation.electionId}:${input.revocation.delegationId}`,
    envelope: {
      type: "optiona_worker_delegation_revocation_dm",
      schemaVersion: 1,
      revocation: input.revocation,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionAWorkerElectionConfigDm(input: {
  signer: SignerService;
  recipientNpub: string;
  snapshot: WorkerElectionConfigSnapshot;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-worker-election-config:${input.snapshot.electionId}:${input.snapshot.delegationId}`,
    envelope: {
      type: "optiona_worker_election_config_dm",
      schemaVersion: 1,
      snapshot: input.snapshot,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABlindBallotPlanDm(input: {
  signer: SignerService;
  recipientNpub: string;
  plan: BlindBallotPlan;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-ballot-plan:${input.plan.electionId}:${input.plan.initialRequestId}`,
    envelope: { type: "optiona_blind_ballot_plan_dm", schemaVersion: 1, plan: input.plan, sentAt: new Date().toISOString() },
  });
}

export async function fetchOptionABlindRequestDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  diagnosticsSink?: (diagnostics: OptionABlindRequestFetchDiagnostics) => void;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindBallotRequest[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  optionABlindDmLog("fetch_blind_requests_started", {
    recipientNpub,
    relayCount: relays.length,
  });
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? input.limit ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const since = input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS;
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });

  const rejectReasons: Record<string, number> = {};
  const unique = new Map<string, BlindBallotRequest>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        incrementReason(rejectReasons, "decode_failed");
        continue;
      }
      const requests = parseBlindRequestDmContent(decoded.rumorContent);
      if (!requests?.length) {
        incrementReason(rejectReasons, "parse_failed");
        continue;
      }
      for (const request of requests) {
        if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
          incrementReason(rejectReasons, "election_mismatch");
          continue;
        }
        if (toNpub(decoded.sealPubkey) !== request.invitedNpub) {
          incrementReason(rejectReasons, "sender_mismatch");
          continue;
        }
        const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
        if (!unique.has(key)) {
          unique.set(key, request);
        } else {
          incrementReason(rejectReasons, "duplicate");
        }
      }
    } catch {
      incrementReason(rejectReasons, "decrypt_failed");
      continue;
    }
  }
  const values = [...unique.values()];
  input.diagnosticsSink?.({
    relayCount: relays.length,
    scannedCount: sorted.length,
    parsedCount: values.length,
    dedupedCount: Math.max(0, sorted.length - values.length),
    rejectReasons,
    since,
  });
  optionABlindDmLog("fetch_blind_requests_finished", {
    recipientNpub,
    resultCount: values.length,
  });
  return values;
}

export async function fetchOptionABlindRequestDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  diagnosticsSink?: (diagnostics: OptionABlindRequestFetchDiagnostics) => void;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });

  const rejectReasons: Record<string, number> = {};
  const unique = new Map<string, BlindBallotRequest>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        incrementReason(rejectReasons, "decode_failed");
        continue;
      }
      const requests = parseBlindRequestDmContent(decoded.rumorContent);
      if (!requests?.length) {
        incrementReason(rejectReasons, "parse_failed");
        continue;
      }
      for (const request of requests) {
        if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
          incrementReason(rejectReasons, "election_mismatch");
          continue;
        }
        if (toNpub(decoded.sealPubkey) !== request.invitedNpub) {
          incrementReason(rejectReasons, "sender_mismatch");
          continue;
        }
        const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
        if (!unique.has(key)) {
          unique.set(key, request);
        } else {
          incrementReason(rejectReasons, "duplicate");
        }
      }
    } catch {
      incrementReason(rejectReasons, "decrypt_failed");
      continue;
    }
  }
  const values = [...unique.values()];
  input.diagnosticsSink?.({
    relayCount: relays.length,
    scannedCount: sorted.length,
    parsedCount: values.length,
    dedupedCount: Math.max(0, sorted.length - values.length),
    rejectReasons,
    since: input.since,
  });
  return values;
}

export async function fetchOptionABlindIssuanceDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetRequestId?: string;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindBallotIssuance[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const targetRequestId = input.targetRequestId?.trim() ?? "";
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetRequestId
      ? (pageEvents) => pageContainsSignerDm({
        pageEvents,
        signer: input.signer,
        parse: parseBlindIssuanceDmContent,
        matches: (issuance) => (
          issuance.requestId === targetRequestId
          && (!input.electionId?.trim() || issuance.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });

  const unique = new Map<string, BlindBallotIssuance>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const issuances = parseBlindIssuanceDmContent(decoded.rumorContent);
      if (!issuances?.length) {
        continue;
      }
      for (const issuance of issuances) {
        if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
          continue;
        }
        const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
        if (!unique.has(key)) {
          unique.set(key, issuance);
        }
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindIssuanceDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetRequestId?: string;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const targetRequestId = input.targetRequestId?.trim() ?? "";
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetRequestId
      ? (pageEvents) => pageContainsSecretKeyDm({
        pageEvents,
        secretKey,
        parse: parseBlindIssuanceDmContent,
        matches: (issuance) => (
          issuance.requestId === targetRequestId
          && (!input.electionId?.trim() || issuance.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });

  const unique = new Map<string, BlindBallotIssuance>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const issuances = parseBlindIssuanceDmContent(decoded.rumorContent);
      if (!issuances?.length) {
        continue;
      }
      for (const issuance of issuances) {
        if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
          continue;
        }
        const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
        if (!unique.has(key)) {
          unique.set(key, issuance);
        }
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABallotSubmissionDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BallotSubmission[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  optionABlindDmLog("fetch_submissions_started", {
    recipientNpub,
    relayCount: relays.length,
  });
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? input.limit ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  });

  const unique = new Map<string, BallotSubmission>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const submission = parseBallotSubmissionDmContent(decoded.rumorContent);
      if (!submission) {
        continue;
      }
      const claimedResponseNpub = submission.responseNpub ?? submission.invitedNpub;
      if (claimedResponseNpub && toNpub(decoded.sealPubkey) !== claimedResponseNpub) {
        continue;
      }
      if (input.electionId?.trim() && submission.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${submission.electionId}:${submission.submissionId}:${submission.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, submission);
      }
    } catch {
      continue;
    }
  }
  const values = [...unique.values()];
  optionABlindDmLog("fetch_submissions_finished", {
    recipientNpub,
    resultCount: values.length,
  });
  return values;
}

export async function fetchOptionABallotSubmissionDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BallotSubmission>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const submission = parseBallotSubmissionDmContent(decoded.rumorContent);
      if (!submission) {
        continue;
      }
      const claimedResponseNpub = submission.responseNpub ?? submission.invitedNpub;
      if (claimedResponseNpub && decoded.sealPubkey && toNpub(decoded.sealPubkey) !== claimedResponseNpub) {
        continue;
      }
      if (input.electionId?.trim() && submission.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${submission.electionId}:${submission.submissionId}:${submission.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, submission);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABallotAcceptanceDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetSubmissionId?: string;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BallotAcceptanceResult[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  optionABlindDmLog("fetch_acceptances_started", {
    recipientNpub,
    relayCount: relays.length,
  });
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const targetSubmissionId = input.targetSubmissionId?.trim() ?? "";
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetSubmissionId
      ? (pageEvents) => pageContainsSignerDm({
        pageEvents,
        signer: input.signer,
        parse: parseBallotAcceptanceDmContent,
        matches: (acceptance) => (
          acceptance.submissionId === targetSubmissionId
          && (!input.electionId?.trim() || acceptance.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });

  const unique = new Map<string, BallotAcceptanceResult>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const acceptance = parseBallotAcceptanceDmContent(decoded.rumorContent);
      if (!acceptance) {
        continue;
      }
      if (input.electionId?.trim() && acceptance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${acceptance.electionId}:${acceptance.submissionId}`;
      if (!unique.has(key)) {
        unique.set(key, acceptance);
      }
    } catch {
      continue;
    }
  }
  const values = [...unique.values()];
  optionABlindDmLog("fetch_acceptances_finished", {
    recipientNpub,
    resultCount: values.length,
  });
  return values;
}

export async function fetchOptionABallotAcceptanceDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetSubmissionId?: string;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const targetSubmissionId = input.targetSubmissionId?.trim() ?? "";
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetSubmissionId
      ? (pageEvents) => pageContainsSecretKeyDm({
        pageEvents,
        secretKey,
        parse: parseBallotAcceptanceDmContent,
        matches: (acceptance) => (
          acceptance.submissionId === targetSubmissionId
          && (!input.electionId?.trim() || acceptance.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });

  const unique = new Map<string, BallotAcceptanceResult>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const acceptance = parseBallotAcceptanceDmContent(decoded.rumorContent);
      if (!acceptance) {
        continue;
      }
      if (input.electionId?.trim() && acceptance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${acceptance.electionId}:${acceptance.submissionId}`;
      if (!unique.has(key)) {
        unique.set(key, acceptance);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindIssuanceAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindIssuanceAck[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });

  const unique = new Map<string, BlindIssuanceAck>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const ack = parseBlindIssuanceAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.requestId}:${ack.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindIssuanceAckDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });

  const unique = new Map<string, BlindIssuanceAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const ack = parseBlindIssuanceAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.requestId}:${ack.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindRequestAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetRequestId?: string;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindRequestAck[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const targetRequestId = input.targetRequestId?.trim() ?? "";
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetRequestId
      ? (pageEvents) => pageContainsSignerDm({
        pageEvents,
        signer: input.signer,
        parse: parseBlindRequestAckDmContent,
        matches: (ack) => (
          ack.requestId === targetRequestId
          && (!input.electionId?.trim() || ack.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });
  const unique = new Map<string, BlindRequestAck>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const ack = parseBlindRequestAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.requestId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindRequestAckDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetRequestId?: string;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const targetRequestId = input.targetRequestId?.trim() ?? "";
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetRequestId
      ? (pageEvents) => pageContainsSecretKeyDm({
        pageEvents,
        secretKey,
        parse: parseBlindRequestAckDmContent,
        matches: (ack) => (
          ack.requestId === targetRequestId
          && (!input.electionId?.trim() || ack.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });
  const unique = new Map<string, BlindRequestAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const ack = parseBlindRequestAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.requestId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABallotSubmissionAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetSubmissionId?: string;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BallotSubmissionAck[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const targetSubmissionId = input.targetSubmissionId?.trim() ?? "";
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetSubmissionId
      ? (pageEvents) => pageContainsSignerDm({
        pageEvents,
        signer: input.signer,
        parse: parseBallotSubmissionAckDmContent,
        matches: (ack) => (
          ack.submissionId === targetSubmissionId
          && (!input.electionId?.trim() || ack.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });
  const unique = new Map<string, BallotSubmissionAck>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const ack = parseBallotSubmissionAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.submissionId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABallotSubmissionAckDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  targetSubmissionId?: string;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const targetSubmissionId = input.targetSubmissionId?.trim() ?? "";
  const events = await queryBlindDmSyncPaginated(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    stopAfterPage: targetSubmissionId
      ? (pageEvents) => pageContainsSecretKeyDm({
        pageEvents,
        secretKey,
        parse: parseBallotSubmissionAckDmContent,
        matches: (ack) => (
          ack.submissionId === targetSubmissionId
          && (!input.electionId?.trim() || ack.electionId === input.electionId.trim())
        ),
      })
      : undefined,
  });
  const unique = new Map<string, BallotSubmissionAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const ack = parseBallotSubmissionAckDmContent(decoded.rumorContent);
      if (!ack) {
        continue;
      }
      if (input.electionId?.trim() && ack.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${ack.electionId}:${ack.submissionId}`;
      if (!unique.has(key)) {
        unique.set(key, ack);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAVoterStateDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as OptionAVoterStateSnapshot[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  });
  const unique = new Map<string, OptionAVoterStateSnapshot>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const snapshot = parseVoterStateDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (input.electionId?.trim() && snapshot.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${snapshot.electionId}:${snapshot.invitedNpub}:${snapshot.lastUpdatedAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAVoterStateDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, OptionAVoterStateSnapshot>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const snapshot = parseVoterStateDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (input.electionId?.trim() && snapshot.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${snapshot.electionId}:${snapshot.invitedNpub}:${snapshot.lastUpdatedAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionACoordinatorStateDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as OptionACoordinatorStateSnapshot[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  });
  const unique = new Map<string, OptionACoordinatorStateSnapshot>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({
        signer: input.signer,
        event,
      });
      if (!decoded) {
        continue;
      }
      const snapshot = parseCoordinatorStateDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (input.electionId?.trim() && snapshot.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${snapshot.electionId}:${snapshot.coordinatorNpub}:${snapshot.lastUpdatedAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionACoordinatorStateDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, OptionACoordinatorStateSnapshot>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const snapshot = parseCoordinatorStateDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (input.electionId?.trim() && snapshot.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${snapshot.electionId}:${snapshot.coordinatorNpub}:${snapshot.lastUpdatedAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAParticipantStatusDms(input: {
  signer: SignerService;
  electionId?: string;
  workerNpub?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as OptionAParticipantStatus[];
  }
  const recipientHex = toHexPubkey(await input.signer.getPublicKey());
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? input.limit ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });
  const electionFilter = input.electionId?.trim() ?? "";
  const unique = new Map<string, OptionAParticipantStatus>();
  for (const event of events.slice(0, maxDecryptAttempts)) {
    try {
      const decoded = await decodeGiftWrapWithSigner({ signer: input.signer, event });
      if (!decoded) {
        continue;
      }
      const status = parseOptionAParticipantStatusDmContent(decoded.rumorContent);
      if (
        !status
        || (electionFilter && status.electionId !== electionFilter)
        || !isAuthenticatedParticipantStatusSender(status, decoded.sealPubkey, input.workerNpub)
      ) {
        continue;
      }
      const key = `${status.electionId}:${status.invitedNpub}:${status.source}:${status.state}:${status.observedAt}`;
      if (!unique.has(key)) {
        unique.set(key, status);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAParticipantStatusDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  workerNpub?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  pageLimit?: number;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const { events } = await queryBlindDmSyncWithFallbackPaginated(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  }, {
    pageLimit: input.pageLimit,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
  });
  const electionFilter = input.electionId?.trim() ?? "";
  const unique = new Map<string, OptionAParticipantStatus>();
  for (const event of events) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const status = parseOptionAParticipantStatusDmContent(decoded.rumorContent);
      if (
        !status
        || (electionFilter && status.electionId !== electionFilter)
        || !isAuthenticatedParticipantStatusSender(status, decoded.sealPubkey, input.workerNpub)
      ) {
        continue;
      }
      const key = `${status.electionId}:${status.invitedNpub}:${status.source}:${status.state}:${status.observedAt}`;
      if (!unique.has(key)) {
        unique.set(key, status);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAWorkerStatusDms(input: {
  signer: SignerService;
  coordinatorNpub?: string;
  workerNpub?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as WorkerStatusSnapshot[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
  });
  const coordinatorFilter = input.coordinatorNpub?.trim() ?? "";
  const workerFilter = input.workerNpub?.trim() ?? "";
  const unique = new Map<string, WorkerStatusSnapshot>();
  const sorted = [...events]
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
    .slice(0, maxDecryptAttempts);
  for (const event of sorted) {
    try {
      const decoded = await decodeGiftWrapWithSigner({ signer: input.signer, event });
      if (!decoded) {
        continue;
      }
      const snapshot = parseWorkerStatusDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (coordinatorFilter && snapshot.coordinatorNpub !== coordinatorFilter) {
        continue;
      }
      if (workerFilter && snapshot.workerNpub !== workerFilter) {
        continue;
      }
      const key = `${snapshot.workerNpub}:${snapshot.coordinatorNpub}:${snapshot.heartbeatAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAWorkerStatusDmsWithNsec(input: {
  nsec: string;
  coordinatorNpub?: string;
  workerNpub?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });
  const coordinatorFilter = input.coordinatorNpub?.trim() ?? "";
  const workerFilter = input.workerNpub?.trim() ?? "";
  const unique = new Map<string, WorkerStatusSnapshot>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const snapshot = parseWorkerStatusDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (coordinatorFilter && snapshot.coordinatorNpub !== coordinatorFilter) {
        continue;
      }
      if (workerFilter && snapshot.workerNpub !== workerFilter) {
        continue;
      }
      const key = `${snapshot.workerNpub}:${snapshot.coordinatorNpub}:${snapshot.heartbeatAt}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAWorkerDelegationDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, WorkerDelegationCertificate>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const delegation = parseWorkerDelegationDmContent(decoded.rumorContent);
      if (!delegation) {
        continue;
      }
      if (input.electionId?.trim() && delegation.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${delegation.electionId}:${delegation.delegationId}`;
      if (!unique.has(key)) {
        unique.set(key, delegation);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAWorkerDelegationRevocationDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, WorkerDelegationRevocation>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const revocation = parseWorkerDelegationRevocationDmContent(decoded.rumorContent);
      if (!revocation) {
        continue;
      }
      if (input.electionId?.trim() && revocation.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${revocation.electionId}:${revocation.delegationId}:${revocation.revokedAt}`;
      if (!unique.has(key)) {
        unique.set(key, revocation);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionAWorkerElectionConfigDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since,
    limit: Math.max(1, input.limit ?? 200),
  });
  const unique = new Map<string, WorkerElectionConfigSnapshot>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const decoded = decodeGiftWrapWithSecretKey({ secretKey, event });
      if (!decoded) {
        continue;
      }
      const snapshot = parseWorkerElectionConfigDmContent(decoded.rumorContent);
      if (!snapshot) {
        continue;
      }
      if (input.electionId?.trim() && snapshot.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${snapshot.electionId}:${snapshot.delegationId}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function confirmOptionADmEventCopies(input: {
  eventId: string;
  relays: string[];
  minCopies?: number;
}) {
  const eventId = input.eventId.trim();
  if (!eventId) {
    return {
      eventId: "",
      confirmedCopies: 0,
      confirmedRelays: [],
      checkedRelays: [],
    } satisfies OptionADmEventCopyCheckResult;
  }
  const minCopies = Math.max(1, input.minCopies ?? 2);
  const checkedRelays = filterBlindDmReadRelays(normalizeRelaysRust(input.relays))
    .slice(0, OPTION_A_DM_EXISTENCE_CHECK_MAX_RELAYS);
  const confirmedRelays: string[] = [];
  for (const relay of checkedRelays) {
    try {
      const events = await queryBlindDmSync([relay], {
        ids: [eventId],
        kinds: [KIND_GIFT_WRAP],
        limit: 1,
      });
      if (events.some((event) => event.id === eventId)) {
        confirmedRelays.push(relay);
        if (confirmedRelays.length >= minCopies) {
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return {
    eventId,
    confirmedCopies: confirmedRelays.length,
    confirmedRelays,
    checkedRelays,
  } satisfies OptionADmEventCopyCheckResult;
}

export function subscribeOptionABlindRequestDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onRequest: (request: BlindBallotRequest) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BlindBallotRequest>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_blind_requests",
    parse: parseBlindRequestDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}:${value.invitedNpub}`,
    onValue: input.onRequest,
    onError: input.onError,
  });
}

export function subscribeOptionABlindIssuanceDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onIssuance: (issuance: BlindBallotIssuance) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BlindBallotIssuance>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_issuances",
    parse: parseBlindIssuanceDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}:${value.issuanceId}`,
    onValue: input.onIssuance,
    onError: input.onError,
  });
}

export function subscribeOptionABlindIssuanceDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  onIssuance: (issuance: BlindBallotIssuance) => void;
  onError?: (error: Error) => void;
}) {
  return createSecretKeyGiftWrapSubscription<BlindBallotIssuance>({
    nsec: input.nsec,
    electionId: input.electionId,
    relays: input.relays,
    stage: "subscribe_issuances_nsec",
    parse: parseBlindIssuanceDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}:${value.issuanceId}`,
    onValue: input.onIssuance,
    onError: input.onError,
  });
}

export function subscribeOptionABlindBallotPlanDms(input: {
  signer: SignerService;
  electionId?: string;
  issuerNpub: string;
  relays?: string[];
  since?: number;
  onPlan: (plan: BlindBallotPlan) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BlindBallotPlan>({
    signer: input.signer, electionId: input.electionId, relays: input.relays, since: input.since,
    stage: "subscribe_blind_ballot_plans", parse: parseBlindBallotPlanDmContent,
    keyOf: (plan) => `${plan.electionId}:${plan.planId}`,
    validate: (plan, decoded) => toNpub(decoded.sealPubkey) === toNpub(input.issuerNpub) && plan.issuerNpub === toNpub(input.issuerNpub),
    onValue: input.onPlan, onError: input.onError,
  });
}

export function subscribeOptionABlindBallotPlanDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  issuerNpub: string;
  relays?: string[];
  onPlan: (plan: BlindBallotPlan) => void;
  onError?: (error: Error) => void;
}) {
  return createSecretKeyGiftWrapSubscription<BlindBallotPlan>({
    nsec: input.nsec, electionId: input.electionId, relays: input.relays,
    stage: "subscribe_blind_ballot_plans_nsec", parse: parseBlindBallotPlanDmContent,
    keyOf: (plan) => `${plan.electionId}:${plan.planId}`,
    validate: (plan, decoded) => toNpub(decoded.sealPubkey) === toNpub(input.issuerNpub) && plan.issuerNpub === toNpub(input.issuerNpub),
    onValue: input.onPlan, onError: input.onError,
  });
}

export function subscribeOptionABlindRequestAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onAck: (ack: BlindRequestAck) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BlindRequestAck>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_request_acks",
    parse: parseBlindRequestAckDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}`,
    onValue: input.onAck,
    onError: input.onError,
  });
}

export function subscribeOptionABlindRequestAckDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  onAck: (ack: BlindRequestAck) => void;
  onError?: (error: Error) => void;
}) {
  return createSecretKeyGiftWrapSubscription<BlindRequestAck>({
    nsec: input.nsec,
    electionId: input.electionId,
    relays: input.relays,
    stage: "subscribe_request_acks_nsec",
    parse: parseBlindRequestAckDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}`,
    onValue: input.onAck,
    onError: input.onError,
  });
}

export function subscribeOptionABallotSubmissionDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onSubmission: (submission: BallotSubmission) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BallotSubmission>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_submissions",
    parse: parseBallotSubmissionDmContent,
    keyOf: (value) => `${value.electionId}:${value.submissionId}:${value.invitedNpub}`,
    onValue: input.onSubmission,
    onError: input.onError,
    validate: (value, decoded) => {
      const claimedResponseNpub = value.responseNpub ?? value.invitedNpub;
      return !claimedResponseNpub || toNpub(decoded.sealPubkey) === claimedResponseNpub;
    },
  });
}

export function subscribeOptionABallotAcceptanceDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onAcceptance: (acceptance: BallotAcceptanceResult) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BallotAcceptanceResult>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_acceptances",
    parse: parseBallotAcceptanceDmContent,
    keyOf: (value) => `${value.electionId}:${value.submissionId}`,
    onValue: input.onAcceptance,
    onError: input.onError,
  });
}

export function subscribeOptionABallotSubmissionAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onAck: (ack: BallotSubmissionAck) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BallotSubmissionAck>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_submission_acks",
    parse: parseBallotSubmissionAckDmContent,
    keyOf: (value) => `${value.electionId}:${value.submissionId}`,
    onValue: input.onAck,
    onError: input.onError,
  });
}

export function subscribeOptionABlindIssuanceAckDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onAck: (ack: BlindIssuanceAck) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<BlindIssuanceAck>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_issuance_acks",
    parse: parseBlindIssuanceAckDmContent,
    keyOf: (value) => `${value.electionId}:${value.requestId}:${value.issuanceId}`,
    onValue: input.onAck,
    onError: input.onError,
  });
}

export function subscribeOptionAParticipantStatusDms(input: {
  signer: SignerService;
  electionId?: string;
  workerNpub?: string;
  relays?: string[];
  since?: number;
  onStatus: (status: OptionAParticipantStatus) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<OptionAParticipantStatus>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_participant_status",
    parse: parseOptionAParticipantStatusDmContent,
    keyOf: (value) => `${value.electionId}:${value.invitedNpub}:${value.source}:${value.state}:${value.observedAt}`,
    onValue: input.onStatus,
    onError: input.onError,
    validate: (value, decoded) => isAuthenticatedParticipantStatusSender(value, decoded.sealPubkey, input.workerNpub),
  });
}

export function subscribeOptionAWorkerStatusDms(input: {
  signer: SignerService;
  coordinatorNpub?: string;
  workerNpub?: string;
  relays?: string[];
  since?: number;
  onSnapshot: (snapshot: WorkerStatusSnapshot) => void;
  onError?: (error: Error) => void;
}) {
  const coordinatorFilter = input.coordinatorNpub?.trim() ?? "";
  const workerFilter = input.workerNpub?.trim() ?? "";
  return createSignerGiftWrapSubscription<WorkerStatusSnapshot>({
    signer: input.signer,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_worker_status",
    parse: parseWorkerStatusDmContent,
    keyOf: (value) => `${value.workerNpub}:${value.coordinatorNpub}:${value.heartbeatAt}`,
    onValue: input.onSnapshot,
    onError: input.onError,
    validate: (value) => {
      if (coordinatorFilter && value.coordinatorNpub !== coordinatorFilter) {
        return false;
      }
      if (workerFilter && value.workerNpub !== workerFilter) {
        return false;
      }
      return true;
    },
  });
}

export function subscribeOptionAWorkerDelegationDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onDelegation: (delegation: WorkerDelegationCertificate) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<WorkerDelegationCertificate>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_worker_delegations",
    parse: parseWorkerDelegationDmContent,
    keyOf: (value) => `${value.electionId}:${value.delegationId}`,
    onValue: input.onDelegation,
    onError: input.onError,
  });
}

export function subscribeOptionAWorkerDelegationRevocationDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  onRevocation: (revocation: WorkerDelegationRevocation) => void;
  onError?: (error: Error) => void;
}) {
  return createSignerGiftWrapSubscription<WorkerDelegationRevocation>({
    signer: input.signer,
    electionId: input.electionId,
    relays: input.relays,
    since: input.since,
    stage: "subscribe_worker_revocations",
    parse: parseWorkerDelegationRevocationDmContent,
    keyOf: (value) => `${value.electionId}:${value.delegationId}:${value.revokedAt}`,
    onValue: input.onRevocation,
    onError: input.onError,
  });
}
