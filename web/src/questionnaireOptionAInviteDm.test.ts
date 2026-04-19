import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import type { SignerService } from "./services/signerService";
import { fetchOptionAInviteDms, fetchOptionAInviteDmsWithNsec, publishOptionAInviteDm } from "./questionnaireOptionAInviteDm";

const querySync = vi.fn();
const publish = vi.fn();
const queueNostrPublish = vi.fn();
const publishToRelaysStaggered = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ querySync, publish }),
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (...args: unknown[]) => queueNostrPublish(...args),
  publishToRelaysStaggered: (...args: unknown[]) => publishToRelaysStaggered(...args),
}));

function makeSigner(overrides: Partial<SignerService> = {}): SignerService {
  return {
    isAvailable: async () => true,
    getPublicKey: async () => "f".repeat(64),
    signMessage: async () => "sig",
    signEvent: async <T extends Record<string, unknown>>(event: T) => ({ ...event, id: "event-1", sig: "sig", pubkey: "f".repeat(64) }),
    nip44Encrypt: async () => "ciphertext",
    nip44Decrypt: async () => "",
    ...overrides,
  };
}

describe("questionnaireOptionAInviteDm", () => {
  beforeEach(() => {
    querySync.mockReset();
    publish.mockReset();
    queueNostrPublish.mockReset();
    publishToRelaysStaggered.mockReset();
  });

  it("publishes option A invite over NIP-17 gift wrap", async () => {
    publish.mockReturnValue([Promise.resolve(undefined)]);
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => Promise.allSettled(relays.slice(0, 1).map((relay) => publishOne(relay))),
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());

    const invitedHex = "a".repeat(64);
    const invite = {
      type: "election_invite" as const,
      schemaVersion: 1 as const,
      electionId: "e1",
      title: "Questionnaire",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: nip19.npubEncode(invitedHex),
      coordinatorNpub: nip19.npubEncode("f".repeat(64)),
      expiresAt: null,
    };

    const result = await publishOptionAInviteDm({
      signer: makeSigner(),
      invite,
    });

    expect(result.successes).toBe(1);
    expect(result.failures).toBe(0);
    expect(publish).toHaveBeenCalled();
    const event = publish.mock.calls[0]?.[1] as { kind: number; tags: string[][] };
    expect(event?.kind).toBe(1059);
    expect(event?.tags?.[0]?.[0]).toBe("p");
  });

  it("prefers recipient NIP-17 relay list relays for invite publishes", async () => {
    publish.mockReturnValue([Promise.resolve(undefined)]);
    querySync.mockResolvedValue([{
      kind: 10050,
      pubkey: "a".repeat(64),
      created_at: 123,
      tags: [["relay", "wss://amethyst-inbox.example"], ["relay", "wss://nip17.com"]],
      content: "",
      id: "relay-list",
      sig: "sig",
    }]);
    let publishedRelays: string[] = [];
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => {
        publishedRelays = relays;
        return Promise.allSettled(relays.slice(0, 1).map((relay) => publishOne(relay)));
      },
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());

    await publishOptionAInviteDm({
      signer: makeSigner(),
      invite: {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "e1",
        title: "Questionnaire",
        description: "",
        voteUrl: "https://example.test/vote",
        invitedNpub: nip19.npubEncode("a".repeat(64)),
        coordinatorNpub: nip19.npubEncode("f".repeat(64)),
        expiresAt: null,
      },
    });

    expect(publishedRelays[0]).toBe("wss://amethyst-inbox.example");
    expect(publishedRelays).toContain("wss://nip17.com");
  });

  it("publishes fallback-key invites as addressed NIP-17 private messages", async () => {
    publish.mockReturnValue([Promise.resolve(undefined)]);
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => Promise.allSettled(relays.slice(0, 1).map((relay) => publishOne(relay))),
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());

    const coordinatorSecret = generateSecretKey();
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const invite = {
      type: "election_invite" as const,
      schemaVersion: 1 as const,
      electionId: "e1",
      title: "Questionnaire",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: nip19.npubEncode(recipientHex),
      coordinatorNpub: nip19.npubEncode(getPublicKey(coordinatorSecret)),
      expiresAt: null,
    };

    await publishOptionAInviteDm({
      signer: makeSigner(),
      invite,
      fallbackNsec: nip19.nsecEncode(coordinatorSecret),
      relays: ["wss://relay.example"],
    });

    const event = publish.mock.calls[0]?.[1];
    const rumor = nip17.unwrapEvent(event, recipientSecret) as { kind: number; tags: string[][]; content: string };
    expect(rumor.kind).toBe(14);
    expect(rumor.tags).toContainEqual(["p", recipientHex, "wss://relay.example"]);
    expect(rumor.tags).toContainEqual(["subject", "Auditable Voting invite"]);
    expect(rumor.content).toBe(invite.voteUrl);
  });

  it("reads and decrypts invite DMs for the logged-in voter", async () => {
    const recipientHex = "b".repeat(64);
    const senderHex = "c".repeat(64);
    const wrapPubkey = "d".repeat(64);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const invite = {
      type: "election_invite" as const,
      schemaVersion: 1 as const,
      electionId: "e2",
      title: "Invite title",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: recipientNpub,
      coordinatorNpub: nip19.npubEncode(senderHex),
      expiresAt: null,
    };

    querySync.mockResolvedValue([{
      id: "dm-1",
      kind: 1059,
      pubkey: wrapPubkey,
      content: "ciphertext",
      created_at: 123,
      tags: [["p", recipientHex]],
      sig: "sig",
    }]);

    const signer = makeSigner({
      getPublicKey: async () => recipientHex,
      nip44Decrypt: async (pubkey) => {
        if (pubkey === wrapPubkey) {
          return JSON.stringify({
            id: "seal-1",
            kind: 13,
            pubkey: senderHex,
            created_at: 123,
            tags: [],
            content: "sealed-rumor",
            sig: "sig",
          });
        }
        if (pubkey === senderHex) {
          return JSON.stringify({
            content: JSON.stringify({
              type: "optiona_invite_dm",
              schemaVersion: 1,
              invite,
              sentAt: new Date().toISOString(),
            }),
          });
        }
        return "";
      },
    });

    const invites = await fetchOptionAInviteDms({
      signer,
      electionId: "e2",
      limit: 20,
    });

    expect(invites).toHaveLength(1);
    expect(invites[0]?.electionId).toBe("e2");
    expect(invites[0]?.invitedNpub).toBe(recipientNpub);
  });

  it("recovers invite payload from DM tags when message content is a short link", async () => {
    const recipientHex = "b".repeat(64);
    const senderHex = "c".repeat(64);
    const wrapPubkey = "d".repeat(64);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const invite = {
      type: "election_invite" as const,
      schemaVersion: 1 as const,
      electionId: "e4",
      title: "Invite title",
      description: "",
      voteUrl: "https://tidley.github.io/auditable-voting/?role=voter&q=e4",
      invitedNpub: recipientNpub,
      coordinatorNpub: nip19.npubEncode(senderHex),
      expiresAt: null,
    };

    querySync.mockResolvedValue([{
      id: "dm-2",
      kind: 1059,
      pubkey: wrapPubkey,
      content: "ciphertext",
      created_at: 123,
      tags: [["p", recipientHex]],
      sig: "sig",
    }]);

    const signer = makeSigner({
      getPublicKey: async () => recipientHex,
      nip44Decrypt: async (pubkey) => {
        if (pubkey === wrapPubkey) {
          return JSON.stringify({
            id: "seal-2",
            kind: 13,
            pubkey: senderHex,
            created_at: 123,
            tags: [],
            content: "sealed-rumor",
            sig: "sig",
          });
        }
        if (pubkey === senderHex) {
          return JSON.stringify({
            content: "https://tidley.github.io/auditable-voting/?role=voter&q=e4",
            tags: [
              ["p", recipientHex],
              ["optiona_invite_payload", encodeURIComponent(JSON.stringify({
                type: "optiona_invite_dm",
                schemaVersion: 1,
                invite,
                sentAt: new Date().toISOString(),
              }))],
            ],
          });
        }
        return "";
      },
    });

    const invites = await fetchOptionAInviteDms({
      signer,
      electionId: "e4",
      limit: 20,
    });

    expect(invites).toHaveLength(1);
    expect(invites[0]?.electionId).toBe("e4");
    expect(invites[0]?.invitedNpub).toBe(recipientNpub);
    expect(invites[0]?.coordinatorNpub).toBe(invite.coordinatorNpub);
  });

  it("reads invite DMs with local nsec when no external signer is used", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const senderHex = getPublicKey(senderSecret);
    const invite = {
      type: "election_invite" as const,
      schemaVersion: 1 as const,
      electionId: "e3",
      title: "Invite local",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: recipientNpub,
      coordinatorNpub: nip19.npubEncode(senderHex),
      expiresAt: null,
    };

    const wrapped = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_invite_dm",
        schemaVersion: 1,
        invite,
        sentAt: new Date().toISOString(),
      }),
      "Option A invite",
    );

    querySync.mockResolvedValue([wrapped]);

    const invites = await fetchOptionAInviteDmsWithNsec({
      nsec: recipientNsec,
      electionId: "e3",
      limit: 20,
    });

    expect(invites).toHaveLength(1);
    expect(invites[0]?.electionId).toBe("e3");
    expect(invites[0]?.invitedNpub).toBe(recipientNpub);
  });
});
