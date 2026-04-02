import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
const destroy = vi.fn();
const close = vi.fn();
const querySync = vi.fn();
const subscribeMany = vi.fn();
const wrapEvent = vi.fn();
const unwrapEvent = vi.fn();
const decode = vi.fn();
const getPublicKey = vi.fn();

vi.mock("nostr-tools", () => ({
  getPublicKey,
  nip19: {
    decode,
    npubEncode: vi.fn((value: string) => `npub1${value.slice(0, 8)}`),
  },
  nip17: { wrapEvent, unwrapEvent },
  SimplePool: function () {
    return { publish, destroy, close, querySync, subscribeMany };
  },
}));

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
    querySync.mockResolvedValue([]);
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
  });

  it("sends blinded shard requests over DMs", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleShardRequest({
      voterSecretKey: new Uint8Array([1, 2, 3]),
      coordinatorNpub: "npub1coord",
      voterNpub: "npub1voter",
      voterId: "voter123",
      votingId: "vote-1",
      blindRequest: {
        requestId: "request-1",
        votingId: "vote-1",
        blindedMessage: "blind-msg-1",
        createdAt: "2026-04-02T00:00:00.000Z",
      },
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(JSON.parse(wrapEvent.mock.calls[0][2]).blind_request).toEqual({
      requestId: "request-1",
      votingId: "vote-1",
      blindedMessage: "blind-msg-1",
      createdAt: "2026-04-02T00:00:00.000Z",
    });
    expect(result.successes).toBeGreaterThan(0);
  });

  it("sends round tickets carrying blind-share responses", async () => {
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
      voterNpub: "npub1voter",
      voterId: "voter123",
      coordinatorNpub: "npub1coord",
      coordinatorId: "coord123",
      thresholdLabel: "2 of 3",
      request: {
        id: "request-entry-1",
        voterNpub: "npub1voter",
        voterId: "voter123",
        votingId: "vote-1",
        blindRequest: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      votingPrompt: "Should the proposal pass?",
      shareIndex: 2,
      thresholdT: 2,
      thresholdN: 3,
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(JSON.parse(wrapEvent.mock.calls[0][2]).blind_share_response).toMatchObject({
      shareId: "share-1",
      requestId: "request-1",
      coordinatorNpub: "npub1coord",
      shareIndex: 2,
      thresholdT: 2,
      thresholdN: 3,
    });
    expect(result.responseId).toBe("share-1");
    expect(result.successes).toBeGreaterThan(0);
  });

  it("fetches blind-share ticket responses addressed to the voter", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([{ created_at: 10 }]);
    unwrapEvent.mockReturnValueOnce({
      content: JSON.stringify({
        action: "simple_round_ticket",
        response_id: "share-1",
        request_id: "request-1",
        coordinator_npub: "npub1coord",
        coordinator_id: "coord123",
        threshold_label: "2 of 3",
        voting_prompt: "Should the proposal pass?",
        blind_share_response: {
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
        created_at: "2026-04-02T00:00:01.000Z",
      }),
    });

    const responses = await mod.fetchSimpleShardResponses({
      voterNsec: "nsec1voter",
    });

    expect(responses).toEqual([
      {
        id: "share-1",
        requestId: "request-1",
        coordinatorNpub: "npub1coord",
        coordinatorId: "coord123",
        thresholdLabel: "2 of 3",
        createdAt: "2026-04-02T00:00:01.000Z",
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
      },
    ]);
  });

  it("subscribes to blinded shard requests for a coordinator", async () => {
    const mod = await import("./simpleShardDm");
    const onRequests = vi.fn();

    querySync.mockResolvedValue([]);
    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, handlers: { onevent?: (event: any) => void }) => {
      handlers.onevent?.({ created_at: 10 });
      return { close: vi.fn(async () => undefined) };
    });
    unwrapEvent.mockReturnValue({
      content: JSON.stringify({
        action: "simple_shard_request",
        request_id: "request-1",
        voter_npub: "npub1voter",
        voter_id: "voter123",
        voting_id: "vote-1",
        blind_request: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        created_at: "2026-04-02T00:00:01.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleShardRequests({
      coordinatorNsec: "nsec1coord",
      onRequests,
    });

    expect(onRequests).toHaveBeenCalledWith([
      {
        id: "request-1",
        voterNpub: "npub1voter",
        voterId: "voter123",
        votingId: "vote-1",
        blindRequest: {
          requestId: "request-1",
          votingId: "vote-1",
          blindedMessage: "blind-msg-1",
          createdAt: "2026-04-02T00:00:00.000Z",
        },
        createdAt: "2026-04-02T00:00:01.000Z",
      },
    ]);

    unsubscribe();
  });
});
