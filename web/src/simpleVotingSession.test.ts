import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const subscribeMany = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();
const finalizeEvent = vi.fn();
const resolveNip65OutboxRelays = vi.fn();
const publishOwnNip65RelayHints = vi.fn();

vi.mock("nostr-tools", () => ({
  finalizeEvent,
  getPublicKey,
  nip19: { decode, npubEncode: vi.fn(() => "npub1coord") },
  SimplePool: function () {
    return { publish, destroy, close, querySync, subscribeMany };
  },
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ publish, destroy, close, querySync, subscribeMany }),
}));

vi.mock("./wasm/auditableVotingCore", async () => {
  const actual = await vi.importActual<typeof import("./wasm/auditableVotingCore")>("./wasm/auditableVotingCore");
  return {
    ...actual,
    normalizeRelaysRust: (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))),
  };
});

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

vi.mock("./nip65RelayHints", () => ({
  publishOwnNip65RelayHints,
  resolveNip65OutboxRelays,
}));

const toSimplePublicShardProof = vi.fn((certificate: any) => ({
  coordinatorNpub: certificate.coordinatorNpub,
  votingId: certificate.votingId,
  tokenCommitment: certificate.tokenMessage,
  unblindedSignature: certificate.unblindedSignature,
  shareIndex: certificate.shareIndex,
  keyAnnouncementEvent: certificate.keyAnnouncementEvent,
}));
const deriveTokenIdFromSimplePublicShardProofs = vi.fn(async () => "token-1");

vi.mock("./simpleShardCertificate", () => ({
  toSimplePublicShardProof,
  deriveTokenIdFromSimplePublicShardProofs,
}));

describe("simpleVotingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decode.mockImplementation((value: string) => {
      if (value.startsWith("npub")) {
        return { type: "npub", data: "ab".repeat(32) };
      }
      return { type: "nsec", data: new Uint8Array([1, 2, 3]) };
    });
    getPublicKey.mockReturnValue("cd".repeat(32));
    finalizeEvent.mockImplementation((event) => ({ id: "vote-session-1", pubkey: "pk", content: event.content }));
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
    resolveNip65OutboxRelays.mockImplementation(async ({ fallbackRelays }: { fallbackRelays: string[] }) => fallbackRelays);
    publishOwnNip65RelayHints.mockResolvedValue({ successes: 1 });
  });

  it("publishes a live vote announcement with authorized coordinators", async () => {
    const mod = await import("./simpleVotingSession");

    const result = await mod.publishSimpleLiveVote({
      coordinatorNsec: "nsec1coord",
      prompt: "Should the proposal pass?",
      thresholdT: 2,
      thresholdN: 3,
      authorizedCoordinatorNpubs: ["npub1coord", "npub1coord2", "npub1coord3"],
    });

    expect(finalizeEvent).toHaveBeenCalled();
    expect(result.votingId).toBeTruthy();
    expect(result.successes).toBeGreaterThan(0);
    expect(resolveNip65OutboxRelays).toHaveBeenCalledWith({
      npub: "npub1coord",
      fallbackRelays: expect.any(Array),
    });
    expect(publishOwnNip65RelayHints).toHaveBeenCalledWith({
      secretKey: new Uint8Array([1, 2, 3]),
      outboxRelays: expect.any(Array),
      publishRelays: expect.any(Array),
      channel: "nip65:npub1coord",
    });
    const liveVoteEvent = finalizeEvent.mock.calls
      .map((call) => call[0])
      .find((event) => event.kind === mod.SIMPLE_LIVE_VOTE_KIND);
    expect(liveVoteEvent?.tags).toEqual(
      expect.arrayContaining([
        ["coordinator", "npub1coord"],
        ["coordinator", "npub1coord2"],
        ["coordinator", "npub1coord3"],
      ]),
    );
  });

  it("fetches the latest live vote announcement", async () => {
    const mod = await import("./simpleVotingSession");

    querySync.mockResolvedValue([
      {
        id: "event-older",
        pubkey: "ab".repeat(32),
        created_at: 10,
        content: JSON.stringify({
          voting_id: "vote-1",
          prompt: "Older question",
          authorized_coordinators: ["npub1coord"],
          created_at: "2026-03-30T00:00:00.000Z",
        }),
      },
      {
        id: "event-newer",
        pubkey: "ab".repeat(32),
        created_at: 20,
        content: JSON.stringify({
          voting_id: "vote-2",
          prompt: "Latest question",
          threshold_t: 3,
          threshold_n: 5,
          authorized_coordinators: ["npub1coord", "npub1coord2"],
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      },
    ]);

    const session = await mod.fetchLatestSimpleLiveVote({
      coordinatorNpub: "npub1coord",
    });

    expect(session).toEqual({
      votingId: "vote-2",
      prompt: "Latest question",
      coordinatorNpub: "npub1coord",
      createdAt: "1970-01-01T00:00:20.000Z",
      thresholdT: 3,
      thresholdN: 5,
      authorizedCoordinatorNpubs: ["npub1coord", "npub1coord2"],
      eventId: "event-newer",
    });
  });

  it("backfills live vote sessions from history before relying on subscription events", async () => {
    const mod = await import("./simpleVotingSession");
    const onSessions = vi.fn();
    querySync.mockResolvedValue([
      {
        id: "event-history-1",
        pubkey: "ab".repeat(32),
        created_at: 40,
        content: JSON.stringify({
          voting_id: "vote-history-1",
          prompt: "History question",
          threshold_t: 2,
          threshold_n: 2,
          authorized_coordinators: ["npub1coord", "npub1coord2"],
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      },
    ]);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });

    const unsubscribe = mod.subscribeSimpleLiveVotes({
      coordinatorNpub: "npub1coord",
      onSessions,
    });

    await vi.waitFor(() => {
      expect(querySync).toHaveBeenCalled();
      expect(onSessions).toHaveBeenCalledWith([
        {
          votingId: "vote-history-1",
          prompt: "History question",
          coordinatorNpub: "npub1coord",
          createdAt: "1970-01-01T00:00:40.000Z",
          thresholdT: 2,
          thresholdN: 2,
          authorizedCoordinatorNpubs: ["npub1coord", "npub1coord2"],
          eventId: "event-history-1",
        },
      ]);
    });
    unsubscribe();
  });

  it("publishes a submitted vote using public shard proofs", async () => {
    const mod = await import("./simpleVotingSession");

    const result = await mod.publishSimpleSubmittedVote({
      ballotNsec: "nsec1voter",
      votingId: "vote-2",
      choice: "Yes",
      shardCertificates: [{
        shareId: "cert-1",
        requestId: "request-1",
        coordinatorNpub: "npub1coord",
        votingId: "vote-2",
        tokenMessage: "commit-1",
        unblindedSignature: "sig-1",
        shareIndex: 1,
        createdAt: "2026-03-31T00:00:00.000Z",
        keyAnnouncementEvent: { id: "blind-key-1" },
      }],
    });

    expect(toSimplePublicShardProof).toHaveBeenCalled();
    expect(deriveTokenIdFromSimplePublicShardProofs).toHaveBeenCalled();
    expect(result.eventId).toBe("vote-session-1");
    const payload = JSON.parse(finalizeEvent.mock.calls.at(-1)?.[0]?.content ?? "{}");
    expect(payload.shard_proofs).toHaveLength(1);
    expect(payload.shard_proofs[0]).toEqual(expect.objectContaining({
      coordinatorNpub: "npub1coord",
      votingId: "vote-2",
      tokenCommitment: "commit-1",
    }));
  });

  it("fetches submitted votes for a voting id", async () => {
    const mod = await import("./simpleVotingSession");

    querySync.mockResolvedValue([
      {
        id: "ballot-1",
        pubkey: "ef".repeat(32),
        created_at: 30,
        content: JSON.stringify({
          voting_id: "vote-2",
          choice: "Yes",
          shard_proofs: [{
            coordinatorNpub: "npub1coord",
            votingId: "vote-2",
            tokenCommitment: "commit-1",
            unblindedSignature: "sig-1",
            shareIndex: 1,
            keyAnnouncementEvent: { id: "blind-key-1" },
          }],
          created_at: "2026-03-31T00:05:00.000Z",
        }),
      },
    ]);

    const votes = await mod.fetchSimpleSubmittedVotes({
      votingId: "vote-2",
    });

    expect(votes).toEqual([
      {
        eventId: "ballot-1",
        votingId: "vote-2",
        voterNpub: "npub1coord",
        choice: "Yes",
        shardProofs: [{
          coordinatorNpub: "npub1coord",
          votingId: "vote-2",
          tokenCommitment: "commit-1",
          unblindedSignature: "sig-1",
          shareIndex: 1,
          keyAnnouncementEvent: { id: "blind-key-1" },
        }],
        tokenId: "token-1",
        createdAt: "1970-01-01T00:00:30.000Z",
      },
    ]);
  });

  it("prefers signed event metadata over payload created_at for submitted vote ordering", async () => {
    const mod = await import("./simpleVotingSession");

    querySync.mockResolvedValue([
      {
        id: "ballot-older-event",
        pubkey: "ef".repeat(32),
        created_at: 10,
        content: JSON.stringify({
          voting_id: "vote-2",
          choice: "Yes",
          shard_proofs: [{
            coordinatorNpub: "npub1coord",
            votingId: "vote-2",
            tokenCommitment: "commit-1",
            unblindedSignature: "sig-1",
            shareIndex: 1,
            keyAnnouncementEvent: { id: "blind-key-1" },
          }],
          created_at: "2099-01-01T00:00:00.000Z",
        }),
      },
    ]);

    const votes = await mod.fetchSimpleSubmittedVotes({
      votingId: "vote-2",
    });

    expect(votes[0]?.createdAt).toBe("1970-01-01T00:00:10.000Z");
  });
});
