import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19, type NostrEvent } from "nostr-tools";
import TokenFingerprint from "./TokenFingerprint";
import {
  evaluateQuestionnaireBlindAdmissions,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
} from "./questionnaireTransport";
import { formatQuestionnaireStateLabel } from "./questionnaireRuntime";
import type {
  QuestionnairePublishedResponseRef,
  QuestionnaireQuestion,
  QuestionnaireResultSummary,
} from "./questionnaireProtocol";
import { loadCoordinatorState, loadElectionRegistry, loadElectionSummary } from "./questionnaireOptionAStorage";
import type { BallotSubmission, QuestionnaireAnswer } from "./questionnaireOptionA";

const AUDITOR_REFRESH_INTERVAL_MS = 15000;
const AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT = 20;
const AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT = 2000;
const AUDITOR_QUESTIONNAIRE_HISTORIC_BATCH_SIZE = 8;
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
  questions: QuestionnaireQuestion[];
  eventId: string;
};

type AuditorQuestionnaireResponseDetail = ReturnType<typeof evaluateQuestionnaireBlindAdmissions>["decisions"][number] & {
  includedInLatestPublish: boolean;
};

function readInitialQuestionnaireIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("questionnaire") ?? params.get("q") ?? params.get("election_id") ?? "").trim();
}

export default function SimpleAuditorApp() {
  const [questionnaires, setQuestionnaires] = useState<AuditorQuestionnaireEntry[]>([]);
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState(() => readInitialQuestionnaireIdFromUrl());
  const [selectedResponseDetails, setSelectedResponseDetails] = useState<AuditorQuestionnaireResponseDetail[]>([]);
  const [selectedLatestPublishAt, setSelectedLatestPublishAt] = useState<number | null>(null);
  const [selectedLiveState, setSelectedLiveState] = useState<string | null>(null);
  const [selectedResultSummary, setSelectedResultSummary] = useState<QuestionnaireResultSummary | null>(null);
  const [voterSearchQuery, setVoterSearchQuery] = useState("");
  const [fullResultsOpen, setFullResultsOpen] = useState(false);
  const [freeTextViewerQuestionId, setFreeTextViewerQuestionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [questionnaireRefreshStatus, setQuestionnaireRefreshStatus] = useState<string | null>(null);
  const [responseRefreshStatus, setResponseRefreshStatus] = useState<string | null>(null);
  const [historicSearchInFlight, setHistoricSearchInFlight] = useState(false);
  const selectedQuestionnaireIdRef = useRef("");
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    selectedQuestionnaireIdRef.current = selectedQuestionnaireId;
  }, [selectedQuestionnaireId]);

  const loadQuestionnairesFromNostr = useCallback(async (input?: { historic?: boolean }) => {
    const historic = Boolean(input?.historic);
    const definitions = await fetchQuestionnaireDefinitions({
      limit: historic ? AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT : 400,
    });
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
        ));

      const candidates = historic
        ? latestDefinitions
        : latestDefinitions.slice(0, AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT);
      const entries: AuditorQuestionnaireEntry[] = [];
      for (let index = 0; index < candidates.length; index += AUDITOR_QUESTIONNAIRE_HISTORIC_BATCH_SIZE) {
        const batch = candidates.slice(index, index + AUDITOR_QUESTIONNAIRE_HISTORIC_BATCH_SIZE);
        const batchEntries = await Promise.all(batch.map(async (entry): Promise<AuditorQuestionnaireEntry> => {
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
          coordinatorNpub: normalizeToNpub(entry.definition.coordinatorPubkey),
          createdAt: Number(entry.event.created_at ?? entry.definition.createdAt ?? 0),
          openAt: Number.isFinite(entry.definition.openAt) ? entry.definition.openAt : null,
          closeAt: Number.isFinite(entry.definition.closeAt) ? entry.definition.closeAt : null,
          state: latestState,
          publishedAcceptedResponseCount: latestResult?.acceptedResponseCount ?? null,
          publishedRejectedResponseCount: latestResult?.rejectedResponseCount ?? null,
          resultPublishedAt: Number(latestResult?.createdAt ?? 0) || null,
          questions: entry.definition.questions ?? [],
          eventId: entry.event.id,
        };
        }));
        entries.push(...batchEntries);
      }
      return entries;
  }, []);

  const refreshQuestionnaires = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const entries = await loadQuestionnairesFromNostr();

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
  }, [loadQuestionnairesFromNostr]);

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
      let details = admissions.decisions
        .map((decision) => ({
          ...decision,
          response: {
            ...decision.response,
            authorPubkey: normalizeToNpub(decision.response.authorPubkey),
          },
          includedInLatestPublish: latestPublishAt !== null ? Number(decision.event.created_at ?? 0) <= latestPublishAt : false,
        }))
        .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
      const selectedEntry = questionnaires.find((entry) => entry.questionnaireId === selectedId) ?? null;
      const coordinatorState = resolveOptionACoordinatorState({
        electionId: selectedId,
        preferredCoordinatorNpub: selectedEntry?.coordinatorNpub ?? null,
      });
      if (coordinatorState) {
        const fallbackDetails = Object.values(coordinatorState.acceptanceResults)
          .map((acceptance) => {
            const submission = coordinatorState.receivedSubmissions[acceptance.submissionId];
            if (!submission) {
              return null;
            }
            return optionASubmissionToAuditorDetail({
              submission,
              accepted: acceptance.accepted,
              latestPublishAt,
            });
          })
          .filter((entry): entry is AuditorQuestionnaireResponseDetail => Boolean(entry))
          .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
        if (fallbackDetails.length > 0) {
          details = mergeAuditorResponseDetails(details, fallbackDetails);
        }
      }
      if ((latestResult?.summary.publishedResponseRefs?.length ?? 0) > 0) {
        const summaryRefDetails = (latestResult?.summary.publishedResponseRefs ?? [])
          .map((ref) => optionASummaryRefToAuditorDetail({
            questionnaireId: selectedId,
            ref,
            latestPublishAt,
          }));
        details = mergeAuditorResponseDetails(details, summaryRefDetails);
      }
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
  }, [questionnaires]);

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
    setVoterSearchQuery("");
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

  const selectedQuestionById = useMemo(
    () => new Map((selectedQuestionnaire?.questions ?? []).map((question) => [question.questionId, question])),
    [selectedQuestionnaire?.questions],
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
  const publishedValidCount = selectedResultSummary?.acceptedResponseCount ?? selectedQuestionnaire?.publishedAcceptedResponseCount ?? 0;
  const publishedInvalidCount = selectedResultSummary?.rejectedResponseCount ?? selectedQuestionnaire?.publishedRejectedResponseCount ?? 0;
  const publishedTotalCount = Math.max(0, publishedValidCount + publishedInvalidCount);
  const publishedValidityPercent = publishedTotalCount > 0
    ? ((publishedValidCount / publishedTotalCount) * 100).toFixed(1)
    : "0.0";
  const canExportResults = Boolean(
    selectedQuestionnaire
    && (selectedLiveState ?? selectedQuestionnaire.state) === "results_published"
    && selectedResultSummary,
  );
  const filteredResponseDetails = useMemo(() => {
    const query = voterSearchQuery.trim().toLowerCase();
    if (!query) {
      return selectedResponseDetails;
    }
    return selectedResponseDetails.filter((entry) => (
      entry.response.authorPubkey.toLowerCase().includes(query)
      || entry.response.responseId.toLowerCase().includes(query)
      || entry.response.tokenNullifier.toLowerCase().includes(query)
    ));
  }, [selectedResponseDetails, voterSearchQuery]);

  async function refreshNow() {
    setQuestionnaireRefreshStatus("Refreshing public questionnaires...");
    setResponseRefreshStatus("Refreshing questionnaire responses...");
    await refreshQuestionnaires();
    await refreshSelectedQuestionnaireResponses();
  }

  async function searchHistoricData() {
    if (historicSearchInFlight) {
      return;
    }
    setHistoricSearchInFlight(true);
    setQuestionnaireRefreshStatus("Searching historic questionnaire data...");
    try {
      const entries = await loadQuestionnairesFromNostr({ historic: true });
      setQuestionnaires(entries);
      const selectedId = selectedQuestionnaireIdRef.current.trim();
      if (!selectedId || !entries.some((entry) => entry.questionnaireId === selectedId)) {
        const query = searchQuery.trim().toLowerCase();
        const match = query
          ? entries.find((entry) => (
            entry.questionnaireId.toLowerCase().includes(query)
            || entry.title.toLowerCase().includes(query)
            || entry.description.toLowerCase().includes(query)
            || entry.coordinatorNpub.toLowerCase().includes(query)
            || entry.eventId.toLowerCase().includes(query)
          ))
          : null;
        setSelectedQuestionnaireId((match ?? entries[0])?.questionnaireId ?? "");
      }
      setQuestionnaireRefreshStatus(
        entries.length > 0
          ? `Historic search loaded ${entries.length} questionnaire${entries.length === 1 ? "" : "s"}.`
          : "No historic public questionnaires discovered.",
      );
      await refreshSelectedQuestionnaireResponses();
    } catch {
      setQuestionnaireRefreshStatus("Historic questionnaire search failed.");
    } finally {
      setHistoricSearchInFlight(false);
    }
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

  function exportResults() {
    if (!selectedQuestionnaire || !selectedResultSummary || (selectedLiveState ?? selectedQuestionnaire.state) !== "results_published") {
      return;
    }
    const payload = {
      schemaVersion: 1,
      exportType: "questionnaire_results_validator_export",
      exportedAt: Math.floor(Date.now() / 1000),
      questionnaire: {
        questionnaireId: selectedQuestionnaire.questionnaireId,
        title: selectedQuestionnaire.title,
        description: selectedQuestionnaire.description,
        coordinatorNpub: selectedQuestionnaire.coordinatorNpub,
        state: selectedLiveState ?? selectedQuestionnaire.state,
      },
      summary: selectedResultSummary,
      responses: selectedResponseDetails.map((entry) => ({
        eventId: entry.event.id,
        createdAt: entry.event.created_at,
        accepted: entry.accepted,
        rejectionReason: entry.rejectionReason,
        includedInLatestPublish: entry.includedInLatestPublish,
        response: entry.response,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `questionnaire-results-${selectedQuestionnaire.questionnaireId}.json`;
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <section className='simple-voter-section simple-auditor-panel' data-refresh-status={questionnaireRefreshStatus ?? ""}>
          <div className='simple-voter-header-row'>
            <h2 className='simple-voter-section-title'>Questionnaire Rounds</h2>
            <button type='button' className='simple-voter-secondary' onClick={() => void refreshNow()}>
              Refresh
            </button>
          </div>
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
                  <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
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
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      onClick={() => void searchHistoricData()}
                      disabled={historicSearchInFlight}
                    >
                      {historicSearchInFlight ? "Searching..." : "Search historic data"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className='simple-voter-note'>No questionnaire rounds found for the selected filters.</p>
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void searchHistoricData()}
                    disabled={historicSearchInFlight}
                  >
                    {historicSearchInFlight ? "Searching..." : "Search historic data"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <p className='simple-voter-empty'>No public questionnaire rounds discovered yet.</p>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => void searchHistoricData()}
                disabled={historicSearchInFlight}
              >
                {historicSearchInFlight ? "Searching..." : "Search historic data"}
              </button>
            </>
          )}
        </section>

        <section className='simple-voter-section simple-auditor-panel'>
          <h2 className='simple-voter-section-title'>Questionnaire Results</h2>
          {selectedQuestionnaire ? (
            <>
              <div className='simple-auditor-results-status'>
                <span className='simple-voter-question'>{publishedTotalCount} Response{publishedTotalCount === 1 ? "" : "s"} - {publishedValidityPercent}%</span>
                <div className='simple-auditor-results-progress' aria-hidden='true'>
                  <span style={{ width: `${publishedValidityPercent}%` }} />
                </div>
                <span className='simple-voter-note'>Published at: {formatQuestionnaireTime(Number(selectedResultSummary?.createdAt ?? selectedQuestionnaire.resultPublishedAt ?? 0))}</span>
              </div>
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
                  <p className='simple-auditor-summary-label'>Round phase</p>
                  <p className='simple-voter-question'>{formatQuestionnaireStateLabel(selectedLiveState ?? selectedQuestionnaire.state)}</p>
                </div>
              </div>
              {selectedResultSummary ? (
                <>
                  <div className='simple-auditor-question-grid'>
                    {selectedResultSummary.questionSummaries.map((summary) => (
                      <article key={`${summary.questionId}:${summary.answerType}`} className='simple-auditor-question-card'>
                        <h3 className='simple-voter-question'>{selectedQuestionById.get(summary.questionId)?.prompt || `Question ${summary.questionId}`}</h3>
                        {summary.answerType === "yes_no" ? (
                          <div className='simple-auditor-bars'>
                            <p className='simple-voter-note'>Yes: {summary.yesCount}</p>
                            <div className='simple-auditor-results-progress' aria-hidden='true'>
                              <span style={{ width: `${(summary.yesCount + summary.noCount) > 0 ? (summary.yesCount / (summary.yesCount + summary.noCount)) * 100 : 0}%` }} />
                            </div>
                            <p className='simple-voter-note'>No: {summary.noCount}</p>
                            <div className='simple-auditor-results-progress' aria-hidden='true'>
                              <span style={{ width: `${(summary.yesCount + summary.noCount) > 0 ? (summary.noCount / (summary.yesCount + summary.noCount)) * 100 : 0}%` }} />
                            </div>
                          </div>
                        ) : summary.answerType === "multiple_choice" ? (
                          <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                            {Object.entries(summary.optionCounts).map(([optionId, count]) => (
                              <li key={optionId} className='simple-delivery-ok'>
                                {(selectedQuestionById.get(summary.questionId)?.type === "multiple_choice"
                                  ? selectedQuestionById.get(summary.questionId)?.options.find((option) => option.optionId === optionId)?.label
                                  : optionId) ?? optionId}: {count}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <>
                            <p className='simple-voter-note'>Free-text responses: {summary.freeTextCount}</p>
                            <button
                              type='button'
                              className='simple-voter-secondary'
                              onClick={() => setFreeTextViewerQuestionId(summary.questionId)}
                            >
                              View
                            </button>
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                  <button
                    type='button'
                    className='simple-voter-secondary simple-auditor-full-results'
                    onClick={() => {
                      setVoterSearchQuery("");
                      setFullResultsOpen(true);
                    }}
                  >
                    View Full Results
                  </button>
                  {canExportResults ? (
                    <button
                      type='button'
                      className='simple-voter-secondary simple-auditor-full-results'
                      onClick={exportResults}
                    >
                      Export results
                    </button>
                  ) : null}
                </>
              ) : (
                <p className='simple-voter-empty'>No published result summary yet for this questionnaire.</p>
              )}
            </>
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to inspect results.</p>
          )}
        </section>

        <section className='simple-voter-section'>
          <h2 className='simple-voter-section-title'>Submitted Votes</h2>
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
                        <TokenFingerprint tokenId={entry.response.authorPubkey} compact large hideMetadata />
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
        </section>

        {fullResultsOpen && selectedQuestionnaire ? (
          <section className='token-fingerprint-overlay' role='dialog' aria-modal='true' aria-label='Full questionnaire results'>
            <button type='button' className='token-fingerprint-overlay-close' onClick={() => setFullResultsOpen(false)}>Close</button>
            <div className='token-fingerprint-overlay-card simple-auditor-full-results-card'>
              <h3 className='simple-voter-question'>Full Results · {selectedQuestionnaire.title}</h3>
              <label className='simple-voter-label' htmlFor='simple-auditor-voter-search'>Filter by voter ID</label>
              <input
                id='simple-auditor-voter-search'
                className='simple-voter-input'
                value={voterSearchQuery}
                onChange={(event) => setVoterSearchQuery(event.target.value)}
                placeholder='Search by voter npub, response ID, or token...'
              />
              {filteredResponseDetails.length > 0 ? (
                <ul className='simple-voter-list simple-auditor-result-list'>
                  {filteredResponseDetails.map((entry) => (
                    <li key={entry.event.id} className='simple-voter-list-item'>
                      <div className='simple-auditor-result-row'>
                        <div className='simple-auditor-result-marker'>
                          <TokenFingerprint tokenId={entry.response.authorPubkey} compact large hideMetadata />
                        </div>
                        <div className='simple-auditor-result-body'>
                          <p className='simple-voter-question'>{entry.response.authorPubkey}</p>
                          <p className='simple-voter-note'>Response: {entry.response.responseId} · {entry.accepted ? "Valid" : "Invalid"}</p>
                          {Array.isArray(entry.response.answers) && entry.response.answers.length > 0 ? (
                            <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                              {entry.response.answers.map((answer) => {
                                const question = selectedQuestionById.get(answer.questionId);
                                const prompt = question?.prompt || answer.questionId;
                                if (answer.answerType === "yes_no") {
                                  return <li key={`${entry.event.id}:${answer.questionId}`} className='simple-delivery-ok'>{prompt}: {answer.value ? "Yes" : "No"}</li>;
                                }
                                if (answer.answerType === "multiple_choice") {
                                  const selectedLabels = answer.selectedOptionIds.map((optionId) => (
                                    question?.type === "multiple_choice"
                                      ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
                                      : optionId
                                  ));
                                  return <li key={`${entry.event.id}:${answer.questionId}`} className='simple-delivery-ok'>{prompt}: {selectedLabels.join(", ") || "No option selected"}</li>;
                                }
                                return <li key={`${entry.event.id}:${answer.questionId}`} className='simple-delivery-ok'>{prompt}: {answer.text || "(empty)"}</li>;
                              })}
                            </ul>
                          ) : (
                            <p className='simple-voter-note'>Answer payload is encrypted or unavailable in public events.</p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='simple-voter-empty'>No voter responses match the current filter.</p>
              )}
            </div>
          </section>
        ) : null}

        {freeTextViewerQuestionId && selectedQuestionnaire ? (
          <section className='token-fingerprint-overlay' role='dialog' aria-modal='true' aria-label='Free-text responses'>
            <button type='button' className='token-fingerprint-overlay-close' onClick={() => setFreeTextViewerQuestionId(null)}>Close</button>
            <div className='token-fingerprint-overlay-card simple-auditor-full-results-card'>
              <h3 className='simple-voter-question'>
                {selectedQuestionById.get(freeTextViewerQuestionId)?.prompt || freeTextViewerQuestionId}
              </h3>
              <ul className='simple-voter-list'>
                {selectedResponseDetails
                  .filter((entry) => Array.isArray(entry.response.answers))
                  .map((entry) => {
                    const freeText = entry.response.answers?.find((answer) => (
                      answer.questionId === freeTextViewerQuestionId && answer.answerType === "free_text"
                    ));
                    if (!freeText || freeText.answerType !== "free_text") {
                      return null;
                    }
                    return (
                      <li key={`${entry.event.id}:free-text`} className='simple-voter-list-item'>
                        <p className='simple-voter-note'>{entry.response.authorPubkey}</p>
                        <p className='simple-voter-question'>{freeText.text || "(empty)"}</p>
                      </li>
                    );
                  })
                  .filter(Boolean)}
              </ul>
              {!selectedResponseDetails.some((entry) => (
                Array.isArray(entry.response.answers)
                && entry.response.answers.some((answer) => answer.questionId === freeTextViewerQuestionId && answer.answerType === "free_text")
              )) ? (
                <p className='simple-voter-empty'>No free-text payloads are publicly available for this question.</p>
              ) : null}
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function optionAAnswerToQuestionnaireAnswer(answer: QuestionnaireAnswer) {
  if (answer.type === "yes_no") {
    return {
      questionId: answer.questionId,
      answerType: "yes_no" as const,
      value: answer.answer === "yes",
    };
  }
  if (answer.type === "multiple_choice") {
    return {
      questionId: answer.questionId,
      answerType: "multiple_choice" as const,
      selectedOptionIds: answer.answer,
    };
  }
  return {
    questionId: answer.questionId,
    answerType: "free_text" as const,
    text: answer.answer,
  };
}

function normalizeToNpub(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("npub1")) {
    return trimmed;
  }
  try {
    return nip19.npubEncode(trimmed);
  } catch {
    return trimmed;
  }
}

function mergeAuditorResponseDetails(
  primary: AuditorQuestionnaireResponseDetail[],
  fallback: AuditorQuestionnaireResponseDetail[],
) {
  const byKey = new Map<string, AuditorQuestionnaireResponseDetail>();
  const merged = [...primary, ...fallback];
  for (const detail of merged) {
    const responseId = detail.response.responseId.trim();
    const nullifier = detail.response.tokenNullifier.trim();
    const eventId = detail.event.id.trim();
    const key = responseId || nullifier || eventId;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, detail);
      continue;
    }
    // Prefer real Nostr events over synthetic fallback ids and keep the latest timestamp.
    const existingSynthetic = existing.event.id.startsWith("optiona:");
    const nextSynthetic = detail.event.id.startsWith("optiona:");
    if (existingSynthetic && !nextSynthetic) {
      byKey.set(key, detail);
      continue;
    }
    const existingAnswerCount = Array.isArray(existing.response.answers) ? existing.response.answers.length : 0;
    const nextAnswerCount = Array.isArray(detail.response.answers) ? detail.response.answers.length : 0;
    if (nextAnswerCount > existingAnswerCount) {
      byKey.set(key, detail);
      continue;
    }
    if (existing.includedInLatestPublish !== detail.includedInLatestPublish) {
      byKey.set(key, existing.includedInLatestPublish ? existing : detail);
      continue;
    }
    const existingCreated = Number(existing.event.created_at ?? 0);
    const nextCreated = Number(detail.event.created_at ?? 0);
    if (nextCreated > existingCreated) {
      byKey.set(key, detail);
    }
  }
  return [...byKey.values()].sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
}

function optionASubmissionToAuditorDetail(input: {
  submission: BallotSubmission;
  accepted: boolean;
  latestPublishAt: number | null;
}): AuditorQuestionnaireResponseDetail {
  const submittedAtMs = Date.parse(input.submission.submittedAt);
  const submittedAt = Number.isFinite(submittedAtMs)
    ? Math.floor(submittedAtMs / 1000)
    : Math.floor(Date.now() / 1000);
  const responseNpub = normalizeToNpub(input.submission.responseNpub?.trim() || input.submission.invitedNpub);
  const event = {
    id: `optiona:${input.submission.submissionId}`,
    created_at: submittedAt,
  } as NostrEvent;
  return {
    event,
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: input.submission.electionId,
      responseId: input.submission.submissionId,
      submittedAt,
      authorPubkey: responseNpub,
      tokenNullifier: input.submission.nullifier,
      tokenProof: {
        tokenCommitment: input.submission.tokenCommitment,
        questionnaireId: input.submission.electionId,
        signature: input.submission.credential,
      },
      answers: input.submission.payload.responses.map(optionAAnswerToQuestionnaireAnswer),
    },
    accepted: input.accepted,
    rejectionReason: input.accepted ? null : "duplicate_nullifier",
    includedInLatestPublish: input.latestPublishAt !== null ? submittedAt <= input.latestPublishAt : false,
  };
}

function optionASummaryRefToAuditorDetail(input: {
  questionnaireId: string;
  ref: QuestionnairePublishedResponseRef;
  latestPublishAt: number | null;
}): AuditorQuestionnaireResponseDetail {
  const responseId = input.ref.responseId.trim();
  const submittedAt = Number.isFinite(input.ref.submittedAt)
    ? Number(input.ref.submittedAt)
    : Math.floor(Date.now() / 1000);
  const event = {
    id: `summary:${input.questionnaireId}:${responseId}`,
    created_at: submittedAt,
  } as NostrEvent;
  const normalizedAuthor = normalizeToNpub(input.ref.authorPubkey);
  return {
    event,
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: input.questionnaireId,
      responseId,
      submittedAt,
      authorPubkey: normalizedAuthor,
      tokenNullifier: `summary_missing_${responseId}`,
      tokenProof: {
        tokenCommitment: `summary_missing_${responseId}`,
        questionnaireId: input.questionnaireId,
        signature: "summary_reference",
      },
      answers: input.ref.answers ?? [],
    },
    accepted: input.ref.accepted,
    rejectionReason: input.ref.accepted ? null : "duplicate_nullifier",
    includedInLatestPublish: input.latestPublishAt !== null ? submittedAt <= input.latestPublishAt : true,
  };
}

function resolveOptionACoordinatorState(input: {
  electionId: string;
  preferredCoordinatorNpub?: string | null;
}) {
  const electionId = input.electionId.trim();
  if (!electionId) {
    return null;
  }

  const candidateCoordinatorNpubs = [
    normalizeToNpub(input.preferredCoordinatorNpub?.trim() ?? ""),
    normalizeToNpub(loadElectionSummary(electionId)?.coordinatorNpub?.trim() ?? ""),
    ...loadElectionRegistry()
      .filter((id) => id === electionId)
      .map((id) => normalizeToNpub(loadElectionSummary(id)?.coordinatorNpub?.trim() ?? "")),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  for (const coordinatorNpub of candidateCoordinatorNpubs) {
    const state = loadCoordinatorState({
      coordinatorNpub,
      electionId,
    });
    if (state) {
      return state;
    }
  }

  return null;
}
