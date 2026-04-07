import type { SimpleLiveVoteSession, SimpleSubmittedVote } from "../simpleVotingSession";
import {
  DerivedStateAdapter,
  type DerivedState,
  type ProtocolDiagnostics,
  type ProtocolSnapshot,
  type ReplayStatus,
  type SnapshotMetadata,
} from "../core/derivedStateAdapter";
import {
  buildElectionDefinitionEvent,
  publicEventFromLiveVote,
} from "../core/publicEventBridge";
import { ballotEventFromSubmittedVote } from "../core/ballotEventBridge";
import { sortRecordsByCreatedAtDescRust } from "../wasm/auditableVotingCore";

export const SIMPLE_PUBLIC_ELECTION_ID = "simple-public-election";

export type ProtocolStateCache = {
  snapshot: ProtocolSnapshot;
};

export type ProtocolReplayView = {
  derivedState: DerivedState;
  roundSessions: SimpleLiveVoteSession[];
  snapshotMetadata: SnapshotMetadata;
  replayStatus: ReplayStatus;
  diagnostics: ProtocolDiagnostics;
};

function snapshotMatchesElection(input: {
  electionId: string;
  snapshot?: ProtocolSnapshot | null;
}) {
  return input.snapshot?.election_id === input.electionId;
}

function roundToSession(round: DerivedState["public_state"]["rounds"][number]): SimpleLiveVoteSession {
  const createdAtMs = round.opened_at ?? round.defined_at;
  return {
    votingId: round.round_id,
    prompt: round.prompt,
    coordinatorNpub: round.coordinator_roster[0] ?? "",
    createdAt: new Date(createdAtMs).toISOString(),
    thresholdT: round.threshold_t,
    thresholdN: round.threshold_n,
    authorizedCoordinatorNpubs: round.coordinator_roster,
    eventId: `derived:${round.round_id}`,
  };
}

export class ProtocolStateService {
  private constructor(private readonly adapter: DerivedStateAdapter) {}

  static async create(input: {
    electionId?: string;
    snapshot?: ProtocolStateCache | null;
  } = {}) {
    const electionId = input.electionId ?? SIMPLE_PUBLIC_ELECTION_ID;
    const adapter = snapshotMatchesElection({
      electionId,
      snapshot: input.snapshot?.snapshot,
    }) && input.snapshot?.snapshot
      ? await DerivedStateAdapter.restore(input.snapshot.snapshot)
      : await DerivedStateAdapter.create(electionId);

    return new ProtocolStateService(adapter);
  }

  snapshot(): ProtocolStateCache {
    return { snapshot: this.adapter.exportSnapshot() };
  }

  replayPublicState(input: {
    electionId?: string;
    title?: string;
    authorPubkey: string;
    rounds: SimpleLiveVoteSession[];
    votes?: SimpleSubmittedVote[];
  }) {
    const electionId = input.electionId ?? SIMPLE_PUBLIC_ELECTION_ID;
    const orderedRounds = sortRecordsByCreatedAtDescRust(input.rounds);
    const events = [
      buildElectionDefinitionEvent({
        electionId,
        authorPubkey: input.authorPubkey,
        title: input.title ?? "Auditable Voting",
      }),
      ...orderedRounds.map((session) => publicEventFromLiveVote({
        electionId,
        session,
      })),
      ...(input.votes ?? []).map((vote) => ballotEventFromSubmittedVote({
        electionId,
        vote,
      })),
    ];

    const derivedState = this.adapter.replayAll(events);
    return {
      derivedState,
      roundSessions: sortRecordsByCreatedAtDescRust(
        derivedState.public_state.rounds.map(roundToSession),
      ),
      snapshotMetadata: this.adapter.getSnapshotMetadata(),
      replayStatus: this.adapter.getReplayStatus(),
      diagnostics: this.adapter.getDiagnostics(),
    } satisfies ProtocolReplayView;
  }
}
