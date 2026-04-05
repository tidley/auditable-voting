import { beforeEach, describe, expect, it, vi } from "vitest";

const finalizeEvent = vi.fn();
const getPublicKey = vi.fn();
const publish = vi.fn();
const querySync = vi.fn();
const close = vi.fn();
const destroy = vi.fn();

vi.mock("nostr-tools", () => ({
  finalizeEvent,
  getPublicKey,
  nip19: {
    decode: vi.fn((value: string) => ({ type: "npub", data: value.replace(/^npub1/, "") })),
    npubEncode: vi.fn((value: string) => `npub1${String(value).slice(0, 8)}`),
  },
  SimplePool: function () {
    return { querySync, close, publish, destroy };
  },
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ publish, destroy, close, querySync }),
}));

vi.mock("./wasm/auditableVotingCore", async () => {
  const actual = await vi.importActual<typeof import("./wasm/auditableVotingCore")>("./wasm/auditableVotingCore");
  const normalizeRelaysRust = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return {
    ...actual,
    normalizeRelaysRust,
    buildActorRelaySetRust: (input: {
      preferredRelays?: string[];
      fallbackRelays: string[];
      extraRelays?: string[];
    }) => normalizeRelaysRust([
      ...(input.preferredRelays ?? []),
      ...input.fallbackRelays,
      ...(input.extraRelays ?? []),
    ]),
    buildConversationRelaySetRust: (input: {
      recipientInboxRelays: string[];
      senderOutboxRelays?: string[];
      fallbackRelays: string[];
    }) => normalizeRelaysRust([
      ...input.recipientInboxRelays,
      ...(input.senderOutboxRelays ?? []),
      ...input.fallbackRelays,
    ]),
  };
});

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

describe("nip65RelayHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublicKey.mockReturnValue("deadbeef");
    finalizeEvent.mockImplementation((event) => ({ id: "relay-list-1", ...event }));
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
  });

  it("parses inbox and outbox relay markers from a NIP-65 event", async () => {
    const mod = await import("./nip65RelayHints");

    const parsed = mod.parseNip65RelayHintsEvent({
      kind: mod.NIP65_RELAY_LIST_KIND,
      pubkey: "deadbeef",
      created_at: 100,
      tags: [
        ["r", "wss://inbox.example", "read"],
        ["r", "wss://outbox.example", "write"],
        ["r", "wss://shared.example"],
      ],
    });

    expect(parsed).toEqual({
      npub: "npub1deadbeef",
      inboxRelays: ["wss://inbox.example", "wss://shared.example"],
      outboxRelays: ["wss://outbox.example", "wss://shared.example"],
      fetchedAt: "1970-01-01T00:01:40.000Z",
    });
  });

  it("resolves conversation relays immediately from fallback relays, then uses cached hints after priming", async () => {
    const mod = await import("./nip65RelayHints");

    querySync.mockImplementation(async (_relays: string[], filter: { authors: string[] }) => {
      if (filter.authors[0] === "receiver") {
        return [{
          kind: mod.NIP65_RELAY_LIST_KIND,
          pubkey: "receiver",
          created_at: 100,
          tags: [["r", "wss://recipient-inbox.example", "read"]],
        }];
      }

      if (filter.authors[0] === "sender") {
        return [{
          kind: mod.NIP65_RELAY_LIST_KIND,
          pubkey: "sender",
          created_at: 101,
          tags: [["r", "wss://sender-outbox.example", "write"]],
        }];
      }

      return [];
    });

    const immediateRelays = await mod.resolveNip65ConversationRelays({
      senderNpub: "npub1sender",
      recipientNpub: "npub1receiver",
      fallbackRelays: ["wss://fallback.example"],
    });

    expect(immediateRelays).toEqual([
      "wss://fallback.example",
    ]);

    await mod.primeNip65RelayHints(
      ["npub1sender", "npub1receiver"],
      ["wss://fallback.example"],
    );

    const primedRelays = await mod.resolveNip65ConversationRelays({
      senderNpub: "npub1sender",
      recipientNpub: "npub1receiver",
      fallbackRelays: ["wss://fallback.example"],
    });

    expect(primedRelays).toEqual([
      "wss://recipient-inbox.example",
      "wss://fallback.example",
      "wss://sender-outbox.example",
    ]);
  });

  it("publishes and caches the actor's own relay hints", async () => {
    const mod = await import("./nip65RelayHints");

    const first = await mod.publishOwnNip65RelayHints({
      secretKey: new Uint8Array([1, 2, 3]),
      inboxRelays: ["wss://dm.example"],
      outboxRelays: ["wss://pub.example"],
      publishRelays: ["wss://pub.example"],
    });

    expect(first?.successes).toBe(2);
    expect(finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: mod.NIP65_RELAY_LIST_KIND,
        tags: expect.arrayContaining([
          ["r", "wss://dm.example", "read"],
          ["r", "wss://pub.example", "write"],
        ]),
      }),
      new Uint8Array([1, 2, 3]),
    );

    await mod.publishOwnNip65RelayHints({
      secretKey: new Uint8Array([1, 2, 3]),
      inboxRelays: ["wss://dm.example"],
      outboxRelays: ["wss://pub.example"],
      publishRelays: ["wss://pub.example"],
    });

    expect(finalizeEvent).toHaveBeenCalledTimes(1);
    expect(mod.getCachedNip65RelayHints("npub1deadbeef")).toEqual({
      npub: "npub1deadbeef",
      inboxRelays: ["wss://dm.example"],
      outboxRelays: ["wss://pub.example"],
      fetchedAt: expect.any(String),
    });
  });
});
