import { beforeEach, describe, expect, it, vi } from "vitest";

const querySync = vi.fn();
const close = vi.fn();

vi.mock("nostr-tools", () => ({
  nip19: {
    decode: vi.fn((value: string) => ({ type: "npub", data: value.replace(/^npub1/, "") })),
    npubEncode: vi.fn((value: string) => `npub1${String(value).slice(0, 8)}`),
  },
  SimplePool: function () {
    return { querySync, close };
  },
}));

describe("nip65RelayHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("resolves conversation relays using sender outbox and recipient inbox hints", async () => {
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

    const relays = await mod.resolveNip65ConversationRelays({
      senderNpub: "npub1sender",
      recipientNpub: "npub1receiver",
      fallbackRelays: ["wss://fallback.example"],
    });

    expect(relays).toEqual([
      "wss://recipient-inbox.example",
      "wss://fallback.example",
      "wss://sender-outbox.example",
    ]);
  });
});
