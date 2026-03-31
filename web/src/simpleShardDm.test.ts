import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const wrapEvent = vi.fn();
const unwrapEvent = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();

vi.mock("nostr-tools", () => ({
  getPublicKey,
  nip19: { decode },
  nip17: { wrapEvent, unwrapEvent },
  SimplePool: function () {
    return { publish, destroy, close, querySync };
  },
}));

vi.mock("./simpleShardCertificate", () => ({
  createSimpleShardCertificate: vi.fn(() => ({
    shardId: "resp-1",
    createdAt: "2026-03-31T00:00:00.000Z",
    event: { id: "cert-1", kind: 38993, pubkey: "ab".repeat(32), created_at: 10, tags: [], content: "{}", sig: "sig" },
  })),
  parseSimpleShardCertificate: vi.fn(() => ({
    shardId: "resp-1",
    coordinatorNpub: "npub1coord",
    thresholdLabel: "3 of 5",
    votingId: "vote-1",
    tokenCommitment: "commit-1",
    shareIndex: 1,
    thresholdT: 3,
    thresholdN: 5,
    createdAt: "2026-03-31T00:00:00.000Z",
    event: { id: "cert-1", kind: 38993, pubkey: "ab".repeat(32), created_at: 10, tags: [], content: "{}", sig: "sig" },
  })),
}));

describe("simpleShardDm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decode.mockImplementation((value: string) => {
      if (value.startsWith("npub")) {
        return { type: "npub", data: "ab".repeat(32) };
      }
      return { type: "nsec", data: new Uint8Array([1, 2, 3]) };
    });
    getPublicKey.mockReturnValue("cd".repeat(32));
    wrapEvent.mockReturnValue({ id: "evt-1", pubkey: "pk", content: "cipher" });
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
  });

  it("sends shard responses over the DM relay set", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleShardResponse({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      voterNpub: "npub1voter",
      requestId: "req-1",
      coordinatorNpub: "npub1coord",
      coordinatorId: "abc1234",
      thresholdLabel: "1 of 1",
      votingId: "vote-1",
      tokenCommitment: "commit-1",
      shareIndex: 1,
      thresholdT: 1,
      thresholdN: 1,
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(result.successes).toBeGreaterThan(0);
    expect(result.responseId).toBeTruthy();
  });

  it("fetches shard responses addressed to the voter", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([
      { created_at: 10 },
      { created_at: 9 },
    ]);
    unwrapEvent
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_shard_response",
          response_id: "resp-1",
          request_id: "req-1",
          coordinator_npub: "npub1coord",
          coordinator_id: "abc1234",
          threshold_label: "3 of 5",
          shard_certificate: { id: "cert-1" },
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      })
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_shard_request",
          request_id: "req-x",
        }),
      });

    const responses = await mod.fetchSimpleShardResponses({
      voterNsec: "nsec1voter",
    });

    expect(responses).toEqual([
      {
        id: "resp-1",
        requestId: "req-1",
        coordinatorNpub: "npub1coord",
        coordinatorId: "abc1234",
        thresholdLabel: "3 of 5",
        createdAt: "2026-03-31T00:00:00.000Z",
        shardCertificate: { id: "cert-1", kind: 38993, pubkey: "ab".repeat(32), created_at: 10, tags: [], content: "{}", sig: "sig" },
      },
    ]);
  });
});
