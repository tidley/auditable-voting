import { getPublicKey, nip17, nip19 } from "nostr-tools";
import { deriveActorDisplayId } from "./actorDisplay";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  publishOwnNip65RelayHints,
  resolveNip65ConversationRelays,
  resolveNip65InboxRelays,
} from "./nip65RelayHints";
import {
  recordRelayCloseReasons,
  recordRelayOutcome,
  rankRelaysByBackoff,
  selectRelaysWithBackoff,
} from "./relayBackoff";
import {
  createSimpleBlindShareResponse,
  type SimpleBlindIssuanceRequest,
  type SimpleBlindPrivateKey,
  type SimpleBlindShareResponse,
  type SimpleShardCertificate,
} from "./simpleShardCertificate";
import { getSharedNostrPool } from "./sharedNostrPool";
import { normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";
import {
  fetchMailboxShardRequests,
  fetchMailboxShardResponses,
  fetchMailboxTicketAcknowledgements,
  type MailboxReadQueryDebug,
  sendMailboxRoundTicket,
  sendMailboxShardRequest,
  sendMailboxTicketAck,
  subscribeMailboxShardRequests,
  subscribeMailboxShardResponses,
} from "./simpleMailbox";

export const SIMPLE_DM_RELAYS = [
  'wss://nip17.com',
  'wss://nip17.tomdwyer.uk',
  'wss://relay.damus.io',
  'wss://strfry.bitsbytom.com',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://nostr.bg',
  'wss://auth.nostr1.com',
  'wss://inbox.nostr.wine',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.0xchat.com',
];

const SIMPLE_DM_PUBLISH_MAX_WAIT_MS = 1500;
const SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS = 3000;
const SIMPLE_DM_ACK_BACKFILL_INTERVAL_MS = 2000;
const SIMPLE_DM_WELCOME_BACKFILL_INTERVAL_MS = 4000;
const SIMPLE_DM_PUBLISH_STAGGER_MS = 250;
const SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const SIMPLE_DM_READ_RELAYS_MAX = 2;
const SIMPLE_DM_FOLLOW_READ_RELAYS_MAX = 4;
const SIMPLE_DM_FOLLOW_PUBLISH_RELAYS_MAX = 4;
const SIMPLE_DM_TICKET_READ_RELAYS_MAX = 3;
const SIMPLE_DM_ACK_READ_RELAYS_MAX = 3;
const SIMPLE_DM_TICKET_PUBLISH_RELAYS_MAX = 3;
const SIMPLE_DM_ACK_PUBLISH_RELAYS_MAX = 3;

export type SimpleDmAcknowledgedAction =
  | 'simple_coordinator_follow'
  | 'simple_subcoordinator_join'
  | 'simple_mls_welcome'
  | 'simple_shard_request'
  | 'simple_share_assignment'
  | 'simple_shard_response'
  | 'simple_round_ticket';

export type SimpleCoordinatorRosterAnnouncement = {
  id: string;
  dmEventId: string;
  leadCoordinatorNpub: string;
  coordinatorNpubs: string[];
  questionnaireId?: string;
  questionnaireState?: string;
  createdAt: string;
};

export type SimpleDmAcknowledgement = {
  id: string;
  ackedAction: SimpleDmAcknowledgedAction;
  ackedEventId: string;
  actorNpub: string;
  actorId?: string;
  coordinatorNpubs?: string[];
  votingId?: string;
  requestId?: string;
  responseId?: string;
  mailboxId?: string;
  createdAt: string;
};

export function isDeliveryConfirmed(params: {
  ackSeen: boolean;
  ballotAccepted: boolean;
}) {
  return params.ackSeen || params.ballotAccepted;
}

export type DmPublishResult = {
  eventId: string;
  successes: number;
  failures: number;
  relayResults: Array<{
    relay: string;
    success: boolean;
    error?: string;
  }>;
};

export type SimpleShardRequest = {
  id: string;
  dmEventId: string;
  voterNpub: string;
  voterId: string;
  replyNpub: string;
  votingId: string;
  blindRequest: SimpleBlindIssuanceRequest;
  createdAt: string;
  mailboxId?: string;
  mailboxSalt?: string;
};

export type SimpleShardResponse = {
  id: string;
  dmEventId: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  createdAt: string;
  votingPrompt?: string;
  blindShareResponse: SimpleBlindShareResponse;
  shardCertificate?: SimpleShardCertificate;
  mailboxId?: string;
};

export type SimpleCoordinatorFollower = {
  id: string;
  dmEventId: string;
  voterNpub: string;
  voterId: string;
  votingId?: string;
  createdAt: string;
};

export type SimpleSubCoordinatorApplication = {
  id: string;
  dmEventId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  leadCoordinatorNpub: string;
  mlsJoinPackage?: string;
  createdAt: string;
};

export type SimpleShareAssignment = {
  id: string;
  dmEventId: string;
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  shareIndex: number;
  thresholdN?: number;
  createdAt: string;
};

export type SimpleCoordinatorMlsWelcome = {
  id: string;
  dmEventId: string;
  leadCoordinatorNpub: string;
  electionId: string;
  welcomeBundle: string;
  createdAt: string;
};

export type SimpleTicketLifecycleTrace = {
  conversationKey: string;
  votingId?: string;
  coordinatorNpub?: string;
  coordinatorId?: string;
  voterNpub?: string;
  voterId?: string;
  requestId?: string;
  responseId?: string;
  blindedRequestSeenAt?: number;
  ticketBuiltAt?: number;
  publishStartedAt?: number;
  publishSucceededAt?: number;
  publishTimedOutAt?: number;
  ticketObservedByVoterAt?: number;
  ackSentAt?: number;
  ackSeenByCoordinatorAt?: number;
  publishSuccesses?: number;
  publishFailures?: number;
  lastRelayError?: string;
  lastUpdatedAt: number;
};

type TicketTraceStore = {
  traces: Record<string, SimpleTicketLifecycleTrace>;
  requestIndex: Record<string, string>;
  responseIndex: Record<string, string>;
};

const SIMPLE_TICKET_TRACE_STATE_KEY = "__simpleTicketLifecycleTraceState";

function getTicketTraceStore(): TicketTraceStore {
  const owner = globalThis as typeof globalThis & {
    [SIMPLE_TICKET_TRACE_STATE_KEY]?: TicketTraceStore;
  };
  if (!owner[SIMPLE_TICKET_TRACE_STATE_KEY]) {
    owner[SIMPLE_TICKET_TRACE_STATE_KEY] = {
      traces: {},
      requestIndex: {},
      responseIndex: {},
    };
  }
  return owner[SIMPLE_TICKET_TRACE_STATE_KEY]!;
}

function buildTicketConversationKey(input: {
  votingId?: string;
  coordinatorNpub?: string;
  voterNpub?: string;
}) {
  const votingId = input.votingId?.trim() || "unknown-round";
  const coordinatorNpub = input.coordinatorNpub?.trim() || "unknown-coordinator";
  const voterNpub = input.voterNpub?.trim() || "unknown-voter";
  return `${votingId}:${coordinatorNpub}:${voterNpub}`;
}

function resolveTicketConversationKey(input: {
  votingId?: string;
  coordinatorNpub?: string;
  voterNpub?: string;
  requestId?: string;
  responseId?: string;
}) {
  const store = getTicketTraceStore();
  if (input.responseId?.trim() && store.responseIndex[input.responseId.trim()]) {
    return store.responseIndex[input.responseId.trim()];
  }
  if (input.requestId?.trim() && store.requestIndex[input.requestId.trim()]) {
    return store.requestIndex[input.requestId.trim()];
  }
  if (input.coordinatorNpub?.trim() && input.voterNpub?.trim()) {
    return buildTicketConversationKey(input);
  }
  return null;
}

export function recordSimpleTicketLifecycleTrace(input: {
  votingId?: string;
  coordinatorNpub?: string;
  voterNpub?: string;
  requestId?: string;
  responseId?: string;
  updates: Partial<Omit<SimpleTicketLifecycleTrace, "conversationKey" | "lastUpdatedAt">>;
}) {
  const key = resolveTicketConversationKey(input);
  if (!key) {
    return null;
  }

  const store = getTicketTraceStore();
  const existing = store.traces[key];
  const base: SimpleTicketLifecycleTrace = existing ?? {
    conversationKey: key,
    votingId: input.votingId?.trim() || undefined,
    coordinatorNpub: input.coordinatorNpub?.trim() || undefined,
    coordinatorId: input.coordinatorNpub ? deriveActorDisplayId(input.coordinatorNpub) : undefined,
    voterNpub: input.voterNpub?.trim() || undefined,
    voterId: input.voterNpub ? deriveActorDisplayId(input.voterNpub) : undefined,
    requestId: input.requestId?.trim() || undefined,
    responseId: input.responseId?.trim() || undefined,
    lastUpdatedAt: Date.now(),
  };

  const next: SimpleTicketLifecycleTrace = {
    ...base,
    votingId: base.votingId ?? input.votingId?.trim() ?? input.updates.votingId,
    coordinatorNpub: base.coordinatorNpub ?? input.coordinatorNpub?.trim() ?? input.updates.coordinatorNpub,
    coordinatorId:
      base.coordinatorId
      ?? (input.coordinatorNpub ? deriveActorDisplayId(input.coordinatorNpub) : undefined)
      ?? input.updates.coordinatorId,
    voterNpub: base.voterNpub ?? input.voterNpub?.trim() ?? input.updates.voterNpub,
    voterId:
      base.voterId
      ?? (input.voterNpub ? deriveActorDisplayId(input.voterNpub) : undefined)
      ?? input.updates.voterId,
    requestId: base.requestId ?? input.requestId?.trim() ?? input.updates.requestId,
    responseId: base.responseId ?? input.responseId?.trim() ?? input.updates.responseId,
    lastUpdatedAt: Date.now(),
  };

  for (const [field, value] of Object.entries(input.updates)) {
    if (value === undefined || value === null) {
      continue;
    }
    const keyField = field as keyof SimpleTicketLifecycleTrace;
    if (
      next[keyField] === undefined
      || keyField === "publishSuccesses"
      || keyField === "publishFailures"
      || keyField === "lastRelayError"
      || keyField === "lastUpdatedAt"
    ) {
      (next as Record<string, unknown>)[field] = value;
    }
  }

  store.traces[key] = next;
  if (next.requestId) {
    store.requestIndex[next.requestId] = key;
  }
  if (next.responseId) {
    store.responseIndex[next.responseId] = key;
  }
  return next;
}

export function listSimpleTicketLifecycleTraces() {
  const store = getTicketTraceStore();
  return Object.values(store.traces).sort((left, right) => left.conversationKey.localeCompare(right.conversationKey));
}

export function clearSimpleTicketLifecycleTraces() {
  const store = getTicketTraceStore();
  store.traces = {};
  store.requestIndex = {};
  store.responseIndex = {};
}

function buildDmRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...SIMPLE_DM_RELAYS, ...(relays ?? [])]));
}

function selectDmReadRelays(relays: string[], maxRelays = SIMPLE_DM_READ_RELAYS_MAX) {
  const normalized = normalizeRelaysRust(relays);
  return selectRelaysWithBackoff(normalized, maxRelays);
}

function buildDmPublishChannel(recipientNpub: string, senderNpub?: string) {
  const recipient = recipientNpub.trim();
  const sender = senderNpub?.trim() || "unknown-sender";
  return `simple-dm:${sender}:${recipient}`;
}

async function resolveRecipientInboxRelays(recipientNpub: string, relays?: string[]) {
  return resolveNip65InboxRelays({
    npub: recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
}

async function resolveConversationDmRelays(
  recipientNpub: string,
  senderNpub?: string,
  relays?: string[],
  maxRelays = SIMPLE_DM_READ_RELAYS_MAX,
) {
  const resolved = await resolveNip65ConversationRelays({
    senderNpub,
    recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
  return selectDmReadRelays(resolved, maxRelays);
}

function getNpubFromNsec(nsec: string, actorLabel: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error(`${actorLabel} key must be an nsec.`);
  }

  const secretKey = decoded.data as Uint8Array;
  return {
    secretKey,
    publicHex: getPublicKey(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

function sortByCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return sortRecordsByCreatedAtDescRust(values);
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter((value) => value.length > 0)));
}

function collectActorSecrets(
  actorNsec?: string,
  actorNsecs?: string[],
) {
  return uniqueNonEmpty([actorNsec, ...(actorNsecs ?? [])]).map((value) => getNpubFromNsec(value, "Actor"));
}

function parseWithAnySecretKey<T>(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretEntries: Array<{ secretKey: Uint8Array }>,
  parser: (
    wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
    secretKey: Uint8Array,
  ) => T | null,
): T | null {
  for (const entry of secretEntries) {
    const parsed = parser(wrappedEvent, entry.secretKey);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function parseSimpleShardRequest(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleShardRequest | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      request_id?: string;
      voter_npub?: string;
      reply_npub?: string;
      voting_id?: string;
      blind_request?: SimpleBlindIssuanceRequest;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_shard_request' ||
      !payload.request_id ||
      !payload.voter_npub ||
      !payload.reply_npub ||
      !payload.voting_id ||
      !payload.blind_request
    ) {
      return null;
    }

    return {
      id: payload.blind_request.requestId?.trim() || payload.request_id,
      dmEventId: String(wrappedEvent.id ?? payload.request_id),
      voterNpub: payload.voter_npub,
      voterId: deriveActorDisplayId(payload.voter_npub),
      replyNpub: payload.reply_npub,
      votingId: payload.voting_id,
      blindRequest: payload.blind_request,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleCoordinatorFollower(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleCoordinatorFollower | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      follow_id?: string;
      voter_npub?: string;
      voting_id?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_coordinator_follow' ||
      !payload.follow_id ||
      !payload.voter_npub
    ) {
      return null;
    }

    return {
      id: payload.follow_id,
      dmEventId: String(wrappedEvent.id ?? payload.follow_id),
      voterNpub: payload.voter_npub,
      voterId: deriveActorDisplayId(payload.voter_npub),
      votingId: payload.voting_id?.trim() || undefined,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleShardResponse(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleShardResponse | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      response_id?: string;
      request_id?: string;
      coordinator_npub?: string;
      threshold_label?: string;
      voting_prompt?: string;
      blind_share_response?: SimpleBlindShareResponse;
      created_at?: string;
    };

    if (
      (payload.action !== 'simple_shard_response' &&
        payload.action !== 'simple_round_ticket') ||
      !payload.response_id ||
      !payload.request_id ||
      !payload.threshold_label ||
      !payload.blind_share_response
    ) {
      return null;
    }

    const coordinatorNpub =
      payload.coordinator_npub ??
      payload.blind_share_response.coordinatorNpub;
    if (!coordinatorNpub) {
      return null;
    }

    return {
      id: payload.response_id,
      dmEventId: String(wrappedEvent.id ?? payload.response_id),
      requestId: payload.request_id,
      coordinatorNpub,
      coordinatorId: deriveActorDisplayId(coordinatorNpub),
      thresholdLabel: payload.threshold_label,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
      votingPrompt: payload.voting_prompt?.trim() || undefined,
      blindShareResponse: payload.blind_share_response,
    };
  } catch {
    return null;
  }
}

function parseSimpleSubCoordinatorApplication(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleSubCoordinatorApplication | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      application_id?: string;
      coordinator_npub?: string;
      lead_coordinator_npub?: string;
      mls_join_package?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_subcoordinator_join' ||
      !payload.application_id ||
      !payload.coordinator_npub ||
      !payload.lead_coordinator_npub
    ) {
      return null;
    }

    return {
      id: payload.application_id,
      dmEventId: String(wrappedEvent.id ?? payload.application_id),
      coordinatorNpub: payload.coordinator_npub,
      coordinatorId: deriveActorDisplayId(payload.coordinator_npub),
      leadCoordinatorNpub: payload.lead_coordinator_npub,
      mlsJoinPackage:
        typeof payload.mls_join_package === "string" && payload.mls_join_package.trim().length > 0
          ? payload.mls_join_package
          : undefined,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleCoordinatorMlsWelcome(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleCoordinatorMlsWelcome | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      welcome_id?: string;
      lead_coordinator_npub?: string;
      election_id?: string;
      welcome_bundle?: string;
      created_at?: string;
    };

    if (
      payload.action !== "simple_mls_welcome" ||
      !payload.welcome_id ||
      !payload.lead_coordinator_npub ||
      !payload.election_id ||
      !payload.welcome_bundle
    ) {
      return null;
    }

    return {
      id: payload.welcome_id,
      dmEventId: String(wrappedEvent.id ?? payload.welcome_id),
      leadCoordinatorNpub: payload.lead_coordinator_npub,
      electionId: payload.election_id,
      welcomeBundle: payload.welcome_bundle,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleShareAssignment(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleShareAssignment | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      assignment_id?: string;
      lead_coordinator_npub?: string;
      coordinator_npub?: string;
      share_index?: number;
      threshold_n?: number;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_share_assignment' ||
      !payload.assignment_id ||
      !payload.lead_coordinator_npub ||
      !payload.coordinator_npub ||
      typeof payload.share_index !== 'number'
    ) {
      return null;
    }

    return {
      id: payload.assignment_id,
      dmEventId: String(wrappedEvent.id ?? payload.assignment_id),
      leadCoordinatorNpub: payload.lead_coordinator_npub,
      coordinatorNpub: payload.coordinator_npub,
      shareIndex: payload.share_index,
      thresholdN:
        typeof payload.threshold_n === 'number'
          ? payload.threshold_n
          : undefined,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleDmAcknowledgement(
  wrappedEvent: Record<string, unknown> & { created_at: number },
  secretKey: Uint8Array,
): SimpleDmAcknowledgement | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      ack_id?: string;
      acked_action?: SimpleDmAcknowledgedAction;
      acked_event_id?: string;
      actor_npub?: string;
      coordinator_npubs?: string[];
      voting_id?: string;
      request_id?: string;
      response_id?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_dm_ack' ||
      !payload.ack_id ||
      !payload.acked_action ||
      !payload.acked_event_id ||
      !payload.actor_npub
    ) {
      return null;
    }

    return {
      id: payload.ack_id,
      ackedAction: payload.acked_action,
      ackedEventId: payload.acked_event_id,
      actorNpub: payload.actor_npub,
      actorId: deriveActorDisplayId(payload.actor_npub),
      coordinatorNpubs: Array.isArray(payload.coordinator_npubs)
        ? uniqueNonEmpty(payload.coordinator_npubs)
        : undefined,
      votingId: payload.voting_id?.trim() || undefined,
      requestId: payload.request_id?.trim() || undefined,
      responseId: payload.response_id?.trim() || undefined,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseSimpleCoordinatorRosterAnnouncement(
  wrappedEvent: Record<string, unknown> & { id?: string; created_at: number },
  secretKey: Uint8Array,
): SimpleCoordinatorRosterAnnouncement | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent as never, secretKey) as {
      content: string;
    };
    const payload = JSON.parse(rumor.content) as {
      action?: string;
      roster_id?: string;
      lead_coordinator_npub?: string;
      coordinator_npubs?: string[];
      questionnaire_id?: string;
      questionnaire_state?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_coordinator_roster' ||
      !payload.roster_id ||
      !payload.lead_coordinator_npub ||
      !Array.isArray(payload.coordinator_npubs)
    ) {
      return null;
    }

    const coordinatorNpubs = uniqueNonEmpty(payload.coordinator_npubs);
    if (coordinatorNpubs.length === 0) {
      return null;
    }

    return {
      id: payload.roster_id,
      dmEventId: String(wrappedEvent.id ?? payload.roster_id),
      leadCoordinatorNpub: payload.lead_coordinator_npub,
      coordinatorNpubs,
      questionnaireId: payload.questionnaire_id?.trim() || undefined,
      questionnaireState: payload.questionnaire_state?.trim() || undefined,
      createdAt:
        payload.created_at ??
        new Date(wrappedEvent.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function sendSimpleCoordinatorFollow(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  votingId?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.coordinatorNpub,
    input.voterNpub,
    input.relays,
    SIMPLE_DM_FOLLOW_PUBLISH_RELAYS_MAX,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.voterSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.voterNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.voterSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_coordinator_follow",
      follow_id: crypto.randomUUID(),
      voter_npub: input.voterNpub,
      voting_id: input.votingId,
      created_at: new Date().toISOString(),
    }),
    "Follow coordinator",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.coordinatorNpub, input.voterNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }
  ));
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendSimpleDmAcknowledgement(input: {
  senderSecretKey: Uint8Array;
  recipientNpub: string;
  actorNpub: string;
  ackedAction: SimpleDmAcknowledgedAction;
  ackedEventId: string;
  coordinatorNpubs?: string[];
  votingId?: string;
  requestId?: string;
  responseId?: string;
  mailboxId?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  if (input.ackedAction === "simple_round_ticket") {
    if (!input.votingId || !input.requestId || !input.responseId) {
      throw new Error("Ticket mailbox acknowledgements require votingId, requestId, and responseId.");
    }
    const result = await sendMailboxTicketAck({
      senderSecretKey: input.senderSecretKey,
      recipientNpub: input.recipientNpub,
      actorNpub: input.actorNpub,
      votingId: input.votingId,
      mailboxId: input.mailboxId ?? "",
      requestId: input.requestId,
      ticketId: input.responseId,
      relays: input.relays,
    });
    recordSimpleTicketLifecycleTrace({
      votingId: input.votingId,
      coordinatorNpub: input.recipientNpub,
      requestId: input.requestId,
      responseId: input.responseId,
      updates: {
        ackSentAt: Date.now(),
      },
    });
    return result;
  }

  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== 'npub') {
    throw new Error('Recipient value must be an npub.');
  }

  const dmRelays = await resolveConversationDmRelays(
    input.recipientNpub,
    input.actorNpub,
    input.relays,
    SIMPLE_DM_ACK_PUBLISH_RELAYS_MAX,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.senderSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.actorNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.senderSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: 'simple_dm_ack',
      ack_id: crypto.randomUUID(),
      acked_action: input.ackedAction,
      acked_event_id: input.ackedEventId,
      actor_npub: input.actorNpub,
      coordinator_npubs: input.coordinatorNpubs,
      voting_id: input.votingId,
      request_id: input.requestId,
      response_id: input.responseId,
      created_at: new Date().toISOString(),
    }),
    'DM acknowledgement',
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () =>
      publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
        dmRelays,
        { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
      ),
    {
      channel: buildDmPublishChannel(input.recipientNpub, input.actorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) =>
    result.status === 'fulfilled'
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
  );

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendSimpleCoordinatorRoster(input: {
  leadCoordinatorSecretKey: Uint8Array;
  recipientNpub: string;
  leadCoordinatorNpub: string;
  coordinatorNpubs: string[];
  questionnaireId?: string;
  questionnaireState?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== 'npub') {
    throw new Error('Recipient value must be an npub.');
  }

  const coordinatorNpubs = uniqueNonEmpty(input.coordinatorNpubs);
  if (coordinatorNpubs.length === 0) {
    throw new Error('Coordinator roster must contain at least one npub.');
  }

  const dmRelays = await resolveConversationDmRelays(
    input.recipientNpub,
    input.leadCoordinatorNpub,
    input.relays,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.leadCoordinatorSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.leadCoordinatorNpub}`,
  }).catch(() => null);

  const event = nip17.wrapEvent(
    input.leadCoordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: 'simple_coordinator_roster',
      roster_id: crypto.randomUUID(),
      lead_coordinator_npub: input.leadCoordinatorNpub,
      coordinator_npubs: coordinatorNpubs,
      questionnaire_id: input.questionnaireId?.trim() || undefined,
      questionnaire_state: input.questionnaireState?.trim() || undefined,
      created_at: new Date().toISOString(),
    }),
    'Coordinator roster',
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () =>
      publishToRelaysStaggered(
        (relay) =>
          pool.publish([relay], event, {
            maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS,
          })[0],
        dmRelays,
        { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
      ),
    {
      channel: buildDmPublishChannel(input.recipientNpub, input.leadCoordinatorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) =>
    result.status === 'fulfilled'
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
  );

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendSimpleSubCoordinatorJoin(input: {
  coordinatorSecretKey: Uint8Array;
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  mlsJoinPackage?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.leadCoordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Lead coordinator value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.leadCoordinatorNpub,
    input.coordinatorNpub,
    input.relays,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.coordinatorSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.coordinatorNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.coordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_subcoordinator_join",
      application_id: crypto.randomUUID(),
      coordinator_npub: input.coordinatorNpub,
      lead_coordinator_npub: input.leadCoordinatorNpub,
      mls_join_package: input.mlsJoinPackage,
      created_at: new Date().toISOString(),
    }),
    "Join lead coordinator",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.leadCoordinatorNpub, input.coordinatorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendSimpleCoordinatorMlsWelcome(input: {
  leadCoordinatorSecretKey: Uint8Array;
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  electionId: string;
  welcomeBundle: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.coordinatorNpub,
    input.leadCoordinatorNpub,
    input.relays,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.leadCoordinatorSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.leadCoordinatorNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.leadCoordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_mls_welcome",
      welcome_id: crypto.randomUUID(),
      lead_coordinator_npub: input.leadCoordinatorNpub,
      election_id: input.electionId,
      welcome_bundle: input.welcomeBundle,
      created_at: new Date().toISOString(),
    }),
    "MLS welcome",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.coordinatorNpub, input.leadCoordinatorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function sendSimpleShardRequest(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  replyNpub: string;
  votingId: string;
  blindRequest: SimpleBlindIssuanceRequest;
  relays?: string[];
  mailboxSalt?: string;
  attemptNo?: number;
  supersedesEventId?: string;
}): Promise<DmPublishResult & { mailboxId?: string; mailboxSalt?: string; requestId?: string }> {
  return sendMailboxShardRequest(input);
}

export async function fetchSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShardRequest[]> {
  const keys = getNpubFromNsec(input.coordinatorNsec, "Coordinator");
  const requests = await fetchMailboxShardRequests(input);
  for (const request of requests) {
    recordSimpleTicketLifecycleTrace({
      votingId: request.votingId,
      coordinatorNpub: keys.npub,
      voterNpub: request.voterNpub,
      requestId: request.id,
      updates: {
        blindedRequestSeenAt: Date.now(),
      },
    });
  }
  return requests;
}

export function subscribeSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
  onRequests: (requests: SimpleShardRequest[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const keys = getNpubFromNsec(input.coordinatorNsec, "Coordinator");
  return subscribeMailboxShardRequests({
    ...input,
    onRequests: (requests) => {
      for (const request of requests) {
        recordSimpleTicketLifecycleTrace({
          votingId: request.votingId,
          coordinatorNpub: keys.npub,
          voterNpub: request.voterNpub,
          requestId: request.id,
          updates: {
            blindedRequestSeenAt: Date.now(),
          },
        });
      }
      input.onRequests(requests);
    },
  });
}

export async function fetchSimpleCoordinatorFollowers(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleCoordinatorFollower[]> {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = selectDmReadRelays(
    await resolveRecipientInboxRelays(coordinatorNpub, input.relays),
    SIMPLE_DM_FOLLOW_READ_RELAYS_MAX,
  );
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [coordinatorHex],
    limit: 100,
  });

  const followers = new Map<string, SimpleCoordinatorFollower>();

  for (const wrappedEvent of wrappedEvents) {
    const follower = parseSimpleCoordinatorFollower(wrappedEvent, secretKey);
    if (follower) {
      followers.set(follower.voterNpub, follower);
    }
  }

  return sortByCreatedAtDescending([...followers.values()]);
}

export async function fetchSimpleDmAcknowledgements(input: {
  actorNsec: string;
  actorNsecs?: string[];
  relays?: string[];
}): Promise<SimpleDmAcknowledgement[]> {
  const actorEntries = collectActorSecrets(input.actorNsec, input.actorNsecs);
  if (actorEntries.length === 0) {
    return [];
  }

  const actorHexes = Array.from(new Set(actorEntries.map((entry) => entry.publicHex)));
  const actorNpubs = Array.from(new Set(actorEntries.map((entry) => entry.npub)));
  const inboxRelaySets = await Promise.all(
    actorNpubs.map((actorNpub) => resolveRecipientInboxRelays(actorNpub, input.relays)),
  );
  const dmRelays = selectDmReadRelays(
    Array.from(new Set(inboxRelaySets.flat())),
    SIMPLE_DM_ACK_READ_RELAYS_MAX,
  );
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    '#p': actorHexes,
    limit: 200,
  });

  const acknowledgements = new Map<string, SimpleDmAcknowledgement>();

  for (const wrappedEvent of wrappedEvents) {
    const acknowledgement = parseWithAnySecretKey(
      wrappedEvent,
      actorEntries,
      parseSimpleDmAcknowledgement,
    );
    if (acknowledgement) {
      if (acknowledgement.ackedAction === "simple_round_ticket") {
        recordSimpleTicketLifecycleTrace({
          votingId: acknowledgement.votingId,
          requestId: acknowledgement.requestId,
          responseId: acknowledgement.responseId,
          updates: {
            ackSeenByCoordinatorAt: Date.now(),
          },
        });
      }
      acknowledgements.set(
        `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
        acknowledgement,
      );
    }
  }

  const mailboxAcknowledgements = await fetchMailboxTicketAcknowledgements(input);
  for (const acknowledgement of mailboxAcknowledgements) {
    recordSimpleTicketLifecycleTrace({
      votingId: acknowledgement.votingId,
      requestId: acknowledgement.requestId,
      responseId: acknowledgement.responseId,
      updates: {
        ackSeenByCoordinatorAt: Date.now(),
      },
    });
    acknowledgements.set(
      `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
      acknowledgement,
    );
  }

  return sortByCreatedAtDescending([...acknowledgements.values()]);
}

export async function fetchSimpleCoordinatorRosterAnnouncements(input: {
  voterNsec: string;
  relays?: string[];
}): Promise<SimpleCoordinatorRosterAnnouncement[]> {
  const { secretKey, publicHex: voterHex, npub: voterNpub } = getNpubFromNsec(
    input.voterNsec,
    'Voter',
  );
  const dmRelays = selectDmReadRelays(await resolveRecipientInboxRelays(voterNpub, input.relays));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    '#p': [voterHex],
    limit: 100,
  });

  const announcements = new Map<string, SimpleCoordinatorRosterAnnouncement>();

  for (const wrappedEvent of wrappedEvents) {
    const announcement = parseSimpleCoordinatorRosterAnnouncement(
      wrappedEvent,
      secretKey,
    );
    if (announcement) {
      announcements.set(announcement.leadCoordinatorNpub, announcement);
    }
  }

  return sortByCreatedAtDescending([...announcements.values()]);
}

export function subscribeSimpleDmAcknowledgements(input: {
  actorNsec: string;
  actorNsecs?: string[];
  relays?: string[];
  onAcknowledgements: (acknowledgements: SimpleDmAcknowledgement[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const actorEntries = collectActorSecrets(input.actorNsec, input.actorNsecs);
  if (actorEntries.length === 0) {
    return () => undefined;
  }
  const actorHexes = Array.from(new Set(actorEntries.map((entry) => entry.publicHex)));
  const actorNpubs = Array.from(new Set(actorEntries.map((entry) => entry.npub)));
  const pool = getSharedNostrPool();
  const acknowledgements = new Map<string, SimpleDmAcknowledgement>();
  let closed = false;
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  const refreshAcknowledgements = async () => {
    const nextAcknowledgements = await fetchSimpleDmAcknowledgements({
      actorNsec: input.actorNsec,
      actorNsecs: input.actorNsecs,
      relays: input.relays,
    });

    if (closed) {
      return;
    }

    for (const acknowledgement of nextAcknowledgements) {
      if (acknowledgement.ackedAction === "simple_round_ticket") {
        recordSimpleTicketLifecycleTrace({
          votingId: acknowledgement.votingId,
          requestId: acknowledgement.requestId,
          responseId: acknowledgement.responseId,
          updates: {
            ackSeenByCoordinatorAt: Date.now(),
          },
        });
      }
      acknowledgements.set(
        `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
        acknowledgement,
      );
    }

    input.onAcknowledgements(
      sortByCreatedAtDescending([...acknowledgements.values()]),
    );
  };

  void refreshAcknowledgements()
    .catch((error) => {
      if (closed) {
        return;
      }

      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });

  intervalId = globalThis.setInterval(() => {
    void refreshAcknowledgements().catch(() => undefined);
  }, SIMPLE_DM_ACK_BACKFILL_INTERVAL_MS);

  void Promise.all(actorNpubs.map((actorNpub) => resolveRecipientInboxRelays(actorNpub, input.relays))).then((relaySets) => {
    if (closed) {
      return;
    }

    const dmRelays = selectDmReadRelays(
      Array.from(new Set(relaySets.flat())),
      SIMPLE_DM_ACK_READ_RELAYS_MAX,
    );

    subscription = pool.subscribeMany(
      dmRelays,
      {
        kinds: [1059],
        '#p': actorHexes,
        limit: 200,
      },
      {
        onevent: (wrappedEvent) => {
          const acknowledgement = parseWithAnySecretKey(
            wrappedEvent,
            actorEntries,
            parseSimpleDmAcknowledgement,
          );
        if (!acknowledgement) {
          return;
        }

        if (acknowledgement.ackedAction === "simple_round_ticket") {
          recordSimpleTicketLifecycleTrace({
            votingId: acknowledgement.votingId,
            requestId: acknowledgement.requestId,
            responseId: acknowledgement.responseId,
            updates: {
              ackSeenByCoordinatorAt: Date.now(),
            },
          });
        }
        acknowledgements.set(
          `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
          acknowledgement,
        );
          input.onAcknowledgements(
            sortByCreatedAtDescending([...acknowledgements.values()]),
          );
        },
        onclose: (reasons) => {
          if (closed) {
            return;
          }

          const errors = reasons.filter(
            (reason) => !reason.startsWith('closed by caller'),
          );
          if (errors.length > 0) {
            input.onError?.(new Error(errors.join('; ')));
          }
        },
        maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
      },
    );
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
    }
    void subscription?.close('closed by caller');
  };
}

export function subscribeSimpleCoordinatorRosterAnnouncements(input: {
  voterNsec: string;
  relays?: string[];
  onAnnouncements: (announcements: SimpleCoordinatorRosterAnnouncement[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex: voterHex, npub: voterNpub } = getNpubFromNsec(
    input.voterNsec,
    'Voter',
  );
  const pool = getSharedNostrPool();
  const announcements = new Map<string, SimpleCoordinatorRosterAnnouncement>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null =
    null;

  void fetchSimpleCoordinatorRosterAnnouncements({
    voterNsec: input.voterNsec,
    relays: input.relays,
  })
    .then((initialAnnouncements) => {
      if (closed) {
        return;
      }

      for (const announcement of initialAnnouncements) {
        announcements.set(announcement.leadCoordinatorNpub, announcement);
      }

      input.onAnnouncements(sortByCreatedAtDescending([...announcements.values()]));
    })
    .catch((error) => {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });

  void resolveRecipientInboxRelays(voterNpub, input.relays)
    .then((resolvedRelays) => {
      if (closed) {
        return;
      }
      const dmRelays = selectDmReadRelays(resolvedRelays);

      subscription = pool.subscribeMany(
        dmRelays,
        {
          kinds: [1059],
          '#p': [voterHex],
          limit: 100,
        },
        {
          onevent: (wrappedEvent) => {
            const announcement = parseSimpleCoordinatorRosterAnnouncement(
              wrappedEvent,
              secretKey,
            );
            if (!announcement) {
              return;
            }

            announcements.set(announcement.leadCoordinatorNpub, announcement);
            input.onAnnouncements(
              sortByCreatedAtDescending([...announcements.values()]),
            );
          },
          onclose: (reasons) => {
            if (closed) {
              return;
            }

            const errors = reasons.filter(
              (reason) => !reason.startsWith('closed by caller'),
            );
            if (errors.length > 0) {
              input.onError?.(new Error(errors.join('; ')));
            }
          },
          maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
        },
      );
    })
    .catch((error) => {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });

  return () => {
    closed = true;
    void subscription?.close('closed by caller');
  };
}

export function subscribeSimpleCoordinatorFollowers(input: {
  coordinatorNsec: string;
  relays?: string[];
  onFollowers: (followers: SimpleCoordinatorFollower[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const pool = getSharedNostrPool();
  const followers = new Map<string, SimpleCoordinatorFollower>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleCoordinatorFollowers({
    coordinatorNsec: input.coordinatorNsec,
    relays: input.relays,
  }).then((initialFollowers) => {
    if (closed) {
      return;
    }

    for (const follower of initialFollowers) {
      followers.set(follower.voterNpub, follower);
    }

    input.onFollowers(sortByCreatedAtDescending([...followers.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveRecipientInboxRelays(coordinatorNpub, input.relays).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const dmRelays = selectDmReadRelays(resolvedRelays, SIMPLE_DM_FOLLOW_READ_RELAYS_MAX);

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [coordinatorHex],
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const follower = parseSimpleCoordinatorFollower(wrappedEvent, secretKey);
        if (!follower) {
          return;
        }

        followers.set(follower.voterNpub, follower);
        input.onFollowers(sortByCreatedAtDescending([...followers.values()]));
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          recordRelayCloseReasons(errors);
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
    });
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

export async function fetchSimpleSubCoordinatorApplications(input: {
  leadCoordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleSubCoordinatorApplication[]> {
  const { secretKey, publicHex: leadCoordinatorHex, npub: leadCoordinatorNpub } = getNpubFromNsec(
    input.leadCoordinatorNsec,
    "Lead coordinator",
  );
  const dmRelays = selectDmReadRelays(await resolveRecipientInboxRelays(leadCoordinatorNpub, input.relays));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [leadCoordinatorHex],
    limit: 100,
  });

  const applications = new Map<string, SimpleSubCoordinatorApplication>();

  for (const wrappedEvent of wrappedEvents) {
    const application = parseSimpleSubCoordinatorApplication(wrappedEvent, secretKey);
    if (application) {
      applications.set(application.coordinatorNpub, application);
    }
  }

  return sortByCreatedAtDescending([...applications.values()]);
}

export function subscribeSimpleSubCoordinatorApplications(input: {
  leadCoordinatorNsec: string;
  relays?: string[];
  onApplications: (applications: SimpleSubCoordinatorApplication[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex: leadCoordinatorHex, npub: leadCoordinatorNpub } = getNpubFromNsec(
    input.leadCoordinatorNsec,
    "Lead coordinator",
  );
  const pool = getSharedNostrPool();
  const applications = new Map<string, SimpleSubCoordinatorApplication>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleSubCoordinatorApplications({
    leadCoordinatorNsec: input.leadCoordinatorNsec,
    relays: input.relays,
  }).then((initialApplications) => {
    if (closed) {
      return;
    }

    for (const application of initialApplications) {
      applications.set(application.coordinatorNpub, application);
    }

    input.onApplications(sortByCreatedAtDescending([...applications.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveRecipientInboxRelays(leadCoordinatorNpub, input.relays).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const dmRelays = selectDmReadRelays(resolvedRelays);

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [leadCoordinatorHex],
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const application = parseSimpleSubCoordinatorApplication(wrappedEvent, secretKey);
        if (!application) {
          return;
        }

        applications.set(application.coordinatorNpub, application);
        input.onApplications(sortByCreatedAtDescending([...applications.values()]));
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
    });
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

export async function fetchSimpleCoordinatorMlsWelcomes(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleCoordinatorMlsWelcome[]> {
  const { secretKey, publicHex, npub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = selectDmReadRelays(await resolveRecipientInboxRelays(npub, input.relays));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [publicHex],
    limit: 100,
  });

  const welcomes = new Map<string, SimpleCoordinatorMlsWelcome>();

  for (const wrappedEvent of wrappedEvents) {
    const welcome = parseSimpleCoordinatorMlsWelcome(wrappedEvent, secretKey);
    if (welcome) {
      welcomes.set(welcome.id, welcome);
    }
  }

  return sortByCreatedAtDescending([...welcomes.values()]);
}

export function subscribeSimpleCoordinatorMlsWelcomes(input: {
  coordinatorNsec: string;
  relays?: string[];
  onWelcomes: (welcomes: SimpleCoordinatorMlsWelcome[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex, npub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const pool = getSharedNostrPool();
  const welcomes = new Map<string, SimpleCoordinatorMlsWelcome>();
  let closed = false;
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  const refreshWelcomes = async () => {
    const nextWelcomes = await fetchSimpleCoordinatorMlsWelcomes({
      coordinatorNsec: input.coordinatorNsec,
      relays: input.relays,
    });

    if (closed) {
      return;
    }

    for (const welcome of nextWelcomes) {
      welcomes.set(welcome.id, welcome);
    }

    input.onWelcomes(sortByCreatedAtDescending([...welcomes.values()]));
  };

  void refreshWelcomes().catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  intervalId = globalThis.setInterval(() => {
    void refreshWelcomes().catch(() => undefined);
  }, SIMPLE_DM_WELCOME_BACKFILL_INTERVAL_MS);

  void resolveRecipientInboxRelays(npub, input.relays).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const dmRelays = selectDmReadRelays(resolvedRelays);

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [publicHex],
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const welcome = parseSimpleCoordinatorMlsWelcome(wrappedEvent, secretKey);
        if (!welcome) {
          return;
        }

        welcomes.set(welcome.id, welcome);
        input.onWelcomes(sortByCreatedAtDescending([...welcomes.values()]));
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
    });
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
    }
    void subscription?.close("closed by caller");
  };
}

export async function sendSimpleShardResponse(input: {
  coordinatorSecretKey: Uint8Array;
  blindPrivateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: any;
  recipientNpub: string;
  request: SimpleShardRequest;
  coordinatorNpub: string;
  thresholdLabel: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  relays?: string[];
}): Promise<DmPublishResult & { responseId: string }> {
  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== "npub") {
    throw new Error("Voter value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.recipientNpub,
    input.coordinatorNpub,
    input.relays,
    SIMPLE_DM_TICKET_PUBLISH_RELAYS_MAX,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.coordinatorSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.coordinatorNpub}`,
  }).catch(() => null);
  const blindShareResponse = await createSimpleBlindShareResponse({
    privateKey: input.blindPrivateKey,
    keyAnnouncementEvent: input.keyAnnouncementEvent,
    coordinatorNpub: input.coordinatorNpub,
    request: input.request.blindRequest,
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
  });
  const responseId = blindShareResponse.shareId;
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      ticketBuiltAt: Date.now(),
    },
  });
  const event = nip17.wrapEvent(
    input.coordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_shard_response",
      response_id: responseId,
      request_id: input.request.blindRequest.requestId,
      coordinator_npub: input.coordinatorNpub,
      threshold_label: input.thresholdLabel,
      blind_share_response: blindShareResponse,
      created_at: new Date().toISOString(),
    }),
    "Voting shard response",
  );

  const pool = getSharedNostrPool();
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      publishStartedAt: Date.now(),
    },
  });
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.recipientNpub, input.coordinatorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  const successes = relayResults.filter((result) => result.success).length;
  const failures = relayResults.filter((result) => !result.success).length;
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      publishSucceededAt: successes > 0 ? Date.now() : undefined,
      publishTimedOutAt: successes === 0 ? Date.now() : undefined,
      publishSuccesses: successes,
      publishFailures: failures,
      lastRelayError: relayResults.find((result) => !result.success)?.error,
    },
  });

  return {
    responseId,
    eventId: event.id,
    successes,
    failures,
    relayResults,
  };
}

export async function sendSimpleRoundTicket(input: {
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
  attemptNo?: number;
  supersedesEventId?: string;
  ticketId?: string;
}): Promise<DmPublishResult & {
  responseId: string;
  eventKind?: number;
  eventCreatedAt?: number;
  eventTags?: string[][];
  eventContent?: string;
  envelope?: unknown;
}> {
  const responseId = input.ticketId ?? input.request.id;
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      ticketBuiltAt: Date.now(),
    },
  });
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      publishStartedAt: Date.now(),
    },
  });
  const result = await sendMailboxRoundTicket(input);
  const successes = result.successes;
  const failures = result.failures;
  recordSimpleTicketLifecycleTrace({
    votingId: input.request.votingId,
    coordinatorNpub: input.coordinatorNpub,
    voterNpub: input.request.voterNpub,
    requestId: input.request.id,
    responseId,
    updates: {
      publishSucceededAt: successes > 0 ? Date.now() : undefined,
      publishTimedOutAt: successes === 0 ? Date.now() : undefined,
      publishSuccesses: successes,
      publishFailures: failures,
      lastRelayError: result.relayResults.find((relay) => !relay.success)?.error,
    },
  });

  return {
    responseId: result.responseId,
    eventId: result.eventId,
    eventKind: result.eventKind,
    eventCreatedAt: result.eventCreatedAt,
    eventTags: result.eventTags,
    eventContent: result.eventContent,
    envelope: result.envelope,
    successes: result.successes,
    failures: result.failures,
    relayResults: result.relayResults,
  };
}

export async function sendSimpleShareAssignment(input: {
  leadCoordinatorSecretKey: Uint8Array;
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  shareIndex: number;
  thresholdN?: number;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.coordinatorNpub,
    input.leadCoordinatorNpub,
    input.relays,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.leadCoordinatorSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.leadCoordinatorNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.leadCoordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_share_assignment",
      assignment_id: crypto.randomUUID(),
      lead_coordinator_npub: input.leadCoordinatorNpub,
      coordinator_npub: input.coordinatorNpub,
      share_index: input.shareIndex,
      threshold_n: input.thresholdN,
      created_at: new Date().toISOString(),
    }),
    "Share assignment",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.coordinatorNpub, input.leadCoordinatorNpub),
      minIntervalMs: SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: dmRelays[index], success: true }
      : {
          relay: dmRelays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function fetchSimpleShardResponses(input: {
  voterNsec: string;
  voterNsecs?: string[];
  mailboxIds?: string[];
  relays?: string[];
  onMailboxQueryDebug?: (debug: MailboxReadQueryDebug) => void;
}): Promise<SimpleShardResponse[]> {
  const responses = await fetchMailboxShardResponses({
    voterNsec: input.voterNsec,
    voterNsecs: input.voterNsecs,
    mailboxIds: input.mailboxIds,
    relays: input.relays,
    onQueryDebug: input.onMailboxQueryDebug,
  });
  for (const response of responses) {
    recordSimpleTicketLifecycleTrace({
      coordinatorNpub: response.coordinatorNpub,
      requestId: response.requestId,
      responseId: response.id,
      updates: {
        ticketObservedByVoterAt: Date.now(),
      },
    });
  }
  return responses;
}

export function subscribeSimpleShardResponses(input: {
  voterNsec: string;
  voterNsecs?: string[];
  mailboxIds?: string[];
  relays?: string[];
  onResponses: (responses: SimpleShardResponse[]) => void;
  onMailboxQueryDebug?: (debug: MailboxReadQueryDebug) => void;
  onError?: (error: Error) => void;
}): () => void {
  return subscribeMailboxShardResponses({
    voterNsec: input.voterNsec,
    voterNsecs: input.voterNsecs,
    mailboxIds: input.mailboxIds,
    relays: input.relays,
    onQueryDebug: input.onMailboxQueryDebug,
    onError: input.onError,
    onResponses: (responses) => {
      for (const response of responses) {
        recordSimpleTicketLifecycleTrace({
          coordinatorNpub: response.coordinatorNpub,
          requestId: response.requestId,
          responseId: response.id,
          updates: {
            ticketObservedByVoterAt: Date.now(),
          },
        });
      }
      input.onResponses(responses);
    },
  });
}

export async function fetchSimpleCoordinatorShareAssignments(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShareAssignment[]> {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = selectDmReadRelays(await resolveRecipientInboxRelays(coordinatorNpub, input.relays));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [coordinatorHex],
    limit: 100,
  });

  const assignments = new Map<string, SimpleShareAssignment>();

  for (const wrappedEvent of wrappedEvents) {
    const assignment = parseSimpleShareAssignment(wrappedEvent, secretKey);
    if (assignment) {
      assignments.set(`${assignment.leadCoordinatorNpub}:${assignment.coordinatorNpub}`, assignment);
    }
  }

  return sortByCreatedAtDescending([...assignments.values()]);
}

export function subscribeSimpleCoordinatorShareAssignments(input: {
  coordinatorNsec: string;
  relays?: string[];
  onAssignments: (assignments: SimpleShareAssignment[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const pool = getSharedNostrPool();
  const assignments = new Map<string, SimpleShareAssignment>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleCoordinatorShareAssignments({
    coordinatorNsec: input.coordinatorNsec,
    relays: input.relays,
  }).then((initialAssignments) => {
    if (closed) {
      return;
    }

    for (const assignment of initialAssignments) {
      assignments.set(`${assignment.leadCoordinatorNpub}:${assignment.coordinatorNpub}`, assignment);
    }

    input.onAssignments(sortByCreatedAtDescending([...assignments.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveRecipientInboxRelays(coordinatorNpub, input.relays).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const dmRelays = selectDmReadRelays(resolvedRelays);

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [coordinatorHex],
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const assignment = parseSimpleShareAssignment(wrappedEvent, secretKey);
        if (!assignment) {
          return;
        }

        assignments.set(`${assignment.leadCoordinatorNpub}:${assignment.coordinatorNpub}`, assignment);
        input.onAssignments(sortByCreatedAtDescending([...assignments.values()]));
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS,
    });
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
