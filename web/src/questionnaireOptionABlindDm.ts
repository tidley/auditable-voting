import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip17, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import type {
  BallotAcceptanceResult,
  BallotSubmission,
  BlindBallotIssuance,
  BlindBallotRequest,
  CoordinatorElectionState,
} from "./questionnaireOptionA";
import type { SignerService } from "./services/signerService";
import type {
  WorkerDelegationCertificate,
  WorkerDelegationRevocation,
  WorkerStatusSnapshot,
} from "./questionnaireWorkerDelegation";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import { mapRelayPublishResult } from "./nostrPublishResult";

const OPTION_A_BLIND_DM_RELAYS_MAX = 8;
const OPTION_A_BLIND_DM_READ_RELAYS_MAX = 6;
const OPTION_A_BLIND_DM_READ_RELAYS_FALLBACK_MAX = 8;
const OPTION_A_BLIND_DM_HINT_RELAYS_MAX = 8;
const OPTION_A_BLIND_DM_MAX_WAIT_MS = 1500;
const OPTION_A_BLIND_DM_STAGGER_MS = 250;
const OPTION_A_BLIND_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const ONE_DAY_SECONDS = 24 * 60 * 60;
const ONE_AND_HALF_DAY_SECONDS = 36 * 60 * 60;
const OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS = ONE_AND_HALF_DAY_SECONDS;
const OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT = 40;
const KIND_SEAL = 13;
const KIND_RUMOR_MESSAGE = 14;
const KIND_GIFT_WRAP = 1059;
const KIND_NIP17_RELAY_LIST = 10050;
const OPTION_A_BLIND_DM_QUERY_MAX_CONCURRENCY = 2;
const OPTION_A_BLIND_DM_RELAY_BACKOFF_MS = 60 * 1000;
const OPTION_A_BLIND_DM_SIGNER_DECODE_CACHE_LIMIT = 512;
const OPTION_A_DM_EXISTENCE_CHECK_MAX_RELAYS = 6;

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

type BlindIssuanceDmEnvelope = {
  type: "optiona_blind_issuance_dm";
  schemaVersion: 1;
  issuance: BlindBallotIssuance;
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
  blindRequestSent: boolean;
  blindRequestSentAt?: string | null;
  blindIssuance?: BlindBallotIssuance | null;
  credentialReady: boolean;
  responseNpub?: string | null;
  draftResponses?: BallotSubmission["payload"]["responses"];
  submission?: BallotSubmission | null;
  submissionAccepted?: boolean | null;
  submissionAcceptedAt?: string | null;
  lastUpdatedAt: string;
};

export type OptionACoordinatorStateSnapshot = {
  type: "coordinator_state_snapshot";
  schemaVersion: 1;
  electionId: string;
  coordinatorNpub: string;
  state: Omit<CoordinatorElectionState, "blindSigningPrivateKey">;
  pendingAuthorizationsByNpub?: Record<string, BlindBallotRequest[]>;
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

function optionABlindDmLog(stage: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[OptionA][DM] ${stage}${payload}`);
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
  const available = relays.filter((relay) => {
    const until = optionABlindDmRelayCooldownUntil.get(relay) ?? 0;
    return until <= now;
  });
  if (available.length > 0) {
    return available;
  }
  return relays.slice(0, Math.max(1, Math.min(2, relays.length)));
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

async function queryBlindDmSync(relays: string[], filter: Record<string, unknown>) {
  const queryRelays = filterBlindDmReadRelays(normalizeRelaysRust(relays));
  const key = JSON.stringify({ relays: queryRelays, filter });
  const existing = optionABlindDmInFlightQueries.get(key);
  if (existing) {
    return existing;
  }
  const run = withBlindDmQuerySlot(async () => {
    const pool = getSharedNostrPool();
    try {
      return await pool.querySync(queryRelays, filter);
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
  return relays.slice(0, Math.min(maxRelays, relays.length));
}

function selectPublishRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_BLIND_DM_RELAYS_MAX, relays.length));
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
  const recipientRelays = await fetchRecipientNip17Relays({
    recipientHex,
    discoveryRelays: selectHintRelays(fallbackRelays),
  });
  return selectPublishRelays(mixRecipientAndFallbackRelays(recipientRelays, fallbackRelays));
}

async function resolveRecipientReadRelayCandidates(recipientHex: string, fallbackRelays: string[]) {
  const recipientRelays = await fetchRecipientNip17Relays({
    recipientHex,
    discoveryRelays: selectHintRelays(fallbackRelays),
  });
  return mixRecipientAndFallbackRelays(recipientRelays, fallbackRelays);
}

async function resolveRecipientReadRelays(recipientHex: string, fallbackRelays: string[]) {
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, fallbackRelays);
  return selectReadRelays(relayCandidates);
}

async function queryBlindDmSyncWithFallback(relayCandidates: string[], filter: Record<string, unknown>) {
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

function parseBlindRequestDmContent(content: string): BlindBallotRequest | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindRequestDmEnvelope> | BlindBallotRequest;
    const request = (parsed as BlindRequestDmEnvelope).type === "optiona_blind_request_dm"
      ? (parsed as BlindRequestDmEnvelope).request
      : parsed as BlindBallotRequest;
    if (
      request?.type !== "blind_ballot_request"
      || request.schemaVersion !== 1
      || typeof request.electionId !== "string"
      || typeof request.requestId !== "string"
      || typeof request.invitedNpub !== "string"
    ) {
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

function parseBlindIssuanceDmContent(content: string): BlindBallotIssuance | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindIssuanceDmEnvelope> | BlindBallotIssuance;
    const issuance = (parsed as BlindIssuanceDmEnvelope).type === "optiona_blind_issuance_dm"
      ? (parsed as BlindIssuanceDmEnvelope).issuance
      : parsed as BlindBallotIssuance;
    if (
      issuance?.type !== "blind_ballot_response"
      || issuance.schemaVersion !== 1
      || typeof issuance.electionId !== "string"
      || typeof issuance.requestId !== "string"
      || typeof issuance.invitedNpub !== "string"
    ) {
      return null;
    }
    return issuance;
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

function optionABlindDmSubject(
  envelope: BlindRequestDmEnvelope
    | BlindIssuanceDmEnvelope
    | BlindRequestAckDmEnvelope
    | BlindIssuanceAckDmEnvelope
    | BallotSubmissionDmEnvelope
    | BallotSubmissionAckDmEnvelope
    | BallotAcceptanceDmEnvelope
    | VoterStateDmEnvelope
    | CoordinatorStateDmEnvelope
    | WorkerStatusDmEnvelope
    | WorkerDelegationDmEnvelope
    | WorkerDelegationRevocationDmEnvelope,
) {
  switch (envelope.type) {
    case "optiona_blind_request_dm":
      return "Auditable Voting blind request";
    case "optiona_blind_issuance_dm":
      return "Auditable Voting blind issuance";
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
      return "Auditable Voting coordinator state";
    case "optiona_worker_status_dm":
      return "Auditable Voting worker status";
    case "optiona_worker_delegation_dm":
      return "Auditable Voting worker delegation";
    case "optiona_worker_delegation_revocation_dm":
      return "Auditable Voting worker delegation revocation";
  }
}

function createRumor(input: {
  senderHex: string;
  recipientHex: string;
  relayUrl?: string;
  subject: string;
  envelope: BlindRequestDmEnvelope
    | BlindIssuanceDmEnvelope
    | BlindRequestAckDmEnvelope
    | BlindIssuanceAckDmEnvelope
    | BallotSubmissionDmEnvelope
    | BallotSubmissionAckDmEnvelope
    | BallotAcceptanceDmEnvelope
    | VoterStateDmEnvelope
    | CoordinatorStateDmEnvelope
    | WorkerStatusDmEnvelope
    | WorkerDelegationDmEnvelope
    | WorkerDelegationRevocationDmEnvelope;
}) {
  const rumor = {
    kind: KIND_RUMOR_MESSAGE,
    created_at: Math.round(Date.now() / 1000),
    tags: [
      input.relayUrl ? ["p", input.recipientHex, input.relayUrl] : ["p", input.recipientHex],
      ["subject", input.subject],
    ],
    content: JSON.stringify(input.envelope),
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

function createSignerGiftWrapSubscription<T>(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  since?: number;
  stage: string;
  parse: (content: string) => T | null;
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
      const value = input.parse(decoded.rumorContent);
      if (!value) {
        return;
      }
      const electionId = input.electionId?.trim();
      if (electionId && typeof (value as { electionId?: string }).electionId === "string" && (value as { electionId: string }).electionId !== electionId) {
        return;
      }
      if (input.validate && !input.validate(value, decoded)) {
        return;
      }
      const key = input.keyOf(value);
      if (!key || seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      optionABlindDmLog(`${input.stage}_event`, { key });
      input.onValue(value);
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

async function publishEnvelope(input: {
  signer: SignerService;
  recipientNpub: string;
  envelope: BlindRequestDmEnvelope
    | BlindIssuanceDmEnvelope
    | BlindRequestAckDmEnvelope
    | BlindIssuanceAckDmEnvelope
    | BallotSubmissionDmEnvelope
    | BallotSubmissionAckDmEnvelope
    | BallotAcceptanceDmEnvelope
    | VoterStateDmEnvelope
    | CoordinatorStateDmEnvelope
    | WorkerStatusDmEnvelope
    | WorkerDelegationDmEnvelope
    | WorkerDelegationRevocationDmEnvelope;
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
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-request:${input.request.electionId}:${input.request.requestId}`,
    envelope: {
      type: "optiona_blind_request_dm",
      schemaVersion: 1,
      request: input.request,
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
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-issuance:${input.issuance.electionId}:${input.issuance.requestId}`,
    envelope: {
      type: "optiona_blind_issuance_dm",
      schemaVersion: 1,
      issuance: input.issuance,
      sentAt: new Date().toISOString(),
    },
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

export async function fetchOptionABlindRequestDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
  since?: number;
  maxDecryptAttempts?: number;
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
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
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
      const request = parseBlindRequestDmContent(decoded.rumorContent);
      if (!request) {
        incrementReason(rejectReasons, "parse_failed");
        continue;
      }
      if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
        incrementReason(rejectReasons, "election_mismatch");
        continue;
      }
      const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, request);
      } else {
        incrementReason(rejectReasons, "duplicate");
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
  diagnosticsSink?: (diagnostics: OptionABlindRequestFetchDiagnostics) => void;
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

  const rejectReasons: Record<string, number> = {};
  const unique = new Map<string, BlindBallotRequest>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        incrementReason(rejectReasons, "decode_failed");
        continue;
      }
      const request = parseBlindRequestDmContent(rumor.content);
      if (!request) {
        incrementReason(rejectReasons, "parse_failed");
        continue;
      }
      if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
        incrementReason(rejectReasons, "election_mismatch");
        continue;
      }
      const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, request);
      } else {
        incrementReason(rejectReasons, "duplicate");
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
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindBallotIssuance[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const { events } = await queryBlindDmSyncWithFallback(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
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
      const issuance = parseBlindIssuanceDmContent(decoded.rumorContent);
      if (!issuance) {
        continue;
      }
      if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, issuance);
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
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const { events } = await queryBlindDmSyncWithFallback(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindBallotIssuance>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const issuance = parseBlindIssuanceDmContent(rumor.content);
      if (!issuance) {
        continue;
      }
      if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, issuance);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string; pubkey?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const submission = parseBallotSubmissionDmContent(rumor.content);
      if (!submission) {
        continue;
      }
      const claimedResponseNpub = submission.responseNpub ?? submission.invitedNpub;
      if (claimedResponseNpub && typeof rumor.pubkey === "string" && toNpub(rumor.pubkey) !== claimedResponseNpub) {
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
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
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
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BallotAcceptanceResult>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const acceptance = parseBallotAcceptanceDmContent(rumor.content);
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
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindIssuanceAck[];
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
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindIssuanceAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const ack = parseBlindIssuanceAckDmContent(rumor.content);
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
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindRequestAck[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const maxDecryptAttempts = Math.max(1, input.maxDecryptAttempts ?? OPTION_A_BLIND_DM_SIGNER_DECRYPT_LIMIT);
  const { events } = await queryBlindDmSyncWithFallback(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    since: input.since ?? Math.round(Date.now() / 1000) - OPTION_A_BLIND_DM_SIGNER_LOOKBACK_SECONDS,
    limit: Math.max(1, Math.min(input.limit ?? maxDecryptAttempts, maxDecryptAttempts)),
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
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relayCandidates = await resolveRecipientReadRelayCandidates(recipientHex, buildRelays(input.relays));
  const { events } = await queryBlindDmSyncWithFallback(relayCandidates, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, BlindRequestAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const ack = parseBlindRequestAckDmContent(rumor.content);
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
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BallotSubmissionAck[];
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
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = await resolveRecipientReadRelays(recipientHex, buildRelays(input.relays));
  const events = await queryBlindDmSync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });
  const unique = new Map<string, BallotSubmissionAck>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const ack = parseBallotSubmissionAckDmContent(rumor.content);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const snapshot = parseVoterStateDmContent(rumor.content);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const snapshot = parseCoordinatorStateDmContent(rumor.content);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const snapshot = parseWorkerStatusDmContent(rumor.content);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const delegation = parseWorkerDelegationDmContent(rumor.content);
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
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const revocation = parseWorkerDelegationRevocationDmContent(rumor.content);
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
