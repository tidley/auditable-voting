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
  nip19: { decode },
  nip17: { wrapEvent, unwrapEvent },
  SimplePool: function () {
    return { publish, destroy, close, querySync, subscribeMany };
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

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
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
    subscribeMany.mockReturnValue({ close: vi.fn(async () => undefined) });
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

  it("sends round tickets over the DM relay set", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleRoundTicket({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      voterNpub: "npub1voter",
      voterId: "abc1234",
      coordinatorNpub: "npub1coord",
      coordinatorId: "abc1234",
      thresholdLabel: "1 of 1",
      votingId: "vote-1",
      votingPrompt: "Should the proposal pass?",
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

  it("fetches round tickets addressed to the voter", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([{ created_at: 10 }]);
    unwrapEvent.mockReturnValueOnce({
      content: JSON.stringify({
        action: "simple_round_ticket",
        response_id: "resp-1",
        request_id: "round-ticket:vote-1:npub1coord",
        coordinator_npub: "npub1coord",
        coordinator_id: "abc1234",
        threshold_label: "3 of 5",
        voting_prompt: "Should the proposal pass?",
        shard_certificate: { id: "cert-1" },
        created_at: "2026-03-31T00:00:00.000Z",
      }),
    });

    const responses = await mod.fetchSimpleShardResponses({
      voterNsec: "nsec1voter",
    });

    expect(responses).toEqual([
      {
        id: "resp-1",
        requestId: "round-ticket:vote-1:npub1coord",
        coordinatorNpub: "npub1coord",
        coordinatorId: "abc1234",
        thresholdLabel: "3 of 5",
        createdAt: "2026-03-31T00:00:00.000Z",
        votingPrompt: "Should the proposal pass?",
        shardCertificate: { id: "cert-1", kind: 38993, pubkey: "ab".repeat(32), created_at: 10, tags: [], content: "{}", sig: "sig" },
      },
    ]);
  });

  it("sends follow messages to coordinators", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleCoordinatorFollow({
      voterSecretKey: new Uint8Array([1, 2, 3]),
      coordinatorNpub: "npub1coord",
      voterNpub: "npub1voter",
      voterId: "abc1234",
      votingId: "vote-1",
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(result.successes).toBeGreaterThan(0);
  });

  it("fetches coordinator followers from DMs", async () => {
    const mod = await import("./simpleShardDm");

    querySync.mockResolvedValue([{ created_at: 10 }, { created_at: 9 }]);
    unwrapEvent
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_coordinator_follow",
          follow_id: "follow-1",
          voter_npub: "npub1voter",
          voter_id: "abc1234",
          voting_id: "vote-1",
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      })
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_shard_request",
          request_id: "req-x",
        }),
      });

    const followers = await mod.fetchSimpleCoordinatorFollowers({
      coordinatorNsec: "nsec1coord",
    });

    expect(followers).toEqual([
      {
        id: "follow-1",
        voterNpub: "npub1voter",
        voterId: "abc1234",
        votingId: "vote-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ]);
  });

  it("sends sub-coordinator join messages to the lead coordinator", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleSubCoordinatorJoin({
      coordinatorSecretKey: new Uint8Array([1, 2, 3]),
      leadCoordinatorNpub: "npub1lead",
      coordinatorNpub: "npub1coord",
      coordinatorId: "coord123",
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(result.successes).toBeGreaterThan(0);
  });

  it("subscribes to sub-coordinator join updates", async () => {
    const mod = await import("./simpleShardDm");
    const onApplications = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: { created_at: number }) => void }) => {
      params.onevent?.({ created_at: 10 });
      return { close: vi.fn(async () => undefined) };
    });
    unwrapEvent.mockReturnValueOnce({
      content: JSON.stringify({
        action: "simple_subcoordinator_join",
        application_id: "application-1",
        coordinator_npub: "npub1coord",
        coordinator_id: "coord123",
        lead_coordinator_npub: "npub1lead",
        created_at: "2026-03-31T00:00:00.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleSubCoordinatorApplications({
      leadCoordinatorNsec: "nsec1lead",
      onApplications,
    });

    expect(onApplications).toHaveBeenLastCalledWith([
      {
        id: "application-1",
        coordinatorNpub: "npub1coord",
        coordinatorId: "coord123",
        leadCoordinatorNpub: "npub1lead",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    unsubscribe();
  });

  it("sends share assignments from the lead coordinator", async () => {
    const mod = await import("./simpleShardDm");

    const result = await mod.sendSimpleShareAssignment({
      leadCoordinatorSecretKey: new Uint8Array([1, 2, 3]),
      leadCoordinatorNpub: "npub1lead",
      coordinatorNpub: "npub1coord",
      shareIndex: 2,
      thresholdN: 3,
    });

    expect(wrapEvent).toHaveBeenCalled();
    expect(result.successes).toBeGreaterThan(0);
  });

  it("subscribes to share assignment updates for a coordinator", async () => {
    const mod = await import("./simpleShardDm");
    const onAssignments = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: { created_at: number }) => void }) => {
      params.onevent?.({ created_at: 10 });
      return { close: vi.fn(async () => undefined) };
    });
    unwrapEvent.mockReturnValueOnce({
      content: JSON.stringify({
        action: "simple_share_assignment",
        assignment_id: "assignment-1",
        lead_coordinator_npub: "npub1lead",
        coordinator_npub: "npub1coord",
        share_index: 2,
        threshold_n: 3,
        created_at: "2026-03-31T00:00:00.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleCoordinatorShareAssignments({
      coordinatorNsec: "nsec1coord",
      onAssignments,
    });

    expect(onAssignments).toHaveBeenLastCalledWith([
      {
        id: "assignment-1",
        leadCoordinatorNpub: "npub1lead",
        coordinatorNpub: "npub1coord",
        shareIndex: 2,
        thresholdN: 3,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    unsubscribe();
  });

  it("subscribes to coordinator follower updates", async () => {
    const mod = await import("./simpleShardDm");
    const onFollowers = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: { created_at: number }) => void }) => {
      params.onevent?.({ created_at: 10 });
      params.onevent?.({ created_at: 11 });
      return { close: vi.fn(async () => undefined) };
    });
    unwrapEvent
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_coordinator_follow",
          follow_id: "follow-1",
          voter_npub: "npub1voter",
          voter_id: "abc1234",
          created_at: "2026-03-31T00:00:00.000Z",
        }),
      })
      .mockReturnValueOnce({
        content: JSON.stringify({
          action: "simple_coordinator_follow",
          follow_id: "follow-2",
          voter_npub: "npub1voter-2",
          voter_id: "def5678",
          created_at: "2026-03-31T00:01:00.000Z",
        }),
      });

    const unsubscribe = mod.subscribeSimpleCoordinatorFollowers({
      coordinatorNsec: "nsec1coord",
      onFollowers,
    });

    expect(onFollowers).toHaveBeenLastCalledWith([
      {
        id: "follow-2",
        voterNpub: "npub1voter-2",
        voterId: "def5678",
        votingId: undefined,
        createdAt: "2026-03-31T00:01:00.000Z",
      },
      {
        id: "follow-1",
        voterNpub: "npub1voter",
        voterId: "abc1234",
        votingId: undefined,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    unsubscribe();
  });

  it("subscribes to round ticket updates for a voter", async () => {
    const mod = await import("./simpleShardDm");
    const onResponses = vi.fn();

    subscribeMany.mockImplementation((_relays: string[], _filter: unknown, params: { onevent?: (event: { created_at: number }) => void }) => {
      params.onevent?.({ created_at: 10 });
      return { close: vi.fn(async () => undefined) };
    });
    unwrapEvent.mockReturnValueOnce({
      content: JSON.stringify({
        action: "simple_round_ticket",
        response_id: "resp-1",
        request_id: "round-ticket:vote-1:npub1coord",
        coordinator_npub: "npub1coord",
        coordinator_id: "abc1234",
        threshold_label: "3 of 5",
        voting_prompt: "Should the proposal pass?",
        shard_certificate: { id: "cert-1" },
        created_at: "2026-03-31T00:00:00.000Z",
      }),
    });

    const unsubscribe = mod.subscribeSimpleShardResponses({
      voterNsec: "nsec1voter",
      onResponses,
    });

    expect(onResponses).toHaveBeenLastCalledWith([
      {
        id: "resp-1",
        requestId: "round-ticket:vote-1:npub1coord",
        coordinatorNpub: "npub1coord",
        coordinatorId: "abc1234",
        thresholdLabel: "3 of 5",
        createdAt: "2026-03-31T00:00:00.000Z",
        votingPrompt: "Should the proposal pass?",
        shardCertificate: { id: "cert-1", kind: 38993, pubkey: "ab".repeat(32), created_at: 10, tags: [], content: "{}", sig: "sig" },
      },
    ]);

    unsubscribe();
  });
});
