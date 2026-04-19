import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import TokenFingerprint from "./TokenFingerprint";
import {
  evaluateQuestionnaireBlindAdmissions,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
} from "./questionnaireTransport";
import { formatQuestionnaireStateLabel } from "./questionnaireRuntime";
import type { QuestionnaireResultSummary } from "./questionnaireProtocol";

const AUDITOR_REFRESH_INTERVAL_MS = 15000;
const AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT = 20;
const AUDITOR_QUESTIONNAIRE_RESPONSE_LIMIT = 400;

type AuditorQuestionnaireEntry = {
  questionnaireId: string;
  title: string;
  description: string;
  coordinatorNpub: string;
  createdAt: number;
  openAt: number | null;
  closeAt: number | null;
  state: string | null;
  publishedAcceptedResponseCount: number | null;
  publishedRejectedResponseCount: number | null;
  resultPublishedAt: number | null;
  eventId: string;
};

type AuditorQuestionnaireResponseDetail = ReturnType<typeof evaluateQuestionnaireBlindAdmissions>["decisions"][number] & {
  includedInLatestPublish: boolean;
};

export default function SimpleAuditorApp() {
  const [questionnaires, setQuestionnaires] = useState<AuditorQuestionnaireEntry[]>([]);
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState("");
  const [selectedResponseDetails, setSelectedResponseDetails] = useState<AuditorQuestionnaireResponseDetail[]>([]);
  const [selectedLatestPublishAt, setSelectedLatestPublishAt] = useState<number | null>(null);
  const [selectedLiveState, setSelectedLiveState] = useState<string | null>(null);
  const [selectedResultSummary, setSelectedResultSummary] = useState<QuestionnaireResultSummary | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [questionnaireRefreshStatus, setQuestionnaireRefreshStatus] = useState<string | null>(null);
  const [responseRefreshStatus, setResponseRefreshStatus] = useState<string | null>(null);
  const selectedQuestionnaireIdRef = useRef("");
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    selectedQuestionnaireIdRef.current = selectedQuestionnaireId;
  }, [selectedQuestionnaireId]);

  const refreshQuestionnaires = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
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
          publishedAcceptedResponseCount: latestResult?.acceptedResponseCount ?? null,
          publishedRejectedResponseCount: latestResult?.rejectedResponseCount ?? null,
          resultPublishedAt: Number(latestResult?.createdAt ?? 0) || null,
          eventId: entry.event.id,
        };
      }));

      setQuestionnaires(entries);
      const selectedId = selectedQuestionnaireIdRef.current.trim();
      if (!selectedId || !entries.some((entry) => entry.questionnaireId === selectedId)) {
        setSelectedQuestionnaireId(entries[0]?.questionnaireId ?? "");
      }
      setQuestionnaireRefreshStatus(
        entries.length > 0
          ? "Questionnaires refreshed from Nostr."
          : "No public questionnaires discovered yet.",
      );
    } catch {
      setQuestionnaires([]);
      setSelectedQuestionnaireId("");
      setQuestionnaireRefreshStatus("Failed to refresh public questionnaires.");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);

  const refreshSelectedQuestionnaireResponses = useCallback(async () => {
    const selectedId = selectedQuestionnaireIdRef.current.trim();
    if (!selectedId) {
      setSelectedResponseDetails([]);
      setSelectedLatestPublishAt(null);
      setSelectedLiveState(null);
      setSelectedResultSummary(null);
      setResponseRefreshStatus("Choose a questionnaire round.");
      return;
    }
    try {
      const [responseEntries, resultEntries, stateEntries] = await Promise.all([
        fetchQuestionnaireBlindResponses({
          questionnaireId: selectedId,
          limit: AUDITOR_QUESTIONNAIRE_RESPONSE_LIMIT,
        }),
        fetchQuestionnaireResultSummary({
          questionnaireId: selectedId,
          limit: 50,
        }).catch(() => []),
        fetchQuestionnaireState({
          questionnaireId: selectedId,
          limit: 50,
        }).catch(() => []),
      ]);
      const admissions = evaluateQuestionnaireBlindAdmissions({ entries: responseEntries });
      const latestResult = [...resultEntries]
        .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0))[0];
      const latestState = [...stateEntries]
        .sort((left, right) => Number(right.event.created_at ?? right.state.createdAt ?? 0) - Number(left.event.created_at ?? left.state.createdAt ?? 0))[0];
      const latestPublishAt = latestResult?.event.created_at ?? null;
      const details = admissions.decisions
        .map((decision) => ({
          ...decision,
          includedInLatestPublish: latestPublishAt !== null ? Number(decision.event.created_at ?? 0) <= latestPublishAt : false,
        }))
        .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
      setSelectedResponseDetails(details);
      setSelectedLatestPublishAt(latestPublishAt);
      setSelectedLiveState(latestState?.state.state ?? null);
      setSelectedResultSummary(latestResult?.summary ?? null);
      setResponseRefreshStatus("Questionnaire responses refreshed from Nostr.");
    } catch {
      setSelectedResponseDetails([]);
      setSelectedLatestPublishAt(null);
      setSelectedLiveState(null);
      setSelectedResultSummary(null);
      setResponseRefreshStatus("Failed to refresh questionnaire responses.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const runRefresh = async () => {
      if (cancelled) {
        return;
      }
      await refreshQuestionnaires();
      if (!cancelled) {
        await refreshSelectedQuestionnaireResponses();
      }
    };

    void runRefresh();
    const intervalId = window.setInterval(() => {
      void runRefresh();
    }, AUDITOR_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refreshQuestionnaires, refreshSelectedQuestionnaireResponses]);

  useEffect(() => {
    if (!selectedQuestionnaireId.trim()) {
      setSelectedResponseDetails([]);
      setSelectedLatestPublishAt(null);
      setSelectedLiveState(null);
      setSelectedResultSummary(null);
      return;
    }
    void refreshSelectedQuestionnaireResponses();
  }, [refreshSelectedQuestionnaireResponses, selectedQuestionnaireId]);

  const coordinatorOptions = useMemo(
    () => [...new Set(
      questionnaires
        .map((questionnaire) => questionnaire.coordinatorNpub.trim())
        .filter((value) => value.length > 0),
    )],
    [questionnaires],
  );

  const [selectedCoordinatorNpub, setSelectedCoordinatorNpub] = useState("");

  const filteredQuestionnaires = useMemo(
    () => questionnaires.filter((questionnaire) => {
      if (selectedCoordinatorNpub && questionnaire.coordinatorNpub !== selectedCoordinatorNpub) {
        return false;
      }
      const query = searchQuery.trim().toLowerCase();
      if (query.length > 0) {
        const matchesQuery = (
          questionnaire.questionnaireId.toLowerCase().includes(query)
          || questionnaire.title.toLowerCase().includes(query)
          || questionnaire.description.toLowerCase().includes(query)
          || questionnaire.coordinatorNpub.toLowerCase().includes(query)
          || questionnaire.eventId.toLowerCase().includes(query)
        );
        if (!matchesQuery) {
          return false;
        }
      }
      return true;
    }),
    [questionnaires, searchQuery, selectedCoordinatorNpub],
  );

  useEffect(() => {
    if (selectedCoordinatorNpub && !coordinatorOptions.includes(selectedCoordinatorNpub)) {
      setSelectedCoordinatorNpub("");
    }
    if (filteredQuestionnaires.length === 0) {
      if (selectedQuestionnaireId) {
        setSelectedQuestionnaireId("");
      }
      return;
    }
    if (!selectedQuestionnaireId || !filteredQuestionnaires.some((entry) => entry.questionnaireId === selectedQuestionnaireId)) {
      setSelectedQuestionnaireId(filteredQuestionnaires[0].questionnaireId);
    }
  }, [coordinatorOptions, filteredQuestionnaires, selectedCoordinatorNpub, selectedQuestionnaireId]);

  const selectedQuestionnaire = useMemo(
    () => filteredQuestionnaires.find((entry) => entry.questionnaireId === selectedQuestionnaireId)
      ?? null,
    [filteredQuestionnaires, selectedQuestionnaireId],
  );

  const liveAcceptedCount = useMemo(
    () => selectedResponseDetails.filter((entry) => entry.accepted).length,
    [selectedResponseDetails],
  );

  const liveRejectedCount = useMemo(
    () => selectedResponseDetails.filter((entry) => !entry.accepted).length,
    [selectedResponseDetails],
  );

  const unpublishedAcceptedCount = useMemo(
    () => selectedResponseDetails.filter((entry) => entry.accepted && !entry.includedInLatestPublish).length,
    [selectedResponseDetails],
  );

  const unpublishedRejectedCount = useMemo(
    () => selectedResponseDetails.filter((entry) => !entry.accepted && !entry.includedInLatestPublish).length,
    [selectedResponseDetails],
  );

  async function refreshNow() {
    setQuestionnaireRefreshStatus("Refreshing public questionnaires...");
    setResponseRefreshStatus("Refreshing questionnaire responses...");
    await refreshQuestionnaires();
    await refreshSelectedQuestionnaireResponses();
  }

  function formatQuestionnaireTime(unix: number | null) {
    if (!unix) {
      return "Not set";
    }
    return new Date(unix * 1000).toLocaleString();
  }

  function formatRoundOptionLabel(entry: AuditorQuestionnaireEntry) {
    return `${entry.title} · ${entry.questionnaireId}`;
  }

  function formatPublishState(includedInLatestPublish: boolean) {
    if (selectedLatestPublishAt === null) {
      return "Unpublished";
    }
    return includedInLatestPublish ? "Published" : "Unpublished";
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Auditor</h1>
          <button type='button' className='simple-voter-primary' onClick={() => void refreshNow()}>
            Refresh
          </button>
        </div>

        <SimpleCollapsibleSection title='Questionnaire rounds'>
          {questionnaires.length > 0 ? (
            <>
              <label className='simple-voter-label' htmlFor='simple-auditor-coordinator-npub'>
                Coordinator npub
              </label>
              <select
                id='simple-auditor-coordinator-npub'
                className='simple-voter-input'
                value={selectedCoordinatorNpub}
                onChange={(event) => setSelectedCoordinatorNpub(event.target.value)}
              >
                <option value=''>Any coordinator npub</option>
                {coordinatorOptions.map((coordinatorNpub) => (
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
              {filteredQuestionnaires.length > 0 ? (
                <>
                  <label className='simple-voter-label' htmlFor='simple-auditor-round'>
                    Round
                  </label>
                  <select
                    id='simple-auditor-round'
                    className='simple-voter-input'
                    value={selectedQuestionnaire?.questionnaireId ?? ''}
                    onChange={(event) => setSelectedQuestionnaireId(event.target.value)}
                  >
                    {filteredQuestionnaires.map((entry) => (
                      <option key={entry.eventId} value={entry.questionnaireId}>
                        {formatRoundOptionLabel(entry)}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className='simple-voter-note'>No questionnaire rounds found for the selected filters.</p>
              )}
              {selectedQuestionnaire ? (
                <div className='simple-auditor-summary-grid'>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Question</p>
                    <p className='simple-voter-question'>{selectedQuestionnaire.title}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Questionnaire ID</p>
                    <p className='simple-voter-question'>{selectedQuestionnaire.questionnaireId}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Publish state</p>
                    <p className='simple-voter-question'>{selectedLatestPublishAt ? `Published at ${formatQuestionnaireTime(selectedLatestPublishAt)}` : "Not published yet"}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Round phase</p>
                    <p className='simple-voter-question'>{formatQuestionnaireStateLabel(selectedLiveState ?? selectedQuestionnaire.state)}</p>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className='simple-voter-empty'>No public questionnaire rounds discovered yet.</p>
          )}
          {questionnaireRefreshStatus ? <p className='simple-voter-note'>{questionnaireRefreshStatus}</p> : null}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Questionnaire results'>
          {selectedQuestionnaire ? (
            selectedResultSummary ? (
              <>
                <p className='simple-voter-question'>{selectedQuestionnaire.title}</p>
                <p className='simple-voter-note'>
                  Published at: {formatQuestionnaireTime(Number(selectedResultSummary.createdAt ?? selectedQuestionnaire.resultPublishedAt ?? 0))}
                </p>
                <p className='simple-voter-note'>
                  Published totals: valid {selectedResultSummary.acceptedResponseCount}, invalid {selectedResultSummary.rejectedResponseCount}
                </p>
                <ul className='simple-voter-list'>
                  {selectedResultSummary.questionSummaries.map((summary) => (
                    <li
                      key={`${summary.questionId}:${summary.answerType}`}
                      className='simple-voter-list-item'
                    >
                      <div className='simple-submitted-vote-copy'>
                        <p className='simple-voter-question'>Question {summary.questionId}</p>
                        {summary.answerType === "yes_no" ? (
                          <p className='simple-voter-note'>Yes: {summary.yesCount} | No: {summary.noCount}</p>
                        ) : summary.answerType === "multiple_choice" ? (
                          <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                            {Object.entries(summary.optionCounts).map(([optionId, count]) => (
                              <li key={optionId} className='simple-delivery-ok'>{optionId}: {count}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className='simple-voter-note'>Free-text responses: {summary.freeTextCount}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='simple-voter-empty'>No published result summary yet for this questionnaire.</p>
            )
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to inspect results.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Audit summary'>
          {selectedQuestionnaire ? (
            <>
              <div className='simple-auditor-summary-grid'>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Live valid responses</p>
                  <p className='simple-auditor-score'>{liveAcceptedCount}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Live invalid responses</p>
                  <p className='simple-auditor-score'>{liveRejectedCount}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Unpublished valid</p>
                  <p className='simple-auditor-score'>{unpublishedAcceptedCount}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Unpublished invalid</p>
                  <p className='simple-auditor-score'>{unpublishedRejectedCount}</p>
                </div>
              </div>
              <p className='simple-voter-note'>
                Published summary: {selectedQuestionnaire.publishedAcceptedResponseCount ?? 0} valid, {selectedQuestionnaire.publishedRejectedResponseCount ?? 0} invalid.
              </p>
              {responseRefreshStatus ? <p className='simple-voter-note'>{responseRefreshStatus}</p> : null}
            </>
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to audit.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Submitted votes'>
          {selectedQuestionnaire ? (
            selectedResponseDetails.length > 0 ? (
              <>
                <p className='simple-voter-question'>{selectedQuestionnaire.title}</p>
                <p className='simple-submitted-score'>Total responses: {selectedResponseDetails.length}</p>
                <ul className='simple-voter-list'>
                  {selectedResponseDetails.map((entry) => (
                    <li key={entry.event.id} className='simple-voter-list-item'>
                      <div className='simple-submitted-vote-row'>
                        <div className='simple-submitted-vote-copy'>
                          <p className='simple-voter-question'>
                            Response {entry.response.responseId} {entry.accepted
                              ? <span className='simple-status-valid'>[Valid]</span>
                              : <span className='simple-status-invalid'>[Invalid: duplicate nullifier]</span>}
                          </p>
                          <p className='simple-voter-note'>Event {entry.event.id}</p>
                          <p className='simple-voter-note'>
                            Publish state: {formatPublishState(entry.includedInLatestPublish)} | Submitted: {formatQuestionnaireTime(Number(entry.event.created_at ?? 0))}
                          </p>
                        </div>
                        <TokenFingerprint tokenId={entry.response.tokenNullifier} compact large hideMetadata />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='simple-voter-empty'>No submitted responses found for this round yet.</p>
            )
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to inspect responses.</p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}
