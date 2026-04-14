import { describe, expect, it } from "vitest";

import { DerivedStateAdapter } from "./derivedStateAdapter";
import { buildElectionDefinitionEvent, publicEventFromLiveVote } from "./publicEventBridge";
import { ballotEventFromSubmittedVote } from "./ballotEventBridge";

describe("DerivedStateAdapter", () => {
  it("derives round and ballot state deterministically", async () => {
    const adapter = await DerivedStateAdapter.create("simple-public-election");
    const state = adapter.replayAll([
      buildElectionDefinitionEvent({
        electionId: "simple-public-election",
        authorPubkey: "npub1coord",
        title: "Auditable Voting",
      }),
      publicEventFromLiveVote({
        electionId: "simple-public-election",
        session: {
          votingId: "vote-1",
          prompt: "Should the proposal pass?",
          coordinatorNpub: "npub1coord",
          createdAt: "2026-04-07T00:00:00.000Z",
          thresholdT: 2,
          thresholdN: 2,
          authorizedCoordinatorNpubs: ["npub1coord", "npub1coord2"],
          eventId: "round-open-1",
        },
      }),
      ballotEventFromSubmittedVote({
        electionId: "simple-public-election",
        vote: {
          eventId: "ballot-1",
          votingId: "vote-1",
          voterNpub: "npub1voter",
          choice: "Yes",
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
      }),
    ]);

    expect(state.public_state.rounds).toHaveLength(1);
    expect(state.public_state.rounds[0].phase).toBe("open");
    expect(state.ballot_state.acceptance_rule).toBe("first_valid_wins");
    expect(state.ballot_state.accepted_ballots).toHaveLength(1);
    expect(state.ballot_state.round_summaries[0]).toEqual(
      expect.objectContaining({ yes_count: 1, no_count: 0, accepted_ballot_count: 1 }),
    );
  });

  it("exposes snapshot metadata, replay status, and diagnostics", async () => {
    const adapter = await DerivedStateAdapter.create("simple-public-election");
    adapter.replayAll([
      buildElectionDefinitionEvent({
        electionId: "simple-public-election",
        authorPubkey: "npub1coord",
        title: "Auditable Voting",
      }),
    ]);

    expect(adapter.getSnapshotMetadata()).toEqual(
      expect.objectContaining({
        election_id: "simple-public-election",
        snapshot_format_version: 1,
        protocol_schema_version: 1,
        compatibility: "compatible",
      }),
    );
    expect(adapter.getReplayStatus()).toEqual(
      expect.objectContaining({
        total_events: 1,
        unique_events: 1,
        duplicate_events: 0,
      }),
    );
    expect(adapter.getDiagnostics()).toEqual(
      expect.objectContaining({
        accepted_ballot_count: 0,
        rejected_ballot_count: 0,
        snapshot_status: "compatible",
      }),
    );
  });

  it("rejects incompatible snapshot versions on restore", async () => {
    const adapter = await DerivedStateAdapter.create("simple-public-election");
    const snapshot = adapter.exportSnapshot();
    snapshot.schema_version = 999;

    await expect(DerivedStateAdapter.restore(snapshot)).rejects.toThrow(
      /Incompatible protocol snapshot version/,
    );
  });
});
