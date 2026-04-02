import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  deriveTokenIdFromSimpleShardCertificates,
  type SimpleShardCertificate,
} from "./simpleShardCertificate";

export const SIMPLE_PUBLIC_RELAYS = [
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.nostr.band",
  "wss://relay.damus.io",
];

export const SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS = 1500;
export const SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS = 1500;
export const SIMPLE_PUBLIC_PUBLISH_STAGGER_MS = 300;
export const SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS = 500;

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
  voterNpub: string;
  choice: "Yes" | "No";
  shardCertificates: SimpleShardCertificate[];
  tokenId: string | null;
  createdAt: string;
};

function buildPublicRelays(relays?: string[]) {
  return Array.from(
    new Set([...SIMPLE_PUBLIC_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)),
  );
}

function sortByCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function parseSimpleLiveVoteEvent(
  event: { id: string; pubkey: string; created_at: number; content: string },
  fallbackCoordinatorNpub?: string,
): SimpleLiveVoteSession | null {
  try {
    const payload = JSON.parse(event.content) as {
      voting_id?: string;
      prompt?: string;
      threshold_t?: number;
      threshold_n?: number;
      created_at?: string;
    };

    if (!payload.voting_id || !payload.prompt) {
      return null;
    }

    return {
      votingId: payload.voting_id,
      prompt: payload.prompt,
      coordinatorNpub: fallbackCoordinatorNpub ?? nip19.npubEncode(event.pubkey),
      createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
      thresholdT: typeof payload.threshold_t === "number" ? payload.threshold_t : undefined,
      thresholdN: typeof payload.threshold_n === "number" ? payload.threshold_n : undefined,
      eventId: event.id,
    };
  } catch {
    return null;
  }
}

async function parseSimpleSubmittedVoteEvent(
  event: { id: string; pubkey: string; created_at: number; content: string },
  votingId: string,
): Promise<SimpleSubmittedVote | null> {
  try {
    const payload = JSON.parse(event.content) as {
      voting_id?: string;
      choice?: "Yes" | "No";
      shard_certificates?: SimpleShardCertificate[];
      created_at?: string;
    };

    if (
      payload.voting_id !== votingId
      || (payload.choice !== "Yes" && payload.choice !== "No")
    ) {
      return null;
    }

    const shardCertificates = Array.isArray(payload.shard_certificates) ? payload.shard_certificates : [];

    return {
      eventId: event.id,
      votingId: payload.voting_id,
      voterNpub: nip19.npubEncode(event.pubkey),
      choice: payload.choice,
      shardCertificates,
      tokenId: await deriveTokenIdFromSimpleShardCertificates(shardCertificates),
      createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function publishSimpleLiveVote(input: {
  coordinatorNsec: string;
  prompt: string;
  votingId?: string;
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
  const votingId = input.votingId?.trim() || crypto.randomUUID();

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
    const results = await queueNostrPublish(
      () => publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
        relays,
        { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
      ),
      { channel: "simple-public", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
    );
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

    const sessions = events
      .map((event) => parseSimpleLiveVoteEvent(event, input.coordinatorNpub))
      .filter((session): session is SimpleLiveVoteSession => session !== null);

    sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sessions[0] ?? null;
  } finally {
    pool.close(relays);
  }
}

export function subscribeLatestSimpleLiveVote(input: {
  coordinatorNpub: string;
  relays?: string[];
  onSession: (session: SimpleLiveVoteSession | null) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const coordinatorHex = decoded.data as string;
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();
  const sessions = new Map<string, SimpleLiveVoteSession>();
  let closed = false;

  const subscription = pool.subscribeMany(relays, {
    kinds: [SIMPLE_LIVE_VOTE_KIND],
    authors: [coordinatorHex],
    limit: 20,
  }, {
    onevent: (event) => {
      const session = parseSimpleLiveVoteEvent(event, input.coordinatorNpub);
      if (!session) {
        return;
      }

      sessions.set(session.eventId, session);
      input.onSession(sortByCreatedAtDescending([...sessions.values()])[0] ?? null);
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
    maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export function subscribeSimpleLiveVotes(input: {
  coordinatorNpub: string;
  relays?: string[];
  onSessions: (sessions: SimpleLiveVoteSession[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const coordinatorHex = decoded.data as string;
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();
  const sessions = new Map<string, SimpleLiveVoteSession>();
  let closed = false;

  const subscription = pool.subscribeMany(relays, {
    kinds: [SIMPLE_LIVE_VOTE_KIND],
    authors: [coordinatorHex],
    limit: 100,
  }, {
    onevent: (event) => {
      const session = parseSimpleLiveVoteEvent(event, input.coordinatorNpub);
      if (!session) {
        return;
      }

      sessions.set(session.eventId, session);
      input.onSessions(sortByCreatedAtDescending([...sessions.values()]));
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
    maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export async function fetchSimpleLiveVotes(input?: {
  relays?: string[];
}): Promise<SimpleLiveVoteSession[]> {
  const relays = buildPublicRelays(input?.relays);
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_LIVE_VOTE_KIND],
      limit: 200,
    });

    return sortByCreatedAtDescending(
      events
        .map((event) => parseSimpleLiveVoteEvent(event))
        .filter((session): session is SimpleLiveVoteSession => session !== null),
    );
  } finally {
    pool.close(relays);
  }
}

export async function publishSimpleSubmittedVote(input: {
  ballotNsec: string;
  votingId: string;
  choice: "Yes" | "No";
  shardCertificates: SimpleShardCertificate[];
  relays?: string[];
}) {
  const ballotDecoded = nip19.decode(input.ballotNsec.trim());
  if (ballotDecoded.type !== "nsec") {
    throw new Error("Ballot key must be an nsec.");
  }

  const secretKey = ballotDecoded.data as Uint8Array;
  const ballotNpub = nip19.npubEncode(getPublicKey(secretKey));
  const relays = buildPublicRelays(input.relays);
  const createdAt = new Date().toISOString();

  const event = finalizeEvent({
    kind: SIMPLE_LIVE_VOTE_BALLOT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-live-vote-ballot"],
      ["d", input.votingId],
      ...input.shardCertificates.map((certificate) => ["s", certificate.shareId]),
    ],
    content: JSON.stringify({
      voting_id: input.votingId,
      choice: input.choice,
      shard_certificates: input.shardCertificates,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(
      () => publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
        relays,
        { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
      ),
      { channel: "simple-public", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
    );
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
      ballotNpub,
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
  votingId: string;
  relays?: string[];
}): Promise<SimpleSubmittedVote[]> {
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_LIVE_VOTE_BALLOT_KIND],
      "#d": [input.votingId],
      limit: 200,
    });

    const votes = new Map<string, SimpleSubmittedVote>();

    for (const event of events) {
      const vote = await parseSimpleSubmittedVoteEvent(event, input.votingId);
      if (vote) {
        votes.set(event.id, vote);
      }
    }

    return sortByCreatedAtDescending([...votes.values()]);
  } finally {
    pool.close(relays);
  }
}

export function subscribeSimpleSubmittedVotes(input: {
  votingId: string;
  relays?: string[];
  onVotes: (votes: SimpleSubmittedVote[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();
  const votes = new Map<string, SimpleSubmittedVote>();
  let closed = false;

  const subscription = pool.subscribeMany(relays, {
    kinds: [SIMPLE_LIVE_VOTE_BALLOT_KIND],
    "#d": [input.votingId],
    limit: 200,
  }, {
    onevent: async (event) => {
      const vote = await parseSimpleSubmittedVoteEvent(event, input.votingId);
      if (!vote) {
        return;
      }

      votes.set(vote.eventId, vote);
      input.onVotes(sortByCreatedAtDescending([...votes.values()]));
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
    maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}
