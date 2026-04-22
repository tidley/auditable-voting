import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19, type NostrEvent } from "nostr-tools";
import TokenFingerprint from "./TokenFingerprint";
import {
  evaluateQuestionnaireBlindAdmissions,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireWorkerDelegationStatus,
  fetchQuestionnaireSubmissionDecisions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
  type QuestionnaireWorkerDelegationStatus,
} from "./questionnaireTransport";
import { formatQuestionnaireStateLabel } from "./questionnaireRuntime";
import type {
  QuestionnairePublishedResponseRef,
  QuestionnaireQuestion,
  QuestionnaireResultSummary,
} from "./questionnaireProtocol";

const AUDITOR_REFRESH_INTERVAL_MS = 15000;
const AUDITOR_QUESTIONNAIRE_LIST_REFRESH_INTERVAL_MS = 120000;
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
  const [selectedWorkerDelegationStatus, setSelectedWorkerDelegationStatus] = useState<QuestionnaireWorkerDelegationStatus | null>(null);
  const [voterSearchQuery, setVoterSearchQuery] = useState("");
  const [showInvalidVotes, setShowInvalidVotes] = useState(false);
  const [freeTextViewerQuestionId, setFreeTextViewerQuestionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [questionnaireRefreshStatus, setQuestionnaireRefreshStatus] = useState<string | null>(null);
  const [responseRefreshStatus, setResponseRefreshStatus] = useState<string | null>(null);
  const [historicSearchInFlight, setHistoricSearchInFlight] = useState(false);
  const selectedQuestionnaireIdRef = useRef("");
  const refreshQueueRef = useRef<{
    pendingList: boolean;
    pendingSelected: boolean;
    inFlightPromise: Promise<void> | null;
  }>({
    pendingList: false,
    pendingSelected: false,
    inFlightPromise: null,
  });

  useEffect(() => {
    selectedQuestionnaireIdRef.current = selectedQuestionnaireId;
  }, [selectedQuestionnaireId]);

  const loadQuestionnairesFromNostr = useCallback(async (input?: { historic?: boolean }) => {
    const historic = Boolean(input?.historic);
    const definitions = await fetchQuestionnaireDefinitions({
      limit: historic ? AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT : 400,
      readRelayLimit: 2,
      preferKindOnly: true,
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
          fetchQuestionnaireState({
            questionnaireId: id,
            limit: 50,
            readRelayLimit: 2,
            preferKindOnly: true,
          }).catch(() => []),
          fetchQuestionnaireResultSummary({
            questionnaireId: id,
            limit: 50,
            readRelayLimit: 2,
            preferKindOnly: true,
          }).catch(() => []),
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
    try {
      const entries = await loadQuestionnairesFromNostr();
      setQuestionnaires((previous) => (
        areQuestionnaireEntriesEqual(previous, entries) ? previous : entries
      ));
      const selectedId = selectedQuestionnaireIdRef.current.trim();
      const nextSelectedId = (!selectedId || !entries.some((entry) => entry.questionnaireId === selectedId))
        ? (entries[0]?.questionnaireId ?? "")
        : selectedId;
      setSelectedQuestionnaireId((previous) => (previous === nextSelectedId ? previous : nextSelectedId));
      const nextStatus = (
        entries.length > 0
          ? "Questionnaires refreshed from Nostr."
          : "No public questionnaires discovered yet."
      );
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    } catch {
      const nextStatus = "Failed to refresh public questionnaires.";
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    }
  }, [loadQuestionnairesFromNostr]);

  const refreshSelectedQuestionnaireResponses = useCallback(async () => {
    const selectedId = selectedQuestionnaireIdRef.current.trim();
    if (!selectedId) {
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      setSelectedWorkerDelegationStatus((previous) => (previous === null ? previous : null));
      const nextStatus = "Choose a questionnaire round.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
      return;
    }
    try {
      const [responseEntries, decisionEntries, resultEntries, stateEntries, delegationStatus] = await Promise.all([
        fetchQuestionnaireBlindResponses({
          questionnaireId: selectedId,
          limit: AUDITOR_QUESTIONNAIRE_RESPONSE_LIMIT,
          readRelayLimit: 2,
          preferKindOnly: true,
        }),
        fetchQuestionnaireSubmissionDecisions({
          questionnaireId: selectedId,
          limit: AUDITOR_QUESTIONNAIRE_RESPONSE_LIMIT,
          readRelayLimit: 2,
          preferKindOnly: true,
        }).catch(() => []),
        fetchQuestionnaireResultSummary({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 2,
          preferKindOnly: true,
        }).catch(() => []),
        fetchQuestionnaireState({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 2,
          preferKindOnly: true,
        }).catch(() => []),
        fetchQuestionnaireWorkerDelegationStatus({
          questionnaireId: selectedId,
          readRelayLimit: 2,
        }).catch(() => null),
      ]);
      const admissions = evaluateQuestionnaireBlindAdmissions({
        entries: responseEntries,
        decisionEntries,
      });
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
      if ((latestResult?.summary.publishedResponseRefs?.length ?? 0) > 0) {
        const summaryRefDetails = (latestResult?.summary.publishedResponseRefs ?? [])
          .map((ref) => optionASummaryRefToAuditorDetail({
            questionnaireId: selectedId,
            ref,
            latestPublishAt,
          }));
        details = mergeAuditorResponseDetails(details, summaryRefDetails);
      }
      const nextLiveState = latestState?.state.state ?? null;
      const nextResultSummary = latestResult?.summary ?? null;
      setSelectedResponseDetails((previous) => (
        areAuditorResponseDetailsEqual(previous, details) ? previous : details
      ));
      setSelectedLatestPublishAt((previous) => (previous === latestPublishAt ? previous : latestPublishAt));
      setSelectedLiveState((previous) => (previous === nextLiveState ? previous : nextLiveState));
      setSelectedResultSummary((previous) => (
        areQuestionnaireResultSummaryEqual(previous, nextResultSummary) ? previous : nextResultSummary
      ));
      setSelectedWorkerDelegationStatus((previous) => (
        areWorkerDelegationStatusesEqual(previous, delegationStatus)
          ? previous
          : delegationStatus
      ));
      const nextStatus = "Questionnaire responses refreshed from Nostr.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    } catch {
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      setSelectedWorkerDelegationStatus((previous) => (previous === null ? previous : null));
      const nextStatus = "Failed to refresh questionnaire responses.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    }
  }, []);

  const drainRefreshQueue = useCallback(async (forceWhenHidden = false) => {
    if (refreshQueueRef.current.inFlightPromise) {
      await refreshQueueRef.current.inFlightPromise;
      return;
    }
    refreshQueueRef.current.inFlightPromise = (async () => {
      while (refreshQueueRef.current.pendingList || refreshQueueRef.current.pendingSelected) {
        const visible = typeof document === "undefined" || document.visibilityState === "visible";
        if (!visible && !forceWhenHidden) {
          break;
        }
        const runList = refreshQueueRef.current.pendingList;
        const runSelected = refreshQueueRef.current.pendingSelected;
        refreshQueueRef.current.pendingList = false;
        refreshQueueRef.current.pendingSelected = false;
        if (runList) {
          await refreshQuestionnaires();
        }
        if (runSelected) {
          await refreshSelectedQuestionnaireResponses();
        }
      }
    })();
    try {
      await refreshQueueRef.current.inFlightPromise;
    } finally {
      refreshQueueRef.current.inFlightPromise = null;
    }
  }, [refreshQuestionnaires, refreshSelectedQuestionnaireResponses]);

  const enqueueRefresh = useCallback(async (input?: {
    list?: boolean;
    selected?: boolean;
    forceWhenHidden?: boolean;
  }) => {
    const list = input?.list !== false;
    const selected = input?.selected !== false;
    if (list) {
      refreshQueueRef.current.pendingList = true;
    }
    if (selected) {
      refreshQueueRef.current.pendingSelected = true;
    }
    await drainRefreshQueue(Boolean(input?.forceWhenHidden));
  }, [drainRefreshQueue]);

  useEffect(() => {
    let cancelled = false;
    let selectedTimeoutId: number | null = null;
    let listTimeoutId: number | null = null;

    const scheduleSelected = (delayMs: number) => {
      selectedTimeoutId = window.setTimeout(async () => {
        if (cancelled) {
          return;
        }
        await enqueueRefresh({ list: false, selected: true });
        if (!cancelled) {
          scheduleSelected(AUDITOR_REFRESH_INTERVAL_MS);
        }
      }, delayMs);
    };

    const scheduleList = (delayMs: number) => {
      listTimeoutId = window.setTimeout(async () => {
        if (cancelled) {
          return;
        }
        await enqueueRefresh({ list: true, selected: false });
        if (!cancelled) {
          scheduleList(AUDITOR_QUESTIONNAIRE_LIST_REFRESH_INTERVAL_MS);
        }
      }, delayMs);
    };

    const handleForegroundRefresh = () => {
      if (cancelled) {
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void enqueueRefresh({ list: true, selected: true });
    };

    void enqueueRefresh({ list: true, selected: true, forceWhenHidden: true });
    scheduleSelected(AUDITOR_REFRESH_INTERVAL_MS);
    scheduleList(AUDITOR_QUESTIONNAIRE_LIST_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleForegroundRefresh);
    window.addEventListener("focus", handleForegroundRefresh);
    window.addEventListener("online", handleForegroundRefresh);

    return () => {
      cancelled = true;
      if (selectedTimeoutId !== null) {
        window.clearTimeout(selectedTimeoutId);
      }
      if (listTimeoutId !== null) {
        window.clearTimeout(listTimeoutId);
      }
      document.removeEventListener("visibilitychange", handleForegroundRefresh);
      window.removeEventListener("focus", handleForegroundRefresh);
      window.removeEventListener("online", handleForegroundRefresh);
    };
  }, [enqueueRefresh]);

  useEffect(() => {
    if (!selectedQuestionnaireId.trim()) {
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      return;
    }
    setVoterSearchQuery((previous) => (previous ? "" : previous));
    void enqueueRefresh({ list: false, selected: true, forceWhenHidden: true });
  }, [enqueueRefresh, selectedQuestionnaireId]);

  const coordinatorOptions = useMemo(
    () => [...new Set(
      questionnaires
        .map((questionnaire) => questionnaire.coordinatorNpub.trim())
        .filter((value) => value.length > 0),
    )],
    [questionnaires],
  );

  const [selectedCoordinatorNpub, setSelectedCoordinatorNpub] = useState("");
  const coordinatorSelectOptions = useMemo(() => {
    if (!selectedCoordinatorNpub || coordinatorOptions.includes(selectedCoordinatorNpub)) {
      return coordinatorOptions;
    }
    return [selectedCoordinatorNpub, ...coordinatorOptions];
  }, [coordinatorOptions, selectedCoordinatorNpub]);

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
    if (filteredQuestionnaires.length === 0) {
      if (selectedQuestionnaireId) {
        setSelectedQuestionnaireId("");
      }
      return;
    }
    if (!selectedQuestionnaireId || !filteredQuestionnaires.some((entry) => entry.questionnaireId === selectedQuestionnaireId)) {
      setSelectedQuestionnaireId(filteredQuestionnaires[0].questionnaireId);
    }
  }, [filteredQuestionnaires, selectedQuestionnaireId]);

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
    const visibilityFiltered = showInvalidVotes
      ? selectedResponseDetails.filter((entry) => !entry.accepted)
      : selectedResponseDetails.filter((entry) => entry.accepted);
    const query = voterSearchQuery.trim().toLowerCase();
    if (!query) {
      return visibilityFiltered;
    }
    return visibilityFiltered.filter((entry) => (
      entry.response.authorPubkey.toLowerCase().includes(query)
      || entry.response.responseId.toLowerCase().includes(query)
      || entry.response.tokenNullifier.toLowerCase().includes(query)
    ));
  }, [selectedResponseDetails, showInvalidVotes, voterSearchQuery]);

  async function refreshNow() {
    const nextQuestionnaireStatus = "Refreshing public questionnaires...";
    const nextResponseStatus = "Refreshing questionnaire responses...";
    setQuestionnaireRefreshStatus((previous) => (previous === nextQuestionnaireStatus ? previous : nextQuestionnaireStatus));
    setResponseRefreshStatus((previous) => (previous === nextResponseStatus ? previous : nextResponseStatus));
    await enqueueRefresh({ list: true, selected: true, forceWhenHidden: true });
  }

  async function searchHistoricData() {
    if (historicSearchInFlight) {
      return;
    }
    setHistoricSearchInFlight(true);
    const searchingStatus = "Searching historic questionnaire data...";
    setQuestionnaireRefreshStatus((previous) => (previous === searchingStatus ? previous : searchingStatus));
    try {
      const entries = await loadQuestionnairesFromNostr({ historic: true });
      setQuestionnaires((previous) => (
        areQuestionnaireEntriesEqual(previous, entries) ? previous : entries
      ));
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
        const nextSelectedId = (match ?? entries[0])?.questionnaireId ?? "";
        setSelectedQuestionnaireId((previous) => (previous === nextSelectedId ? previous : nextSelectedId));
      }
      const nextStatus = (
        entries.length > 0
          ? `Historic search loaded ${entries.length} questionnaire${entries.length === 1 ? "" : "s"}.`
          : "No historic public questionnaires discovered."
      );
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
      await enqueueRefresh({ list: false, selected: true, forceWhenHidden: true });
    } catch {
      const nextStatus = "Historic questionnaire search failed.";
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
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
                {coordinatorSelectOptions.map((coordinatorNpub) => (
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
              <div className='simple-auditor-results-meta'>
                <span className='simple-voter-note'>
                  {publishedTotalCount} Response{publishedTotalCount === 1 ? "" : "s"} • {publishedValidityPercent}%
                </span>
                <span className='simple-voter-note'>
                  Round phase: {formatQuestionnaireStateLabel(selectedLiveState ?? selectedQuestionnaire.state)}
                </span>
                <span className='simple-voter-note'>
                  Published at: {formatQuestionnaireTime(Number(selectedResultSummary?.createdAt ?? selectedQuestionnaire.resultPublishedAt ?? 0))}
                </span>
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
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Delegated worker</p>
                  <p className='simple-voter-question'>
                    {formatWorkerDelegationStatus(selectedWorkerDelegationStatus)}
                  </p>
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
                                {(() => {
                                  const question = selectedQuestionById.get(summary.questionId);
                                  if (question?.type !== "multiple_choice") {
                                    return optionId;
                                  }
                                  return question.options.find((option) => option.optionId === optionId)?.label ?? optionId;
                                })()}: {count}
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
                <p className='simple-voter-note'>For question: {selectedQuestionnaire.title}</p>
                <div className='simple-auditor-submitted-toolbar'>
                  <div className='simple-auditor-submitted-stat'>
                    <p className='simple-auditor-summary-label'>Total responses</p>
                    <p className='simple-auditor-score'>{selectedResponseDetails.length}</p>
                  </div>
                  <div className='simple-auditor-submitted-filter'>
                    <label className='simple-voter-label' htmlFor='simple-auditor-submitted-search'>Filter by voter ID</label>
                    <input
                      id='simple-auditor-submitted-search'
                      className='simple-voter-input'
                      value={voterSearchQuery}
                      onChange={(event) => setVoterSearchQuery(event.target.value)}
                      placeholder='Search by voter npub, response ID, or token...'
                    />
                    <label className='simple-voter-note simple-auditor-invalid-toggle'>
                      <input
                        type='checkbox'
                        checked={showInvalidVotes}
                        onChange={(event) => setShowInvalidVotes(event.target.checked)}
                      />
                      {" "}
                      Show invalid votes only
                    </label>
                  </div>
                </div>
                <ul className='simple-voter-list simple-auditor-result-list'>
                  {filteredResponseDetails.map((entry) => (
                    <li key={entry.event.id} className='simple-voter-list-item'>
                      <div className='simple-auditor-result-row'>
                        <div className='simple-auditor-result-marker'>
                          <TokenFingerprint tokenId={entry.response.authorPubkey} compact large hideMetadata />
                          <p className='simple-voter-note simple-auditor-marker-status'>
                            Status: {entry.accepted ? "Valid" : "Invalid"}
                          </p>
                        </div>
                        <div className='simple-auditor-result-body'>
                          <div className='simple-auditor-result-head'>
                            <p className='simple-voter-question'>{entry.response.authorPubkey}</p>
                          </div>
                          <p className='simple-voter-note'>
                            Submitted: {formatQuestionnaireTime(Number(entry.response.submittedAt ?? entry.event.created_at ?? 0))}
                          </p>
                          <p className='simple-voter-note'>Response ID: {entry.response.responseId}</p>
                          {Array.isArray(entry.response.answers) && entry.response.answers.length > 0 ? (
                            <ol className='simple-delivery-diagnostics simple-delivery-diagnostics-compact simple-auditor-answer-list'>
                              {entry.response.answers.map((answer) => {
                                const question = selectedQuestionById.get(answer.questionId);
                                const prompt = question?.prompt || answer.questionId;
                                if (answer.answerType === "yes_no") {
                                  return (
                                    <li key={`${entry.event.id}:${answer.questionId}`}>
                                      <span className='simple-auditor-answer-prompt'>{prompt}: </span>
                                      <span className='simple-auditor-answer-value'>{answer.value ? "Yes" : "No"}</span>
                                    </li>
                                  );
                                }
                                if (answer.answerType === "multiple_choice") {
                                  const selectedLabels = answer.selectedOptionIds.map((optionId) => (
                                    question?.type === "multiple_choice"
                                      ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
                                      : optionId
                                  ));
                                  return (
                                    <li key={`${entry.event.id}:${answer.questionId}`}>
                                      <span className='simple-auditor-answer-prompt'>{prompt}: </span>
                                      <span className='simple-auditor-answer-value'>{selectedLabels.join(", ") || "No option selected"}</span>
                                    </li>
                                  );
                                }
                                return (
                                  <li key={`${entry.event.id}:${answer.questionId}`}>
                                    <span className='simple-auditor-answer-prompt'>{prompt}: </span>
                                    <span className='simple-auditor-answer-value'>{answer.text || "(empty)"}</span>
                                  </li>
                                );
                              })}
                            </ol>
                          ) : (
                            <p className='simple-voter-note'>Answer payload is encrypted or unavailable in public events.</p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {filteredResponseDetails.length === 0 ? (
                  <p className='simple-voter-empty'>No voter responses match the current filter.</p>
                ) : null}
              </>
            ) : (
              <p className='simple-voter-empty'>No submitted responses found for this round yet.</p>
            )
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to inspect responses.</p>
          )}
        </section>

        {freeTextViewerQuestionId && selectedQuestionnaire ? (
          <section
            className='token-fingerprint-overlay'
            role='dialog'
            aria-modal='true'
            aria-label='Free-text responses'
            onClick={() => setFreeTextViewerQuestionId(null)}
          >
            <button type='button' className='token-fingerprint-overlay-close' onClick={() => setFreeTextViewerQuestionId(null)}>Close</button>
            <div className='token-fingerprint-overlay-card simple-auditor-full-results-card' onClick={(event) => event.stopPropagation()}>
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

function areQuestionnaireEntriesEqual(
  left: AuditorQuestionnaireEntry[],
  right: AuditorQuestionnaireEntry[],
) {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.questionnaireId !== b.questionnaireId
      || a.title !== b.title
      || a.description !== b.description
      || a.coordinatorNpub !== b.coordinatorNpub
      || a.createdAt !== b.createdAt
      || a.openAt !== b.openAt
      || a.closeAt !== b.closeAt
      || a.state !== b.state
      || a.publishedAcceptedResponseCount !== b.publishedAcceptedResponseCount
      || a.publishedRejectedResponseCount !== b.publishedRejectedResponseCount
      || a.resultPublishedAt !== b.resultPublishedAt
      || a.eventId !== b.eventId
      || !areQuestionsEqual(a.questions, b.questions)
    ) {
      return false;
    }
  }
  return true;
}

function areQuestionsEqual(left: QuestionnaireQuestion[], right: QuestionnaireQuestion[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function areQuestionnaireResultSummaryEqual(
  left: QuestionnaireResultSummary | null,
  right: QuestionnaireResultSummary | null,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function areWorkerDelegationStatusesEqual(
  left: QuestionnaireWorkerDelegationStatus | null,
  right: QuestionnaireWorkerDelegationStatus | null,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.state === right.state
    && left.delegationId === right.delegationId
    && left.workerNpub === right.workerNpub
    && left.expiresAt === right.expiresAt
    && left.updatedAt === right.updatedAt
  );
}

function formatWorkerDelegationStatus(status: QuestionnaireWorkerDelegationStatus | null) {
  if (!status || status.state === "none") {
    return "None";
  }
  const worker = status.workerNpub ? normalizeToNpub(status.workerNpub) : "";
  const workerSuffix = worker ? ` (${worker})` : "";
  if (status.state === "active") {
    return `Active${workerSuffix}`;
  }
  if (status.state === "revoked") {
    return `Revoked${workerSuffix}`;
  }
  return `Expired${workerSuffix}`;
}

function areAuditorResponseDetailsEqual(
  left: AuditorQuestionnaireResponseDetail[],
  right: AuditorQuestionnaireResponseDetail[],
) {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.event.id !== b.event.id
      || Number(a.event.created_at ?? 0) !== Number(b.event.created_at ?? 0)
      || a.accepted !== b.accepted
      || a.rejectionReason !== b.rejectionReason
      || a.includedInLatestPublish !== b.includedInLatestPublish
      || a.response.responseId !== b.response.responseId
      || a.response.authorPubkey !== b.response.authorPubkey
      || a.response.tokenNullifier !== b.response.tokenNullifier
      || JSON.stringify(a.response.answers ?? []) !== JSON.stringify(b.response.answers ?? [])
    ) {
      return false;
    }
  }
  return true;
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
