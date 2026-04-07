import { describe, expect, it } from "vitest";

import { ProtocolStateService, SIMPLE_PUBLIC_ELECTION_ID } from "./ProtocolStateService";

describe("ProtocolStateService", () => {
  it("replays rounds and ballots into shared Rust-derived state and restores from snapshot", async () => {
    const rounds = [
      {
        votingId: "vote-1",
        prompt: "Should the proposal pass?",
        coordinatorNpub: "npub1coord",
        createdAt: "2026-04-07T00:00:00.000Z",
        thresholdT: 2,
        thresholdN: 2,
        authorizedCoordinatorNpubs: ["npub1coord", "npub1coord2"],
        eventId: "round-open-1",
      },
    ];

    const votes = [
      {
        eventId: "ballot-1",
        votingId: "vote-1",
        voterNpub: "npub1voter",
        choice: "Yes" as const,
        shardProofs: [
          {
            coordinatorNpub: "npub1coord",
            votingId: "vote-1",
            tokenCommitment: "commit-1",
            unblindedSignature: "sig-1",
            shareIndex: 1,
            keyAnnouncementEvent: { id: "blind-key-1" },
          },
          {
            coordinatorNpub: "npub1coord2",
            votingId: "vote-1",
            tokenCommitment: "commit-1",
            unblindedSignature: "sig-2",
            shareIndex: 2,
            keyAnnouncementEvent: { id: "blind-key-2" },
          },
        ],
        tokenId: "token-1",
        createdAt: "2026-04-07T00:00:01.000Z",
      },
    ];

    const service = await ProtocolStateService.create({
      electionId: SIMPLE_PUBLIC_ELECTION_ID,
    });
    const firstReplay = service.replayPublicState({
      electionId: SIMPLE_PUBLIC_ELECTION_ID,
      authorPubkey: "npub1coord",
      rounds,
      votes,
    });

    expect(firstReplay.roundSessions).toHaveLength(1);
    expect(firstReplay.roundSessions[0].votingId).toBe("vote-1");
    expect(firstReplay.derivedState.ballot_state.round_summaries[0]).toEqual(
      expect.objectContaining({ yes_count: 1, no_count: 0, accepted_ballot_count: 1 }),
    );
    expect(firstReplay.snapshotMetadata.compatibility).toBe("compatible");
    expect(firstReplay.replayStatus.duplicate_events).toBe(0);
    expect(firstReplay.diagnostics.snapshot_status).toBe("compatible");

    const restored = await ProtocolStateService.create({
      electionId: SIMPLE_PUBLIC_ELECTION_ID,
      snapshot: service.snapshot(),
    });
    const secondReplay = restored.replayPublicState({
      electionId: SIMPLE_PUBLIC_ELECTION_ID,
      authorPubkey: "npub1coord",
      rounds,
      votes,
    });

    expect(secondReplay.derivedState).toEqual(firstReplay.derivedState);
    expect(secondReplay.snapshotMetadata.compatibility).toBe("compatible");
    expect(secondReplay.diagnostics.known_round_ids).toEqual(["vote-1"]);
  });
});
