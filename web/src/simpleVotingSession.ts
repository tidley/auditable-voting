import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { DEFAULT_VOTE_RELAYS } from "./ballot";
import { queueNostrPublish } from "./nostrPublishQueue";

export const SIMPLE_LIVE_VOTE_KIND = 38990;
export const SIMPLE_LIVE_VOTE_BALLOT_KIND = 38991;

export type SimpleLiveVoteSession = {
  votingId: string;
  prompt: string;
  coordinatorNpub: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  eventId: string;
};

export type SimpleSubmittedVote = {
  eventId: string;
  votingId: string;
  coordinatorNpub: string;
  voterNpub: string;
  choice: "Yes" | "No";
  shardIds: string[];
  createdAt: string;
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

export async function publishSimpleSubmittedVote(input: {
  voterNsec: string;
  coordinatorNpub: string;
  votingId: string;
  choice: "Yes" | "No";
  shardIds: string[];
  relays?: string[];
}) {
  const voterDecoded = nip19.decode(input.voterNsec.trim());
  if (voterDecoded.type !== "nsec") {
    throw new Error("Voter key must be an nsec.");
  }

  const coordinatorDecoded = nip19.decode(input.coordinatorNpub.trim());
  if (coordinatorDecoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const secretKey = voterDecoded.data as Uint8Array;
  const coordinatorHex = coordinatorDecoded.data as string;
  const voterNpub = nip19.npubEncode(getPublicKey(secretKey));
  const relays = buildPublicRelays(input.relays);
  const createdAt = new Date().toISOString();

  const event = finalizeEvent({
    kind: SIMPLE_LIVE_VOTE_BALLOT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-live-vote-ballot"],
      ["p", coordinatorHex],
      ["d", input.votingId],
      ...input.shardIds.map((shardId) => ["s", shardId]),
    ],
    content: JSON.stringify({
      voting_id: input.votingId,
      choice: input.choice,
      voter_npub: voterNpub,
      shard_ids: input.shardIds,
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
      eventId: event.id,
      voterNpub,
      createdAt,
      successes: relayResults.filter((result) => result.success).length,
      failures: relayResults.filter((result) => !result.success).length,
      relayResults,
    };
  } finally {
    pool.destroy();
  }
}

export async function fetchSimpleSubmittedVotes(input: {
  coordinatorNpub: string;
  votingId: string;
  relays?: string[];
}): Promise<SimpleSubmittedVote[]> {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const coordinatorHex = decoded.data as string;
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_LIVE_VOTE_BALLOT_KIND],
      "#p": [coordinatorHex],
      limit: 200,
    });

    const votes = new Map<string, SimpleSubmittedVote>();

    for (const event of events) {
      try {
        const payload = JSON.parse(event.content) as {
          voting_id?: string;
          choice?: "Yes" | "No";
          voter_npub?: string;
          shard_ids?: string[];
          created_at?: string;
        };

        if (
          payload.voting_id !== input.votingId
          || (payload.choice !== "Yes" && payload.choice !== "No")
          || !payload.voter_npub
        ) {
          continue;
        }

        votes.set(event.id, {
          eventId: event.id,
          votingId: payload.voting_id,
          coordinatorNpub: input.coordinatorNpub,
          voterNpub: payload.voter_npub,
          choice: payload.choice,
          shardIds: Array.isArray(payload.shard_ids) ? payload.shard_ids : [],
          createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
        });
      } catch {
        continue;
      }
    }

    return [...votes.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } finally {
    pool.close(relays);
  }
}
