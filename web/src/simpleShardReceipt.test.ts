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

describe("simpleShardReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decode.mockImplementation((value: string) => {
      if (value.startsWith("npub")) {
        return { type: "npub", data: "ab".repeat(32) };
      }
      return { type: "nsec", data: new Uint8Array([1, 2, 3]) };
    });
    getPublicKey.mockReturnValue("cd".repeat(32));
    finalizeEvent.mockReturnValue({ id: "receipt-1", pubkey: "pk", content: "{}" });
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
  });

  it("publishes a shard receipt", async () => {
    const mod = await import("./simpleShardReceipt");

    const result = await mod.publishSimpleShardReceipt({
      coordinatorNsec: "nsec1coord",
      shardId: "resp-1",
      thresholdLabel: "1 of 1",
    });

    expect(finalizeEvent).toHaveBeenCalled();
    expect(result.eventId).toBe("receipt-1");
  });

  it("fetches shard receipts", async () => {
    const mod = await import("./simpleShardReceipt");

    querySync.mockResolvedValue([
      {
        id: "receipt-evt-1",
        created_at: 20,
        content: JSON.stringify({
          shard_id: "resp-1",
          threshold_label: "1 of 1",
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      },
    ]);

    const receipts = await mod.fetchSimpleShardReceipts({
      coordinatorNpub: "npub1coord",
    });

    expect(receipts).toEqual([
      {
        eventId: "receipt-evt-1",
        shardId: "resp-1",
        coordinatorNpub: "npub1coord",
        thresholdLabel: "1 of 1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ]);
  });
});
