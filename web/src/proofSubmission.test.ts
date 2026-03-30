import { describe, it, expect, vi, beforeEach } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const wrapEvent = vi.fn();
const decode = vi.fn();

vi.mock("nostr-tools", () => ({
  nip19: { decode },
  nip17: { wrapEvent },
  SimplePool: function () { return { publish, destroy }; },
}));

describe("proofSubmission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decode.mockReturnValue({ type: "npub", data: "ab".repeat(32) });
    wrapEvent.mockReturnValue({ id: "evt-1", pubkey: "pk", content: "cipher" });
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
  });

  it("submits proof DM and returns relay counts", async () => {
    const mod = await import("./proofSubmission");
    const result = await mod.submitProofViaDm({
      voterSecretKey: new Uint8Array([1]),
      coordinatorNpub: "npub1coord",
      voteEventId: "vote-1",
      proof: { id: "kid", amount: 1, secret: "s", C: "c" } as any,
      relays: ["wss://relay.example"],
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(result.successes).toBe(1);
    expect(result.failures).toBe(0);
  });

  it("returns synthetic failure entry when all retries fail", async () => {
    const mod = await import("./proofSubmission");
    decode.mockReturnValue({ type: "note", data: "x" });

    const result = await mod.submitProofsToAllCoordinators({
      voterSecretKey: new Uint8Array([1]),
      voteEventId: "vote-1",
      coordinatorProofs: [{ coordinatorNpub: "npub1coord", proof: { id: "kid", amount: 1, secret: "s", C: "c" } as any }],
      relays: ["wss://relay.example"],
      retries: 1,
    });

    expect(result[0].result.eventId).toBe("");
    expect(result[0].result.failures).toBe(1);
  });
});
