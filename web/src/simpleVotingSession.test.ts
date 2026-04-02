import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const subscribeMany = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();
const finalizeEvent = vi.fn();

vi.mock("nostr-tools", () => ({
  finalizeEvent,
  getPublicKey,
  nip19: { decode, npubEncode: vi.fn(() => "npub1coord") },
  SimplePool: function () {
    return { publish, destroy, close, querySync, subscribeMany };
  },
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

vi.mock("./simpleShardCertificate", () => ({
  deriveTokenIdFromSimpleShardCertificates: vi.fn(async () => "token-1"),
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
    finalizeEvent.mockReturnValue({ id: "vote-session-1", pubkey: "pk", content: "{}" });
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
  });

  it("publishes a live vote announcement", async () => {
    const mod = await import("./simpleVotingSession");

    const result = await mod.publishSimpleLiveVote({
      coordinatorNsec: "nsec1coord",
      prompt: "Should the proposal pass?",
      thresholdT: 1,
      thresholdN: 1,
    });

    expect(finalizeEvent).toHaveBeenCalled();
    expect(result.votingId).toBeTruthy();
    expect(result.successes).toBeGreaterThan(0);
  });

  it("fetches the latest live vote announcement", async () => {
    const mod = await import("./simpleVotingSession");

    querySync.mockResolvedValue([
      {
        id: "event-older",
        created_at: 10,
        content: JSON.stringify({
          voting_id: "vote-1",
          prompt: "Older question",
          created_at: "2026-03-30T00:00:00.000Z",
        }),
      },
      {
        id: "event-newer",
        created_at: 20,
        content: JSON.stringify({
          voting_id: "vote-2",
          prompt: "Latest question",
          threshold_t: 3,
          threshold_n: 5,
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
      createdAt: "2026-03-31T00:00:00.000Z",
      thresholdT: 3,
      thresholdN: 5,
      eventId: "event-newer",
    });
  });

  it("subscribes to the latest live vote announcement", async () => {
    const mod = await import("./simpleVotingSession");
    const onSession = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: any) => void }) => {
      params.onevent?.({
        id: "event-older",
        pubkey: "ab".repeat(32),
        created_at: 10,
        content: JSON.stringify({
          voting_id: "vote-1",
          prompt: "Older question",
          created_at: "2026-03-30T00:00:00.000Z",
        }),
      });
      params.onevent?.({
        id: "event-newer",
        pubkey: "ab".repeat(32),
        created_at: 20,
        content: JSON.stringify({
          voting_id: "vote-2",
          prompt: "Latest question",
          threshold_t: 3,
          threshold_n: 5,
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      });
      return { close: vi.fn(async () => undefined) };
    });

    const unsubscribe = mod.subscribeLatestSimpleLiveVote({
      coordinatorNpub: "npub1coord",
      onSession,
    });

    expect(onSession).toHaveBeenLastCalledWith({
      votingId: "vote-2",
      prompt: "Latest question",
      coordinatorNpub: "npub1coord",
      createdAt: "2026-03-31T00:00:00.000Z",
      thresholdT: 3,
      thresholdN: 5,
      eventId: "event-newer",
    });

    unsubscribe();
  });

  it("publishes a submitted vote", async () => {
    const mod = await import("./simpleVotingSession");

    const result = await mod.publishSimpleSubmittedVote({
      ballotNsec: "nsec1voter",
      votingId: "vote-2",
      choice: "Yes",
      shardCertificates: [{
        id: "cert-1",
        kind: 38993,
        pubkey: "ab".repeat(32),
        created_at: 10,
        tags: [],
        content: JSON.stringify({
          shard_id: "resp-1",
          threshold_label: "1 of 1",
          voting_id: "vote-2",
          token_commitment: "commit-1",
          share_index: 1,
        }),
        sig: "sig",
      }],
    });

    expect(finalizeEvent).toHaveBeenCalled();
    expect(result.eventId).toBe("vote-session-1");
    expect(result.successes).toBeGreaterThan(0);
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
          shard_certificates: [{
            id: "cert-1",
            kind: 38993,
            pubkey: "ab".repeat(32),
            created_at: 10,
            tags: [],
            content: JSON.stringify({
              shard_id: "resp-1",
              threshold_label: "1 of 1",
              voting_id: "vote-2",
              token_commitment: "commit-1",
              share_index: 1,
            }),
            sig: "sig",
          }],
          created_at: "2026-03-31T00:05:00.000Z",
        }),
      },
      {
        id: "ballot-2",
        pubkey: "12".repeat(32),
        created_at: 20,
        content: JSON.stringify({
          voting_id: "vote-x",
          choice: "No",
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
        shardCertificates: [{
          id: "cert-1",
          kind: 38993,
          pubkey: "ab".repeat(32),
          created_at: 10,
          tags: [],
          content: JSON.stringify({
            shard_id: "resp-1",
            threshold_label: "1 of 1",
            voting_id: "vote-2",
            token_commitment: "commit-1",
            share_index: 1,
          }),
          sig: "sig",
        }],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:05:00.000Z",
      },
    ]);
  });

  it("subscribes to submitted vote updates", async () => {
    const mod = await import("./simpleVotingSession");
    const onVotes = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: any) => void }) => {
      params.onevent?.({
        id: "ballot-1",
        pubkey: "ef".repeat(32),
        created_at: 30,
        content: JSON.stringify({
          voting_id: "vote-2",
          choice: "Yes",
          shard_certificates: [{
            id: "cert-1",
            kind: 38993,
            pubkey: "ab".repeat(32),
            created_at: 10,
            tags: [],
            content: JSON.stringify({
              shard_id: "resp-1",
              threshold_label: "1 of 1",
              voting_id: "vote-2",
              token_commitment: "commit-1",
              share_index: 1,
            }),
            sig: "sig",
          }],
          created_at: "2026-03-31T00:05:00.000Z",
        }),
      });
      return { close: vi.fn(async () => undefined) };
    });

    const unsubscribe = mod.subscribeSimpleSubmittedVotes({
      votingId: "vote-2",
      onVotes,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onVotes).toHaveBeenLastCalledWith([
      {
        eventId: "ballot-1",
        votingId: "vote-2",
        voterNpub: "npub1coord",
        choice: "Yes",
        shardCertificates: [{
          id: "cert-1",
          kind: 38993,
          pubkey: "ab".repeat(32),
          created_at: 10,
          tags: [],
          content: JSON.stringify({
            shard_id: "resp-1",
            threshold_label: "1 of 1",
            voting_id: "vote-2",
            token_commitment: "commit-1",
            share_index: 1,
          }),
          sig: "sig",
        }],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:05:00.000Z",
      },
    ]);

    unsubscribe();
  });
});
