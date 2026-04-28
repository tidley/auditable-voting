import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  publishOwnNip65RelayHints,
  resolveNip65OutboxRelays,
} from "./nip65RelayHints";
import { getSharedNostrPool } from "./sharedNostrPool";
import {
  deriveTokenIdFromSimplePublicShardProofs,
  toSimplePublicShardProof,
  type SimpleShardCertificate,
  type SimplePublicShardProof,
} from "./simpleShardCertificate";
import { recordRelayCloseReasons, recordRelayOutcome, rankRelaysByBackoff, selectRelaysWithBackoff } from "./relayBackoff";
import { normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";

export const SIMPLE_PUBLIC_RELAYS = [
  "wss://relay.nostr.net",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.wine",
  "wss://nostr.mom",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.damus.io",
  "wss://purplepag.es",
  "wss://eden.nostr.land",
];

export const SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS = 1500;
export const SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS = 1500;
export const SIMPLE_PUBLIC_PUBLISH_STAGGER_MS = 300;
export const SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS = 500;
const SIMPLE_PUBLIC_READ_RELAYS_MAX = 2;

// Use regular custom event kinds so relays preserve the full transcript instead of replacing by author/d-tag.
export const SIMPLE_LIVE_VOTE_KIND = 14090;
export const SIMPLE_LIVE_VOTE_BALLOT_KIND = 14091;

export type SimpleLiveVoteSession = {
  votingId: string;
  prompt: string;
  coordinatorNpub: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  authorizedCoordinatorNpubs: string[];
  eventId: string;
};

export type SimpleSubmittedVote = {
  eventId: string;
  ballotId?: string;
  votingId: string;
  voterNpub: string;
  choice: "Yes" | "No";
  shardProofs: SimplePublicShardProof[];
  tokenId: string | null;
  requestId?: string;
  ticketId?: string;
  createdAt: string;
};

function buildPublicRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...SIMPLE_PUBLIC_RELAYS, ...(relays ?? [])]));
}

function selectPublicReadRelays(relays: string[]) {
  return selectRelaysWithBackoff(relays, SIMPLE_PUBLIC_READ_RELAYS_MAX);
}

function sortByCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return sortRecordsByCreatedAtDescRust(values);
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
      authorized_coordinators?: string[];
      created_at?: string;
    };

    if (!payload.voting_id || !payload.prompt) {
      return null;
    }

    return {
      votingId: payload.voting_id,
      prompt: payload.prompt,
      coordinatorNpub: fallbackCoordinatorNpub ?? nip19.npubEncode(event.pubkey),
      createdAt: new Date(event.created_at * 1000).toISOString(),
      thresholdT: typeof payload.threshold_t === "number" ? payload.threshold_t : undefined,
      thresholdN: typeof payload.threshold_n === "number" ? payload.threshold_n : undefined,
      authorizedCoordinatorNpubs: Array.from(
        new Set(
          (Array.isArray(payload.authorized_coordinators)
            ? payload.authorized_coordinators
            : [fallbackCoordinatorNpub ?? nip19.npubEncode(event.pubkey)])
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
        ),
      ),
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
      ballot_id?: string;
      voting_id?: string;
      choice?: "Yes" | "No";
      shard_proofs?: SimplePublicShardProof[];
      shard_certificates?: SimpleShardCertificate[];
      request_id?: string;
      ticket_id?: string;
      created_at?: string;
    };

    if (
      payload.voting_id !== votingId
      || (payload.choice !== "Yes" && payload.choice !== "No")
    ) {
      return null;
    }

    const shardProofs = Array.isArray(payload.shard_proofs)
      ? payload.shard_proofs
      : Array.isArray(payload.shard_certificates)
        ? payload.shard_certificates.map((certificate) => toSimplePublicShardProof(certificate))
        : [];

    return {
      eventId: event.id,
      ballotId: typeof payload.ballot_id === "string" && payload.ballot_id.trim().length > 0
        ? payload.ballot_id.trim()
        : event.id,
      votingId: payload.voting_id,
      voterNpub: nip19.npubEncode(event.pubkey),
      choice: payload.choice,
      shardProofs,
      tokenId: await deriveTokenIdFromSimplePublicShardProofs(shardProofs),
      requestId: typeof payload.request_id === "string" && payload.request_id.trim().length > 0
        ? payload.request_id.trim()
        : undefined,
      ticketId: typeof payload.ticket_id === "string" && payload.ticket_id.trim().length > 0
        ? payload.ticket_id.trim()
        : undefined,
      createdAt: new Date(event.created_at * 1000).toISOString(),
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
  authorizedCoordinatorNpubs?: string[];
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorHex = getPublicKey(secretKey);
  const coordinatorNpub = nip19.npubEncode(coordinatorHex);
  const relays = await resolveNip65OutboxRelays({
    npub: coordinatorNpub,
    fallbackRelays: buildPublicRelays(input.relays),
  });
  await publishOwnNip65RelayHints({
    secretKey,
    outboxRelays: relays,
    publishRelays: relays,
    channel: `nip65:${coordinatorNpub}`,
  }).catch(() => null);
  const createdAt = new Date().toISOString();
  const votingId = input.votingId?.trim() || crypto.randomUUID();
  const authorizedCoordinatorNpubs = Array.from(
    new Set(
      (input.authorizedCoordinatorNpubs?.length
        ? input.authorizedCoordinatorNpubs
        : [coordinatorNpub]).filter((value) => value.trim().length > 0),
    ),
  );

  const event = finalizeEvent({
    kind: SIMPLE_LIVE_VOTE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-live-vote"],
      ["voting-id", votingId],
      ...authorizedCoordinatorNpubs.map((coordinatorNpub) => ["coordinator", coordinatorNpub] as [string, string]),
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
      authorized_coordinators: authorizedCoordinatorNpubs,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = getSharedNostrPool();
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
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }

  return {
    votingId,
    eventId: event.id,
    coordinatorNpub,
    createdAt,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
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
  const relays = selectPublicReadRelays(await resolveNip65OutboxRelays({
    npub: input.coordinatorNpub,
    fallbackRelays: buildPublicRelays(input.relays),
  }));
  const pool = getSharedNostrPool();
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
  const fallbackRelays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();
  const sessions = new Map<string, SimpleLiveVoteSession>();
  let closed = false;
  let intervalId: number | null = null;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void resolveNip65OutboxRelays({
    npub: input.coordinatorNpub,
    fallbackRelays,
  }).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const relays = selectPublicReadRelays(resolvedRelays);
    const publishLatest = () => {
      input.onSession(sortByCreatedAtDescending([...sessions.values()])[0] ?? null);
    };

    const refreshFromHistory = async () => {
      const events = await pool.querySync(relays, {
        kinds: [SIMPLE_LIVE_VOTE_KIND],
        authors: [coordinatorHex],
        limit: 20,
      });

      for (const event of events) {
        const session = parseSimpleLiveVoteEvent(event, input.coordinatorNpub);
        if (session) {
          sessions.set(session.eventId, session);
        }
      }

      publishLatest();
    };

    void refreshFromHistory().catch((error) => {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });
    intervalId = window.setInterval(() => {
      void refreshFromHistory().catch(() => undefined);
    }, 5000);

    subscription = pool.subscribeMany(relays, {
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
        publishLatest();
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }
        recordRelayCloseReasons(reasons);

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
    });
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
    }
    void subscription?.close("closed by caller");
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
  const fallbackRelays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();
  const sessions = new Map<string, SimpleLiveVoteSession>();
  let closed = false;
  let intervalId: number | null = null;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;

  void resolveNip65OutboxRelays({
    npub: input.coordinatorNpub,
    fallbackRelays,
  }).then((resolvedRelays) => {
    if (closed) {
      return;
    }
    const relays = selectPublicReadRelays(resolvedRelays);
    const publishSessions = () => {
      input.onSessions(sortByCreatedAtDescending([...sessions.values()]));
    };

    const refreshFromHistory = async () => {
      const events = await pool.querySync(relays, {
        kinds: [SIMPLE_LIVE_VOTE_KIND],
        authors: [coordinatorHex],
        limit: 100,
      });

      for (const event of events) {
        const session = parseSimpleLiveVoteEvent(event, input.coordinatorNpub);
        if (session) {
          sessions.set(session.eventId, session);
        }
      }

      publishSessions();
    };

    void refreshFromHistory().catch((error) => {
      if (!closed && error instanceof Error) {
        input.onError?.(error);
      }
    });
    intervalId = window.setInterval(() => {
      void refreshFromHistory().catch(() => undefined);
    }, 5000);

    subscription = pool.subscribeMany(relays, {
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
        publishSessions();
      },
      onclose: (reasons) => {
        if (closed) {
          return;
        }
        recordRelayCloseReasons(reasons);

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
        }
      },
      maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
    });
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
    }
    void subscription?.close("closed by caller");
  };
}

export async function fetchSimpleLiveVotes(input?: {
  relays?: string[];
}): Promise<SimpleLiveVoteSession[]> {
  const relays = selectPublicReadRelays(buildPublicRelays(input?.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [SIMPLE_LIVE_VOTE_KIND],
    limit: 200,
  });

  return sortByCreatedAtDescending(
    events
      .map((event) => parseSimpleLiveVoteEvent(event))
      .filter((session): session is SimpleLiveVoteSession => session !== null),
  );
}

export async function publishSimpleSubmittedVote(input: {
  ballotNsec: string;
  votingId: string;
  choice: "Yes" | "No";
  shardCertificates: SimpleShardCertificate[];
  ballotId?: string;
  requestId?: string;
  ticketId?: string;
  relays?: string[];
}) {
  const ballotDecoded = nip19.decode(input.ballotNsec.trim());
  if (ballotDecoded.type !== "nsec") {
    throw new Error("Ballot key must be an nsec.");
  }

  const secretKey = ballotDecoded.data as Uint8Array;
  const ballotNpub = nip19.npubEncode(getPublicKey(secretKey));
  const coordinatorRelays = await Promise.all(
    Array.from(new Set(input.shardCertificates.map((certificate) => certificate.coordinatorNpub))).map(
      async (coordinatorNpub) => resolveNip65OutboxRelays({
        npub: coordinatorNpub,
        fallbackRelays: buildPublicRelays(input.relays),
      }),
    ),
  );
  const relays = Array.from(new Set(coordinatorRelays.flat()));
  await publishOwnNip65RelayHints({
    secretKey,
    outboxRelays: relays,
    publishRelays: relays,
    channel: `nip65:${ballotNpub}`,
  }).catch(() => null);
  const createdAt = new Date().toISOString();
  const ballotId = input.ballotId?.trim() || crypto.randomUUID();
  const shardProofs = input.shardCertificates.map((certificate) =>
    toSimplePublicShardProof(certificate),
  );
  const tokenId = await deriveTokenIdFromSimplePublicShardProofs(shardProofs);

  const event = finalizeEvent({
    kind: SIMPLE_LIVE_VOTE_BALLOT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-live-vote-ballot"],
      ["d", input.votingId],
      ["ballot-id", ballotId],
      ...(input.requestId?.trim() ? [["request-id", input.requestId.trim()]] : []),
      ...(input.ticketId?.trim() ? [["ticket-id", input.ticketId.trim()]] : []),
      ...(tokenId ? [["token-id", tokenId]] : []),
      ...shardProofs.map((proof) => ["coordinator", proof.coordinatorNpub] as [string, string]),
    ],
    content: JSON.stringify({
      ballot_id: ballotId,
      voting_id: input.votingId,
      choice: input.choice,
      shard_proofs: shardProofs,
      request_id: input.requestId?.trim() || undefined,
      ticket_id: input.ticketId?.trim() || undefined,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = getSharedNostrPool();
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
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }

  return {
    eventId: event.id,
    ballotId,
    ballotNpub,
    tokenId,
    createdAt,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
  };
}

export async function fetchSimpleSubmittedVotes(input: {
  votingId: string;
  relays?: string[];
}): Promise<SimpleSubmittedVote[]> {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
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
}

export function subscribeSimpleSubmittedVotes(input: {
  votingId: string;
  relays?: string[];
  onVotes: (votes: SimpleSubmittedVote[]) => void;
  onError?: (error: Error) => void;
}): () => void {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const votes = new Map<string, SimpleSubmittedVote>();
  let closed = false;

  const publishVotes = () => {
    input.onVotes(sortByCreatedAtDescending([...votes.values()]));
  };

  const refreshFromHistory = async () => {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_LIVE_VOTE_BALLOT_KIND],
      "#d": [input.votingId],
      limit: 200,
    });

    for (const event of events) {
      const vote = await parseSimpleSubmittedVoteEvent(event, input.votingId);
      if (vote) {
        votes.set(vote.eventId, vote);
      }
    }

    publishVotes();
  };

  void refreshFromHistory().catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  const intervalId = window.setInterval(() => {
    void refreshFromHistory().catch(() => undefined);
  }, 5000);

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
      publishVotes();
    },
    onclose: (reasons) => {
      if (closed) {
        return;
      }
      recordRelayCloseReasons(reasons);

      const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
      if (errors.length > 0) {
        input.onError?.(new Error(errors.join("; ")));
      }
    },
    maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
  });

  return () => {
    closed = true;
    window.clearInterval(intervalId);
    void subscription.close("closed by caller");
  };
}
