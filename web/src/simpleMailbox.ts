import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { nip44 } from "nostr-tools";
import { deriveActorDisplayId } from "./actorDisplay";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  isNip65EnabledForSession,
  publishOwnNip65RelayHints,
  resolveNip65ConversationRelays,
  resolveNip65InboxRelays,
} from "./nip65RelayHints";
import { getSharedNostrPool } from "./sharedNostrPool";
import { sha256HexRust, normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";
import { mapRelayPublishResult } from "./nostrPublishResult";
import type {
  SimpleBlindIssuanceRequest,
  SimpleBlindPrivateKey,
  SimpleBlindShareResponse,
} from "./simpleShardCertificate";
import { createSimpleBlindShareResponse } from "./simpleShardCertificate";
import type { SimpleDmAcknowledgement, SimpleShardRequest, SimpleShardResponse } from "./simpleShardDm";

export const SIMPLE_MAILBOX_RELAYS = [
  "wss://relay.nostr.net",
  "wss://nos.lol",
  "wss://relay.nostr.info",
  "wss://relay.nos.social",
  "wss://relay.momostr.pink",
  "wss://relay.azzamo.net",
];

export const SIMPLE_MAILBOX_REQUEST_KIND = 31100;
export const SIMPLE_MAILBOX_TICKET_KIND = 31101;
export const SIMPLE_MAILBOX_ACK_KIND = 31102;
export const SIMPLE_MAILBOX_SCHEMA_VERSION = 1;
export const SIMPLE_MAILBOX_ELECTION_ID = "simple-public-election";
const SIMPLE_MAILBOX_PUBLISH_MAX_WAIT_MS = 1500;
const SIMPLE_MAILBOX_SUBSCRIPTION_MAX_WAIT_MS = 3000;
const SIMPLE_MAILBOX_PUBLISH_STAGGER_MS = 1000;
const SIMPLE_MAILBOX_MIN_PUBLISH_INTERVAL_MS = 5000;
const SIMPLE_MAILBOX_REQUEST_RELAYS_MAX = 5;
const SIMPLE_MAILBOX_TICKET_RELAYS_MAX = 5;
const SIMPLE_MAILBOX_ACK_RELAYS_MAX = 5;
const SIMPLE_MAILBOX_READ_RELAYS_MAX = 5;
const SIMPLE_MAILBOX_ANCHOR_RELAYS = [
  "wss://relay.nostr.net",
  "wss://nos.lol",
];
const SIMPLE_MAILBOX_ANCHORS_PER_MESSAGE_MAX = 1;
const SIMPLE_MAILBOX_RELAY_HEALTH_MAX_PENALTY_MS = 30 * 60_000;

type MailboxRelayHealth = {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastError?: string;
};

const mailboxRelayHealth = new Map<string, MailboxRelayHealth>();

export type MailboxRequestPayload = {
  kind: "blind_request";
  request_id: string;
  voter_pubkey: string;
  blinded_payload: string;
  mailbox_reply_key?: string;
  mailbox_salt: string;
  blind_request: SimpleBlindIssuanceRequest;
};

export type MailboxTicketBundlePayload = {
  kind: "ticket_bundle";
  request_id: string;
  ticket_id: string;
  ticket_payload: {
    ticket_shards: SimpleBlindShareResponse[];
    ticket_commitment: string;
    round_binding: {
      election_id: string;
      round_id: string;
    };
    threshold_label?: string;
    voting_prompt?: string;
  };
  bundle_proof: {
    coordinator_set_hash: string;
  };
};

export type MailboxAckPayload = {
  kind: "ticket_ack";
  request_id: string;
  ticket_id: string;
  ack_id: string;
  receipt_timestamp: number;
};

export type MailboxRequestState = {
  requestId: string;
  roundId: string;
  mailboxId: string;
  requestSeen: boolean;
};

export type MailboxTicketState = {
  requestId: string;
  ticketId: string;
  roundId: string;
  mailboxId: string;
  ticketSent: boolean;
  ticketObserved: boolean;
};

export type MailboxAckState = {
  ticketId: string;
  ackId: string;
  roundId: string;
  mailboxId: string;
  ackSeen: boolean;
};

export type MailboxCompletionState = {
  ticketSent: boolean;
  ackSeen: boolean;
  ballotAccepted: boolean;
  ticketDeliveryConfirmed: boolean;
};

export type MailboxReadQueryDebug = {
  source: "fetch" | "subscribe";
  relays: string[];
  recipientNpubs: string[];
  recipientHexes: string[];
  mailboxIds: string[];
  eventTypes: string[];
  kinds: number[];
  limit: number;
  resultCount?: number;
  queriedAt: string;
};

export function deriveMailboxCompletionState(input: {
  ticketSent: boolean;
  ackSeen: boolean;
  ballotAccepted: boolean;
}): MailboxCompletionState {
  return {
    ticketSent: input.ticketSent,
    ackSeen: input.ackSeen,
    ballotAccepted: input.ballotAccepted,
    ticketDeliveryConfirmed: input.ackSeen || input.ballotAccepted,
  };
}

type MailboxEnvelopeBase<TPayload extends object> = {
  schema_version: 1;
  event_type: string;
  election_id: string;
  round_id: string;
  created_at: number;
  sender_pubkey: string;
  payload: TPayload;
};

type MailboxRequestEnvelope = MailboxEnvelopeBase<{
  mailbox_id: string;
  request_id: string;
  payload_commitment: string;
  ciphertext_scheme: "nip44v2";
  ciphertext_type: "blind_request";
  ciphertext: string;
  attempt_no: number;
  supersedes_event_id: string | null;
}>;

type MailboxTicketEnvelope = MailboxEnvelopeBase<{
  mailbox_id: string;
  request_id: string;
  ticket_id: string;
  payload_commitment: string;
  ciphertext_scheme: "nip44v2";
  ciphertext_type: "ticket_bundle";
  ciphertext: string;
  attempt_no: number;
  supersedes_event_id: string | null;
  coordinator_set_hash: string;
}>;

type MailboxAckEnvelope = MailboxEnvelopeBase<{
  mailbox_id: string;
  request_id: string;
  ticket_id: string;
  ack_id: string;
  payload_commitment: string;
  ciphertext_scheme: "nip44v2";
  ciphertext_type: "ticket_ack";
  ciphertext: string;
  attempt_no: number;
  supersedes_event_id: string | null;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function buildMailboxRelays(relays?: string[]) {
  return normalizeRelaysRust([...SIMPLE_MAILBOX_RELAYS, ...(relays ?? [])]);
}

async function resolveMailboxInboxRelays(npub: string, relays?: string[]) {
  const fallbackRelays = buildMailboxRelays(relays);
  if (!isNip65EnabledForSession()) {
    return fallbackRelays;
  }
  return resolveNip65InboxRelays({
    npub,
    fallbackRelays,
  });
}

async function resolveMailboxConversationRelays(recipientNpub: string, senderNpub: string, relays?: string[]) {
  const fallbackRelays = buildMailboxRelays(relays);
  if (!isNip65EnabledForSession()) {
    return fallbackRelays;
  }
  return resolveNip65ConversationRelays({
    recipientNpub,
    senderNpub,
    fallbackRelays,
  });
}

async function publishMailboxRelayHintsIfEnabled(input: Parameters<typeof publishOwnNip65RelayHints>[0]) {
  if (!isNip65EnabledForSession()) {
    return null;
  }
  return publishOwnNip65RelayHints(input).catch(() => null);
}

function rotateBySeed(values: string[], seed: string) {
  if (values.length <= 1) {
    return values;
  }
  const offset = Number.parseInt(seed.slice(0, 8), 16) % values.length;
  return Array.from({ length: values.length }, (_, index) => values[(offset + index) % values.length]);
}

function rankMailboxRelaysByHealth(relays: string[]) {
  const now = Date.now();
  const healthy: string[] = [];
  const unhealthy: Array<{ relay: string; cooldownUntil: number }> = [];

  for (const relay of relays) {
    const health = mailboxRelayHealth.get(relay);
    if (!health || health.cooldownUntil <= now) {
      healthy.push(relay);
      continue;
    }
    unhealthy.push({ relay, cooldownUntil: health.cooldownUntil });
  }

  unhealthy.sort((left, right) => left.cooldownUntil - right.cooldownUntil);
  return [...healthy, ...unhealthy.map((entry) => entry.relay)];
}

function getMailboxRelayPenaltyMs(error?: string) {
  const normalized = (error ?? "").toLowerCase();
  if (!normalized) {
    return 60_000;
  }
  if (normalized.includes("rate-limited") || normalized.includes("too much")) {
    return 3 * 60_000;
  }
  if (normalized.includes("pow")) {
    return 10 * 60_000;
  }
  if (
    normalized.includes("blocked")
    || normalized.includes("spam")
    || normalized.includes("policy violated")
    || normalized.includes("web of trust")
  ) {
    return 20 * 60_000;
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return 90_000;
  }
  return 2 * 60_000;
}

function recordMailboxRelayOutcome(relay: string, success: boolean, error?: string) {
  if (success) {
    mailboxRelayHealth.set(relay, {
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastError: undefined,
    });
    return;
  }

  const previous = mailboxRelayHealth.get(relay);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const basePenaltyMs = getMailboxRelayPenaltyMs(error);
  const scaledPenaltyMs = Math.min(
    SIMPLE_MAILBOX_RELAY_HEALTH_MAX_PENALTY_MS,
    basePenaltyMs * Math.min(8, 2 ** (consecutiveFailures - 1)),
  );
  mailboxRelayHealth.set(relay, {
    cooldownUntil: Date.now() + scaledPenaltyMs,
    consecutiveFailures,
    lastError: error,
  });
}

function selectRecipientRelays(relays: string[], recipientNpub: string, maxRelayCount: number) {
  const normalized = normalizeRelaysRust(relays);
  const maxRelays = Math.min(maxRelayCount, normalized.length);
  if (maxRelays === normalized.length) {
    return normalized;
  }

  const seed = sha256HexRust(`mailbox-relays|${recipientNpub.trim()}`);
  const anchorPool = SIMPLE_MAILBOX_ANCHOR_RELAYS.filter((relay) => normalized.includes(relay));
  const rotatedAnchors = rotateBySeed(anchorPool, seed);
  const selectedAnchors = rotatedAnchors.slice(0, Math.min(SIMPLE_MAILBOX_ANCHORS_PER_MESSAGE_MAX, rotatedAnchors.length));
  const secondaryPool = normalized.filter((relay) => !selectedAnchors.includes(relay));
  const rotatedSecondaries = rotateBySeed(secondaryPool, seed.slice(8));
  const deterministicOrder = [...selectedAnchors, ...rotatedSecondaries];
  const healthRankedOrder = rankMailboxRelaysByHealth(deterministicOrder);
  return normalizeRelaysRust(healthRankedOrder).slice(0, maxRelays);
}

function selectRecipientRelayUnion(
  entries: Array<{ recipientNpub: string; relays: string[] }>,
  maxRelayCount: number,
) {
  const merged = normalizeRelaysRust(
    entries.flatMap((entry) => selectRecipientRelays(entry.relays, entry.recipientNpub, maxRelayCount)),
  );
  if (merged.length <= maxRelayCount) {
    return merged;
  }
  return rankMailboxRelaysByHealth(merged).slice(0, maxRelayCount);
}

function getKeysFromNsec(nsec: string, actorLabel: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error(`${actorLabel} key must be an nsec.`);
  }
  const secretKey = decoded.data as Uint8Array;
  const publicHex = getPublicKey(secretKey);
  return {
    secretKey,
    publicHex,
    npub: nip19.npubEncode(publicHex),
  };
}

function getConversationKey(secretKey: Uint8Array, targetNpub: string) {
  const decoded = nip19.decode(targetNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Target value must be an npub.");
  }
  return nip44.v2.utils.getConversationKey(secretKey, decoded.data as string);
}

function getMailboxId(input: {
  electionId: string;
  roundId: string;
  mailboxPubkey: string;
  mailboxSalt: string;
}) {
  return sha256HexRust(
    `mailbox|${input.electionId}|${input.roundId}|${input.mailboxPubkey}|${input.mailboxSalt}`,
  );
}

function getTicketId(input: {
  electionId: string;
  roundId: string;
  requestId: string;
  payloadCommitment: string;
}) {
  return sha256HexRust(
    `ticket|${input.electionId}|${input.roundId}|${input.requestId}|${input.payloadCommitment}`,
  );
}

function getAckId(input: {
  electionId: string;
  roundId: string;
  ticketId: string;
}) {
  return sha256HexRust(
    `ack|${input.electionId}|${input.roundId}|${input.ticketId}`,
  );
}

function formatThresholdLabel(shard: SimpleBlindShareResponse) {
  if (typeof shard.thresholdT === "number" && typeof shard.thresholdN === "number") {
    return `${shard.thresholdT} of ${shard.thresholdN}`;
  }
  return "1 of 1";
}

async function publishMailboxEvent(input: {
  secretKey: Uint8Array;
  recipientNpub: string;
  kind: number;
  tags: string[][];
  content: string;
  relays?: string[];
  channel: string;
  maxRelayCount: number;
}) {
  const recipient = nip19.decode(input.recipientNpub.trim());
  if (recipient.type !== "npub") {
    throw new Error("Recipient value must be an npub.");
  }
  const senderNpub = nip19.npubEncode(getPublicKey(input.secretKey));
  const relays = await resolveMailboxConversationRelays(input.recipientNpub, senderNpub, input.relays);
  const publishRelays = selectRecipientRelays(relays, input.recipientNpub, input.maxRelayCount);
  await publishMailboxRelayHintsIfEnabled({
    secretKey: input.secretKey,
    inboxRelays: relays,
    outboxRelays: relays,
    publishRelays,
    channel: `nip65:${senderNpub}`,
  });

  const event = finalizeEvent({
    kind: input.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipient.data as string], ...input.tags],
    content: input.content,
  }, input.secretKey);

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_MAILBOX_PUBLISH_MAX_WAIT_MS })[0],
      publishRelays,
      { staggerMs: SIMPLE_MAILBOX_PUBLISH_STAGGER_MS },
    ),
    {
      channel: input.channel,
      minIntervalMs: SIMPLE_MAILBOX_MIN_PUBLISH_INTERVAL_MS,
    },
  );

  const relayResults = results.map((result, index) => mapRelayPublishResult(result, publishRelays[index]));
  for (const result of relayResults) {
    recordMailboxRelayOutcome(result.relay, result.success, result.error);
  }

  return {
    eventId: event.id,
    eventKind: event.kind,
    eventCreatedAt: event.created_at,
    eventTags: event.tags,
    eventContent: event.content,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendMailboxShardRequest(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  replyNpub: string;
  votingId: string;
  blindRequest: SimpleBlindIssuanceRequest;
  relays?: string[];
  electionId?: string;
  mailboxSalt?: string;
  attemptNo?: number;
  supersedesEventId?: string;
}) {
  const electionId = input.electionId ?? SIMPLE_MAILBOX_ELECTION_ID;
  const mailboxSalt = input.mailboxSalt ?? crypto.randomUUID().replace(/-/g, "");
  const mailboxId = getMailboxId({
    electionId,
    roundId: input.votingId,
    mailboxPubkey: input.replyNpub,
    mailboxSalt,
  });
  const requestPayload: MailboxRequestPayload = {
    kind: "blind_request",
    request_id: input.blindRequest.requestId,
    voter_pubkey: input.voterNpub,
    blinded_payload: input.blindRequest.blindedMessage,
    mailbox_reply_key: input.replyNpub,
    mailbox_salt: mailboxSalt,
    blind_request: input.blindRequest,
  };
  const plaintext = canonicalJson(requestPayload);
  const payloadCommitment = sha256HexRust(plaintext);
  const ciphertext = nip44.v2.encrypt(
    plaintext,
    getConversationKey(input.voterSecretKey, input.coordinatorNpub),
  );
  const createdAt = Math.floor(Date.now() / 1000);
  const envelope: MailboxRequestEnvelope = {
    schema_version: 1,
    event_type: "mailbox_request_envelope",
    election_id: electionId,
    round_id: input.votingId,
    created_at: createdAt,
    sender_pubkey: input.replyNpub,
    payload: {
      mailbox_id: mailboxId,
      request_id: input.blindRequest.requestId,
      payload_commitment: payloadCommitment,
      ciphertext_scheme: "nip44v2",
      ciphertext_type: "blind_request",
      ciphertext,
      attempt_no: input.attemptNo ?? 1,
      supersedes_event_id: input.supersedesEventId ?? null,
    },
  };

  const published = await publishMailboxEvent({
    secretKey: input.voterSecretKey,
    recipientNpub: input.coordinatorNpub,
    kind: SIMPLE_MAILBOX_REQUEST_KIND,
    tags: [
      ["election", electionId],
      ["round", input.votingId],
      ["mailbox", mailboxId],
      ["schema", String(SIMPLE_MAILBOX_SCHEMA_VERSION)],
      ["etype", "mailbox_request_envelope"],
      ["request", input.blindRequest.requestId],
      ["payload_commitment", payloadCommitment],
    ],
    content: canonicalJson(envelope),
    relays: input.relays,
    channel: `simple-mailbox:${input.replyNpub}:${input.coordinatorNpub}`,
    maxRelayCount: SIMPLE_MAILBOX_REQUEST_RELAYS_MAX,
  });

  return {
    ...published,
    mailboxId,
    mailboxSalt,
    requestId: input.blindRequest.requestId,
  };
}

export async function sendMailboxRoundTicket(input: {
  coordinatorSecretKey: Uint8Array;
  blindPrivateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: any;
  recipientNpub: string;
  coordinatorNpub: string;
  thresholdLabel: string;
  request: SimpleShardRequest;
  votingPrompt: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  relays?: string[];
  electionId?: string;
  attemptNo?: number;
  supersedesEventId?: string;
  ticketId?: string;
}) {
  const electionId = input.electionId ?? SIMPLE_MAILBOX_ELECTION_ID;
  const blindShareResponse = await createSimpleBlindShareResponse({
    privateKey: input.blindPrivateKey,
    keyAnnouncementEvent: input.keyAnnouncementEvent,
    coordinatorNpub: input.coordinatorNpub,
    request: input.request.blindRequest,
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
  });
  const ticketPayload = {
    ticket_shards: [blindShareResponse],
    ticket_commitment: sha256HexRust(canonicalJson([blindShareResponse])),
    round_binding: {
      election_id: electionId,
      round_id: input.request.votingId,
    },
    threshold_label: input.thresholdLabel,
    voting_prompt: input.votingPrompt,
  };
  const bundleProof = {
    coordinator_set_hash: sha256HexRust(input.coordinatorNpub),
  };
  const bundle: MailboxTicketBundlePayload = {
    kind: "ticket_bundle",
    request_id: input.request.id,
    ticket_id: "",
    ticket_payload: ticketPayload,
    bundle_proof: bundleProof,
  };
  const payloadCommitment = sha256HexRust(canonicalJson(bundle));
  const ticketId = input.ticketId ?? getTicketId({
    electionId,
    roundId: input.request.votingId,
    requestId: input.request.id,
    payloadCommitment,
  });
  bundle.ticket_id = ticketId;
  const plaintext = canonicalJson(bundle);
  const ciphertext = nip44.v2.encrypt(
    plaintext,
    getConversationKey(input.coordinatorSecretKey, input.recipientNpub),
  );
  const envelope: MailboxTicketEnvelope = {
    schema_version: 1,
    event_type: "mailbox_ticket_envelope",
    election_id: electionId,
    round_id: input.request.votingId,
    created_at: Math.floor(Date.now() / 1000),
    sender_pubkey: input.coordinatorNpub,
    payload: {
      mailbox_id: input.request.mailboxId ?? "",
      request_id: input.request.id,
      ticket_id: ticketId,
      payload_commitment: payloadCommitment,
      ciphertext_scheme: "nip44v2",
      ciphertext_type: "ticket_bundle",
      ciphertext,
      attempt_no: input.attemptNo ?? 1,
      supersedes_event_id: input.supersedesEventId ?? null,
      coordinator_set_hash: bundleProof.coordinator_set_hash,
    },
  };

  const published = await publishMailboxEvent({
    secretKey: input.coordinatorSecretKey,
    recipientNpub: input.recipientNpub,
    kind: SIMPLE_MAILBOX_TICKET_KIND,
    tags: [
      ["election", electionId],
      ["round", input.request.votingId],
      ["mailbox", envelope.payload.mailbox_id],
      ["schema", String(SIMPLE_MAILBOX_SCHEMA_VERSION)],
      ["etype", "mailbox_ticket_envelope"],
      ["request", input.request.id],
      ["ticket", ticketId],
      ["payload_commitment", payloadCommitment],
      ["attempt", String(input.attemptNo ?? 1)],
    ],
    content: canonicalJson(envelope),
    relays: input.relays,
    channel: `simple-mailbox:${input.coordinatorNpub}:tickets`,
    maxRelayCount: SIMPLE_MAILBOX_TICKET_RELAYS_MAX,
  });

  return {
    ...published,
    responseId: ticketId,
    ticketId,
    envelope,
    blindShareResponse,
  };
}

export async function sendMailboxTicketAck(input: {
  senderSecretKey: Uint8Array;
  recipientNpub: string;
  actorNpub: string;
  votingId: string;
  mailboxId: string;
  requestId: string;
  ticketId: string;
  relays?: string[];
  electionId?: string;
  attemptNo?: number;
  supersedesEventId?: string;
}) {
  const electionId = input.electionId ?? SIMPLE_MAILBOX_ELECTION_ID;
  const ackPayload: MailboxAckPayload = {
    kind: "ticket_ack",
    request_id: input.requestId,
    ticket_id: input.ticketId,
    ack_id: getAckId({
      electionId,
      roundId: input.votingId,
      ticketId: input.ticketId,
    }),
    receipt_timestamp: Math.floor(Date.now() / 1000),
  };
  const plaintext = canonicalJson(ackPayload);
  const payloadCommitment = sha256HexRust(plaintext);
  const ciphertext = nip44.v2.encrypt(
    plaintext,
    getConversationKey(input.senderSecretKey, input.recipientNpub),
  );
  const envelope: MailboxAckEnvelope = {
    schema_version: 1,
    event_type: "mailbox_ack_envelope",
    election_id: electionId,
    round_id: input.votingId,
    created_at: Math.floor(Date.now() / 1000),
    sender_pubkey: input.actorNpub,
    payload: {
      mailbox_id: input.mailboxId,
      request_id: input.requestId,
      ticket_id: input.ticketId,
      ack_id: ackPayload.ack_id,
      payload_commitment: payloadCommitment,
      ciphertext_scheme: "nip44v2",
      ciphertext_type: "ticket_ack",
      ciphertext,
      attempt_no: input.attemptNo ?? 1,
      supersedes_event_id: input.supersedesEventId ?? null,
    },
  };

  const published = await publishMailboxEvent({
    secretKey: input.senderSecretKey,
    recipientNpub: input.recipientNpub,
    kind: SIMPLE_MAILBOX_ACK_KIND,
    tags: [
      ["election", electionId],
      ["round", input.votingId],
      ["mailbox", input.mailboxId],
      ["schema", String(SIMPLE_MAILBOX_SCHEMA_VERSION)],
      ["etype", "mailbox_ack_envelope"],
      ["request", input.requestId],
      ["ticket", input.ticketId],
      ["ack", ackPayload.ack_id],
      ["payload_commitment", payloadCommitment],
      ["attempt", String(input.attemptNo ?? 1)],
    ],
    content: canonicalJson(envelope),
    relays: input.relays,
    channel: `simple-mailbox:${input.actorNpub}:${input.recipientNpub}`,
    maxRelayCount: SIMPLE_MAILBOX_ACK_RELAYS_MAX,
  });

  return {
    ...published,
    ackId: ackPayload.ack_id,
  };
}

function parseEnvelopeContent<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function decryptRequestEvent(
  event: { id: string; pubkey: string; content: string; created_at: number },
  secretKey: Uint8Array,
): SimpleShardRequest | null {
  const envelope = parseEnvelopeContent<MailboxRequestEnvelope>(event.content);
  if (!envelope || envelope.event_type !== "mailbox_request_envelope") {
    return null;
  }
  try {
    const plaintext = nip44.v2.decrypt(
      envelope.payload.ciphertext,
      nip44.v2.utils.getConversationKey(secretKey, event.pubkey),
    );
    const request = JSON.parse(plaintext) as MailboxRequestPayload;
    const blindRequest = request.blind_request;
    if (!blindRequest?.requestId) {
      return null;
    }
    return {
      id: blindRequest.requestId,
      dmEventId: event.id,
      voterNpub: request.voter_pubkey,
      voterId: deriveActorDisplayId(request.voter_pubkey),
      replyNpub: request.mailbox_reply_key ?? request.voter_pubkey,
      votingId: envelope.round_id,
      blindRequest,
      createdAt: new Date(envelope.created_at * 1000).toISOString(),
      mailboxId: envelope.payload.mailbox_id,
      mailboxSalt: request.mailbox_salt,
    };
  } catch {
    return null;
  }
}

function decryptTicketEvent(
  event: { id: string; pubkey: string; content: string; created_at: number },
  secretKey: Uint8Array,
): SimpleShardResponse | null {
  const envelope = parseEnvelopeContent<MailboxTicketEnvelope>(event.content);
  if (!envelope || envelope.event_type !== "mailbox_ticket_envelope") {
    return null;
  }
  try {
    const plaintext = nip44.v2.decrypt(
      envelope.payload.ciphertext,
      nip44.v2.utils.getConversationKey(secretKey, event.pubkey),
    );
    const bundle = JSON.parse(plaintext) as MailboxTicketBundlePayload;
    const shard = bundle.ticket_payload.ticket_shards[0];
    if (!shard) {
      return null;
    }
    return {
      id: bundle.ticket_id,
      dmEventId: event.id,
      requestId: bundle.request_id,
      coordinatorNpub: shard.coordinatorNpub,
      coordinatorId: deriveActorDisplayId(shard.coordinatorNpub),
      thresholdLabel: bundle.ticket_payload.threshold_label ?? formatThresholdLabel(shard),
      createdAt: new Date(envelope.created_at * 1000).toISOString(),
      votingPrompt: bundle.ticket_payload.voting_prompt,
      blindShareResponse: shard,
      mailboxId: envelope.payload.mailbox_id,
    };
  } catch {
    return null;
  }
}

function decryptAckEvent(
  event: { id: string; pubkey: string; content: string; created_at: number },
  secretKey: Uint8Array,
): SimpleDmAcknowledgement | null {
  const envelope = parseEnvelopeContent<MailboxAckEnvelope>(event.content);
  if (!envelope || envelope.event_type !== "mailbox_ack_envelope") {
    return null;
  }
  try {
    const plaintext = nip44.v2.decrypt(
      envelope.payload.ciphertext,
      nip44.v2.utils.getConversationKey(secretKey, event.pubkey),
    );
    const ack = JSON.parse(plaintext) as MailboxAckPayload;
    return {
      id: ack.ack_id,
      ackedAction: "simple_round_ticket",
      ackedEventId: ack.ticket_id,
      actorNpub: envelope.sender_pubkey,
      actorId: deriveActorDisplayId(envelope.sender_pubkey),
      votingId: envelope.round_id,
      requestId: ack.request_id,
      responseId: ack.ticket_id,
      createdAt: new Date(envelope.created_at * 1000).toISOString(),
      mailboxId: envelope.payload.mailbox_id,
    };
  } catch {
    return null;
  }
}

async function fetchMailboxEvents(input: {
  kinds: number[];
  recipientNpubs: string[];
  mailboxIds?: string[];
  eventTypes?: string[];
  relays?: string[];
  limit?: number;
  onQueryDebug?: (debug: MailboxReadQueryDebug) => void;
}) {
  const inboxRelaySets = await Promise.all(
    input.recipientNpubs.map((recipientNpub) => resolveMailboxInboxRelays(recipientNpub, input.relays)),
  );
  const relays = selectRecipientRelayUnion(
    input.recipientNpubs.map((recipientNpub, index) => ({
      recipientNpub,
      relays: inboxRelaySets[index] ?? [],
    })),
    SIMPLE_MAILBOX_READ_RELAYS_MAX,
  );
  const recipientHexes = input.recipientNpubs.map((recipientNpub) => {
    const decoded = nip19.decode(recipientNpub);
    if (decoded.type !== "npub") {
      throw new Error("Recipient value must be an npub.");
    }
    return decoded.data as string;
  });
  const mailboxIds = Array.from(
    new Set((input.mailboxIds ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  const eventTypes = Array.from(
    new Set((input.eventTypes ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  const limit = input.limit ?? 200;
  const filter: {
    kinds: number[];
    "#p": string[];
    "#mailbox"?: string[];
    "#etype"?: string[];
    limit: number;
  } = {
    kinds: input.kinds,
    "#p": recipientHexes,
    limit,
  };
  if (mailboxIds.length > 0) {
    filter["#mailbox"] = mailboxIds;
  }
  if (eventTypes.length > 0) {
    filter["#etype"] = eventTypes;
  }
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, filter);
  input.onQueryDebug?.({
    source: "fetch",
    relays: [...relays],
    recipientNpubs: [...input.recipientNpubs],
    recipientHexes,
    mailboxIds,
    eventTypes,
    kinds: [...input.kinds],
    limit,
    resultCount: events.length,
    queriedAt: new Date().toISOString(),
  });
  return events;
}

export async function fetchMailboxShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
}) {
  const keys = getKeysFromNsec(input.coordinatorNsec, "Coordinator");
  const events = await fetchMailboxEvents({
    kinds: [SIMPLE_MAILBOX_REQUEST_KIND],
    recipientNpubs: [keys.npub],
    relays: input.relays,
    limit: 200,
  });
  const requests = new Map<string, SimpleShardRequest>();
  for (const event of events) {
    const request = decryptRequestEvent(event, keys.secretKey);
    if (request) {
      requests.set(request.id, request);
    }
  }
  return sortRecordsByCreatedAtDescRust([...requests.values()]);
}

export async function fetchMailboxShardResponses(input: {
  voterNsec: string;
  voterNsecs?: string[];
  mailboxIds?: string[];
  relays?: string[];
  onQueryDebug?: (debug: MailboxReadQueryDebug) => void;
}) {
  const keyEntries = [input.voterNsec, ...(input.voterNsecs ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => getKeysFromNsec(value, "Voter"));
  const events = await fetchMailboxEvents({
    kinds: [SIMPLE_MAILBOX_TICKET_KIND],
    recipientNpubs: keyEntries.map((entry) => entry.npub),
    mailboxIds: input.mailboxIds,
    eventTypes: ["mailbox_ticket_envelope"],
    relays: input.relays,
    limit: 200,
    onQueryDebug: input.onQueryDebug,
  });
  const responses = new Map<string, SimpleShardResponse>();
  for (const event of events) {
    for (const entry of keyEntries) {
      const response = decryptTicketEvent(event, entry.secretKey);
      if (response) {
        responses.set(response.id, response);
        break;
      }
    }
  }
  return sortRecordsByCreatedAtDescRust([...responses.values()]);
}

export async function fetchMailboxTicketAcknowledgements(input: {
  actorNsec: string;
  actorNsecs?: string[];
  relays?: string[];
}) {
  const keyEntries = [input.actorNsec, ...(input.actorNsecs ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => getKeysFromNsec(value, "Actor"));
  const events = await fetchMailboxEvents({
    kinds: [SIMPLE_MAILBOX_ACK_KIND],
    recipientNpubs: keyEntries.map((entry) => entry.npub),
    relays: input.relays,
    limit: 200,
  });
  const acknowledgements = new Map<string, SimpleDmAcknowledgement>();
  for (const event of events) {
    for (const entry of keyEntries) {
      const acknowledgement = decryptAckEvent(event, entry.secretKey);
      if (acknowledgement) {
        acknowledgements.set(acknowledgement.id, acknowledgement);
        break;
      }
    }
  }
  return sortRecordsByCreatedAtDescRust([...acknowledgements.values()]);
}

export function subscribeMailboxShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
  onRequests: (requests: SimpleShardRequest[]) => void;
  onError?: (error: Error) => void;
}) {
  const keys = getKeysFromNsec(input.coordinatorNsec, "Coordinator");
  const requests = new Map<string, SimpleShardRequest>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchMailboxShardRequests(input).then((initial) => {
    if (closed) {
      return;
    }
    for (const request of initial) {
      requests.set(request.id, request);
    }
    input.onRequests(sortRecordsByCreatedAtDescRust([...requests.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveMailboxInboxRelays(keys.npub, input.relays).then((relaySet) => {
    if (closed) {
      return;
    }
    const decoded = nip19.decode(keys.npub);
    if (decoded.type !== "npub") {
      return;
    }
    subscription = getSharedNostrPool().subscribeMany(
      selectRecipientRelays(relaySet, keys.npub, SIMPLE_MAILBOX_READ_RELAYS_MAX),
      {
      kinds: [SIMPLE_MAILBOX_REQUEST_KIND],
      "#p": [decoded.data as string],
      limit: 200,
    },
    {
      onevent: (event) => {
        const request = decryptRequestEvent(event, keys.secretKey);
        if (!request) {
          return;
        }
        requests.set(request.id, request);
        input.onRequests(sortRecordsByCreatedAtDescRust([...requests.values()]));
      },
      onclose: (reasons) => {
        if (!closed) {
          const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
          if (errors.length > 0) {
            input.onError?.(new Error(errors.join("; ")));
          }
        }
      },
      maxWait: SIMPLE_MAILBOX_SUBSCRIPTION_MAX_WAIT_MS,
    },
    );
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    void subscription?.close("closed by caller");
  };
}

export function subscribeMailboxShardResponses(input: {
  voterNsec: string;
  voterNsecs?: string[];
  mailboxIds?: string[];
  relays?: string[];
  onResponses: (responses: SimpleShardResponse[]) => void;
  onQueryDebug?: (debug: MailboxReadQueryDebug) => void;
  onError?: (error: Error) => void;
}) {
  const keyEntries = [input.voterNsec, ...(input.voterNsecs ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => getKeysFromNsec(value, "Voter"));
  const responses = new Map<string, SimpleShardResponse>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchMailboxShardResponses(input).then((initial) => {
    if (closed) {
      return;
    }
    for (const response of initial) {
      responses.set(response.id, response);
    }
    input.onResponses(sortRecordsByCreatedAtDescRust([...responses.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void Promise.all(
    keyEntries.map((entry) => resolveMailboxInboxRelays(entry.npub, input.relays)),
  ).then((relaySets) => {
    if (closed) {
      return;
    }
    const recipientHexes = keyEntries.map((entry) => entry.publicHex);
    const mailboxIds = Array.from(
      new Set((input.mailboxIds ?? []).map((value) => value.trim()).filter(Boolean)),
    );
    const filter: {
      kinds: number[];
      "#p": string[];
      "#mailbox"?: string[];
      "#etype": string[];
      limit: number;
    } = {
      kinds: [SIMPLE_MAILBOX_TICKET_KIND],
      "#p": recipientHexes,
      "#etype": ["mailbox_ticket_envelope"],
      limit: 200,
    };
    if (mailboxIds.length > 0) {
      filter["#mailbox"] = mailboxIds;
    }
    const subscriptionRelays = selectRecipientRelayUnion(
      keyEntries.map((entry, index) => ({
        recipientNpub: entry.npub,
        relays: relaySets[index] ?? [],
      })),
      SIMPLE_MAILBOX_READ_RELAYS_MAX,
    );
    input.onQueryDebug?.({
      source: "subscribe",
      relays: [...subscriptionRelays],
      recipientNpubs: keyEntries.map((entry) => entry.npub),
      recipientHexes,
      mailboxIds,
      eventTypes: ["mailbox_ticket_envelope"],
      kinds: [SIMPLE_MAILBOX_TICKET_KIND],
      limit: 200,
      queriedAt: new Date().toISOString(),
    });
    subscription = getSharedNostrPool().subscribeMany(
      subscriptionRelays,
      filter,
      {
        onevent: (event) => {
          for (const entry of keyEntries) {
            const response = decryptTicketEvent(event, entry.secretKey);
            if (!response) {
              continue;
            }
            responses.set(response.id, response);
            input.onResponses(sortRecordsByCreatedAtDescRust([...responses.values()]));
            return;
          }
        },
        onclose: (reasons) => {
          if (!closed) {
            const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
            if (errors.length > 0) {
              input.onError?.(new Error(errors.join("; ")));
            }
          }
        },
        maxWait: SIMPLE_MAILBOX_SUBSCRIPTION_MAX_WAIT_MS,
      },
    );
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    void subscription?.close("closed by caller");
  };
}

export async function fetchMailboxTicketAcknowledgementsMerged(input: {
  actorNsec: string;
  actorNsecs?: string[];
  relays?: string[];
}) {
  return fetchMailboxTicketAcknowledgements(input);
}
