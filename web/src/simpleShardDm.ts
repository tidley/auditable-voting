import { getPublicKey, nip17, nip19, SimplePool } from "nostr-tools";
import type { DmPublishResult } from "./proofSubmission";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  createSimpleBlindShareResponse,
  type SimpleBlindIssuanceRequest,
  type SimpleBlindPrivateKey,
  type SimpleBlindShareResponse,
  type SimpleShardCertificate,
} from "./simpleShardCertificate";

export const SIMPLE_DM_RELAYS = [
  'wss://relay.0xchat.com',
  'wss://auth.nostr1.com',
  'wss://nip17.com',
  'wss://nip17.tomdwyer.uk',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

export type SimpleDmAcknowledgedAction =
  | 'simple_coordinator_follow'
  | 'simple_subcoordinator_join'
  | 'simple_shard_request'
  | 'simple_share_assignment'
  | 'simple_shard_response'
  | 'simple_round_ticket';

export type SimpleDmAcknowledgement = {
  id: string;
  ackedAction: SimpleDmAcknowledgedAction;
  ackedEventId: string;
  actorNpub: string;
  actorId?: string;
  votingId?: string;
  requestId?: string;
  responseId?: string;
  createdAt: string;
};

export type SimpleShardRequest = {
  id: string;
  dmEventId: string;
  voterNpub: string;
  voterId: string;
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
  return Array.from(
    new Set([...SIMPLE_DM_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)),
  );
}

function sortByCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
      voter_id?: string;
      voting_id?: string;
      blind_request?: SimpleBlindIssuanceRequest;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_shard_request' ||
      !payload.request_id ||
      !payload.voter_npub ||
      !payload.voter_id ||
      !payload.voting_id ||
      !payload.blind_request
    ) {
      return null;
    }

    return {
      id: payload.request_id,
      dmEventId: String(wrappedEvent.id ?? payload.request_id),
      voterNpub: payload.voter_npub,
      voterId: payload.voter_id,
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
      voter_id?: string;
      voting_id?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_coordinator_follow' ||
      !payload.follow_id ||
      !payload.voter_npub ||
      !payload.voter_id
    ) {
      return null;
    }

    return {
      id: payload.follow_id,
      dmEventId: String(wrappedEvent.id ?? payload.follow_id),
      voterNpub: payload.voter_npub,
      voterId: payload.voter_id,
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
      coordinator_id?: string;
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
      !payload.coordinator_id ||
      !payload.threshold_label ||
      !payload.blind_share_response
    ) {
      return null;
    }

    return {
      id: payload.response_id,
      dmEventId: String(wrappedEvent.id ?? payload.response_id),
      requestId: payload.request_id,
      coordinatorNpub:
        payload.coordinator_npub ??
        payload.blind_share_response.coordinatorNpub,
      coordinatorId: payload.coordinator_id,
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
      coordinator_id?: string;
      lead_coordinator_npub?: string;
      created_at?: string;
    };

    if (
      payload.action !== 'simple_subcoordinator_join' ||
      !payload.application_id ||
      !payload.coordinator_npub ||
      !payload.coordinator_id ||
      !payload.lead_coordinator_npub
    ) {
      return null;
    }

    return {
      id: payload.application_id,
      dmEventId: String(wrappedEvent.id ?? payload.application_id),
      coordinatorNpub: payload.coordinator_npub,
      coordinatorId: payload.coordinator_id,
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
      actor_id?: string;
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
      actorId: payload.actor_id?.trim() || undefined,
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

export async function sendSimpleCoordinatorFollow(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  votingId?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
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
      voter_id: input.voterId,
      voting_id: input.votingId,
      created_at: new Date().toISOString(),
    }),
    "Follow coordinator",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
}

export async function sendSimpleDmAcknowledgement(input: {
  senderSecretKey: Uint8Array;
  recipientNpub: string;
  actorNpub: string;
  actorId?: string;
  ackedAction: SimpleDmAcknowledgedAction;
  ackedEventId: string;
  votingId?: string;
  requestId?: string;
  responseId?: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.recipientNpub);
  if (decoded.type !== 'npub') {
    throw new Error('Recipient value must be an npub.');
  }

  const dmRelays = buildDmRelays(input.relays);
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
      actor_id: input.actorId,
      voting_id: input.votingId,
      request_id: input.requestId,
      response_id: input.responseId,
      created_at: new Date().toISOString(),
    }),
    'DM acknowledgement',
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() =>
      publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
        dmRelays,
      ),
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
  } finally {
    pool.destroy();
  }
}

export async function sendSimpleSubCoordinatorJoin(input: {
  coordinatorSecretKey: Uint8Array;
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  coordinatorId: string;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.leadCoordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Lead coordinator value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
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
      coordinator_id: input.coordinatorId,
      lead_coordinator_npub: input.leadCoordinatorNpub,
      created_at: new Date().toISOString(),
    }),
    "Join lead coordinator",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
}

export async function sendSimpleShardRequest(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  votingId: string;
  blindRequest: SimpleBlindIssuanceRequest;
  relays?: string[];
}): Promise<DmPublishResult> {
  const decoded = nip19.decode(input.coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
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
      voter_id: input.voterId,
      voting_id: input.votingId,
      blind_request: input.blindRequest,
      created_at: new Date().toISOString(),
    }),
    "Voting shard request",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
}

export async function fetchSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShardRequest[]> {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
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
  } finally {
    pool.close(dmRelays);
  }
}

export function subscribeSimpleShardRequests(input: {
  coordinatorNsec: string;
  relays?: string[];
  onRequests: (requests: SimpleShardRequest[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const requests = new Map<string, SimpleShardRequest>();
  let closed = false;

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

  const subscription = pool.subscribeMany(dmRelays, {
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
    maxWait: 4000,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export async function fetchSimpleCoordinatorFollowers(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleCoordinatorFollower[]> {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
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
  } finally {
    pool.close(dmRelays);
  }
}

export async function fetchSimpleDmAcknowledgements(input: {
  actorNsec: string;
  relays?: string[];
}): Promise<SimpleDmAcknowledgement[]> {
  const decoded = nip19.decode(input.actorNsec.trim());
  if (decoded.type !== 'nsec') {
    throw new Error('Actor key must be an nsec.');
  }

  const secretKey = decoded.data as Uint8Array;
  const actorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
    const wrappedEvents = await pool.querySync(dmRelays, {
      kinds: [1059],
      '#p': [actorHex],
      limit: 100,
    });

    const acknowledgements = new Map<string, SimpleDmAcknowledgement>();

    for (const wrappedEvent of wrappedEvents) {
      const acknowledgement = parseSimpleDmAcknowledgement(
        wrappedEvent,
        secretKey,
      );
      if (acknowledgement) {
        acknowledgements.set(
          `${acknowledgement.actorNpub}:${acknowledgement.ackedAction}:${acknowledgement.ackedEventId}`,
          acknowledgement,
        );
      }
    }

    return sortByCreatedAtDescending([...acknowledgements.values()]);
  } finally {
    pool.close(dmRelays);
  }
}

export function subscribeSimpleDmAcknowledgements(input: {
  actorNsec: string;
  relays?: string[];
  onAcknowledgements: (acknowledgements: SimpleDmAcknowledgement[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.actorNsec.trim());
  if (decoded.type !== 'nsec') {
    throw new Error('Actor key must be an nsec.');
  }

  const secretKey = decoded.data as Uint8Array;
  const actorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const acknowledgements = new Map<string, SimpleDmAcknowledgement>();
  let closed = false;

  void fetchSimpleDmAcknowledgements({
    actorNsec: input.actorNsec,
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

  const subscription = pool.subscribeMany(
    dmRelays,
    {
      kinds: [1059],
      '#p': [actorHex],
      limit: 100,
    },
    {
      onevent: (wrappedEvent) => {
        const acknowledgement = parseSimpleDmAcknowledgement(
          wrappedEvent,
          secretKey,
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
      maxWait: 4000,
    },
  );

  return () => {
    closed = true;
    void subscription.close('closed by caller');
    pool.destroy();
  };
}

export function subscribeSimpleCoordinatorFollowers(input: {
  coordinatorNsec: string;
  relays?: string[];
  onFollowers: (followers: SimpleCoordinatorFollower[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const followers = new Map<string, SimpleCoordinatorFollower>();
  let closed = false;

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

  const subscription = pool.subscribeMany(dmRelays, {
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
    maxWait: 4000,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export async function fetchSimpleSubCoordinatorApplications(input: {
  leadCoordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleSubCoordinatorApplication[]> {
  const decoded = nip19.decode(input.leadCoordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Lead coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const leadCoordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
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
  } finally {
    pool.close(dmRelays);
  }
}

export function subscribeSimpleSubCoordinatorApplications(input: {
  leadCoordinatorNsec: string;
  relays?: string[];
  onApplications: (applications: SimpleSubCoordinatorApplication[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.leadCoordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Lead coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const leadCoordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const applications = new Map<string, SimpleSubCoordinatorApplication>();
  let closed = false;

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

  const subscription = pool.subscribeMany(dmRelays, {
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
    maxWait: 4000,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export async function sendSimpleShardResponse(input: {
  coordinatorSecretKey: Uint8Array;
  blindPrivateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: any;
  voterNpub: string;
  request: SimpleShardRequest;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  relays?: string[];
}): Promise<DmPublishResult & { responseId: string }> {
  const decoded = nip19.decode(input.voterNpub);
  if (decoded.type !== "npub") {
    throw new Error("Voter value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
  const blindShareResponse = createSimpleBlindShareResponse({
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
      request_id: input.request.id,
      coordinator_npub: input.coordinatorNpub,
      coordinator_id: input.coordinatorId,
      threshold_label: input.thresholdLabel,
      blind_share_response: blindShareResponse,
      created_at: new Date().toISOString(),
    }),
    "Voting shard response",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
}

export async function sendSimpleRoundTicket(input: {
  coordinatorSecretKey: Uint8Array;
  blindPrivateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: any;
  voterNpub: string;
  voterId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  request: SimpleShardRequest;
  votingPrompt: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  relays?: string[];
}): Promise<DmPublishResult & { responseId: string }> {
  const decoded = nip19.decode(input.voterNpub);
  if (decoded.type !== "npub") {
    throw new Error("Voter value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
  const blindShareResponse = createSimpleBlindShareResponse({
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
      request_id: input.request.id,
      voter_id: input.voterId,
      coordinator_npub: input.coordinatorNpub,
      coordinator_id: input.coordinatorId,
      threshold_label: input.thresholdLabel,
      voting_prompt: input.votingPrompt,
      blind_share_response: blindShareResponse,
      created_at: new Date().toISOString(),
    }),
    "Round ticket",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
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

  const dmRelays = buildDmRelays(input.relays);
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

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      dmRelays,
    ));
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
  } finally {
    pool.destroy();
  }
}

export async function fetchSimpleShardResponses(input: {
  voterNsec: string;
  relays?: string[];
}): Promise<SimpleShardResponse[]> {
  const decoded = nip19.decode(input.voterNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Voter key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const voterHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
    const wrappedEvents = await pool.querySync(dmRelays, {
      kinds: [1059],
      "#p": [voterHex],
      limit: 100,
    });

    const responses = new Map<string, SimpleShardResponse>();

    for (const wrappedEvent of wrappedEvents) {
      const response = parseSimpleShardResponse(wrappedEvent, secretKey);
      if (response) {
        responses.set(response.id, response);
      }
    }

    return sortByCreatedAtDescending([...responses.values()]);
  } finally {
    pool.close(dmRelays);
  }
}

export function subscribeSimpleShardResponses(input: {
  voterNsec: string;
  relays?: string[];
  onResponses: (responses: SimpleShardResponse[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.voterNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Voter key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const voterHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const responses = new Map<string, SimpleShardResponse>();
  let closed = false;

  void fetchSimpleShardResponses({
    voterNsec: input.voterNsec,
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

  const subscription = pool.subscribeMany(dmRelays, {
    kinds: [1059],
    "#p": [voterHex],
    limit: 100,
  }, {
    onevent: (wrappedEvent) => {
      const response = parseSimpleShardResponse(wrappedEvent, secretKey);
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
    maxWait: 4000,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export async function fetchSimpleCoordinatorShareAssignments(input: {
  coordinatorNsec: string;
  relays?: string[];
}): Promise<SimpleShareAssignment[]> {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();

  try {
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
  } finally {
    pool.close(dmRelays);
  }
}

export function subscribeSimpleCoordinatorShareAssignments(input: {
  coordinatorNsec: string;
  relays?: string[];
  onAssignments: (assignments: SimpleShareAssignment[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const dmRelays = buildDmRelays(input.relays);
  const pool = new SimplePool();
  const assignments = new Map<string, SimpleShareAssignment>();
  let closed = false;

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

  const subscription = pool.subscribeMany(dmRelays, {
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
    maxWait: 4000,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}
