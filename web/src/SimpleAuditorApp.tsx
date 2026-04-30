import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19, type NostrEvent } from "nostr-tools";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  evaluateQuestionnaireBlindAdmissions,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireParticipantCount,
  fetchQuestionnaireWorkerDelegationStatus,
  fetchQuestionnaireSubmissionDecisions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
  type QuestionnaireWorkerDelegationStatus,
} from "./questionnaireTransport";
import { formatQuestionnaireStateEventLabel, formatQuestionnaireStateLabel } from "./questionnaireRuntime";
import type {
  QuestionnairePublishedResponseRef,
  QuestionnaireQuestion,
  QuestionnaireResultQuestionSummary,
  QuestionnaireResultSummary,
  QuestionnaireStateEvent,
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
  expectedInviteeCount: number | null;
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
  const [selectedLiveStateEvent, setSelectedLiveStateEvent] = useState<QuestionnaireStateEvent | null>(null);
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
        const [stateEntries, resultEntries, participantCountEntries] = await Promise.all([
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
          fetchQuestionnaireParticipantCount({
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
        const coordinatorNpub = normalizeToNpub(entry.definition.coordinatorPubkey);
        const latestParticipantCount = selectLatestParticipantCount(participantCountEntries, id, coordinatorNpub);
        return {
          questionnaireId: id,
          title: entry.definition.title || "Untitled questionnaire",
          description: entry.definition.description || "",
          coordinatorNpub,
          createdAt: Number(entry.event.created_at ?? entry.definition.createdAt ?? 0),
          openAt: Number.isFinite(entry.definition.openAt) ? entry.definition.openAt : null,
          closeAt: Number.isFinite(entry.definition.closeAt) ? entry.definition.closeAt : null,
          state: latestState,
          expectedInviteeCount: latestParticipantCount?.expectedInviteeCount ?? null,
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
      setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      setSelectedWorkerDelegationStatus((previous) => (previous === null ? previous : null));
      const nextStatus = "Choose a questionnaire round.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
      return;
    }
    try {
      const [responseEntries, decisionEntries, resultEntries, stateEntries, delegationStatus, participantCountEntries] = await Promise.all([
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
        fetchQuestionnaireParticipantCount({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 2,
          preferKindOnly: true,
        }).catch(() => []),
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
      const nextLiveStateEvent = latestState?.state ?? null;
      const nextResultSummary = latestResult?.summary ?? null;
      setSelectedResponseDetails((previous) => (
        areAuditorResponseDetailsEqual(previous, details) ? previous : details
      ));
      setSelectedLatestPublishAt((previous) => (previous === latestPublishAt ? previous : latestPublishAt));
      setSelectedLiveState((previous) => (previous === nextLiveState ? previous : nextLiveState));
      setSelectedLiveStateEvent((previous) => (
        JSON.stringify(previous) === JSON.stringify(nextLiveStateEvent) ? previous : nextLiveStateEvent
      ));
      setSelectedResultSummary((previous) => (
        areQuestionnaireResultSummaryEqual(previous, nextResultSummary) ? previous : nextResultSummary
      ));
      setSelectedWorkerDelegationStatus((previous) => (
        areWorkerDelegationStatusesEqual(previous, delegationStatus)
          ? previous
          : delegationStatus
      ));
      setQuestionnaires((previous) => previous.map((entry) => {
        if (entry.questionnaireId !== selectedId) {
          return entry;
        }
        const latestParticipantCount = selectLatestParticipantCount(participantCountEntries, selectedId, entry.coordinatorNpub);
        return latestParticipantCount
          ? { ...entry, expectedInviteeCount: latestParticipantCount.expectedInviteeCount }
          : entry;
      }));
      const nextStatus = "Questionnaire responses refreshed from Nostr.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    } catch {
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
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
      setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
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

  const liveQuestionSummaries = useMemo(
    () => buildLiveQuestionSummaries(
      selectedQuestionnaire?.questions ?? [],
      selectedResponseDetails.filter((entry) => entry.accepted),
    ),
    [selectedQuestionnaire?.questions, selectedResponseDetails],
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
  const displayValidCount = selectedResultSummary?.acceptedResponseCount ?? liveAcceptedCount;
  const displayInvalidCount = selectedResultSummary?.rejectedResponseCount ?? liveRejectedCount;
  const displayTotalCount = Math.max(0, displayValidCount + displayInvalidCount);
  const displayValidityPercent = displayTotalCount > 0
    ? ((displayValidCount / displayTotalCount) * 100).toFixed(1)
    : "0.0";
  const displayValidityPercentNumber = Number(displayValidityPercent);
  const expectedInviteeCount = selectedQuestionnaire?.expectedInviteeCount ?? null;
  const expectedResponseText = expectedInviteeCount === null
    ? "Not published"
    : `${expectedInviteeCount} expected`;
  const responseCompletionText = expectedInviteeCount === null
    ? "Unknown"
    : expectedInviteeCount > 0
      ? displayValidCount > expectedInviteeCount
        ? `${displayValidCount} accepted (${expectedInviteeCount} expected)`
        : `${displayValidCount}/${expectedInviteeCount} accepted (${Math.min(100, Math.max(0, (displayValidCount / expectedInviteeCount) * 100)).toFixed(1)}%)`
      : "No invitees expected";
  const displayedQuestionSummaries = selectedResultSummary?.questionSummaries ?? liveQuestionSummaries;
  const resultSummarySourceLabel = selectedResultSummary ? "Published result summary" : "Live verified submissions";
  const selectedRoundPhaseLabel = selectedLiveStateEvent
    ? formatQuestionnaireStateEventLabel(selectedLiveStateEvent)
    : formatQuestionnaireStateLabel(selectedLiveState ?? selectedQuestionnaire?.state);
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

        <section className='simple-voter-section simple-auditor-panel simple-auditor-results-dashboard'>
          {selectedQuestionnaire ? (
            <>
              <div className='simple-auditor-results-hero'>
                <div className='simple-auditor-results-title-block'>
                  <p className='simple-auditor-breadcrumb'>Questionnaires / {selectedQuestionnaire.questionnaireId}</p>
                  <h2 className='simple-voter-section-title'>Questionnaire Results</h2>
                  <div className='simple-auditor-results-meta'>
                    <span className='simple-auditor-pill simple-auditor-pill-green'>{selectedRoundPhaseLabel}</span>
                    <span className='simple-auditor-pill'>{displayTotalCount} response{displayTotalCount === 1 ? "" : "s"}</span>
                    <span className='simple-auditor-pill'>{resultSummarySourceLabel}</span>
                  </div>
                </div>
                {canExportResults ? (
                  <button
                    type='button'
                    className='simple-voter-secondary simple-auditor-export-button'
                    onClick={exportResults}
                  >
                    Export results
                  </button>
                ) : null}
              </div>

              <div className='simple-auditor-status-grid'>
                <article className='simple-auditor-status-card'>
                  <p className='simple-auditor-summary-label'>Validation status</p>
                  <p className='simple-auditor-status-value'>{displayValidCount}/{displayTotalCount || 0} accepted</p>
                  <p className='simple-auditor-status-note'>{displayValidityPercent}% success</p>
                  <div className='simple-auditor-results-progress simple-auditor-results-progress-green' aria-hidden='true'>
                    <span style={{ width: `${Math.min(100, Math.max(0, displayValidityPercentNumber))}%` }} />
                  </div>
                </article>
                <article className='simple-auditor-status-card simple-auditor-status-card-icon'>
                  <span className='simple-auditor-status-icon' aria-hidden='true'>!</span>
                  <div>
                    <p className='simple-auditor-summary-label'>Security layer</p>
                    <p className='simple-auditor-status-value'>Audit proxy: {formatWorkerDelegationStatus(selectedWorkerDelegationStatus)}</p>
                    <p className='simple-auditor-status-note'>Delegated issuance and verification</p>
                  </div>
                </article>
                <article className='simple-auditor-status-card simple-auditor-status-card-icon'>
                  <span className='simple-auditor-status-icon simple-auditor-status-icon-blue' aria-hidden='true'>i</span>
                  <div>
                    <p className='simple-auditor-summary-label'>Campaign progress</p>
                    <p className='simple-auditor-status-value'>Round phase: {selectedRoundPhaseLabel}</p>
                    <p className='simple-auditor-status-note'>{responseCompletionText}</p>
                  </div>
                </article>
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
                  <p className='simple-voter-question'>{selectedRoundPhaseLabel}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Expected responses</p>
                  <p className='simple-voter-question'>{expectedResponseText}</p>
                  <p className='simple-voter-note'>{responseCompletionText}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Published at</p>
                  <p className='simple-voter-question'>
                    {formatQuestionnaireTime(Number(selectedResultSummary?.createdAt ?? selectedQuestionnaire.resultPublishedAt ?? 0))}
                  </p>
                </div>
              </div>
              {displayedQuestionSummaries.length > 0 ? (
                <>
                  <div className='simple-auditor-question-grid'>
                    {displayedQuestionSummaries.map((summary) => (
                      <article key={`${summary.questionId}:${summary.answerType}`} className='simple-auditor-question-card'>
                        <div className='simple-auditor-question-card-head'>
                          <div>
                            <h3 className='simple-voter-question'>{selectedQuestionById.get(summary.questionId)?.prompt || `Question ${summary.questionId}`}</h3>
                            <p className='simple-voter-note'>
                              {summary.answerType === "yes_no"
                                ? "Single choice response"
                                : summary.answerType === "multiple_choice"
                                  ? "Multiple selection frequency"
                                  : "Free-text responses"}
                            </p>
                          </div>
                          {summary.answerType === "multiple_choice" ? (
                            <span className='simple-auditor-mini-badge'>Aggr. view</span>
                          ) : null}
                        </div>
                        {summary.answerType === "yes_no" ? (
                          <div className='simple-auditor-donut-layout'>
                            {(() => {
                              const total = summary.yesCount + summary.noCount;
                              const yesPercent = total > 0 ? (summary.yesCount / total) * 100 : 0;
                              return (
                                <>
                                  <div
                                    className='simple-auditor-donut'
                                    style={{
                                      background: `conic-gradient(#2563eb 0 ${yesPercent}%, #f97316 ${yesPercent}% 100%)`,
                                    }}
                                    aria-hidden='true'
                                  >
                                    <div className='simple-auditor-donut-core'>
                                      <strong>{total}</strong>
                                      <span>Total</span>
                                    </div>
                                  </div>
                                  <div className='simple-auditor-donut-legend'>
                                    <span><i className='simple-auditor-dot simple-auditor-dot-purple' />Yes <strong>{summary.yesCount}</strong></span>
                                    <span><i className='simple-auditor-dot simple-auditor-dot-mint' />No <strong>{summary.noCount}</strong></span>
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        ) : summary.answerType === "multiple_choice" ? (
                          <div className='simple-auditor-option-bars'>
                            {Object.entries(summary.optionCounts)
                              .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
                              .map(([optionId, count]) => {
                                const question = selectedQuestionById.get(summary.questionId);
                                const label = question?.type === "multiple_choice"
                                  ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
                                  : optionId;
                                const maxCount = Math.max(1, ...Object.values(summary.optionCounts));
                                const percentOfAccepted = displayValidCount > 0 ? (count / displayValidCount) * 100 : 0;
                                return (
                                  <div key={optionId} className='simple-auditor-option-bar-row'>
                                    <div className='simple-auditor-option-bar-label'>
                                      <span>{label}</span>
                                      <strong>{count} ({percentOfAccepted.toFixed(0)}%)</strong>
                                    </div>
                                    <div className='simple-auditor-results-progress' aria-hidden='true'>
                                      <span style={{ width: `${Math.max(4, (count / maxCount) * 100)}%` }} />
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                        ) : (
                          <div className='simple-auditor-free-text-cardlet'>
                            <div className='simple-auditor-free-text-icon' aria-hidden='true'>#</div>
                            <div>
                              <p className='simple-voter-question'>{summary.freeTextCount} response{summary.freeTextCount === 1 ? "" : "s"} collected</p>
                            </div>
                            <button
                              type='button'
                              className='simple-voter-secondary simple-auditor-text-button'
                              onClick={() => setFreeTextViewerQuestionId(summary.questionId)}
                            >
                              View text submissions
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                  {!selectedResultSummary ? (
                    <p className='simple-voter-note'>No published result summary yet; showing live verified submissions found on public relays.</p>
                  ) : null}
                </>
              ) : (
                <p className='simple-voter-empty'>No published result summary or live verified submissions yet for this questionnaire.</p>
              )}
            </>
          ) : (
            <p className='simple-voter-empty'>Choose a questionnaire round to inspect results.</p>
          )}
        </section>

        <section className='simple-voter-section simple-auditor-submissions-section'>
          <div className='simple-auditor-submissions-header'>
            <h2 className='simple-voter-section-title'>Submitted Votes</h2>
            <span className='simple-auditor-pill'>{filteredResponseDetails.length} shown</span>
          </div>
          {selectedQuestionnaire ? (
            selectedResponseDetails.length > 0 ? (
              <>
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
                          <p className={`simple-auditor-status-chip ${entry.accepted ? "simple-auditor-status-chip-valid" : "simple-auditor-status-chip-invalid"}`}>
                            {entry.accepted ? "Valid" : "Invalid"}
                          </p>
                        </div>
                        <div className='simple-auditor-result-body'>
                          <div className='simple-auditor-result-head'>
                            <div>
                              <p className='simple-auditor-table-kicker'>Voter identity and status</p>
                              <p className='simple-voter-question' title={entry.response.authorPubkey}>{deriveActorDisplayId(entry.response.authorPubkey)}</p>
                            </div>
                            <div className='simple-auditor-submission-time'>
                              <p className='simple-auditor-table-kicker'>Submission time</p>
                              <p className='simple-voter-note'>
                                {formatQuestionnaireTime(Number(entry.response.submittedAt ?? entry.event.created_at ?? 0))}
                              </p>
                            </div>
                          </div>
                          <p className='simple-voter-note'>Response ID: {entry.response.responseId}</p>
                          {Array.isArray(entry.response.answers) && entry.response.answers.length > 0 ? (
                            <ol className='simple-auditor-answer-list'>
                              {entry.response.answers.map((answer) => {
                                const question = selectedQuestionById.get(answer.questionId);
                                const prompt = question?.prompt || answer.questionId;
                                if (answer.answerType === "yes_no") {
                                  return (
                                    <li key={`${entry.event.id}:${answer.questionId}`}>
                                      <span className='simple-auditor-answer-prompt'>{prompt}</span>
                                      <span className='simple-auditor-answer-chip'>{answer.value ? "Yes" : "No"}</span>
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
                                      <span className='simple-auditor-answer-prompt'>{prompt}</span>
                                      {selectedLabels.length > 0 ? selectedLabels.map((label) => (
                                        <span key={label} className='simple-auditor-answer-chip'>{label}</span>
                                      )) : (
                                        <span className='simple-auditor-answer-chip'>No option selected</span>
                                      )}
                                    </li>
                                  );
                                }
                                return (
                                  <li key={`${entry.event.id}:${answer.questionId}`}>
                                    <span className='simple-auditor-answer-prompt'>{prompt}</span>
                                    <span className='simple-auditor-answer-chip simple-auditor-answer-chip-text'>{answer.text || "(empty)"}</span>
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
      || a.expectedInviteeCount !== b.expectedInviteeCount
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
  const workerSuffix = worker ? ` (${deriveActorDisplayId(worker)})` : "";
  if (status.state === "active") {
    return `Active${workerSuffix}`;
  }
  if (status.state === "revoked") {
    return `Revoked${workerSuffix}`;
  }
  return `Expired${workerSuffix}`;
}

function buildLiveQuestionSummaries(
  questions: QuestionnaireQuestion[],
  acceptedResponses: AuditorQuestionnaireResponseDetail[],
): QuestionnaireResultQuestionSummary[] {
  return questions.map((question): QuestionnaireResultQuestionSummary => {
    if (question.type === "yes_no") {
      let yesCount = 0;
      let noCount = 0;
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        if (answer?.answerType !== "yes_no") {
          continue;
        }
        if (answer.value) {
          yesCount += 1;
        } else {
          noCount += 1;
        }
      }
      return {
        questionId: question.questionId,
        answerType: "yes_no",
        yesCount,
        noCount,
      };
    }

    if (question.type === "multiple_choice") {
      const optionCounts = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        if (answer?.answerType !== "multiple_choice") {
          continue;
        }
        for (const optionId of answer.selectedOptionIds) {
          if (Object.prototype.hasOwnProperty.call(optionCounts, optionId)) {
            optionCounts[optionId] += 1;
          }
        }
      }
      return {
        questionId: question.questionId,
        answerType: "multiple_choice",
        optionCounts,
      };
    }

    let freeTextCount = 0;
    for (const entry of acceptedResponses) {
      const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
      if (answer?.answerType === "free_text" && answer.text.trim()) {
        freeTextCount += 1;
      }
    }
    return {
      questionId: question.questionId,
      answerType: "free_text",
      freeTextCount,
    };
  });
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

function selectLatestParticipantCount(
  entries: Awaited<ReturnType<typeof fetchQuestionnaireParticipantCount>>,
  questionnaireId: string,
  coordinatorNpub: string,
) {
  const expectedCoordinator = normalizeToNpub(coordinatorNpub);
  return entries
    .filter((entry) => entry.participantCount.questionnaireId === questionnaireId)
    .filter((entry) => normalizeToNpub(entry.participantCount.coordinatorPubkey) === expectedCoordinator)
    .filter((entry) => normalizeToNpub(entry.event.pubkey) === expectedCoordinator)
    .sort((left, right) => (
      Number(right.event.created_at ?? right.participantCount.createdAt ?? 0)
      - Number(left.event.created_at ?? left.participantCount.createdAt ?? 0)
    ))[0]
    ?.participantCount ?? null;
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
