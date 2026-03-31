import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();
const finalizeEvent = vi.fn();

vi.mock("nostr-tools", () => ({
  finalizeEvent,
  getPublicKey,
  nip19: { decode, npubEncode: vi.fn(() => "npub1coord") },
  SimplePool: function () {
    return { publish, destroy, close, querySync };
  },
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
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

  it("publishes a submitted vote", async () => {
    const mod = await import("./simpleVotingSession");

    const result = await mod.publishSimpleSubmittedVote({
      voterNsec: "nsec1voter",
      coordinatorNpub: "npub1coord",
      votingId: "vote-2",
      choice: "Yes",
      shardIds: ["resp-1"],
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
        created_at: 30,
        content: JSON.stringify({
          voting_id: "vote-2",
          choice: "Yes",
          voter_npub: "npub1voter",
          shard_ids: ["resp-1"],
          created_at: "2026-03-31T00:05:00.000Z",
        }),
      },
      {
        id: "ballot-2",
        created_at: 20,
        content: JSON.stringify({
          voting_id: "vote-x",
          choice: "No",
          voter_npub: "npub1other",
        }),
      },
    ]);

    const votes = await mod.fetchSimpleSubmittedVotes({
      coordinatorNpub: "npub1coord",
      votingId: "vote-2",
    });

    expect(votes).toEqual([
      {
        eventId: "ballot-1",
        votingId: "vote-2",
        coordinatorNpub: "npub1coord",
        voterNpub: "npub1voter",
        choice: "Yes",
        shardIds: ["resp-1"],
        createdAt: "2026-03-31T00:05:00.000Z",
      },
    ]);
  });
});
