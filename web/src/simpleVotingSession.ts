import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { DEFAULT_VOTE_RELAYS } from "./ballot";
import { queueNostrPublish } from "./nostrPublishQueue";

export const SIMPLE_LIVE_VOTE_KIND = 38990;

export type SimpleLiveVoteSession = {
  votingId: string;
  prompt: string;
  coordinatorNpub: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  eventId: string;
};

function buildPublicRelays(relays?: string[]) {
  return Array.from(
    new Set([...DEFAULT_VOTE_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)),
  );
}

export async function publishSimpleLiveVote(input: {
  coordinatorNsec: string;
  prompt: string;
  relays?: string[];
  thresholdT?: number;
  thresholdN?: number;
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const coordinatorNpub = nip19.npubEncode(coordinatorHex);
  const relays = buildPublicRelays(input.relays);
  const createdAt = new Date().toISOString();
  const votingId = crypto.randomUUID();

  const event = finalizeEvent({
    kind: SIMPLE_LIVE_VOTE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-live-vote"],
      ["voting-id", votingId],
      ...(input.thresholdT !== undefined ? [["threshold-t", String(input.thresholdT)]] : []),
      ...(input.thresholdN !== undefined ? [["threshold-n", String(input.thresholdN)]] : []),
    ],
    content: JSON.stringify({
      voting_id: votingId,
      question_id: "yes_no",
      prompt: input.prompt,
      options: ["Yes", "No"],
      threshold_t: input.thresholdT,
      threshold_n: input.thresholdN,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(() => Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 })));
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
      votingId,
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

export async function fetchLatestSimpleLiveVote(input: {
  coordinatorNpub: string;
  relays?: string[];
}): Promise<SimpleLiveVoteSession | null> {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const coordinatorHex = decoded.data as string;
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_LIVE_VOTE_KIND],
      authors: [coordinatorHex],
      limit: 20,
    });

    const sessions = events.flatMap((event) => {
      try {
        const payload = JSON.parse(event.content) as {
          voting_id?: string;
          prompt?: string;
          threshold_t?: number;
          threshold_n?: number;
          created_at?: string;
        };

        if (!payload.voting_id || !payload.prompt) {
          return [];
        }

        return [{
          votingId: payload.voting_id,
          prompt: payload.prompt,
          coordinatorNpub: input.coordinatorNpub,
          createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
          thresholdT: typeof payload.threshold_t === "number" ? payload.threshold_t : undefined,
          thresholdN: typeof payload.threshold_n === "number" ? payload.threshold_n : undefined,
          eventId: event.id,
        }];
      } catch {
        return [];
      }
    });

    sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sessions[0] ?? null;
  } finally {
    pool.close(relays);
  }
}
