import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { nip19, type NostrEvent } from "nostr-tools";
import QuestionnaireResultsDashboard, { type QuestionnaireResultsDashboardResponseDetail } from "./QuestionnaireResultsDashboard";
import {
  evaluateQuestionnaireBlindAdmissions,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireProvisionalResponses,
  fetchQuestionnaireDefinitions,
  fetchQuestionnaireParticipantCount,
  fetchQuestionnaireWorkerDelegationStatus,
  fetchQuestionnaireSubmissionDecisions,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireState,
  verifyQuestionnaireBlindResponseProofs,
  type QuestionnaireWorkerDelegationStatus,
} from "./questionnaireTransport";
import {
  calculateRankQuestionScores,
  normaliseRankedOptionIds,
  type QuestionnaireQuestion,
  type QuestionnaireDefinition,
  type QuestionnairePublishedResponseRef,
  type QuestionnaireResponseAnswer,
  type QuestionnaireResultQuestionSummary,
  type QuestionnaireResultSummary,
  type QuestionnaireStateEvent,
} from "./questionnaireProtocol";
import { decryptQuestionnaireBlindResponseAnswers } from "./questionnaireResponsePublish";
import {
  parseQuestionnaireBlindResponseEvent,
  parseQuestionnaireProvisionalResponseEvent,
  parseQuestionnaireSubmissionDecisionEvent,
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_RESPONSE_PROVISIONAL_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
} from "./questionnaireResponsePublish";
import {
  parseQuestionnaireDefinitionEvent,
  parseQuestionnaireParticipantCountEvent,
  parseQuestionnaireStateEvent,
  QUESTIONNAIRE_DEFINITION_KIND,
  QUESTIONNAIRE_PARTICIPANT_COUNT_KIND,
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  QUESTIONNAIRE_STATE_KIND,
  subscribeQuestionnaireEventKinds,
} from "./questionnaireNostr";
import { fetchQuestionnaireResultPack } from "./questionnaireResultPack";
import type { QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import { deriveActorDisplayId, formatQuestionnaireDisplayId } from "./actorDisplay";
import { UiButton, UiSelect, UiTextField } from "./ui/DesignLayer";

const AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT = 20;
const AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT = 2000;
const AUDITOR_QUESTIONNAIRE_RESPONSE_PAGE_LIMIT = 500;
const AUDITOR_QUESTIONNAIRE_RESPONSE_MAX_PAGES = 32;
const AUDITOR_QUESTIONNAIRE_RESPONSE_TIME_BUDGET_MS = 30_000;
const AUDITOR_RESPONSE_AUTO_REFRESH_MS = 60_000;
const AUDITOR_LIST_AUTO_REFRESH_MS = 30_000;

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
  questionnaireRelays?: string[];
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  responseSearchValues?: string[];
  eventId: string;
};

type AuditorQuestionnaireResponseDetail = ReturnType<typeof evaluateQuestionnaireBlindAdmissions>["decisions"][number] & {
  includedInLatestPublish: boolean;
};

type AuditorMemoryCache = {
  questionnaires: AuditorQuestionnaireEntry[];
  selectedQuestionnaireId: string;
  selectedDefinitionEventId: string;
  selectedResponseDetails: AuditorQuestionnaireResponseDetail[];
  selectedProvisionalResponseDetails: QuestionnaireResultsDashboardResponseDetail[];
  selectedLatestPublishAt: number | null;
  selectedLiveState: string | null;
  selectedLiveStateEvent: QuestionnaireStateEvent | null;
  selectedResultSummary: QuestionnaireResultSummary | null;
  selectedWorkerDelegationStatus: QuestionnaireWorkerDelegationStatus | null;
  questionnaireRefreshStatus: string | null;
  responseRefreshStatus: string | null;
};

type SimpleAuditorAppProps = {
  filtersInMenu?: boolean;
  filtersMenuOpen?: boolean;
  onFiltersMenuClose?: () => void;
};

let auditorSessionAutoRefreshDone = false;
let auditorMemoryCache: AuditorMemoryCache = {
  questionnaires: [],
  selectedQuestionnaireId: "",
  selectedDefinitionEventId: "",
  selectedResponseDetails: [],
  selectedProvisionalResponseDetails: [],
  selectedLatestPublishAt: null,
  selectedLiveState: null,
  selectedLiveStateEvent: null,
  selectedResultSummary: null,
  selectedWorkerDelegationStatus: null,
  questionnaireRefreshStatus: null,
  responseRefreshStatus: null,
};

function readInitialQuestionnaireIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("questionnaire") ?? params.get("q") ?? params.get("election_id") ?? "").trim();
}

function readInitialCoordinatorNpubFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("coordinator") ?? params.get("organiser") ?? "").trim();
}

function readInitialDefinitionEventIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get("definition")?.trim() ?? "";
}

function writeSelectedQuestionnaireToUrl(input: {
  questionnaireId: string;
  coordinatorNpub: string;
  definitionEventId: string;
}) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (input.questionnaireId.trim()) {
    url.searchParams.set("q", input.questionnaireId.trim());
  } else {
    url.searchParams.delete("q");
    url.searchParams.delete("questionnaire");
    url.searchParams.delete("election_id");
  }
  if (input.coordinatorNpub.trim()) {
    url.searchParams.set("coordinator", input.coordinatorNpub.trim());
  }
  if (input.definitionEventId.trim()) {
    url.searchParams.set("definition", input.definitionEventId.trim());
  } else {
    url.searchParams.delete("definition");
  }
  window.history.replaceState({}, "", url.toString());
}

function calculateAuditorResponseFetchLimit(...counts: Array<number | null | undefined>) {
  const expectedCount = Math.max(
    0,
    ...counts
      .map((count) => Number(count ?? 0))
      .filter((count) => Number.isFinite(count) && count > 0),
  );
  if (expectedCount <= 0) {
    return AUDITOR_QUESTIONNAIRE_RESPONSE_PAGE_LIMIT;
  }
  const headroom = Math.max(50, Math.ceil(expectedCount * 0.1));
  return Math.max(AUDITOR_QUESTIONNAIRE_RESPONSE_PAGE_LIMIT, expectedCount + headroom);
}

function selectedResponsesMatchPublishedTotal(
  summary: QuestionnaireResultSummary | null,
  responseDetails: AuditorQuestionnaireResponseDetail[],
) {
  if (!summary) {
    return false;
  }
  const publishedTotal = summary.acceptedResponseCount + summary.rejectedResponseCount;
  if (publishedTotal <= 0) {
    return false;
  }
  const loadedAcceptedCount = responseDetails.filter((entry) => entry.accepted).length;
  const loadedRejectedCount = responseDetails.filter((entry) => !entry.accepted).length;
  return summary.acceptedResponseCount >= loadedAcceptedCount
    && summary.rejectedResponseCount >= loadedRejectedCount;
}

export default function SimpleAuditorApp({
  filtersInMenu = false,
  filtersMenuOpen = false,
  onFiltersMenuClose,
}: SimpleAuditorAppProps = {}) {
  const urlPinnedQuestionnaireId = useMemo(() => readInitialQuestionnaireIdFromUrl(), []);
  const urlPinnedCoordinatorNpub = useMemo(() => readInitialCoordinatorNpubFromUrl(), []);
  const urlPinnedDefinitionEventId = useMemo(() => readInitialDefinitionEventIdFromUrl(), []);
  const initialQuestionnaireId = useMemo(() => urlPinnedQuestionnaireId || auditorMemoryCache.selectedQuestionnaireId, [urlPinnedQuestionnaireId]);
  const canUseCachedSelection = initialQuestionnaireId === auditorMemoryCache.selectedQuestionnaireId;
  const [questionnaires, setQuestionnaires] = useState<AuditorQuestionnaireEntry[]>(() => auditorMemoryCache.questionnaires);
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState(initialQuestionnaireId);
  const [selectedDefinitionEventId, setSelectedDefinitionEventId] = useState(urlPinnedDefinitionEventId || auditorMemoryCache.selectedDefinitionEventId);
  const [selectedResponseDetails, setSelectedResponseDetails] = useState<AuditorQuestionnaireResponseDetail[]>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedResponseDetails : []
  ));
  const [selectedProvisionalResponseDetails, setSelectedProvisionalResponseDetails] = useState<QuestionnaireResultsDashboardResponseDetail[]>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedProvisionalResponseDetails : []
  ));
  const [selectedLatestPublishAt, setSelectedLatestPublishAt] = useState<number | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedLatestPublishAt : null
  ));
  const [selectedLiveState, setSelectedLiveState] = useState<string | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedLiveState : null
  ));
  const [selectedLiveStateEvent, setSelectedLiveStateEvent] = useState<QuestionnaireStateEvent | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedLiveStateEvent : null
  ));
  const [selectedResultSummary, setSelectedResultSummary] = useState<QuestionnaireResultSummary | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedResultSummary : null
  ));
  const [selectedWorkerDelegationStatus, setSelectedWorkerDelegationStatus] = useState<QuestionnaireWorkerDelegationStatus | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.selectedWorkerDelegationStatus : null
  ));
  const [searchQuery, setSearchQuery] = useState("");
  const [observerDecryptNsec, setObserverDecryptNsec] = useState("");
  const [questionnaireRefreshStatus, setQuestionnaireRefreshStatus] = useState<string | null>(() => auditorMemoryCache.questionnaireRefreshStatus);
  const [responseRefreshStatus, setResponseRefreshStatus] = useState<string | null>(() => (
    canUseCachedSelection ? auditorMemoryCache.responseRefreshStatus : null
  ));
  const [filterMenuMount, setFilterMenuMount] = useState<HTMLElement | null>(null);
  const [topBarActionsMount, setTopBarActionsMount] = useState<HTMLElement | null>(null);
  const [refreshInFlight, setRefreshInFlight] = useState(false);
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);
  const initialListLoadDoneRef = useRef(auditorMemoryCache.questionnaires.length > 0);
  const initialSelectedLoadDoneRef = useRef(canUseCachedSelection && auditorMemoryCache.selectedResponseDetails.length >= 0);
  const selectedQuestionnaireIdRef = useRef(initialQuestionnaireId);
  const selectedDefinitionEventIdRef = useRef(urlPinnedDefinitionEventId || auditorMemoryCache.selectedDefinitionEventId);
  const selectedDefinitionIsPinnedRef = useRef(Boolean(urlPinnedDefinitionEventId));
  const selectedResponseDetailsRef = useRef<AuditorQuestionnaireResponseDetail[]>([]);
  const selectedResultSummaryRef = useRef<QuestionnaireResultSummary | null>(null);
  const selectedRefreshEffectHasRunRef = useRef(false);
  const selectedChangeFromRefreshRef = useRef(false);
  const refreshQueueRef = useRef<{
    pendingList: boolean;
    pendingSelected: boolean;
    inFlightPromise: Promise<void> | null;
  }>({
    pendingList: false,
    pendingSelected: false,
    inFlightPromise: null,
  });
  const questionnairesRef = useRef<AuditorQuestionnaireEntry[]>([]);

  useEffect(() => {
    selectedQuestionnaireIdRef.current = selectedQuestionnaireId;
  }, [selectedQuestionnaireId]);
  useEffect(() => {
    selectedDefinitionEventIdRef.current = selectedDefinitionEventId;
  }, [selectedDefinitionEventId]);
  useEffect(() => {
    selectedResponseDetailsRef.current = selectedResponseDetails;
  }, [selectedResponseDetails]);
  useEffect(() => {
    selectedResultSummaryRef.current = selectedResultSummary;
  }, [selectedResultSummary]);
  useEffect(() => {
    questionnairesRef.current = questionnaires;
  }, [questionnaires]);
  useEffect(() => {
    if (!filtersInMenu || !filtersMenuOpen || typeof document === "undefined") {
      setFilterMenuMount((previous) => (previous === null ? previous : null));
      return;
    }
    const mount = document.getElementById("simple-auditor-menu-filters");
    setFilterMenuMount((previous) => (previous === mount ? previous : mount));
  }, [filtersInMenu, filtersMenuOpen]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const mount = document.getElementById("simple-auditor-topbar-actions");
    setTopBarActionsMount((previous) => (previous === mount ? previous : mount));
  }, []);
  useEffect(() => {
    auditorMemoryCache = {
      questionnaires,
      selectedQuestionnaireId,
      selectedDefinitionEventId,
      selectedResponseDetails,
      selectedProvisionalResponseDetails,
      selectedLatestPublishAt,
      selectedLiveState,
      selectedLiveStateEvent,
      selectedResultSummary,
      selectedWorkerDelegationStatus,
      questionnaireRefreshStatus,
      responseRefreshStatus,
    };
  }, [
    questionnaireRefreshStatus,
    questionnaires,
    responseRefreshStatus,
    selectedLatestPublishAt,
    selectedLiveState,
    selectedLiveStateEvent,
    selectedQuestionnaireId,
    selectedDefinitionEventId,
    selectedResponseDetails,
    selectedProvisionalResponseDetails,
    selectedResultSummary,
    selectedWorkerDelegationStatus,
  ]);

  const loadQuestionnairesFromNostr = useCallback(async (input?: { historic?: boolean }) => {
    const historic = Boolean(input?.historic);
    const definitions = await fetchQuestionnaireDefinitions({
      limit: historic ? AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT : 400,
      readRelayLimit: 2,
      preferKindOnly: true,
    });
       const candidatesByEventId = new Map<string, Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]>();
       for (const entry of definitions) {
         const id = entry.definition.questionnaireId.trim();
         if (!id) {
           continue;
         }
         if (urlPinnedCoordinatorNpub && !definitionMatchesCoordinator(entry, urlPinnedCoordinatorNpub)) {
           continue;
         }
         candidatesByEventId.set(entry.event.id, entry);
       }

       const latestDefinitions = [...candidatesByEventId.values()]
        .sort((left, right) => (
          Number(right.event.created_at ?? right.definition.createdAt ?? 0)
          - Number(left.event.created_at ?? left.definition.createdAt ?? 0)
        ));

      let candidates = historic
        ? latestDefinitions
        : latestDefinitions.slice(0, AUDITOR_QUESTIONNAIRE_DETAIL_LIMIT);
      const selectedIdForList = selectedQuestionnaireIdRef.current.trim();
       if (selectedIdForList) {
         const selectedDefinitions = await fetchQuestionnaireDefinitions({
           questionnaireId: selectedIdForList,
           // A selected round needs its complete public definition history, not only
           // the recent variants which happened to fit in the discovery list.
           limit: AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT,
           readRelayLimit: 8,
           preferKindOnly: true,
         }).catch(() => []);
          const selectedDefinitionsForCoordinator = selectedDefinitions.filter((entry) => (
            !urlPinnedCoordinatorNpub || definitionMatchesCoordinator(entry, urlPinnedCoordinatorNpub)
          ));
          if (selectedDefinitionsForCoordinator.length > 0) {
            candidates = dedupeDefinitionEntries([
              ...selectedDefinitionsForCoordinator,
              ...candidates.filter((entry) => entry.definition.questionnaireId !== selectedIdForList),
            ]);
         }
       }
       const previousEntriesById = new Map(questionnairesRef.current.map((entry) => [entry.eventId, entry]));
      const entries: AuditorQuestionnaireEntry[] = [];
      for (const entry of candidates) {
        const id = entry.definition.questionnaireId;
        const questionnaireRelays = entry.definition.questionnaireRelays;
        const coordinatorNpub = normalizeToNpub(entry.definition.coordinatorPubkey);
         const previousEntry = previousEntriesById.get(entry.event.id);
        entries.push({
          questionnaireId: id,
          title: entry.definition.title || "Untitled questionnaire",
          description: entry.definition.description || "",
          coordinatorNpub,
          createdAt: Number(entry.event.created_at ?? entry.definition.createdAt ?? 0),
          openAt: Number.isFinite(entry.definition.openAt) ? entry.definition.openAt : null,
          closeAt: Number.isFinite(entry.definition.closeAt) ? entry.definition.closeAt : null,
          state: previousEntry?.state ?? null,
          expectedInviteeCount: previousEntry?.expectedInviteeCount ?? null,
          publishedAcceptedResponseCount: previousEntry?.publishedAcceptedResponseCount ?? null,
          publishedRejectedResponseCount: previousEntry?.publishedRejectedResponseCount ?? null,
          resultPublishedAt: previousEntry?.resultPublishedAt ?? null,
          questions: entry.definition.questions ?? [],
          questionnaireRelays,
          blindSigningPublicKey: entry.definition.blindSigningPublicKey ?? null,
          responseSearchValues: previousEntry?.responseSearchValues ?? [],
          eventId: entry.event.id,
        });
      }
      return entries;
  }, [urlPinnedCoordinatorNpub]);

  const refreshQuestionnaires = useCallback(async () => {
    try {
      const entries = await loadQuestionnairesFromNostr();
      initialListLoadDoneRef.current = true;
      questionnairesRef.current = entries;
      setQuestionnaires((previous) => (
        areQuestionnaireEntriesEqual(previous, entries) ? previous : entries
      ));
      const selectedId = selectedQuestionnaireIdRef.current.trim();
      const selectedIsUrlPinned = Boolean(initialQuestionnaireId && selectedId === initialQuestionnaireId);
      const selectedDefinitionEventId = selectedDefinitionEventIdRef.current;
      const selectedEntry = entries.find((entry) => entry.eventId === selectedDefinitionEventId)
        ?? entries.find((entry) => entry.questionnaireId === selectedId);
      const nextSelectedId = (!selectedId || (!selectedIsUrlPinned && !selectedEntry))
        ? (entries[0]?.questionnaireId ?? "")
        : selectedId;
      const nextDefinitionEventId = selectedEntry?.eventId ?? entries.find((entry) => entry.questionnaireId === nextSelectedId)?.eventId ?? "";
      selectedQuestionnaireIdRef.current = nextSelectedId;
      if (nextDefinitionEventId !== selectedDefinitionEventIdRef.current) {
        selectedDefinitionIsPinnedRef.current = false;
      }
      selectedDefinitionEventIdRef.current = nextDefinitionEventId;
      if (selectedId !== nextSelectedId) {
        selectedChangeFromRefreshRef.current = true;
      }
      setSelectedQuestionnaireId((previous) => (previous === nextSelectedId ? previous : nextSelectedId));
      setSelectedDefinitionEventId((previous) => (previous === nextDefinitionEventId ? previous : nextDefinitionEventId));
      const nextStatus = (
        entries.length > 0
          ? "Questionnaires refreshed from Nostr."
          : "No public questionnaires discovered yet."
      );
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    } catch {
      initialListLoadDoneRef.current = true;
      const nextStatus = "Failed to refresh public questionnaires.";
      setQuestionnaireRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    }
  }, [initialQuestionnaireId, loadQuestionnairesFromNostr]);

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
      const selectedQuestionnaire = questionnairesRef.current.find((entry) => entry.eventId === selectedDefinitionEventIdRef.current)
        ?? questionnairesRef.current.find((entry) => entry.questionnaireId === selectedId);
      const questionnaireRelays = selectedQuestionnaire?.questionnaireRelays;
      const [
        definitionEntries,
        resultEntries,
        stateEntries,
        delegationStatus,
        participantCountEntries,
      ] = await Promise.all([
        fetchQuestionnaireDefinitions({
          questionnaireId: selectedId,
           limit: AUDITOR_QUESTIONNAIRE_HISTORIC_LIMIT,
          readRelayLimit: 8,
          preferKindOnly: true,
          relays: questionnaireRelays,
        }).catch(() => []),
        fetchQuestionnaireResultSummary({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 5,
          preferKindOnly: true,
          maxPages: 32,
          timeBudgetMs: AUDITOR_QUESTIONNAIRE_RESPONSE_TIME_BUDGET_MS,
          relays: questionnaireRelays,
        }).catch(() => []),
        fetchQuestionnaireState({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 2,
          preferKindOnly: true,
          relays: questionnaireRelays,
        }).catch(() => []),
        fetchQuestionnaireWorkerDelegationStatus({
          questionnaireId: selectedId,
          readRelayLimit: 2,
          relays: questionnaireRelays,
        }).catch(() => null),
        fetchQuestionnaireParticipantCount({
          questionnaireId: selectedId,
          limit: 50,
          readRelayLimit: 2,
          preferKindOnly: true,
          relays: questionnaireRelays,
        }).catch(() => []),
      ]);
       const latestResult = [...resultEntries]
        .sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0))[0];
      const latestParticipantCount = selectedQuestionnaire
        ? selectLatestParticipantCount(participantCountEntries, selectedId, selectedQuestionnaire.coordinatorNpub)
        : null;
      const expectedResponseTotal = latestResult?.summary
        ? latestResult.summary.acceptedResponseCount + latestResult.summary.rejectedResponseCount
        : null;
      const responseFetchLimit = calculateAuditorResponseFetchLimit(
        expectedResponseTotal,
        latestResult?.summary.publishedResponseRefs?.length,
        latestParticipantCount?.expectedInviteeCount,
        selectedQuestionnaire?.expectedInviteeCount,
      );
       const [responseEntries, decisionEntries, provisionalEntries] = await Promise.all([
        fetchQuestionnaireBlindResponses({
          questionnaireId: selectedId,
          limit: responseFetchLimit,
          readRelayLimit: 5,
          preferKindOnly: true,
          maxPages: AUDITOR_QUESTIONNAIRE_RESPONSE_MAX_PAGES,
          timeBudgetMs: AUDITOR_QUESTIONNAIRE_RESPONSE_TIME_BUDGET_MS,
          relays: questionnaireRelays,
        }),
        fetchQuestionnaireSubmissionDecisions({
          questionnaireId: selectedId,
          limit: responseFetchLimit,
          readRelayLimit: 5,
          preferKindOnly: true,
          maxPages: AUDITOR_QUESTIONNAIRE_RESPONSE_MAX_PAGES,
          timeBudgetMs: AUDITOR_QUESTIONNAIRE_RESPONSE_TIME_BUDGET_MS,
          relays: questionnaireRelays,
        }).catch(() => []),
        fetchQuestionnaireProvisionalResponses({
          questionnaireId: selectedId,
          limit: responseFetchLimit,
          readRelayLimit: 5,
          preferKindOnly: true,
          maxPages: AUDITOR_QUESTIONNAIRE_RESPONSE_MAX_PAGES,
          timeBudgetMs: AUDITOR_QUESTIONNAIRE_RESPONSE_TIME_BUDGET_MS,
          relays: questionnaireRelays,
         }).catch(() => []),
       ]);
       const resolvedDefinitionEntry = selectAuditorDefinition({
         questionnaireId: selectedId,
         definitions: definitionEntries,
          responseEvents: responseEntries.map((entry) => entry.event),
          coordinatorNpub: urlPinnedCoordinatorNpub,
           definitionEventId: selectedDefinitionIsPinnedRef.current
             ? selectedDefinitionEventIdRef.current
             : "",
       });
       // Do not let a previously discovered, same-ID definition override an ambiguous public stream.
        const resolvedDefinition = resolvedDefinitionEntry?.definition
          ?? (definitionEntries.length === 0 ? selectedQuestionnaire : null);
        if (resolvedDefinitionEntry && !selectedDefinitionIsPinnedRef.current) {
          selectedDefinitionEventIdRef.current = resolvedDefinitionEntry.event.id;
          setSelectedDefinitionEventId((previous) => (
            previous === resolvedDefinitionEntry.event.id ? previous : resolvedDefinitionEntry.event.id
          ));
        }
        const verifiedResponseIds = await verifyQuestionnaireBlindResponseProofs({
         entries: responseEntries,
         publicKey: resolvedDefinition?.blindSigningPublicKey ?? null,
      });
      const admissions = evaluateQuestionnaireBlindAdmissions({
        entries: responseEntries,
        decisionEntries,
        verifiedResponseIds,
        requireVerifiedProofs: true,
      });
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
      if (
        latestResult?.summary.resultPack
        && (
          (expectedResponseTotal !== null && details.length < expectedResponseTotal)
          || ((latestResult.summary.publishedResponseRefs?.length ?? 0) > details.length)
        )
      ) {
        try {
          const pack = await fetchQuestionnaireResultPack(latestResult.summary.resultPack);
          if (pack.questionnaireId === selectedId) {
            const packDetails = pack.responses.map((ref) => optionASummaryRefToAuditorDetail({
              questionnaireId: selectedId,
              ref,
              latestPublishAt,
              source: "result-pack",
            }));
            const nextDetails = mergeAuditorResponseDetails(details, packDetails);
            details = nextDetails;
          }
        } catch (error) {
          console.warn("Blossom result-pack fetch failed", error);
        }
      }
      const provisionalDetails = dedupeAuditorProvisionalResponseDetails(provisionalEntries.map(({ event, response }) => ({
        event,
        accepted: true,
        rejectionReason: null,
        includedInLatestPublish: false,
        decryptedAnswerQuestionIds: response.questionIds,
        response: {
          responseId: response.responseId,
          authorPubkey: normalizeToNpub(response.authorPubkey),
          submittedAt: response.submittedAt,
          answers: response.answers,
        },
      }))).sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
      const nextLiveState = latestState?.state.state ?? null;
      const nextLiveStateEvent = latestState?.state ?? null;
      const nextResultSummary = latestResult?.summary ?? null;
      setSelectedResponseDetails((previous) => (
        areAuditorResponseDetailsEqual(previous, details) ? previous : details
      ));
      setSelectedProvisionalResponseDetails((previous) => (
        areAuditorResponseDetailsEqual(previous, provisionalDetails) ? previous : provisionalDetails
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
          if (entry.eventId !== (resolvedDefinitionEntry?.event.id ?? selectedQuestionnaire?.eventId)) {
           return entry;
         }
         const definition = resolvedDefinitionEntry?.definition;
         return {
           ...entry,
           ...(definition ? {
             title: definition.title || "Untitled questionnaire",
             description: definition.description || "",
             coordinatorNpub: normalizeToNpub(definition.coordinatorPubkey),
             createdAt: Number(resolvedDefinitionEntry.event.created_at ?? definition.createdAt ?? 0),
             openAt: Number.isFinite(definition.openAt) ? definition.openAt : null,
             closeAt: Number.isFinite(definition.closeAt) ? definition.closeAt : null,
             questions: definition.questions ?? [],
             questionnaireRelays: definition.questionnaireRelays,
             blindSigningPublicKey: definition.blindSigningPublicKey ?? null,
             eventId: resolvedDefinitionEntry.event.id,
           } : {}),
          state: nextLiveState,
          publishedAcceptedResponseCount: nextResultSummary?.acceptedResponseCount ?? entry.publishedAcceptedResponseCount,
          publishedRejectedResponseCount: nextResultSummary?.rejectedResponseCount ?? entry.publishedRejectedResponseCount,
          resultPublishedAt: Number(nextResultSummary?.createdAt ?? 0) || entry.resultPublishedAt,
          ...(latestParticipantCount ? { expectedInviteeCount: latestParticipantCount.expectedInviteeCount } : {}),
          responseSearchValues: buildAuditorResponseDetailSearchValues(details),
        };
      }));
      initialSelectedLoadDoneRef.current = true;
      setResponseRefreshStatus((previous) => (previous === null ? previous : null));
    } catch {
      initialSelectedLoadDoneRef.current = true;
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedProvisionalResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      setSelectedWorkerDelegationStatus((previous) => (previous === null ? previous : null));
      const nextStatus = "Failed to refresh questionnaire responses.";
      setResponseRefreshStatus((previous) => (previous === nextStatus ? previous : nextStatus));
    }
  }, [urlPinnedCoordinatorNpub]);

  const drainRefreshQueue = useCallback(async (forceWhenHidden = false) => {
    if (refreshQueueRef.current.inFlightPromise) {
      await refreshQueueRef.current.inFlightPromise;
      if (refreshQueueRef.current.pendingList || refreshQueueRef.current.pendingSelected) {
        await drainRefreshQueue(forceWhenHidden);
      }
      return;
    }
    setRefreshInFlight(true);
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
      setRefreshInFlight(false);
    }
  }, [refreshQuestionnaires, refreshSelectedQuestionnaireResponses]);

  const enqueueRefresh = useCallback(async (input?: {
    list?: boolean;
    selected?: boolean;
    forceWhenHidden?: boolean;
    automatic?: boolean;
  }) => {
    if (input?.automatic) {
      if (auditorSessionAutoRefreshDone && (auditorMemoryCache.questionnaires.length > 0 || questionnairesRef.current.length > 0)) {
        return;
      }
      auditorSessionAutoRefreshDone = true;
    }
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
    void enqueueRefresh({ list: true, selected: true, forceWhenHidden: true, automatic: true });
  }, [enqueueRefresh]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const refreshSelected = () => {
      if (!visible() || !selectedQuestionnaireIdRef.current.trim()) {
        return;
      }
      if (selectedResponsesMatchPublishedTotal(selectedResultSummaryRef.current, selectedResponseDetailsRef.current)) {
        return;
      }
      void enqueueRefresh({ list: false, selected: true });
    };
    const refreshList = () => {
      if (!visible()) {
        return;
      }
      void enqueueRefresh({ list: true, selected: false });
    };
    const refreshOnVisible = () => {
      if (visible()) {
        void enqueueRefresh({ list: true, selected: true });
      }
    };
    const responseIntervalId = window.setInterval(refreshSelected, AUDITOR_RESPONSE_AUTO_REFRESH_MS);
    const listIntervalId = window.setInterval(refreshList, AUDITOR_LIST_AUTO_REFRESH_MS);
    window.addEventListener("focus", refreshOnVisible);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.clearInterval(responseIntervalId);
      window.clearInterval(listIntervalId);
      window.removeEventListener("focus", refreshOnVisible);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [enqueueRefresh]);

  useEffect(() => {
    const selectedId = selectedQuestionnaireId.trim();
    if (!selectedId) {
      return;
    }
    const selectedQuestionnaire = questionnairesRef.current.find((entry) => entry.eventId === selectedDefinitionEventIdRef.current)
      ?? questionnairesRef.current.find((entry) => entry.questionnaireId === selectedId);
    const unsubscribe = subscribeQuestionnaireEventKinds({
      questionnaireId: selectedId,
      kinds: [
        QUESTIONNAIRE_DEFINITION_KIND,
        QUESTIONNAIRE_STATE_KIND,
        QUESTIONNAIRE_PARTICIPANT_COUNT_KIND,
        QUESTIONNAIRE_RESPONSE_BLIND_KIND,
        QUESTIONNAIRE_RESPONSE_PROVISIONAL_KIND,
        QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
        QUESTIONNAIRE_RESULT_SUMMARY_KIND,
      ],
      relays: selectedQuestionnaire?.questionnaireRelays,
      readRelayLimit: 8,
      limit: 50,
      since: Math.floor(Date.now() / 1000),
      parseQuestionnaireIdFromEvent: (event) => {
        if (event.kind === QUESTIONNAIRE_DEFINITION_KIND) {
          return parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_STATE_KIND) {
          return parseQuestionnaireStateEvent(event)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_PARTICIPANT_COUNT_KIND) {
          return parseQuestionnaireParticipantCountEvent(event)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_BLIND_KIND) {
          return parseQuestionnaireBlindResponseEvent(event.content)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_PROVISIONAL_KIND) {
          return parseQuestionnaireProvisionalResponseEvent(event.content)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_SUBMISSION_DECISION_KIND) {
          return parseQuestionnaireSubmissionDecisionEvent(event.content)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_RESULT_SUMMARY_KIND) {
          try {
            const parsed = JSON.parse(event.content) as { questionnaireId?: string };
            return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
          } catch {
            return null;
          }
        }
        return null;
      },
      onEvent: () => {
        if (selectedResponsesMatchPublishedTotal(selectedResultSummaryRef.current, selectedResponseDetailsRef.current)) {
          return;
        }
        void enqueueRefresh({ list: false, selected: true });
      },
      onError: () => undefined,
    });
    return unsubscribe;
  }, [enqueueRefresh, questionnaires, selectedDefinitionEventId, selectedQuestionnaireId]);

  useEffect(() => {
    if (!selectedQuestionnaireId.trim()) {
      selectedChangeFromRefreshRef.current = false;
      setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedProvisionalResponseDetails((previous) => (previous.length === 0 ? previous : []));
      setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
      setSelectedLiveState((previous) => (previous === null ? previous : null));
      setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
      setSelectedResultSummary((previous) => (previous === null ? previous : null));
      return;
    }
    const selectionCameFromRefresh = selectedChangeFromRefreshRef.current;
    selectedChangeFromRefreshRef.current = false;
    if (!selectedRefreshEffectHasRunRef.current) {
      selectedRefreshEffectHasRunRef.current = true;
      return;
    }
    if (selectionCameFromRefresh) {
      return;
    }
    setSelectedResponseDetails((previous) => (previous.length === 0 ? previous : []));
    setSelectedProvisionalResponseDetails((previous) => (previous.length === 0 ? previous : []));
    setSelectedLatestPublishAt((previous) => (previous === null ? previous : null));
    setSelectedLiveState((previous) => (previous === null ? previous : null));
    setSelectedLiveStateEvent((previous) => (previous === null ? previous : null));
    setSelectedResultSummary((previous) => (previous === null ? previous : null));
    setSelectedWorkerDelegationStatus((previous) => (previous === null ? previous : null));
    setResponseRefreshStatus((previous) => (previous === null ? previous : null));
    void enqueueRefresh({ list: false, selected: true, forceWhenHidden: true });
  }, [enqueueRefresh, selectedDefinitionEventId, selectedQuestionnaireId]);

  const coordinatorOptions = useMemo(
    () => [...new Set(
      questionnaires
        .map((questionnaire) => questionnaire.coordinatorNpub.trim())
        .filter((value) => value.length > 0),
    )],
    [questionnaires],
  );

  const [selectedCoordinatorNpub, setSelectedCoordinatorNpub] = useState(() => normalizeToNpub(urlPinnedCoordinatorNpub));
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
      if (!matchesAuditorQuestionnaireSearch(questionnaire, searchQuery)) {
        return false;
      }
      return true;
    }),
    [questionnaires, searchQuery, selectedCoordinatorNpub],
  );

  useEffect(() => {
    if (urlPinnedQuestionnaireId && selectedQuestionnaireId !== urlPinnedQuestionnaireId) {
      setSelectedQuestionnaireId(urlPinnedQuestionnaireId);
      return;
    }
    if (filteredQuestionnaires.length === 0) {
      if (initialQuestionnaireId && selectedQuestionnaireId === initialQuestionnaireId) {
        return;
      }
      if (selectedQuestionnaireId) {
        setSelectedQuestionnaireId("");
      }
      return;
    }
    if (!selectedQuestionnaireId || !filteredQuestionnaires.some((entry) => entry.eventId === selectedDefinitionEventId)) {
      if (initialQuestionnaireId && selectedQuestionnaireId === initialQuestionnaireId) {
        return;
      }
      setSelectedQuestionnaireId(filteredQuestionnaires[0].questionnaireId);
      setSelectedDefinitionEventId(filteredQuestionnaires[0].eventId);
    }
  }, [filteredQuestionnaires, initialQuestionnaireId, selectedDefinitionEventId, selectedQuestionnaireId, urlPinnedQuestionnaireId]);

  useEffect(() => {
    const selected = questionnaires.find((entry) => entry.eventId === selectedDefinitionEventId)
      ?? questionnaires.find((entry) => entry.questionnaireId === selectedQuestionnaireId);
    writeSelectedQuestionnaireToUrl({
      questionnaireId: selectedQuestionnaireId,
      coordinatorNpub: selected?.coordinatorNpub ?? selectedCoordinatorNpub,
      definitionEventId: selected?.eventId ?? selectedDefinitionEventId,
    });
  }, [questionnaires, selectedCoordinatorNpub, selectedDefinitionEventId, selectedQuestionnaireId]);

  const selectedQuestionnaire = useMemo(
    () => questionnaires.find((entry) => entry.eventId === selectedDefinitionEventId)
      ?? questionnaires.find((entry) => entry.questionnaireId === selectedQuestionnaireId)
      ?? null,
    [questionnaires, selectedDefinitionEventId, selectedQuestionnaireId],
  );
  const selectedDefinitionHistory = useMemo(
    () => questionnaires
      .filter((entry) => entry.questionnaireId === selectedQuestionnaireId)
      .sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId)),
    [questionnaires, selectedQuestionnaireId],
  );

  const decryptedResponseResult = useMemo(
    () => decryptAuditorResponseDetails({
      responseDetails: selectedResponseDetails,
      coordinatorNsec: observerDecryptNsec,
    }),
    [observerDecryptNsec, selectedResponseDetails],
  );
  const displayResponseDetails = decryptedResponseResult.responseDetails;

  const liveQuestionSummaries = useMemo(
    () => buildLiveQuestionSummaries(
      selectedQuestionnaire?.questions ?? [],
      displayResponseDetails.filter((entry) => entry.accepted),
    ),
    [displayResponseDetails, selectedQuestionnaire?.questions],
  );

  const liveAcceptedCount = useMemo(
    () => displayResponseDetails.filter((entry) => entry.accepted).length,
    [displayResponseDetails],
  );

  const liveRejectedCount = useMemo(
    () => displayResponseDetails.filter((entry) => !entry.accepted).length,
    [displayResponseDetails],
  );
  const selectedResultSummaryMatchesLoadedResponses = selectedResultSummary
    ? selectedResponsesMatchPublishedTotal(selectedResultSummary, displayResponseDetails)
    : false;
  const displayValidCount = selectedResultSummaryMatchesLoadedResponses
    ? selectedResultSummary?.acceptedResponseCount ?? liveAcceptedCount
    : liveAcceptedCount;
  const displayInvalidCount = selectedResultSummaryMatchesLoadedResponses
    ? selectedResultSummary?.rejectedResponseCount ?? liveRejectedCount
    : liveRejectedCount;
  const hasPublishedQuestionSummaries = selectedResultSummaryMatchesLoadedResponses
    && (selectedResultSummary?.questionSummaries?.length ?? 0) > 0;
  const displayedQuestionSummaries = hasPublishedQuestionSummaries
    ? selectedResultSummary?.questionSummaries ?? []
    : liveQuestionSummaries;
  const publishedAtTime = selectedResultSummary?.createdAt
    ?? selectedQuestionnaire?.createdAt
    ?? selectedQuestionnaire?.resultPublishedAt
    ?? 0;
  const canExportResults = Boolean(
    selectedQuestionnaire
    && (selectedLiveState ?? selectedQuestionnaire.state) === "results_published"
    && selectedResultSummary,
  );
  async function refreshNow() {
    if (manualRefreshInFlight) {
      return;
    }
    const nextQuestionnaireStatus = "Refreshing public questionnaires...";
    setManualRefreshInFlight(true);
    try {
      setQuestionnaireRefreshStatus((previous) => (previous === nextQuestionnaireStatus ? previous : nextQuestionnaireStatus));
      setResponseRefreshStatus((previous) => (previous === null ? previous : null));
      await enqueueRefresh({ list: true, selected: true, forceWhenHidden: true });
    } finally {
      setManualRefreshInFlight(false);
    }
  }

  function formatQuestionnaireTime(unix: number | null) {
    if (!unix) {
      return "Not set";
    }
    return new Date(unix * 1000).toLocaleString();
  }

  function formatRoundOptionLabel(entry: AuditorQuestionnaireEntry) {
    return `${entry.title} · ${formatQuestionnaireDisplayId(entry.questionnaireId)} · organiser ${deriveActorDisplayId(entry.coordinatorNpub)} · ${formatQuestionnaireTime(entry.createdAt)} · ${entry.eventId.slice(0, 12)}`;
  }

  function formatDefinitionHistoryOptionLabel(entry: AuditorQuestionnaireEntry, index: number) {
    const version = index === 0 ? "Initial / original" : `Revision ${index}`;
    return `${version} · creator ${deriveActorDisplayId(entry.coordinatorNpub)} · event ${entry.eventId} · published ${formatQuestionnaireTime(entry.createdAt)} · ${entry.questions.length} question${entry.questions.length === 1 ? "" : "s"}`;
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
      responses: displayResponseDetails.map((entry) => ({
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

  const filterControls = questionnaires.length > 0 ? (
    <div className='simple-auditor-filters'>
      <UiTextField
        label='Search'
        fieldClassName='simple-auditor-search-field'
        inputProps={{
          id: 'simple-auditor-search',
          value: searchQuery,
          onChange: (event) => setSearchQuery(event.target.value),
          placeholder: 'Filter by questionnaire, organiser, Submission ID, or Submittor identity...',
        }}
      />
      <UiSelect
        label='Questionnaire organiser identity'
        id='simple-auditor-coordinator-npub'
        fieldClassName='simple-auditor-organiser-field'
        value={selectedCoordinatorNpub}
        onChange={(event) => setSelectedCoordinatorNpub(event.target.value)}
      >
        <option value=''>Any questionnaire organiser</option>
        {coordinatorSelectOptions.map((coordinatorNpub) => (
          <option key={coordinatorNpub} value={coordinatorNpub}>
            {coordinatorNpub}
          </option>
        ))}
      </UiSelect>
      {filteredQuestionnaires.length > 0 ? (
        <UiSelect
          label='Round'
          id='simple-auditor-round'
          fieldClassName='simple-auditor-round-field'
          value={selectedQuestionnaire?.eventId ?? ''}
          onChange={(event) => {
            const selected = filteredQuestionnaires.find((entry) => entry.eventId === event.target.value);
            setSelectedQuestionnaireId(selected?.questionnaireId ?? "");
            setSelectedDefinitionEventId(event.target.value);
            selectedDefinitionIsPinnedRef.current = true;
            onFiltersMenuClose?.();
          }}
        >
          {filteredQuestionnaires.map((entry) => (
            <option key={entry.eventId} value={entry.eventId}>
              {formatRoundOptionLabel(entry)}
            </option>
          ))}
        </UiSelect>
      ) : (
        <p className='simple-voter-note'>No questionnaire rounds found for the selected filters.</p>
      )}
      {selectedQuestionnaire ? (
        <div className='simple-auditor-definition-history'>
          <UiSelect
            label='Definition history'
            id='simple-auditor-definition-history'
            fieldClassName='simple-auditor-definition-history-field'
            value={selectedQuestionnaire.eventId}
            onChange={(event) => {
              const selected = selectedDefinitionHistory.find((entry) => entry.eventId === event.target.value);
              if (!selected) {
                return;
              }
              selectedDefinitionIsPinnedRef.current = true;
              setSelectedQuestionnaireId(selected.questionnaireId);
              setSelectedDefinitionEventId(selected.eventId);
              onFiltersMenuClose?.();
            }}
          >
            {selectedDefinitionHistory.map((entry, index) => (
              <option key={entry.eventId} value={entry.eventId}>
                {formatDefinitionHistoryOptionLabel(entry, index)}
              </option>
            ))}
          </UiSelect>
          {selectedDefinitionHistory.length > 1 ? (
            <p className='simple-voter-note'>The selected definition controls the displayed questions and blind-proof verification.</p>
          ) : (
            <p className='simple-voter-note'>No other definition variants were discoverable. Currently using definition event {selectedQuestionnaire.eventId}.</p>
          )}
        </div>
      ) : null}
    </div>
  ) : null;
  const filterPortal = filtersInMenu && filtersMenuOpen && filterMenuMount && filterControls
    ? createPortal((
      <div className='simple-account-menu-section simple-auditor-menu-filter-section' role='none'>
        <p className='simple-account-menu-kicker'>Filters</p>
        {filterControls}
      </div>
    ), filterMenuMount)
    : null;
  const initialQuestionnaireListLoading = questionnaires.length === 0 && !initialListLoadDoneRef.current && refreshInFlight;
  const shouldShowNoQuestionnaires = questionnaires.length === 0 && !initialQuestionnaireListLoading;
  const shouldShowResponseRefreshStatus = Boolean(responseRefreshStatus);
  const shouldShowAuditorPanel = !topBarActionsMount
    || !filtersInMenu
    || shouldShowNoQuestionnaires
    || shouldShowResponseRefreshStatus;
  const refreshButton = (
    <UiButton
      icon={manualRefreshInFlight ? "spinner" : "refresh"}
      className='simple-auditor-refresh-button'
      onPress={() => void refreshNow()}
      isDisabled={manualRefreshInFlight}
    >
      {manualRefreshInFlight ? "Busy..." : "Refresh"}
    </UiButton>
  );
  const refreshPortal = topBarActionsMount ? createPortal(refreshButton, topBarActionsMount) : null;

  return (
    <main className='simple-voter-shell simple-auditor-shell'>
      {filterPortal}
      {refreshPortal}
      <section className='simple-voter-page simple-auditor-page'>
        {shouldShowAuditorPanel ? (
          <section className='simple-voter-section simple-auditor-panel' data-refresh-status={questionnaireRefreshStatus ?? ""}>
            {!topBarActionsMount ? (
              <div className='simple-voter-header-row'>
                {refreshButton}
              </div>
            ) : null}
            {questionnaires.length > 0 ? (
              filtersInMenu ? null : filterControls
            ) : shouldShowNoQuestionnaires ? (
              <p className='simple-voter-empty'>No public questionnaire rounds discovered yet.</p>
            ) : null}
            {shouldShowResponseRefreshStatus ? (
              <p className='simple-voter-note'>{responseRefreshStatus}</p>
            ) : null}
          </section>
        ) : null}

        <QuestionnaireResultsDashboard
          questionnaire={selectedQuestionnaire ? {
            questionnaireId: selectedQuestionnaire.questionnaireId,
            title: selectedQuestionnaire.title,
            description: selectedQuestionnaire.description,
            createdAt: selectedQuestionnaire.createdAt,
            openAt: selectedQuestionnaire.openAt,
            closeAt: selectedQuestionnaire.closeAt,
            closedAt: selectedLiveStateEvent?.createdAt ?? null,
            resultPublishedAt: selectedQuestionnaire.resultPublishedAt,
            state: selectedLiveState ?? selectedQuestionnaire.state,
            resultPack: selectedResultSummary?.resultPack ?? null,
            questions: selectedQuestionnaire.questions,
          } : null}
          questionSummaries={displayedQuestionSummaries}
          responseDetails={displayResponseDetails}
          provisionalResponseDetails={selectedProvisionalResponseDetails}
          displayValidCount={displayValidCount}
          displayInvalidCount={displayInvalidCount}
          loadedValidCount={liveAcceptedCount}
          loadedInvalidCount={liveRejectedCount}
          publishedTotalsAvailable={selectedResultSummaryMatchesLoadedResponses}
          showSubmittedVotes={Boolean(selectedQuestionnaire)}
          coordinatorLabel={selectedWorkerDelegationStatus?.state === "active" && selectedWorkerDelegationStatus.workerNpub ? "Proxy" : "Organiser"}
          coordinatorText={selectedWorkerDelegationStatus?.state === "active" && selectedWorkerDelegationStatus.workerNpub
            ? normalizeToNpub(selectedWorkerDelegationStatus.workerNpub)
            : selectedQuestionnaire?.coordinatorNpub || "Unknown"}
          publishedAtLabel='Published'
          publishedAtTime={Number(publishedAtTime)}
          canExportResults={canExportResults}
          onExportResults={exportResults}
          responseDecryptControls={(
            <div className='simple-auditor-decrypt-control'>
              <UiTextField
                label='Decrypt answer details'
                inputProps={{
                  id: 'simple-auditor-decrypt-nsec',
                  type: 'password',
                  value: observerDecryptNsec,
                  onChange: (event) => setObserverDecryptNsec(event.target.value),
                  placeholder: 'Organiser nsec...',
                  autoComplete: 'off',
                  spellCheck: false,
                }}
              />
              {decryptedResponseResult.statusText ? (
                <p className='simple-voter-note'>{decryptedResponseResult.statusText}</p>
              ) : null}
            </div>
          )}
          fallbackQuestionSummaryNote={null}
          emptyQuestionSummaryText={
            selectedResultSummary
              ? "Published result summary contains no per-question aggregates, and no live answer payloads are available yet."
              : selectedQuestionnaire && !initialSelectedLoadDoneRef.current && refreshInFlight
                ? "Loading questionnaire results from Nostr relays..."
                : "No published result summary or live verified submissions yet for this questionnaire."
          }
          emptySelectionText={
            initialQuestionnaireListLoading
              ? "Loading questionnaires from Nostr relays..."
              : "Choose a questionnaire round to inspect results."
          }
          emptyResponsesText={
            selectedQuestionnaire && !initialSelectedLoadDoneRef.current && refreshInFlight
              ? "Loading submitted responses from Nostr relays..."
              : "No submitted responses found for this round yet."
          }
          emptyResponseSelectionText='Choose a questionnaire round to inspect responses.'
        />
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
      || JSON.stringify(a.responseSearchValues ?? []) !== JSON.stringify(b.responseSearchValues ?? [])
      || JSON.stringify(a.questionnaireRelays ?? []) !== JSON.stringify(b.questionnaireRelays ?? [])
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

    if (question.type === "rank") {
      const optionScores = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
      const rankCounts: Record<string, Record<string, number>> = Object.fromEntries(
        question.options.map((option) => [option.optionId, {}]),
      );
      let blankResponseCount = 0;
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        const rankedOptionIds = answer?.answerType === "rank"
          ? normaliseRankedOptionIds(question, answer.rankedOptionIds)
          : [];
        if (rankedOptionIds.length === 0) {
          blankResponseCount += 1;
        }
        const responseScores = calculateRankQuestionScores(question, rankedOptionIds);
        for (const [optionId, score] of Object.entries(responseScores)) {
          optionScores[optionId] = (optionScores[optionId] ?? 0) + score;
          const scoreKey = String(score);
          rankCounts[optionId][scoreKey] = (rankCounts[optionId][scoreKey] ?? 0) + 1;
        }
      }
      return {
        questionId: question.questionId,
        answerType: "rank",
        optionScores,
        rankCounts,
        responseCount: acceptedResponses.length,
        blankResponseCount,
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
  left: QuestionnaireResultsDashboardResponseDetail[],
  right: QuestionnaireResultsDashboardResponseDetail[],
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

export function matchesAuditorQuestionnaireSearch(
  questionnaire: {
    questionnaireId: string;
    title: string;
    description: string;
    coordinatorNpub: string;
    eventId: string;
    responseSearchValues?: string[];
  },
  searchQuery: string,
) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [
    questionnaire.questionnaireId,
    questionnaire.title,
    questionnaire.description,
    questionnaire.coordinatorNpub,
    questionnaire.eventId,
    ...(questionnaire.responseSearchValues ?? []),
  ].some((value) => value.toLowerCase().includes(query));
}

function buildAuditorResponseDetailSearchValues(details: AuditorQuestionnaireResponseDetail[]) {
  return collectAuditorSubmissionSearchValues(details.map((detail) => ({
    responseId: detail.response.responseId,
    authorPubkey: detail.response.authorPubkey,
    tokenNullifier: detail.response.tokenNullifier,
    rejectionReason: detail.rejectionReason,
  })));
}

export function collectAuditorSubmissionSearchValues(entries: Array<{
  responseId?: string | null;
  authorPubkey?: string | null;
  tokenNullifier?: string | null;
  rejectionReason?: string | null;
}>) {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    if (trimmed) {
      values.add(trimmed);
    }
  };
  for (const entry of entries) {
    add(entry.responseId);
    add(entry.tokenNullifier);
    add(entry.rejectionReason);
    const authorPubkey = entry.authorPubkey?.trim() ?? "";
    if (authorPubkey) {
      const normalizedAuthor = normalizeToNpub(authorPubkey);
      add(authorPubkey);
      add(normalizedAuthor);
      add(deriveActorDisplayId(normalizedAuthor || authorPubkey));
    }
  }
  return [...values];
}

function definitionMatchesCoordinator(
  entry: { event: NostrEvent; definition: QuestionnaireDefinition },
  coordinatorNpub: string,
) {
  const expected = normalizeToNpub(coordinatorNpub);
  return Boolean(expected)
    && normalizeToNpub(entry.event.pubkey) === expected
    && normalizeToNpub(entry.definition.coordinatorPubkey) === expected;
}

function dedupeDefinitionEntries<T extends { event: NostrEvent }>(entries: T[]) {
  const byEventId = new Map<string, T>();
  for (const entry of entries) {
    byEventId.set(entry.event.id, entry);
  }
  return [...byEventId.values()];
}

function selectAuditorDefinition(input: {
  questionnaireId: string;
  definitions: Array<{ event: NostrEvent; definition: QuestionnaireDefinition }>;
  responseEvents: NostrEvent[];
  coordinatorNpub: string;
  definitionEventId: string;
}) {
  const candidates = input.definitions.filter((entry) => entry.definition.questionnaireId === input.questionnaireId);
  const explicitlySelected = candidates.find((entry) => entry.event.id === input.definitionEventId);
  if (explicitlySelected) {
    return explicitlySelected;
  }
  const referenceCounts = new Map<string, number>();
  for (const event of input.responseEvents) {
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) {
        referenceCounts.set(tag[1], (referenceCounts.get(tag[1]) ?? 0) + 1);
      }
    }
  }
  const referenced = candidates.filter((entry) => referenceCounts.has(entry.event.id));
  if (referenced.length > 0) {
    return referenced.sort((left, right) => (
      (referenceCounts.get(right.event.id) ?? 0) - (referenceCounts.get(left.event.id) ?? 0)
      || Number(right.event.created_at ?? right.definition.createdAt ?? 0) - Number(left.event.created_at ?? left.definition.createdAt ?? 0)
      || left.event.id.localeCompare(right.event.id)
    ))[0];
  }
  if (input.coordinatorNpub) {
    const coordinatorDefinitions = candidates.filter((entry) => definitionMatchesCoordinator(entry, input.coordinatorNpub));
    if (coordinatorDefinitions.length > 0) {
      return coordinatorDefinitions.sort((left, right) => (
        Number(right.event.created_at ?? right.definition.createdAt ?? 0) - Number(left.event.created_at ?? left.definition.createdAt ?? 0)
        || left.event.id.localeCompare(right.event.id)
      ))[0];
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
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
    if (existing.accepted !== detail.accepted) {
      byKey.set(key, existing.accepted ? existing : mergeAcceptedAuditorResponseDetail(existing, detail));
      continue;
    }
    // Prefer real Nostr events over synthetic fallback ids and keep the latest timestamp.
    const existingSynthetic = isSyntheticAuditorEventId(existing.event.id);
    const nextSynthetic = isSyntheticAuditorEventId(detail.event.id);
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

function dedupeAuditorProvisionalResponseDetails(details: QuestionnaireResultsDashboardResponseDetail[]) {
  const byKey = new Map<string, QuestionnaireResultsDashboardResponseDetail>();
  for (const detail of details) {
    const questionIds = [...new Set((detail.response.answers ?? []).map((answer) => answer.questionId).filter(Boolean))]
      .sort()
      .join(",");
    const key = `${detail.response.authorPubkey}:${questionIds || detail.response.responseId}`;
    const existing = byKey.get(key);
    if (!existing || Number(detail.event.created_at ?? detail.response.submittedAt ?? 0) >= Number(existing.event.created_at ?? existing.response.submittedAt ?? 0)) {
      byKey.set(key, detail);
    }
  }
  return [...byKey.values()].sort((left, right) => Number(right.event.created_at ?? 0) - Number(left.event.created_at ?? 0));
}

function isSyntheticAuditorEventId(eventId: string) {
  return eventId.startsWith("optiona:")
    || eventId.startsWith("summary:")
    || eventId.startsWith("result-pack:");
}

function mergeAcceptedAuditorResponseDetail(
  rejected: AuditorQuestionnaireResponseDetail,
  accepted: AuditorQuestionnaireResponseDetail,
) {
  const rejectedAnswerCount = Array.isArray(rejected.response.answers) ? rejected.response.answers.length : 0;
  const acceptedAnswerCount = Array.isArray(accepted.response.answers) ? accepted.response.answers.length : 0;
  const response = rejectedAnswerCount > acceptedAnswerCount
    ? {
        ...rejected.response,
        answers: rejected.response.answers,
      }
    : accepted.response;
  return {
    ...rejected,
    accepted: true,
    rejectionReason: null,
    includedInLatestPublish: rejected.includedInLatestPublish || accepted.includedInLatestPublish,
    decidedAt: accepted.decidedAt ?? rejected.decidedAt,
    decisionEventId: accepted.decisionEventId ?? rejected.decisionEventId,
    response,
  };
}

function optionASummaryRefToAuditorDetail(input: {
  questionnaireId: string;
  ref: QuestionnairePublishedResponseRef;
  latestPublishAt: number | null;
  source?: "summary" | "result-pack";
}): AuditorQuestionnaireResponseDetail {
  const responseId = input.ref.responseId.trim();
  const submittedAt = Number.isFinite(input.ref.submittedAt)
    ? Number(input.ref.submittedAt)
    : Math.floor(Date.now() / 1000);
  const event = {
    id: `${input.source ?? "summary"}:${input.questionnaireId}:${responseId}`,
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
      tokenNullifier: input.ref.tokenNullifier ?? `summary_missing_${responseId}`,
      tokenNullifiers: input.ref.tokenNullifiers,
      tokenProof: input.ref.tokenProof ?? {
        tokenCommitment: `summary_missing_${responseId}`,
        questionnaireId: input.questionnaireId,
        signature: "summary_reference",
      },
      tokenProofs: input.ref.tokenProofs,
      answers: input.ref.answers ?? [],
    },
    accepted: input.ref.accepted,
    rejectionReason: input.ref.accepted
      ? null
      : input.ref.rejectionReason === "duplicate_response"
        || input.ref.rejectionReason === "invalid_token_proof"
        || input.ref.rejectionReason === "invalid_payload_shape"
        || input.ref.rejectionReason === "questionnaire_closed"
        ? input.ref.rejectionReason
        : "duplicate_nullifier",
    includedInLatestPublish: input.latestPublishAt !== null ? submittedAt <= input.latestPublishAt : true,
  };
}

function decryptAuditorResponseDetails(input: {
  responseDetails: AuditorQuestionnaireResponseDetail[];
  coordinatorNsec: string;
}) {
  const nsec = input.coordinatorNsec.trim();
  const encryptedRows = input.responseDetails.filter(auditorResponseHasEncryptedAnswers);
  if (encryptedRows.length === 0) {
    return {
      responseDetails: input.responseDetails,
      statusText: "",
    };
  }
  if (!nsec) {
    return {
      responseDetails: input.responseDetails,
      statusText: "",
    };
  }

  let failedCount = 0;
  const responseDetails = input.responseDetails.map((entry) => {
    if (!auditorResponseHasEncryptedAnswers(entry)) {
      return entry;
    }
    try {
      const eventPubkey = (entry.event as Partial<NostrEvent>).pubkey || entry.response.authorPubkey;
      const decrypted = decryptQuestionnaireBlindResponseAnswers({
        coordinatorNsec: nsec,
        eventPubkey,
        response: entry.response,
      });
      const decryptedAnswerQuestionIds = deriveDecryptedAnswerQuestionIds({
        encryptedPayloadDecrypted: decrypted.encryptedPayloadDecrypted,
        decryptedAnswers: decrypted.answers,
        originalAnswers: entry.response.answers,
      });
      return {
        ...entry,
        decryptedAnswerQuestionIds,
        response: {
          ...entry.response,
          answers: decrypted.answers,
        },
      };
    } catch {
      failedCount += 1;
      return entry;
    }
  });

  const statusText = failedCount > 0
    ? `${failedCount} encrypted response${failedCount === 1 ? "" : "s"} could not be decrypted. Check that the nsec matches the questionnaire organiser.`
    : "";

  return {
    responseDetails,
    statusText,
  };
}

function deriveDecryptedAnswerQuestionIds(input: {
  encryptedPayloadDecrypted: boolean;
  decryptedAnswers: QuestionnaireResponseAnswer[];
  originalAnswers: QuestionnaireResponseAnswer[] | undefined;
}) {
  const questionIds = new Set<string>();
  if (input.encryptedPayloadDecrypted) {
    for (const answer of input.decryptedAnswers) {
      questionIds.add(answer.questionId);
    }
  }
  for (const answer of input.originalAnswers ?? []) {
    if (
      answer.answerType === "free_text"
      && answer.text.trim().startsWith("enc:nip44v2:")
    ) {
      questionIds.add(answer.questionId);
    }
  }
  return [...questionIds];
}

function auditorResponseHasEncryptedAnswers(entry: AuditorQuestionnaireResponseDetail) {
  return Boolean(entry.response.encryptedPayload)
    || (entry.response.answers ?? []).some((answer) => (
      answer.answerType === "free_text"
      && answer.text.trim().startsWith("enc:nip44v2:")
    ));
}
