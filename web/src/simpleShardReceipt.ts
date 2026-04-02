import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { DEFAULT_VOTE_RELAYS } from "./ballot";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";

export const SIMPLE_SHARD_RECEIPT_KIND = 38992;

export type SimpleShardReceipt = {
  eventId: string;
  shardId: string;
  coordinatorNpub: string;
  thresholdLabel: string;
  createdAt: string;
};

function buildPublicRelays(relays?: string[]) {
  return Array.from(
    new Set([...DEFAULT_VOTE_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)),
  );
}

export async function publishSimpleShardReceipt(input: {
  coordinatorNsec: string;
  shardId: string;
  thresholdLabel: string;
  relays?: string[];
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorNpub = nip19.npubEncode(getPublicKey(secretKey));
  const relays = buildPublicRelays(input.relays);
  const createdAt = new Date().toISOString();

  const event = finalizeEvent({
    kind: SIMPLE_SHARD_RECEIPT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-shard-receipt"],
      ["shard-id", input.shardId],
    ],
    content: JSON.stringify({
      shard_id: input.shardId,
      threshold_label: input.thresholdLabel,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 4000 })[0],
      relays,
    ));
    const relayResults = results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: relays[index], success: true }
        : {
            relay: relays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }
    ));

    return {
      eventId: event.id,
      coordinatorNpub,
      createdAt,
      successes: relayResults.filter((result) => result.success).length,
      failures: relayResults.filter((result) => !result.success).length,
      relayResults,
    };
  } finally {
    pool.destroy();
  }
}

export async function fetchSimpleShardReceipts(input: {
  coordinatorNpub: string;
  relays?: string[];
}): Promise<SimpleShardReceipt[]> {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const coordinatorHex = decoded.data as string;
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_SHARD_RECEIPT_KIND],
      authors: [coordinatorHex],
      limit: 200,
    });

    const receipts = new Map<string, SimpleShardReceipt>();

    for (const event of events) {
      try {
        const payload = JSON.parse(event.content) as {
          shard_id?: string;
          threshold_label?: string;
          created_at?: string;
        };

        if (!payload.shard_id || !payload.threshold_label) {
          continue;
        }

        receipts.set(event.id, {
          eventId: event.id,
          shardId: payload.shard_id,
          coordinatorNpub: input.coordinatorNpub,
          thresholdLabel: payload.threshold_label,
          createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
        });
      } catch {
        continue;
      }
    }

    return [...receipts.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } finally {
    pool.close(relays);
  }
}
