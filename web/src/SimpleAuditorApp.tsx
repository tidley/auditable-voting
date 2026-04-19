import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
} from "./questionnaireTransport";

const SIMPLE_AUDITOR_ELECTION_ID = "simple-public-election";
const AUDITOR_REFRESH_INTERVAL_MS = 15000;
const AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT = 20;

type AuditorQuestionnaireEntry = {
  questionnaireId: string;
  title: string;
  description: string;
  coordinatorNpub: string;
  createdAt: number;
  openAt: number | null;
  closeAt: number | null;
  state: string | null;
  acceptedResponseCount: number | null;
  eventId: string;
};

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
  const [questionnaires, setQuestionnaires] = useState<AuditorQuestionnaireEntry[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [selectedLeadCoordinatorNpub, setSelectedLeadCoordinatorNpub] = useState("");
  const [selectedRosterCoordinatorNpub, setSelectedRosterCoordinatorNpub] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [questionnaireRefreshStatus, setQuestionnaireRefreshStatus] = useState<string | null>(null);
  const snapshotRef = useRef<ProtocolSnapshot | null>(null);
  const selectedVotingIdRef = useRef("");
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    selectedVotingIdRef.current = selectedVotingId;
  }, [selectedVotingId]);

  const refreshDerivedState = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const rounds = await fetchSimpleLiveVotes();
      const orderedRounds = sortRecordsByCreatedAtDescRust(rounds);
      const selectedRoundId = selectedVotingIdRef.current.trim() || (orderedRounds[0]?.votingId ?? "");
      const selectedRoundVotes = selectedRoundId
        ? typeof fetchSimpleSubmittedVotes === "function"
          ? await fetchSimpleSubmittedVotes({ votingId: selectedRoundId })
          : []
        : [];

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
        ...selectedRoundVotes.map((vote) => ballotEventFromSubmittedVote({
          electionId: SIMPLE_AUDITOR_ELECTION_ID,
          vote,
        })),
      ];

      const adapter = snapshotRef.current
        ? await DerivedStateAdapter.restore(snapshotRef.current)
        : await DerivedStateAdapter.create(SIMPLE_AUDITOR_ELECTION_ID);

      const nextDerivedState = adapter.replayAll(protocolEvents);
      const nextSnapshot = adapter.exportSnapshot();
      setDerivedState(nextDerivedState);
      snapshotRef.current = nextSnapshot;
      setRefreshStatus(
        orderedRounds.length > 0
          ? "Rounds and ballots refreshed from Nostr."
          : "No public rounds discovered yet.",
      );
    } catch {
      setRefreshStatus("Failed to refresh public rounds.");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);

  const refreshQuestionnaires = useCallback(async () => {
    try {
      const definitions = await fetchQuestionnaireDefinitions({ limit: 400 });
      const latestDefinitionById = new Map<string, Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]>();
      for (const entry of definitions) {
        const id = entry.definition.questionnaireId.trim();
        if (!id) {
          continue;
        }
        const previous = latestDefinitionById.get(id);
        const createdAt = Number(entry.event.created_at ?? entry.definition.createdAt ?? 0);
        const previousCreatedAt = previous
          ? Number(previous.event.created_at ?? previous.definition.createdAt ?? 0)
          : 0;
        if (!previous || createdAt >= previousCreatedAt) {
          latestDefinitionById.set(id, entry);
        }
      }

      const latestDefinitions = [...latestDefinitionById.values()]
        .sort((left, right) => (
          Number(right.event.created_at ?? right.definition.createdAt ?? 0)
          - Number(left.event.created_at ?? left.definition.createdAt ?? 0)
        ))
        .slice(0, AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT);

      const entries = await Promise.all(latestDefinitions.map(async (entry): Promise<AuditorQuestionnaireEntry> => {
        const id = entry.definition.questionnaireId;
        const [stateEntries, resultEntries] = await Promise.all([
          fetchQuestionnaireState({ questionnaireId: id, limit: 50 }).catch(() => []),
          fetchQuestionnaireResultSummary({ questionnaireId: id, limit: 50 }).catch(() => []),
        ]);
        const latestState = [...stateEntries]
          .sort((left, right) => Number(right.event.created_at ?? right.state.createdAt ?? 0) - Number(left.event.created_at ?? left.state.createdAt ?? 0))[0]
          ?.state.state ?? null;
        const latestResult = [...resultEntries]
          .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0))[0]
          ?.summary ?? null;
        return {
          questionnaireId: id,
          title: entry.definition.title || "Untitled questionnaire",
          description: entry.definition.description || "",
          coordinatorNpub: entry.definition.coordinatorPubkey,
          createdAt: Number(entry.event.created_at ?? entry.definition.createdAt ?? 0),
          openAt: Number.isFinite(entry.definition.openAt) ? entry.definition.openAt : null,
          closeAt: Number.isFinite(entry.definition.closeAt) ? entry.definition.closeAt : null,
          state: latestState,
          acceptedResponseCount: latestResult?.acceptedResponseCount ?? null,
          eventId: entry.event.id,
        };
      }));

      setQuestionnaires(entries);
      setQuestionnaireRefreshStatus(
        entries.length > 0
          ? "Questionnaires refreshed from Nostr."
          : "No public questionnaires discovered yet.",
      );
    } catch {
      setQuestionnaires([]);
      setQuestionnaireRefreshStatus("Failed to refresh public questionnaires.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const runRefresh = async () => {
      if (cancelled) {
        return;
      }
      await Promise.all([refreshDerivedState(), refreshQuestionnaires()]);
    };

    void runRefresh();
    const intervalId = window.setInterval(() => {
      void runRefresh();
    }, AUDITOR_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refreshDerivedState, refreshQuestionnaires]);

  useEffect(() => {
    if (!selectedVotingId.trim()) {
      return;
    }
    void refreshDerivedState();
  }, [refreshDerivedState, selectedVotingId]);

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
      const query = searchQuery.trim().toLowerCase();
      if (query.length > 0) {
        const matchesQuery = (
          round.votingId.toLowerCase().includes(query)
          || round.prompt.toLowerCase().includes(query)
          || round.eventId.toLowerCase().includes(query)
          || round.coordinatorNpub.toLowerCase().includes(query)
          || round.authorizedCoordinatorNpubs.some((npub) => npub.toLowerCase().includes(query))
        );
        if (!matchesQuery) {
          return false;
        }
      }
      return true;
    }),
    [discoveredRounds, searchQuery, selectedLeadCoordinatorNpub, selectedRosterCoordinatorNpub],
  );

  const filteredQuestionnaires = useMemo(
    () => questionnaires.filter((questionnaire) => {
      const query = searchQuery.trim().toLowerCase();
      if (query.length === 0) {
        return true;
      }
      return (
        questionnaire.questionnaireId.toLowerCase().includes(query)
        || questionnaire.title.toLowerCase().includes(query)
        || questionnaire.description.toLowerCase().includes(query)
        || questionnaire.coordinatorNpub.toLowerCase().includes(query)
        || questionnaire.eventId.toLowerCase().includes(query)
      );
    }),
    [questionnaires, searchQuery],
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
    setQuestionnaireRefreshStatus("Refreshing public questionnaires...");
    await Promise.all([refreshDerivedState(), refreshQuestionnaires()]);
  }

  function formatQuestionnaireTime(unix: number | null) {
    if (!unix) {
      return "Not set";
    }
    return new Date(unix * 1000).toLocaleString();
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
              <label className='simple-voter-label' htmlFor='simple-auditor-search'>
                Search
              </label>
              <input
                id='simple-auditor-search'
                className='simple-voter-input'
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder='Filter by npub, round/questionnaire ID, or prompt...'
              />
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

        <SimpleCollapsibleSection title='Discovered questionnaires'>
          {questionnaires.length > 0 ? (
            filteredQuestionnaires.length > 0 ? (
              <ul className='simple-voter-list'>
                {filteredQuestionnaires.map((questionnaire) => (
                  <li key={questionnaire.eventId} className='simple-voter-list-item'>
                    <div className='simple-submitted-vote-copy'>
                      <p className='simple-voter-question'>{questionnaire.title}</p>
                      <p className='simple-voter-note'>Questionnaire ID: {questionnaire.questionnaireId}</p>
                      <p className='simple-voter-note'>Coordinator: {questionnaire.coordinatorNpub || "Unknown"}</p>
                      <p className='simple-voter-note'>
                        State: {questionnaire.state ?? "Unknown"} | Responses: {questionnaire.acceptedResponseCount ?? "Not published"}
                      </p>
                      <p className='simple-voter-note'>
                        Created: {formatQuestionnaireTime(questionnaire.createdAt)} | Opens: {formatQuestionnaireTime(questionnaire.openAt)} | Closes: {formatQuestionnaireTime(questionnaire.closeAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='simple-voter-note'>No questionnaires found for the current search.</p>
            )
          ) : (
            <p className='simple-voter-empty'>No public questionnaires discovered yet.</p>
          )}
          {questionnaireRefreshStatus ? <p className='simple-voter-note'>{questionnaireRefreshStatus}</p> : null}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Audit summary'>
          {selectedRound ? (
            <>
              <div className='simple-auditor-summary-grid'>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Accepted Yes</p>
                  <p className='simple-auditor-score'>{selectedSummary?.yes_count ?? 0}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Accepted No</p>
                  <p className='simple-auditor-score'>{selectedSummary?.no_count ?? 0}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Rejected ballots</p>
                  <p className='simple-auditor-score'>{selectedSummary?.rejected_ballot_count ?? 0}</p>
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
