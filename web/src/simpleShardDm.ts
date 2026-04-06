import { getPublicKey, nip17, nip19 } from "nostr-tools";
import { deriveActorDisplayId } from "./actorDisplay";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  publishOwnNip65RelayHints,
  resolveNip65ConversationRelays,
  resolveNip65InboxRelays,
} from "./nip65RelayHints";
import {
  createSimpleBlindShareResponse,
  type SimpleBlindIssuanceRequest,
  type SimpleBlindPrivateKey,
  type SimpleBlindShareResponse,
  type SimpleShardCertificate,
} from "./simpleShardCertificate";
import { getSharedNostrPool } from "./sharedNostrPool";
import { normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";

export const SIMPLE_DM_RELAYS = [
  'wss://nip17.tomdwyer.uk',
  'wss://strfry.bitsbytom.com',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://auth.nostr1.com',
  'wss://relay.0xchat.com',
];

const SIMPLE_DM_PUBLISH_MAX_WAIT_MS = 1500;
const SIMPLE_DM_SUBSCRIPTION_MAX_WAIT_MS = 1500;
const SIMPLE_DM_PUBLISH_STAGGER_MS = 250;
const SIMPLE_DM_MIN_PUBLISH_INTERVAL_MS = 300;

export type SimpleDmAcknowledgedAction =
  | 'simple_coordinator_follow'
  | 'simple_subcoordinator_join'
  | 'simple_shard_request'
  | 'simple_share_assignment'
  | 'simple_shard_response'
  | 'simple_round_ticket';

export type SimpleCoordinatorRosterAnnouncement = {
  id: string;
  dmEventId: string;
  leadCoordinatorNpub: string;
  coordinatorNpubs: string[];
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
  createdAt: string;
};

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

function buildDmRelays(relays?: string[]) {
  return normalizeRelaysRust([...SIMPLE_DM_RELAYS, ...(relays ?? [])]);
}

function buildDmPublishChannel(recipientNpub: string) {
  return `simple-dm:${recipientNpub.trim()}`;
}

async function resolveRecipientInboxRelays(recipientNpub: string, relays?: string[]) {
  return resolveNip65InboxRelays({
    npub: recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
}

async function resolveConversationDmRelays(recipientNpub: string, senderNpub?: string, relays?: string[]) {
  return resolveNip65ConversationRelays({
    senderNpub,
    recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
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
      id: payload.request_id,
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
      channel: buildDmPublishChannel(input.coordinatorNpub),
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
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== 'npub') {
    throw new Error('Recipient value must be an npub.');
  }

  const dmRelays = await resolveConversationDmRelays(
    input.recipientNpub,
    input.actorNpub,
    input.relays,
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
      channel: buildDmPublishChannel(input.recipientNpub),
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
      channel: buildDmPublishChannel(input.recipientNpub),
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
      channel: buildDmPublishChannel(input.leadCoordinatorNpub),
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
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.coordinatorNpub,
    input.voterNpub,
    input.relays,
  );
  await publishOwnNip65RelayHints({
    secretKey: input.voterSecretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${input.replyNpub}`,
  }).catch(() => null);
  const event = nip17.wrapEvent(
    input.voterSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_shard_request",
      request_id: crypto.randomUUID(),
      voter_npub: input.voterNpub,
      reply_npub: input.replyNpub,
      voting_id: input.votingId,
      blind_request: input.blindRequest,
      created_at: new Date().toISOString(),
    }),
    "Voting shard request",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.coordinatorNpub),
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

export async function fetchSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShardRequest[]> {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = await resolveRecipientInboxRelays(coordinatorNpub, input.relays);
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [coordinatorHex],
    limit: 100,
  });

  const requests = new Map<string, SimpleShardRequest>();

  for (const wrappedEvent of wrappedEvents) {
    const request = parseSimpleShardRequest(wrappedEvent, secretKey);
    if (request) {
      requests.set(request.id, request);
    }
  }

  return sortByCreatedAtDescending([...requests.values()]);
}

export function subscribeSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
  onRequests: (requests: SimpleShardRequest[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const pool = getSharedNostrPool();
  const requests = new Map<string, SimpleShardRequest>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleShardRequests({
    coordinatorNsec: input.coordinatorNsec,
    relays: input.relays,
  }).then((initialRequests) => {
    if (closed) {
      return;
    }

    for (const request of initialRequests) {
      requests.set(request.id, request);
    }

    input.onRequests(sortByCreatedAtDescending([...requests.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveRecipientInboxRelays(coordinatorNpub, input.relays).then((dmRelays) => {
    if (closed) {
      return;
    }

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [coordinatorHex],
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const request = parseSimpleShardRequest(wrappedEvent, secretKey);
        if (!request) {
          return;
        }

        requests.set(request.id, request);
        input.onRequests(sortByCreatedAtDescending([...requests.values()]));
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

export async function fetchSimpleCoordinatorFollowers(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleCoordinatorFollower[]> {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = await resolveRecipientInboxRelays(coordinatorNpub, input.relays);
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
  const dmRelays = Array.from(new Set(inboxRelaySets.flat()));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    '#p': actorHexes,
    limit: 100,
  });

  const acknowledgements = new Map<string, SimpleDmAcknowledgement>();

  for (const wrappedEvent of wrappedEvents) {
    const acknowledgement = parseWithAnySecretKey(
      wrappedEvent,
      actorEntries,
      parseSimpleDmAcknowledgement,
    );
    if (acknowledgement) {
      acknowledgements.set(
        `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
        acknowledgement,
      );
    }
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
  const dmRelays = await resolveRecipientInboxRelays(voterNpub, input.relays);
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
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleDmAcknowledgements({
    actorNsec: input.actorNsec,
    actorNsecs: input.actorNsecs,
    relays: input.relays,
  })
    .then((initialAcknowledgements) => {
      if (closed) {
        return;
      }

      for (const acknowledgement of initialAcknowledgements) {
        acknowledgements.set(
          `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
          acknowledgement,
        );
      }

      input.onAcknowledgements(
        sortByCreatedAtDescending([...acknowledgements.values()]),
      );
    })
    .catch((error) => {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });

  void Promise.all(actorNpubs.map((actorNpub) => resolveRecipientInboxRelays(actorNpub, input.relays))).then((relaySets) => {
    if (closed) {
      return;
    }

    const dmRelays = Array.from(new Set(relaySets.flat()));

    subscription = pool.subscribeMany(
      dmRelays,
      {
        kinds: [1059],
        '#p': actorHexes,
        limit: 100,
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
    .then((dmRelays) => {
      if (closed) {
        return;
      }

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

  void resolveRecipientInboxRelays(coordinatorNpub, input.relays).then((dmRelays) => {
    if (closed) {
      return;
    }

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
  const dmRelays = await resolveRecipientInboxRelays(leadCoordinatorNpub, input.relays);
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

  void resolveRecipientInboxRelays(leadCoordinatorNpub, input.relays).then((dmRelays) => {
    if (closed) {
      return;
    }

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
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.recipientNpub),
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
    responseId,
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
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
}): Promise<DmPublishResult & { responseId: string }> {
  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== "npub") {
    throw new Error("Voter value must be an npub.");
  }

  const dmRelays = await resolveConversationDmRelays(
    input.recipientNpub,
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
  const event = nip17.wrapEvent(
    input.coordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_round_ticket",
      response_id: responseId,
      request_id: input.request.blindRequest.requestId,
      coordinator_npub: input.coordinatorNpub,
      threshold_label: input.thresholdLabel,
      voting_prompt: input.votingPrompt,
      blind_share_response: blindShareResponse,
      created_at: new Date().toISOString(),
    }),
    "Round ticket",
  );

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_DM_PUBLISH_MAX_WAIT_MS })[0],
      dmRelays,
      { staggerMs: SIMPLE_DM_PUBLISH_STAGGER_MS },
    ),
    {
      channel: buildDmPublishChannel(input.recipientNpub),
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
    responseId,
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
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
      channel: buildDmPublishChannel(input.coordinatorNpub),
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
  relays?: string[];
}): Promise<SimpleShardResponse[]> {
  const voterEntries = collectActorSecrets(input.voterNsec, input.voterNsecs);
  if (voterEntries.length === 0) {
    return [];
  }
  const voterHexes = Array.from(new Set(voterEntries.map((entry) => entry.publicHex)));
  const voterNpubs = Array.from(new Set(voterEntries.map((entry) => entry.npub)));
  const inboxRelaySets = await Promise.all(
    voterNpubs.map((voterNpub) => resolveRecipientInboxRelays(voterNpub, input.relays)),
  );
  const dmRelays = Array.from(new Set(inboxRelaySets.flat()));
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": voterHexes,
    limit: 100,
  });

  const responses = new Map<string, SimpleShardResponse>();

  for (const wrappedEvent of wrappedEvents) {
    const response = parseWithAnySecretKey(wrappedEvent, voterEntries, parseSimpleShardResponse);
    if (response) {
      responses.set(response.id, response);
    }
  }

  return sortByCreatedAtDescending([...responses.values()]);
}

export function subscribeSimpleShardResponses(input: {
  voterNsec: string;
  voterNsecs?: string[];
  relays?: string[];
  onResponses: (responses: SimpleShardResponse[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const voterEntries = collectActorSecrets(input.voterNsec, input.voterNsecs);
  if (voterEntries.length === 0) {
    return () => undefined;
  }
  const voterHexes = Array.from(new Set(voterEntries.map((entry) => entry.publicHex)));
  const voterNpubs = Array.from(new Set(voterEntries.map((entry) => entry.npub)));
  const pool = getSharedNostrPool();
  const responses = new Map<string, SimpleShardResponse>();
  let closed = false;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void fetchSimpleShardResponses({
    voterNsec: input.voterNsec,
    voterNsecs: input.voterNsecs,
    relays: input.relays,
  }).then((initialResponses) => {
    if (closed) {
      return;
    }

    for (const response of initialResponses) {
      responses.set(response.id, response);
    }

    input.onResponses(sortByCreatedAtDescending([...responses.values()]));
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void Promise.all(voterNpubs.map((voterNpub) => resolveRecipientInboxRelays(voterNpub, input.relays))).then((relaySets) => {
    if (closed) {
      return;
    }

    const dmRelays = Array.from(new Set(relaySets.flat()));

    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": voterHexes,
      limit: 100,
    }, {
      onevent: (wrappedEvent) => {
        const response = parseWithAnySecretKey(wrappedEvent, voterEntries, parseSimpleShardResponse);
        if (!response) {
          return;
        }

        responses.set(response.id, response);
        input.onResponses(sortByCreatedAtDescending([...responses.values()]));
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

export async function fetchSimpleCoordinatorShareAssignments(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShareAssignment[]> {
  const { secretKey, publicHex: coordinatorHex, npub: coordinatorNpub } = getNpubFromNsec(
    input.coordinatorNsec,
    "Coordinator",
  );
  const dmRelays = await resolveRecipientInboxRelays(coordinatorNpub, input.relays);
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

  void resolveRecipientInboxRelays(coordinatorNpub, input.relays).then((dmRelays) => {
    if (closed) {
      return;
    }

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
