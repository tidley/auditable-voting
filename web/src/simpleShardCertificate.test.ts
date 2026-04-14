import { beforeEach, describe, expect, it, vi } from "vitest";

const querySync = vi.fn();
const subscribeMany = vi.fn();
const resolveNip65OutboxRelays = vi.fn();
const verifyEvent = vi.fn();
const decode = vi.fn();
const npubEncode = vi.fn();

vi.mock("@cloudflare/blindrsa-ts", () => ({
  RSABSSA: {
    SHA384: {
      PSS: {
        Deterministic: () => ({
          prepare: vi.fn(),
          blind: vi.fn(),
          blindSign: vi.fn(),
          finalize: vi.fn(),
          verify: vi.fn(),
        }),
      },
    },
  },
}));

vi.mock("nostr-tools", () => ({
  finalizeEvent: vi.fn(),
  getPublicKey: vi.fn(),
  verifyEvent,
  nip19: {
    decode,
    npubEncode,
    nsecEncode: vi.fn(),
  },
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ querySync, subscribeMany }),
}));

vi.mock("./nip65RelayHints", () => ({
  publishOwnNip65RelayHints: vi.fn(),
  resolveNip65OutboxRelays,
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

vi.mock("./wasm/auditableVotingCore", () => ({
  normalizeRelaysRust: (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))),
}));

describe("simpleShardCertificate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decode.mockReturnValue({ type: "npub", data: "ab".repeat(32) });
    npubEncode.mockReturnValue("npub1coord");
    verifyEvent.mockReturnValue(true);
    resolveNip65OutboxRelays.mockImplementation(async ({ fallbackRelays }: { fallbackRelays: string[] }) => fallbackRelays);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
  });

  it("backfills missed blind key announcements after subscription setup", async () => {
    vi.useRealTimers();
    const mod = await import("./simpleShardCertificate");
    const onAnnouncement = vi.fn();

    querySync
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "blind-key-1",
          kind: mod.SIMPLE_BLIND_KEY_KIND,
          pubkey: "ab".repeat(32),
          created_at: 50,
          content: JSON.stringify({
            voting_id: "vote-1",
            scheme: mod.SIMPLE_BLIND_SCHEME,
            key_id: "key-1",
            bits: mod.SIMPLE_BLIND_KEY_BITS,
            hash: mod.SIMPLE_BLIND_HASH,
            salt_length: mod.SIMPLE_BLIND_SALT_LENGTH,
            n: "n-value",
            e: "e-value",
            created_at: "2026-04-07T01:00:00.000Z",
          }),
        },
      ]);

    const unsubscribe = mod.subscribeLatestSimpleBlindKeyAnnouncement({
      coordinatorNpub: "npub1coord",
      votingId: "vote-1",
      onAnnouncement,
    });

    await vi.waitFor(() => {
      expect(querySync).toHaveBeenCalledTimes(1);
      expect(onAnnouncement).toHaveBeenCalledWith(null);
    });
    await new Promise((resolve) => setTimeout(resolve, 5200));

    await vi.waitFor(() => {
      expect(querySync).toHaveBeenCalledTimes(2);
      expect(onAnnouncement).toHaveBeenLastCalledWith(expect.objectContaining({
        coordinatorNpub: "npub1coord",
        votingId: "vote-1",
        publicKey: expect.objectContaining({
          keyId: "key-1",
        }),
      }));
    });

    unsubscribe();
  }, 10000);
});
