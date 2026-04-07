import { beforeEach, describe, expect, it, vi } from "vitest";

type PublishedControlEvent = {
  id: string;
  content: string;
};

let publishedControlEvents: PublishedControlEvent[] = [];
let publishCounter = 0;

vi.mock("../nostr/publishCoordinatorControl", () => ({
  publishCoordinatorControl: vi.fn(async (input: { message: { content: string } }) => {
    const eventId = `coordinator-control-${++publishCounter}`;
    publishedControlEvents.push({
      id: eventId,
      content: input.message.content,
    });
    return {
      eventId,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
}));

describe("CoordinatorControlService", () => {
  beforeEach(() => {
    publishedControlEvents = [];
    publishCounter = 0;
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
});
