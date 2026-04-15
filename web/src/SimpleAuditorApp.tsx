import { useEffect, useMemo, useRef, useState } from "react";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import TokenFingerprint from "./TokenFingerprint";
import {
  fetchSimpleLiveVotes,
  fetchSimpleSubmittedVotes,
  type SimpleLiveVoteSession,
} from "./simpleVotingSession";
import { formatRoundOptionLabel } from "./roundLabel";
import { sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";
import { DerivedStateAdapter, type DerivedState, type ProtocolSnapshot } from "./core/derivedStateAdapter";
import { ballotEventFromSubmittedVote } from "./core/ballotEventBridge";
import {
  buildElectionDefinitionEvent,
  publicEventFromLiveVote,
} from "./core/publicEventBridge";

const SIMPLE_AUDITOR_ELECTION_ID = "simple-public-election";

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

export default function SimpleAuditorApp() {
  const [derivedState, setDerivedState] = useState<DerivedState | null>(null);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [selectedLeadCoordinatorNpub, setSelectedLeadCoordinatorNpub] = useState("");
  const [selectedRosterCoordinatorNpub, setSelectedRosterCoordinatorNpub] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const snapshotRef = useRef<ProtocolSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refreshDerivedState() {
      try {
        const rounds = await fetchSimpleLiveVotes();
        const orderedRounds = sortRecordsByCreatedAtDescRust(rounds);
        const ballotsByRound = await Promise.all(
          orderedRounds.map(async (round) => ({
            round,
            votes: await fetchSimpleSubmittedVotes({ votingId: round.votingId }),
          })),
        );

        const protocolEvents = [
          buildElectionDefinitionEvent({
            electionId: SIMPLE_AUDITOR_ELECTION_ID,
            authorPubkey: orderedRounds[0]?.coordinatorNpub ?? "auditor",
            title: "Auditable Voting",
          }),
          ...orderedRounds.map((round) => publicEventFromLiveVote({
            electionId: SIMPLE_AUDITOR_ELECTION_ID,
            session: round,
          })),
          ...ballotsByRound.flatMap(({ votes }) => votes.map((vote) => ballotEventFromSubmittedVote({
            electionId: SIMPLE_AUDITOR_ELECTION_ID,
            vote,
          }))),
        ];

        const adapter = snapshotRef.current
          ? await DerivedStateAdapter.restore(snapshotRef.current)
          : await DerivedStateAdapter.create(SIMPLE_AUDITOR_ELECTION_ID);

        const nextDerivedState = adapter.replayAll(protocolEvents);
        const nextSnapshot = adapter.exportSnapshot();

        if (cancelled) {
          return;
        }

        setDerivedState(nextDerivedState);
        snapshotRef.current = nextSnapshot;
        setRefreshStatus(
          orderedRounds.length > 0
            ? "Rounds and ballots refreshed from Nostr."
            : "No public rounds discovered yet.",
        );
      } catch {
        if (!cancelled) {
          setRefreshStatus("Failed to refresh public rounds.");
        }
      }
    }

    void refreshDerivedState();
    const intervalId = window.setInterval(() => {
      void refreshDerivedState();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const discoveredRounds = useMemo(
    () => sortRecordsByCreatedAtDescRust(
      (derivedState?.public_state.rounds ?? []).map(roundToSession),
    ),
    [derivedState],
  );

  const leadCoordinatorOptions = useMemo(
    () => [...new Set(
      discoveredRounds
        .map((round) => round.coordinatorNpub.trim())
        .filter((value) => value.length > 0),
    )],
    [discoveredRounds],
  );

  const rosterCoordinatorOptions = useMemo(
    () => [...new Set(
      discoveredRounds.flatMap((round) => round.authorizedCoordinatorNpubs.map((value) => value.trim())),
    )].filter((value) => value.length > 0),
    [discoveredRounds],
  );

  const filteredDiscoveredRounds = useMemo(
    () => discoveredRounds.filter((round) => {
      if (selectedLeadCoordinatorNpub && round.coordinatorNpub !== selectedLeadCoordinatorNpub) {
        return false;
      }
      if (selectedRosterCoordinatorNpub && !round.authorizedCoordinatorNpubs.includes(selectedRosterCoordinatorNpub)) {
        return false;
      }
      return true;
    }),
    [discoveredRounds, selectedLeadCoordinatorNpub, selectedRosterCoordinatorNpub],
  );

  useEffect(() => {
    if (selectedLeadCoordinatorNpub && !leadCoordinatorOptions.includes(selectedLeadCoordinatorNpub)) {
      setSelectedLeadCoordinatorNpub("");
    }
    if (selectedRosterCoordinatorNpub && !rosterCoordinatorOptions.includes(selectedRosterCoordinatorNpub)) {
      setSelectedRosterCoordinatorNpub("");
    }
  }, [
    leadCoordinatorOptions,
    rosterCoordinatorOptions,
    selectedLeadCoordinatorNpub,
    selectedRosterCoordinatorNpub,
  ]);

  useEffect(() => {
    if (filteredDiscoveredRounds.length === 0) {
      if (selectedVotingId) {
        setSelectedVotingId("");
      }
      return;
    }
    if (!selectedVotingId || !filteredDiscoveredRounds.some((round) => round.votingId === selectedVotingId)) {
      setSelectedVotingId(filteredDiscoveredRounds[0].votingId);
    }
  }, [filteredDiscoveredRounds, selectedVotingId]);

  const selectedRoundId = selectedVotingId || filteredDiscoveredRounds[0]?.votingId || "";

  const selectedRound = useMemo(
    () => derivedState?.public_state.rounds.find((round) => round.round_id === selectedRoundId)
      ?? null,
    [derivedState, selectedRoundId],
  );

  const selectedSummary = useMemo(
    () => derivedState?.ballot_state.round_summaries.find((summary) => summary.round_id === selectedRound?.round_id) ?? null,
    [derivedState, selectedRound?.round_id],
  );

  const acceptedBallots = useMemo(
    () => derivedState?.ballot_state.accepted_ballots.filter((ballot) => ballot.round_id === selectedRound?.round_id) ?? [],
    [derivedState, selectedRound?.round_id],
  );

  const rejectedBallots = useMemo(
    () => derivedState?.ballot_state.rejected_ballots.filter((ballot) => ballot.round_id === selectedRound?.round_id) ?? [],
    [derivedState, selectedRound?.round_id],
  );

  async function refreshNow() {
    snapshotRef.current = null;
    setRefreshStatus("Refreshing public rounds...");
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Auditor</h1>
          <button type='button' className='simple-voter-primary' onClick={() => void refreshNow()}>
            Refresh rounds
          </button>
        </div>

        <SimpleCollapsibleSection title='Discovered rounds'>
          {discoveredRounds.length > 0 ? (
            <>
              <label className='simple-voter-label' htmlFor='simple-auditor-lead-coordinator'>
                Lead coordinator
              </label>
              <select
                id='simple-auditor-lead-coordinator'
                className='simple-voter-input'
                value={selectedLeadCoordinatorNpub}
                onChange={(event) => setSelectedLeadCoordinatorNpub(event.target.value)}
              >
                <option value=''>All lead coordinators</option>
                {leadCoordinatorOptions.map((coordinatorNpub) => (
                  <option key={coordinatorNpub} value={coordinatorNpub}>
                    {coordinatorNpub}
                  </option>
                ))}
              </select>
              <label className='simple-voter-label' htmlFor='simple-auditor-coordinator-npub'>
                Coordinator npub
              </label>
              <select
                id='simple-auditor-coordinator-npub'
                className='simple-voter-input'
                value={selectedRosterCoordinatorNpub}
                onChange={(event) => setSelectedRosterCoordinatorNpub(event.target.value)}
              >
                <option value=''>Any coordinator npub</option>
                {rosterCoordinatorOptions.map((coordinatorNpub) => (
                  <option key={coordinatorNpub} value={coordinatorNpub}>
                    {coordinatorNpub}
                  </option>
                ))}
              </select>
              {filteredDiscoveredRounds.length > 0 ? (
                <>
                  <label className='simple-voter-label' htmlFor='simple-auditor-round'>
                    Round
                  </label>
                  <select
                    id='simple-auditor-round'
                    className='simple-voter-input'
                    value={selectedRound?.round_id ?? ''}
                    onChange={(event) => setSelectedVotingId(event.target.value)}
                  >
                    {filteredDiscoveredRounds.map((round) => (
                      <option key={round.eventId} value={round.votingId}>
                        {formatRoundOptionLabel(round)}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className='simple-voter-note'>No rounds found for the selected coordinator filters.</p>
              )}
              {selectedRound ? (
                <div className='simple-auditor-summary-grid'>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Question</p>
                    <p className='simple-voter-question'>{selectedRound.prompt}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Voting ID</p>
                    <p className='simple-voter-question'>{selectedRound.round_id}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Threshold</p>
                    <p className='simple-voter-question'>
                      {selectedRound.threshold_t} of {selectedRound.threshold_n}
                    </p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Round phase</p>
                    <p className='simple-voter-question'>{selectedRound.phase}</p>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className='simple-voter-empty'>No public rounds discovered yet.</p>
          )}
          {refreshStatus ? <p className='simple-voter-note'>{refreshStatus}</p> : null}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Audit summary'>
          {selectedRound && selectedSummary ? (
            <>
              <div className='simple-auditor-summary-grid'>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Accepted Yes</p>
                  <p className='simple-auditor-score'>{selectedSummary.yes_count}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Accepted No</p>
                  <p className='simple-auditor-score'>{selectedSummary.no_count}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Rejected ballots</p>
                  <p className='simple-auditor-score'>{selectedSummary.rejected_ballot_count}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Acceptance rule</p>
                  <p className='simple-voter-question'>{derivedState?.ballot_state.acceptance_rule.replace(/_/g, ' ')}</p>
                </div>
              </div>
              <p className='simple-voter-question'>
                Authorized coordinators: {selectedRound.coordinator_roster.length}
              </p>
              <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                {selectedRound.coordinator_roster.map((npub) => (
                  <li key={npub} className='simple-delivery-ok'>{npub}</li>
                ))}
              </ul>
              {derivedState?.public_state.issues.length ? (
                <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                  {derivedState.public_state.issues.map((issue) => (
                    <li key={`${issue.code}:${issue.event_id ?? issue.detail}`} className='simple-delivery-error'>
                      {issue.code}: {issue.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className='simple-voter-empty'>Choose a public round to audit.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Submitted votes'>
          {selectedRound ? (
            acceptedBallots.length > 0 || rejectedBallots.length > 0 ? (
              <>
                <p className='simple-voter-question'>{selectedRound.prompt}</p>
                <p className='simple-submitted-score'>
                  Yes: {selectedSummary?.yes_count ?? 0} | No: {selectedSummary?.no_count ?? 0}
                </p>
                <ul className='simple-voter-list'>
                  {acceptedBallots.map((ballot) => (
                    <li key={ballot.event_id} className='simple-voter-list-item'>
                      <div className='simple-submitted-vote-row'>
                        <div className='simple-submitted-vote-copy'>
                          <p className='simple-voter-question'>
                            Vote {ballot.choice} <span className='simple-status-valid'>[Valid]</span>
                          </p>
                          <p className='simple-voter-note'>Ballot {ballot.event_id}</p>
                        </div>
                        <TokenFingerprint tokenId={ballot.token_id} compact large hideMetadata />
                      </div>
                    </li>
                  ))}
                  {rejectedBallots.map((ballot) => (
                    <li key={ballot.event_id} className='simple-voter-list-item'>
                      <div className='simple-submitted-vote-row'>
                        <div className='simple-submitted-vote-copy'>
                          <p className='simple-voter-question'>
                            Vote {ballot.choice} <span className='simple-status-invalid'>[Invalid: {ballot.reason.detail}]</span>
                          </p>
                          <p className='simple-voter-note'>Ballot {ballot.event_id}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='simple-voter-empty'>No submitted votes found for this round yet.</p>
            )
          ) : (
            <p className='simple-voter-empty'>Choose a public round to inspect ballots.</p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}
