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
});
