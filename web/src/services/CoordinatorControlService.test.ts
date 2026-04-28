import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorOutboundTransportMessage } from "../core/coordinatorCoreAdapter";

type PublishedControlEvent = {
  id: string;
  content: string;
  pubkey: string;
};

let publishedControlEvents: PublishedControlEvent[] = [];
let publishCounter = 0;
const publishCoordinatorControlMock = vi.fn(async (input: {
  message: { content: string; sender_pubkey: string };
  onPrepared?: (prepared: { eventId: string; rawEvent: unknown }) => void;
}) => {
  const eventId = `coordinator-control-${++publishCounter}`;
  input.onPrepared?.({ eventId, rawEvent: { id: eventId } });
  publishedControlEvents.push({
    id: eventId,
    content: input.message.content,
    pubkey: input.message.sender_pubkey,
  });
  return {
    eventId,
    successes: 1,
    failures: 0,
    relayResults: [],
  };
});

vi.mock("../nostr/publishCoordinatorControl", () => ({
  publishCoordinatorControl: publishCoordinatorControlMock,
}));

describe("CoordinatorControlService", () => {
  beforeEach(() => {
    publishedControlEvents = [];
    publishCounter = 0;
    publishCoordinatorControlMock.mockClear();
    publishCoordinatorControlMock.mockImplementation(async (input: {
      message: { content: string; sender_pubkey: string };
      onPrepared?: (prepared: { eventId: string; rawEvent: unknown }) => void;
    }) => {
      const eventId = `coordinator-control-${++publishCounter}`;
      input.onPrepared?.({ eventId, rawEvent: { id: eventId } });
      publishedControlEvents.push({
        id: eventId,
        content: input.message.content,
        pubkey: input.message.sender_pubkey,
      });
      return {
        eventId,
        successes: 1,
        failures: 0,
        relayResults: [],
      };
    });
  });

  it("replays round-open control events deterministically across coordinators", async () => {
    const { CoordinatorControlService } = await import("./CoordinatorControlService");

    const lead = await CoordinatorControlService.create({
      electionId: "simple-election:lead",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
    });
    const sub = await CoordinatorControlService.create({
      electionId: "simple-election:lead",
      localPubkey: "npub-sub",
      roster: ["npub-lead", "npub-sub"],
    });

    const leadPublish = await lead.publishRoundOpenFlow({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
      roundId: "round-1",
      prompt: "Should the proposal pass?",
      thresholdT: 2,
      thresholdN: 2,
      roster: ["npub-lead", "npub-sub"],
    });

    expect(leadPublish.state.latest_round?.phase).toBe("open_proposed");
    expect(publishedControlEvents).toHaveLength(3);

    sub.ingestCoordinatorEvents([...publishedControlEvents]);
    const approval = await sub.maybeAutoApproveRoundOpen({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
    });

    expect(approval).not.toBeNull();
    expect(approval?.state.latest_round?.phase).toBe("open");
    expect(publishedControlEvents).toHaveLength(4);

    lead.ingestCoordinatorEvents([...publishedControlEvents]);
    expect(lead.getState().latest_round?.phase).toBe("open");
    expect(lead.getState().latest_round?.missing_open_committers).toEqual([]);

    const snapshot = lead.snapshot();
    const restored = await CoordinatorControlService.create({
      electionId: "simple-election:lead",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
      snapshot: snapshot.snapshot,
    });

    expect(restored.getState()).toEqual(lead.getState());
  });

  it("preserves configured engine kind in snapshots and restore matching", async () => {
    const { CoordinatorControlService } = await import("./CoordinatorControlService");

    const service = await CoordinatorControlService.create({
      electionId: "simple-election:lead",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
      engineKind: "deterministic",
    });

    const snapshot = service.snapshot();
    expect(snapshot.snapshot.config.engine_kind ?? "deterministic").toBe("deterministic");

    const restored = await CoordinatorControlService.create({
      electionId: "simple-election:lead",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
      engineKind: "deterministic",
      snapshot: snapshot.snapshot,
    });

    expect(restored.snapshot().snapshot.config.engine_kind ?? "deterministic").toBe("deterministic");
  });

  it("supports round-open replay using the open_mls engine", async () => {
    const { CoordinatorControlService } = await import("./CoordinatorControlService");

    const lead = await CoordinatorControlService.create({
      electionId: "simple-election:lead-openmls",
      localPubkey: "lead-openmls",
      leadPubkey: "lead-openmls",
      roster: ["lead-openmls", "sub-openmls"],
      engineKind: "open_mls",
    });
    const sub = await CoordinatorControlService.create({
      electionId: "simple-election:lead-openmls",
      localPubkey: "sub-openmls",
      leadPubkey: "lead-openmls",
      roster: ["lead-openmls", "sub-openmls"],
      engineKind: "open_mls",
    });

    const initialSubStatus = sub.getEngineStatus();
    expect(initialSubStatus.group_ready).toBe(false);
    expect(initialSubStatus.readiness).toBe("waiting_for_group_ready");
    expect(initialSubStatus.welcome_applied).toBe(false);

    const joinPackage = sub.exportSupervisoryJoinPackage();
    expect(typeof joinPackage).toBe("string");

    const welcomeBundle = lead.bootstrapSupervisoryGroup(joinPackage ? [joinPackage] : []);
    expect(typeof welcomeBundle).toBe("string");
    expect(sub.joinSupervisoryGroup(welcomeBundle ?? "")).toBe(true);
    expect(sub.getEngineStatus().welcome_applied).toBe(true);
    expect(sub.getEngineStatus().snapshot_freshness).toBe("live");

    const leadPublish = await lead.publishRoundOpenFlow({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
      roundId: "round-openmls-1",
      prompt: "Should the proposal pass?",
      thresholdT: 2,
      thresholdN: 2,
      roster: ["lead-openmls", "sub-openmls"],
    });

    expect(leadPublish.state.latest_round?.phase).toBe("open_proposed");
    expect(publishedControlEvents).toHaveLength(3);

    sub.ingestCoordinatorEvents([...publishedControlEvents]);
    expect(sub.getEngineStatus().readiness).toBe("waiting_for_own_open_commit");
    const approval = await sub.maybeAutoApproveRoundOpen({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
    });

    expect(approval).not.toBeNull();
    expect(approval?.state.latest_round?.phase).toBe("open");
    expect(sub.getEngineStatus().readiness).toBe("round_open");

    lead.ingestCoordinatorEvents([...publishedControlEvents]);
    expect(lead.getState().latest_round?.phase).toBe("open");
  });

  it("retries coordinator control publish until a relay accepts it", async () => {
    const { CoordinatorControlService } = await import("./CoordinatorControlService");

    let attempt = 0;
    publishCoordinatorControlMock.mockImplementation(async (input: {
      message: { content: string; sender_pubkey: string };
      onPrepared?: (prepared: { eventId: string; rawEvent: unknown }) => void;
    }) => {
      const eventId = `coordinator-control-${++publishCounter}`;
      attempt += 1;
      input.onPrepared?.({ eventId, rawEvent: { id: eventId } });
      if (attempt === 1) {
        return {
          eventId,
          successes: 0,
          failures: 2,
          relayResults: [
            { relay: "wss://relay.nostr.net", success: false, error: "timeout" },
            { relay: "wss://nos.lol", success: false, error: "timeout" },
          ],
        };
      }

      publishedControlEvents.push({
        id: eventId,
        content: input.message.content,
        pubkey: input.message.sender_pubkey,
      });
      return {
        eventId,
        successes: 1,
        failures: 0,
        relayResults: [],
      };
    });

    const lead = await CoordinatorControlService.create({
      electionId: "simple-election:retry",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
    });

    const result = await lead.publishRoundOpenFlow({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
      roundId: "round-retry-1",
      prompt: "Should the proposal pass?",
      thresholdT: 2,
      thresholdN: 2,
      roster: ["npub-lead", "npub-sub"],
    });

    expect(attempt).toBeGreaterThan(1);
    expect(result.state.latest_round?.round_id).toBe("round-retry-1");
    expect(result.state.latest_round?.phase).toBe("open_proposed");
  });

  it("applies the local round-open commit before relay publish retries complete", async () => {
    vi.useFakeTimers();
    const { CoordinatorControlService } = await import("./CoordinatorControlService");

    let publishStep = 0;
    publishCoordinatorControlMock.mockImplementation(async (input: {
      message: CoordinatorOutboundTransportMessage;
      onPrepared?: (prepared: { eventId: string; rawEvent: unknown }) => void;
    }) => {
      const eventId = `coordinator-control-${++publishCounter}`;
      publishStep += 1;
      input.onPrepared?.({ eventId, rawEvent: { id: eventId } });

      if (publishStep <= 2) {
        publishedControlEvents.push({
          id: eventId,
          content: input.message.content,
          pubkey: input.message.sender_pubkey,
        });
        return {
          eventId,
          successes: 1,
          failures: 0,
          relayResults: [],
        };
      }

      return {
        eventId,
        successes: 0,
        failures: 2,
        relayResults: [
          { relay: "wss://relay.nostr.net", success: false, error: "timeout" },
          { relay: "wss://nos.lol", success: false, error: "timeout" },
        ],
      };
    });

    const lead = await CoordinatorControlService.create({
      electionId: "simple-election:self-commit",
      localPubkey: "npub-lead",
      roster: ["npub-lead", "npub-sub"],
    });

    const flow = lead.publishRoundOpenFlow({
      coordinatorNsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs7x58m",
      roundId: "round-self-commit",
      prompt: "Should the proposal pass?",
      thresholdT: 2,
      thresholdN: 2,
      roster: ["npub-lead", "npub-sub"],
    });
    const flowRejection = expect(flow).rejects.toThrow(/Coordinator control publish failed across all relays/);

    await vi.runAllTimersAsync();
    await flowRejection;

    expect(lead.getEngineStatus().readiness).toBe("waiting_for_coordinator_approvals");
    expect(lead.getState().latest_round?.missing_open_committers).toEqual(["npub-sub"]);

    vi.useRealTimers();
  });
});
