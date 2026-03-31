import { getPublicKey, nip17, nip19, SimplePool } from "nostr-tools";
import { DEFAULT_DM_RELAYS, type DmPublishResult } from "./proofSubmission";
import { queueNostrPublish } from "./nostrPublishQueue";
import {
  createSimpleShardCertificate,
  parseSimpleShardCertificate,
  type SimpleShardCertificate,
} from "./simpleShardCertificate";

export type SimpleShardRequest = {
  id: string;
  voterNpub: string;
  voterId: string;
  createdAt: string;
};

export type SimpleShardResponse = {
  id: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  createdAt: string;
  shardCertificate: SimpleShardCertificate;
};

function buildDmRelays(relays?: string[]) {
  return Array.from(
    new Set([...DEFAULT_DM_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)),
  );
}

export async function sendSimpleShardRequest(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
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
      created_at: new Date().toISOString(),
    }),
    "Voting shard request",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(
      () => Promise.allSettled(pool.publish(dmRelays, event, { maxWait: 4000 })),
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
      try {
        const rumor = nip17.unwrapEvent(wrappedEvent, secretKey) as { content: string };
        const payload = JSON.parse(rumor.content) as {
          action?: string;
          request_id?: string;
          voter_npub?: string;
          voter_id?: string;
          created_at?: string;
        };

        if (
          payload.action !== "simple_shard_request"
          || !payload.request_id
          || !payload.voter_npub
          || !payload.voter_id
        ) {
          continue;
        }

        requests.set(payload.request_id, {
          id: payload.request_id,
          voterNpub: payload.voter_npub,
          voterId: payload.voter_id,
          createdAt: payload.created_at ?? new Date(wrappedEvent.created_at * 1000).toISOString(),
        });
      } catch {
        continue;
      }
    }

    return [...requests.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } finally {
    pool.close(dmRelays);
  }
}

export async function sendSimpleShardResponse(input: {
  coordinatorSecretKey: Uint8Array;
  voterNpub: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  relays?: string[];
}): Promise<DmPublishResult & { responseId: string }> {
  const decoded = nip19.decode(input.voterNpub);
  if (decoded.type !== "npub") {
    throw new Error("Voter value must be an npub.");
  }

  const dmRelays = buildDmRelays(input.relays);
  const certificate = createSimpleShardCertificate({
    coordinatorSecretKey: input.coordinatorSecretKey,
    thresholdLabel: input.thresholdLabel,
  });
  const responseId = certificate.shardId;
  const event = nip17.wrapEvent(
    input.coordinatorSecretKey,
    {
      publicKey: decoded.data as string,
      relayUrl: dmRelays[0],
    },
    JSON.stringify({
      action: "simple_shard_response",
      response_id: responseId,
      request_id: input.requestId,
      coordinator_npub: input.coordinatorNpub,
      coordinator_id: input.coordinatorId,
      threshold_label: input.thresholdLabel,
      shard_certificate: certificate.event,
      created_at: new Date().toISOString(),
    }),
    "Voting shard response",
  );

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(
      () => Promise.allSettled(pool.publish(dmRelays, event, { maxWait: 4000 })),
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
      try {
        const rumor = nip17.unwrapEvent(wrappedEvent, secretKey) as { content: string };
        const payload = JSON.parse(rumor.content) as {
          action?: string;
          response_id?: string;
          request_id?: string;
          coordinator_npub?: string;
          coordinator_id?: string;
          threshold_label?: string;
          shard_certificate?: SimpleShardCertificate;
          created_at?: string;
        };

        const parsedCertificate = payload.shard_certificate
          ? parseSimpleShardCertificate(payload.shard_certificate, payload.coordinator_npub)
          : null;

        if (
          payload.action !== "simple_shard_response"
          || !payload.response_id
          || !payload.request_id
          || !payload.coordinator_id
          || !payload.threshold_label
          || !parsedCertificate
        ) {
          continue;
        }

        responses.set(payload.response_id, {
          id: parsedCertificate.shardId,
          requestId: payload.request_id,
          coordinatorNpub: parsedCertificate.coordinatorNpub,
          coordinatorId: payload.coordinator_id,
          thresholdLabel: parsedCertificate.thresholdLabel,
          createdAt: payload.created_at ?? new Date(wrappedEvent.created_at * 1000).toISOString(),
          shardCertificate: parsedCertificate.event,
        });
      } catch {
        continue;
      }
    }

    return [...responses.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } finally {
    pool.close(dmRelays);
  }
}
