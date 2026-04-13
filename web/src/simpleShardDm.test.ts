import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveActorDisplayId } from "./actorDisplay";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const subscribeMany = vi.fn();
const wrapEvent = vi.fn();
const unwrapEvent = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();
const finalizeEvent = vi.fn((event: any) => ({ id: event.id ?? "evt-1", pubkey: "pk", ...event }));
const resolveNip65ConversationRelays = vi.fn();
const resolveNip65InboxRelays = vi.fn();
const publishOwnNip65RelayHints = vi.fn();

vi.mock("nostr-tools", () => ({
  getPublicKey,
  finalizeEvent,
  nip19: {
    decode,
    npubEncode: vi.fn((value: string) => `npub1${value.slice(0, 8)}`),
  },
  nip17: { wrapEvent, unwrapEvent },
  nip44: {
    v2: {
      encrypt: vi.fn((plaintext: string) => `enc:${plaintext}`),
      decrypt: vi.fn((payload: string) => payload.startsWith("enc:") ? payload.slice(4) : payload),
      utils: {
        getConversationKey: vi.fn(() => new Uint8Array([9, 9, 9])),
      },
    },
  },
  SimplePool: function () {
    return { publish, destroy, close, querySync, subscribeMany };
  },
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ publish, destroy, close, querySync, subscribeMany }),
}));

vi.mock("./wasm/auditableVotingCore", async () => {
  const actual = await vi.importActual<typeof import("./wasm/auditableVotingCore")>("./wasm/auditableVotingCore");
  return {
    ...actual,
    normalizeRelaysRust: (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))),
  };
});

vi.mock("./simpleShardCertificate", () => ({
  createSimpleBlindShareResponse: vi.fn((input: {
    coordinatorNpub: string;
    request: { requestId: string };
    shareIndex: number;
    thresholdT?: number;
    thresholdN?: number;
    keyAnnouncementEvent: any;
  }) => ({
    shareId: "share-1",
    requestId: input.request.requestId,
    coordinatorNpub: input.coordinatorNpub,
    blindedSignature: "blind-signature-1",
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
    createdAt: "2026-04-02T00:00:00.000Z",
    keyAnnouncementEvent: input.keyAnnouncementEvent,
  })),
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

vi.mock("./nip65RelayHints", () => ({
  publishOwnNip65RelayHints,
  resolveNip65ConversationRelays,
  resolveNip65InboxRelays,
}));

describe("simpleShardDm", () => {
  function mailboxRequestEvent() {
    return {
      id: "evt-request-1",
      pubkey: "ab".repeat(32),
      created_at: 10,
      content: JSON.stringify({
        schema_version: 1,
        event_type: "mailbox_request_envelope",
        election_id: "simple-public-election",
        round_id: "vote-1",
        created_at: 1712016000,
        sender_pubkey: "npub1voter",
        payload: {
          mailbox_id: "mailbox-1",
          request_id: "blind-request-id",
          payload_commitment: "commit-1",
          ciphertext_scheme: "nip44v2",
          ciphertext_type: "blind_request",
          ciphertext: `enc:${JSON.stringify({
            kind: "blind_request",
            request_id: "blind-request-id",
            voter_pubkey: "npub1voter",
            blinded_payload: "blind-msg-1",
            mailbox_reply_key: "npub1reply",
            mailbox_salt: "salt-1",
            blind_request: {
              requestId: "blind-request-id",
              votingId: "vote-1",
              blindedMessage: "blind-msg-1",
              createdAt: "2026-04-02T00:00:00.000Z",
            },
          })}`,
          attempt_no: 1,
          supersedes_event_id: null,
        },
      }),
    };
  }

  function mailboxTicketEvent() {
    return {
      id: "ticket-event-1",
      pubkey: "ab".repeat(32),
      created_at: 10,
      content: JSON.stringify({
        schema_version: 1,
        event_type: "mailbox_ticket_envelope",
        election_id: "simple-public-election",
        round_id: "vote-1",
        created_at: 1712016001,
        sender_pubkey: "npub1coord",
        payload: {
          mailbox_id: "mailbox-1",
          request_id: "request-1",
          ticket_id: "share-1",
          payload_commitment: "ticket-commit-1",
          ciphertext_scheme: "nip44v2",
          ciphertext_type: "ticket_bundle",
          ciphertext: `enc:${JSON.stringify({
            kind: "ticket_bundle",
            request_id: "request-1",
            ticket_id: "share-1",
            ticket_payload: {
              ticket_shards: [{
                shareId: "share-1",
                requestId: "request-1",
                coordinatorNpub: "npub1coord",
                blindedSignature: "blind-signature-1",
                shareIndex: 2,
                thresholdT: 2,
                thresholdN: 3,
                createdAt: "2026-04-02T00:00:00.000Z",
                keyAnnouncementEvent: { id: "blind-key-1" },
              }],
              ticket_commitment: "ticket-commitment-1",
              round_binding: {
                election_id: "simple-public-election",
                round_id: "vote-1",
              },
              threshold_label: "2 of 3",
              voting_prompt: "Should the proposal pass?",
            },
            bundle_proof: {
              coordinator_set_hash: "coord-set-1",
            },
          })}`,
          attempt_no: 1,
          supersedes_event_id: null,
          coordinator_set_hash: "coord-set-1",
        },
      }),
    };
  }

  function mailboxAckEvent() {
    return {
      id: "ack-event-1",
      pubkey: "ab".repeat(32),
      created_at: 10,
      content: JSON.stringify({
        schema_version: 1,
        event_type: "mailbox_ack_envelope",
        election_id: "simple-public-election",
        round_id: "vote-1",
        created_at: 1712016003,
        sender_pubkey: "npub1coord",
        payload: {
          mailbox_id: "mailbox-1",
          request_id: "request-1",
          ticket_id: "response-1",
          ack_id: "ack-1",
          payload_commitment: "ack-commit-1",
          ciphertext_scheme: "nip44v2",
          ciphertext_type: "ticket_ack",
          ciphertext: `enc:${JSON.stringify({
            kind: "ticket_ack",
            request_id: "request-1",
            ticket_id: "response-1",
            ack_id: "ack-1",
            receipt_timestamp: 1712016003,
          })}`,
          attempt_no: 1,
          supersedes_event_id: null,
        },
      }),
    };
  }

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
    finalizeEvent.mockImplementation((event: any) => ({ id: event.id ?? "evt-1", pubkey: "pk", ...event }));
    publish.mockImplementation((relays: string[]) => relays.map(() => Promise.resolve(undefined)));
    querySync.mockResolvedValue([]);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
    resolveNip65ConversationRelays.mockResolvedValue([
      "wss://recipient.example",
      "wss://sender.example",
    ]);
    resolveNip65InboxRelays.mockResolvedValue(["wss://inbox.example"]);
    publishOwnNip65RelayHints.mockResolvedValue({ successes: 1 });
  });

  it("sends blinded shard requests over mailbox events", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleShardRequest({
      voterSecretKey: new Uint8Array([1, 2, 3]),
      coordinatorNpub: "npub1coord",
      voterNpub: "npub1voter",
      replyNpub: "npub1reply",
      votingId: "vote-1",
      blindRequest: {
        requestId: "request-1",
        votingId: "vote-1",
        blindedMessage: "blind-msg-1",
        createdAt: "2026-04-02T00:00:00.000Z",
      },
    });

    expect(finalizeEvent).toHaveBeenCalled();
    const payload = JSON.parse(finalizeEvent.mock.calls[0][0].content);
    expect(payload.event_type).toBe("mailbox_request_envelope");
    expect(payload.payload.request_id).toBe("request-1");
    expect(resolveNip65ConversationRelays).toHaveBeenCalledWith({
      recipientNpub: "npub1coord",
      senderNpub: "npub1cdcdcdcd",
      fallbackRelays: expect.any(Array),
    });
    expect(publishOwnNip65RelayHints).toHaveBeenCalledWith({
      secretKey: new Uint8Array([1, 2, 3]),
      inboxRelays: ["wss://recipient.example", "wss://sender.example"],
      outboxRelays: ["wss://recipient.example", "wss://sender.example"],
      publishRelays: ["wss://recipient.example", "wss://sender.example"],
      channel: "nip65:npub1cdcdcdcd",
    });
    expect(result.successes).toBeGreaterThan(0);
    expect(result.mailboxId).toBeTruthy();
  });

  it("sends round tickets carrying blind-share responses in mailbox envelopes", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleRoundTicket({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      blindPrivateKey: {
        scheme: "rsa-blind-v1",
        keyId: "key-1",
        bits: 1024,
        n: "aa",
        e: "11",
        d: "22",
      },
      keyAnnouncementEvent: { id: "blind-key-1" },
      recipientNpub: "npub1reply",
      coordinatorNpub: "npub1coord",
      thresholdLabel: "2 of 3",
      request: {
        id: "request-entry-1",
        voterNpub: "npub1voter",
        replyNpub: "npub1reply",
        votingId: "vote-1",
        blindRequest: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2026-04-02T00:00:00.000Z",
        mailboxId: "mailbox-1",
      },
      votingPrompt: "Should the proposal pass?",
      shareIndex: 2,
      thresholdT: 2,
      thresholdN: 3,
    });

    expect(finalizeEvent).toHaveBeenCalled();
    const payload = JSON.parse(finalizeEvent.mock.calls[0][0].content);
    expect(payload.event_type).toBe("mailbox_ticket_envelope");
    expect(payload.payload.request_id).toBe("request-entry-1");
    expect(result.responseId).toBeTruthy();
    expect(result.successes).toBeGreaterThan(0);
  });

  it("fetches blind-share ticket responses addressed to the voter", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([mailboxTicketEvent()]);

    const responses = await mod.fetchSimpleShardResponses({
      voterNsec: "nsec1voter",
    });

    expect(responses).toEqual([
      {
        id: "share-1",
        dmEventId: "ticket-event-1",
        requestId: "request-1",
        coordinatorNpub: "npub1coord",
        coordinatorId: deriveActorDisplayId("npub1coord"),
        thresholdLabel: "2 of 3",
        createdAt: "2024-04-02T00:00:01.000Z",
        votingPrompt: "Should the proposal pass?",
        blindShareResponse: {
          shareId: "share-1",
          requestId: "request-1",
          coordinatorNpub: "npub1coord",
          blindedSignature: "blind-signature-1",
          shareIndex: 2,
          thresholdT: 2,
          thresholdN: 3,
          createdAt: "2026-04-02T00:00:00.000Z",
          keyAnnouncementEvent: { id: "blind-key-1" },
        },
        mailboxId: "mailbox-1",
      },
    ]);
  });

  it("normalises shard request ids to the blind request id when parsing", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([mailboxRequestEvent()]);

    const requests = await mod.fetchSimpleShardRequests({
      coordinatorNsec: "nsec1coord",
    });

    expect(requests).toEqual([
      expect.objectContaining({
        id: "blind-request-id",
        dmEventId: "evt-request-1",
        votingId: "vote-1",
        mailboxId: "mailbox-1",
      }),
    ]);
  });

  it("subscribes to blinded shard requests for a coordinator", async () => {
    const mod = await import("./simpleShardDm");
    const onRequests = vi.fn();

    querySync.mockResolvedValue([]);
    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, handlers: { onevent?: (event: any) => void }) => {
      handlers.onevent?.(mailboxRequestEvent());
      return { close: vi.fn(async () => undefined) };
    });

    const unsubscribe = mod.subscribeSimpleShardRequests({
      coordinatorNsec: "nsec1coord",
      onRequests,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRequests).toHaveBeenCalledWith([
      {
        id: "blind-request-id",
        dmEventId: "evt-request-1",
        voterNpub: "npub1voter",
        voterId: deriveActorDisplayId("npub1voter"),
        replyNpub: "npub1reply",
        votingId: "vote-1",
        blindRequest: {
          requestId: "blind-request-id",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2024-04-02T00:00:00.000Z",
        mailboxId: "mailbox-1",
        mailboxSalt: "salt-1",
      },
    ]);
    expect(resolveNip65InboxRelays).toHaveBeenCalledWith({
      npub: "npub1cdcdcdcd",
      fallbackRelays: expect.any(Array),
    });

    unsubscribe();
  });

  it("sends DM acknowledgements over NIP-17", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleDmAcknowledgement({
      senderSecretKey: new Uint8Array([1, 2, 3]),
      recipientNpub: "npub1coord",
      actorNpub: "npub1voter",
      ackedAction: "simple_shard_request",
      ackedEventId: "wrapped-event-1",
      votingId: "vote-1",
      requestId: "request-1",
    });

    expect(JSON.parse(wrapEvent.mock.calls[0][2])).toMatchObject({
      action: "simple_dm_ack",
      actor_npub: "npub1voter",
      acked_action: "simple_shard_request",
      acked_event_id: "wrapped-event-1",
      voting_id: "vote-1",
      request_id: "request-1",
    });
    expect(result.successes).toBeGreaterThan(0);
  });

  it("fetches mailbox ticket acknowledgements addressed to the actor", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([mailboxAckEvent()]);

    const acknowledgements = await mod.fetchSimpleDmAcknowledgements({
      actorNsec: "nsec1actor",
    });

    expect(acknowledgements).toEqual([
      {
        id: "ack-1",
        ackedAction: "simple_round_ticket",
        ackedEventId: "response-1",
        actorNpub: "npub1coord",
        actorId: deriveActorDisplayId("npub1coord"),
        votingId: "vote-1",
        requestId: "request-1",
        responseId: "response-1",
        createdAt: "2024-04-02T00:00:03.000Z",
        mailboxId: "mailbox-1",
      },
    ]);
  });

  it("marks delivery confirmed when ballot accepted even if ack is missing", async () => {
    const mod = await import("./simpleShardDm");
    expect(mod.isDeliveryConfirmed({ ackSeen: false, ballotAccepted: true })).toBe(true);
    expect(mod.isDeliveryConfirmed({ ackSeen: true, ballotAccepted: false })).toBe(true);
    expect(mod.isDeliveryConfirmed({ ackSeen: false, ballotAccepted: false })).toBe(false);
  });

  it("keeps stable ticket_id across resend attempts", async () => {
    const mod = await import("./simpleShardDm");

    const first = await mod.sendSimpleRoundTicket({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      blindPrivateKey: {
        scheme: "rsa-blind-v1",
        keyId: "key-1",
        bits: 1024,
        n: "aa",
        e: "11",
        d: "22",
      },
      keyAnnouncementEvent: { id: "blind-key-1" },
      recipientNpub: "npub1reply",
      coordinatorNpub: "npub1coord",
      thresholdLabel: "2 of 3",
      request: {
        id: "request-entry-1",
        voterNpub: "npub1voter",
        replyNpub: "npub1reply",
        votingId: "vote-1",
        blindRequest: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2026-04-02T00:00:00.000Z",
        mailboxId: "mailbox-1",
      },
      votingPrompt: "Should the proposal pass?",
      shareIndex: 2,
      thresholdT: 2,
      thresholdN: 3,
    });
    const firstPayload = JSON.parse(finalizeEvent.mock.calls.at(-1)?.[0]?.content ?? "{}");

    const second = await mod.sendSimpleRoundTicket({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      blindPrivateKey: {
        scheme: "rsa-blind-v1",
        keyId: "key-1",
        bits: 1024,
        n: "aa",
        e: "11",
        d: "22",
      },
      keyAnnouncementEvent: { id: "blind-key-1" },
      recipientNpub: "npub1reply",
      coordinatorNpub: "npub1coord",
      thresholdLabel: "2 of 3",
      request: {
        id: "request-entry-1",
        voterNpub: "npub1voter",
        replyNpub: "npub1reply",
        votingId: "vote-1",
        blindRequest: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2026-04-02T00:00:00.000Z",
        mailboxId: "mailbox-1",
      },
      votingPrompt: "Should the proposal pass?",
      shareIndex: 2,
      thresholdT: 2,
      thresholdN: 3,
      attemptNo: 2,
      ticketId: first.responseId,
      supersedesEventId: first.eventId,
    });
    const secondPayload = JSON.parse(finalizeEvent.mock.calls.at(-1)?.[0]?.content ?? "{}");

    expect(second.responseId).toBe(first.responseId);
    expect(firstPayload.payload.ticket_id).toBe(secondPayload.payload.ticket_id);
  });

  it("keeps stable ack_id across resend attempts", async () => {
    const mod = await import("./simpleShardDm");

    await mod.sendSimpleDmAcknowledgement({
      senderSecretKey: new Uint8Array([1, 2, 3]),
      recipientNpub: "npub1coord",
      actorNpub: "npub1voter",
      ackedAction: "simple_round_ticket",
      ackedEventId: "ticket-event-1",
      votingId: "vote-1",
      requestId: "request-1",
      responseId: "ticket-1",
      mailboxId: "mailbox-1",
    });
    const firstPayload = JSON.parse(finalizeEvent.mock.calls.at(-1)?.[0]?.content ?? "{}");

    await mod.sendSimpleDmAcknowledgement({
      senderSecretKey: new Uint8Array([1, 2, 3]),
      recipientNpub: "npub1coord",
      actorNpub: "npub1voter",
      ackedAction: "simple_round_ticket",
      ackedEventId: "ticket-event-1",
      votingId: "vote-1",
      requestId: "request-1",
      responseId: "ticket-1",
      mailboxId: "mailbox-1",
    });
    const secondPayload = JSON.parse(finalizeEvent.mock.calls.at(-1)?.[0]?.content ?? "{}");

    expect(firstPayload.payload.ack_id).toBe(secondPayload.payload.ack_id);
  });

  it("backfills missed DM acknowledgements after subscription setup", async () => {
    vi.useFakeTimers();
    const mod = await import("./simpleShardDm");
    const onAcknowledgements = vi.fn();

    querySync
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ created_at: 10, id: "ack-event-1" }]);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
    unwrapEvent.mockReturnValue({
      content: JSON.stringify({
        action: "simple_dm_ack",
        ack_id: "ack-1",
        acked_action: "simple_mls_welcome",
        acked_event_id: "welcome-event-1",
        actor_npub: "npub1coord",
        created_at: "2026-04-02T00:00:03.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleDmAcknowledgements({
      actorNsec: "nsec1actor",
      onAcknowledgements,
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(querySync).toHaveBeenCalledTimes(4);
    expect(onAcknowledgements).toHaveBeenCalled();

    unsubscribe();
    vi.useRealTimers();
  });

  it("backfills missed coordinator MLS welcomes after subscription setup", async () => {
    vi.useFakeTimers();
    const mod = await import("./simpleShardDm");
    const onWelcomes = vi.fn();

    querySync
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ created_at: 10, id: "welcome-event-1" }]);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
    unwrapEvent.mockReturnValue({
      content: JSON.stringify({
        action: "simple_mls_welcome",
        welcome_id: "welcome-1",
        lead_coordinator_npub: "npub1lead",
        election_id: "simple-election:npub1lead",
        welcome_bundle: "welcome-bundle-1",
        created_at: "2026-04-02T00:00:04.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleCoordinatorMlsWelcomes({
      coordinatorNsec: "nsec1coord",
      onWelcomes,
    });

    await vi.advanceTimersByTimeAsync(4000);

    expect(querySync).toHaveBeenCalledTimes(2);
    expect(onWelcomes).toHaveBeenLastCalledWith([
      {
        id: "welcome-1",
        dmEventId: "welcome-event-1",
        leadCoordinatorNpub: "npub1lead",
        electionId: "simple-election:npub1lead",
        welcomeBundle: "welcome-bundle-1",
        createdAt: "2026-04-02T00:00:04.000Z",
      },
    ]);

    unsubscribe();
    vi.useRealTimers();
  });
});
