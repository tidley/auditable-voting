import { useCallback, useEffect, useMemo, useState } from "react";
import { generateSecretKey, nip19 } from "nostr-tools";
import { fetchQuestionnaireEvents, fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireResponseEnvelope, parseQuestionnaireStateEvent, publishEncryptedQuestionnaireResponse, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND, subscribeQuestionnaireEvents } from "./questionnaireNostr";
import { formatQuestionnaireStateLabel, formatQuestionnaireTokenStatusLabel, parseQuestionnaireResultSummaryEvent, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { buildSimpleNamespacedLocalStorageKey, loadSimpleActorState } from "./simpleLocalState";
import { validateQuestionnaireResponsePayload, type QuestionnaireDefinition, type QuestionnaireResponseAnswer, type QuestionnaireResponsePayload, type QuestionnaireResultSummary } from "./questionnaireProtocol";
import { getSharedNostrPool } from "./sharedNostrPool";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import { resolveQuestionnaireResponderNpub } from "./questionnaireResponderIdentity";
import QuestionnaireOptionAVoterPanel from "./QuestionnaireOptionAVoterPanel";

const RESTORED_QUESTIONNAIRE_IDS_STORAGE_KEY = "voter.restored-questionnaire-ids.v1";
const PARTICIPATION_HISTORY_STORAGE_KEY = "voter.questionnaire-participation-history.v1";
const SUBMITTED_QUESTIONNAIRE_IDS_STORAGE_KEY = "voter.submitted-questionnaire-ids.v1";
const RESPONSE_IDENTITY_STORAGE_KEY = "voter.questionnaire-response-identities.v1";
const VOTER_QUESTIONNAIRE_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const MAX_PARTICIPATION_HISTORY_ENTRIES = 16;
const QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_MAX = 1;
const QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_BASE_DELAY_MS = 1500;

type QuestionnaireAnswerState = Record<string, boolean | string | string[]>;
type SelectorLifecycle = "open" | "published" | "draft" | "closed" | "counted" | "unknown";
type QuestionnaireSelectorEntry = {
  questionnaireId: string;
  title: string;
  description: string;
  lifecycle: SelectorLifecycle;
  coordinatorPubkey: string;
  openAt: number | null;
  closeAt: number | null;
  createdAt: number;
  discoveredAt: number;
  restored: boolean;
};

type QuestionnaireSelectorDiagnostics = {
  scannedDefinitionEvents: number;
  parsedDefinitionEvents: number;
  scannedStateEvents: number;
  parsedStateEvents: number;
  includedQuestionnaireIds: string[];
  rejectCounts: Record<string, number>;
  lastRejectedQuestionnaireId: string | null;
  lastRejectReason: string | null;
  lastFilterUsed: {
    lookbackSeconds: number;
    minFreshUnix: number;
    coordinatorContextNpubs: string[];
    restoredQuestionnaireIds: string[];
  } | null;
};

type QuestionnaireResponsePipelineDiagnostics = {
  responseReady: boolean;
  submitHandlerEntered: boolean;
  submitClicked: boolean;
  responsePayloadBuilt: boolean;
  responsePayloadValidated: boolean;
  responsePublishStarted: boolean;
  responsePublishSucceeded: boolean;
  responseSeenBackLocally: boolean;
  responseSeenByCoordinator: boolean;
  lastResponseRejectReason: string | null;
  lastResponsePublishError: string | null;
  lastResponseEventId: string | null;
  lastResponseEventKind: number | null;
  lastResponseEventCreatedAt: number | null;
  lastResponseEventTags: string[][];
  lastResponseRelayTargets: string[];
  lastResponseRelaySuccessCount: number;
};

type QuestionnaireReadSource = "manual" | "backfill" | "live";

type QuestionnaireParticipationHistoryEntry = {
  questionnaireId: string;
  title: string;
  coordinatorPubkey: string;
  submissionCount: number;
  lastSubmittedAt: number;
};

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function readRestoredQuestionnaireIds(storageKey: string) {
  if (typeof window === "undefined") {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as string[];
    if (!Array.isArray(parsed)) {
      return [] as string[];
    }
    return [...new Set(parsed.filter((value) => typeof value === "string" && value.trim().length > 0))].slice(0, 8);
  } catch {
    return [] as string[];
  }
}

function readParticipationHistory(storageKey: string) {
  if (typeof window === "undefined") {
    return [] as QuestionnaireParticipationHistoryEntry[];
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is QuestionnaireParticipationHistoryEntry => (
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as { questionnaireId?: unknown }).questionnaireId === "string"
        && typeof (entry as { title?: unknown }).title === "string"
        && typeof (entry as { coordinatorPubkey?: unknown }).coordinatorPubkey === "string"
        && typeof (entry as { submissionCount?: unknown }).submissionCount === "number"
        && Number.isFinite((entry as { lastSubmittedAt?: unknown }).lastSubmittedAt)
      ))
      .sort((left, right) => right.lastSubmittedAt - left.lastSubmittedAt)
      .slice(0, MAX_PARTICIPATION_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

function readStringList(storageKey: string, limit = 16) {
  if (typeof window === "undefined") {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
      .slice(-limit);
  } catch {
    return [];
  }
}

function readResponseIdentityMap(storageKey: string) {
  if (typeof window === "undefined") {
    return {} as Record<string, string>;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && typeof value === "string" && key.trim() && value.trim()) {
        next[key] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function mergeParticipationHistory(
  existing: QuestionnaireParticipationHistoryEntry[],
  incoming: QuestionnaireParticipationHistoryEntry[],
) {
  const merged = new Map<string, QuestionnaireParticipationHistoryEntry>();
  for (const item of [...existing, ...incoming]) {
    const previous = merged.get(item.questionnaireId);
    if (!previous || item.lastSubmittedAt >= previous.lastSubmittedAt) {
      merged.set(item.questionnaireId, item);
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.lastSubmittedAt - left.lastSubmittedAt)
    .slice(0, MAX_PARTICIPATION_HISTORY_ENTRIES);
}

function selectorLifecycleFromState(state: string | null | undefined): SelectorLifecycle {
  if (state === "open") {
    return "open";
  }
  if (state === "published") {
    return "published";
  }
  if (state === "draft" || state === "saved") {
    return "draft";
  }
  if (state === "results_published" || state === "counted") {
    return "counted";
  }
  if (state === "closed" || state === "ended" || state === "archived") {
    return "closed";
  }
  return "unknown";
}

function isActiveSelectorLifecycle(lifecycle: SelectorLifecycle) {
  return lifecycle === "open" || lifecycle === "published";
}

function selectorStateBadge(lifecycle: SelectorLifecycle) {
  if (lifecycle === "open") {
    return "Open";
  }
  if (lifecycle === "published") {
    return "Published";
  }
  if (lifecycle === "draft") {
    return "Draft";
  }
  if (lifecycle === "closed") {
    return "Closed";
  }
  if (lifecycle === "counted") {
    return "Counted";
  }
  return "Unknown";
}

function lifecycleFromExplicitState(state: string | null | undefined): SelectorLifecycle {
  if (!state) {
    return "draft";
  }
  return selectorLifecycleFromState(state);
}

function isDefinitionMarkedStale(definition: QuestionnaireDefinition) {
  const asRecord = definition as QuestionnaireDefinition & {
    stale?: boolean;
    superseded?: boolean;
    archived?: boolean;
    deleted?: boolean;
    invalid?: boolean;
    testOnly?: boolean;
  };
  return Boolean(
    asRecord.stale
      || asRecord.superseded
      || asRecord.archived
      || asRecord.deleted
      || asRecord.invalid
      || asRecord.testOnly,
  );
}

function isCoordinatorRelevant(entry: QuestionnaireSelectorEntry, coordinatorContextNpubs: string[]) {
  if (coordinatorContextNpubs.length === 0) {
    return true;
  }
  return coordinatorContextNpubs.includes(entry.coordinatorPubkey);
}

function buildRestoredStorageKey(actorId: string, coordinatorContextNpubs: string[]) {
  const coordinatorScope = coordinatorContextNpubs.length > 0
    ? [...new Set(coordinatorContextNpubs.map((value) => deriveActorDisplayId(value)))].sort().join(".")
    : "none";
  return buildSimpleNamespacedLocalStorageKey(
    `voter:${actorId}:coordinator:${coordinatorScope}:${RESTORED_QUESTIONNAIRE_IDS_STORAGE_KEY}`,
  );
}

function buildParticipationHistoryStorageKey(actorId: string) {
  return buildSimpleNamespacedLocalStorageKey(
    `voter:${actorId}:${PARTICIPATION_HISTORY_STORAGE_KEY}`,
  );
}

function buildSubmittedQuestionnairesStorageKey(actorId: string) {
  return buildSimpleNamespacedLocalStorageKey(
    `voter:${actorId}:${SUBMITTED_QUESTIONNAIRE_IDS_STORAGE_KEY}`,
  );
}

function buildResponseIdentityStorageKey(actorId: string) {
  return buildSimpleNamespacedLocalStorageKey(
    `voter:${actorId}:${RESPONSE_IDENTITY_STORAGE_KEY}`,
  );
}

function selectorComparator(left: QuestionnaireSelectorEntry, right: QuestionnaireSelectorEntry) {
  const statePriority = (entry: QuestionnaireSelectorEntry) => (entry.lifecycle === "open" ? 0 : entry.lifecycle === "published" ? 1 : 2);
  if (statePriority(left) !== statePriority(right)) {
    return statePriority(left) - statePriority(right);
  }
  const leftOpenAt = left.openAt ?? 0;
  const rightOpenAt = right.openAt ?? 0;
  if (leftOpenAt !== rightOpenAt) {
    return rightOpenAt - leftOpenAt;
  }
  const leftFreshness = Math.max(left.createdAt, left.discoveredAt);
  const rightFreshness = Math.max(right.createdAt, right.discoveredAt);
  if (leftFreshness !== rightFreshness) {
    return rightFreshness - leftFreshness;
  }
  return left.questionnaireId.localeCompare(right.questionnaireId);
}

function choosePreferredEntry(
  current: QuestionnaireSelectorEntry | undefined,
  candidate: QuestionnaireSelectorEntry,
  coordinatorContextNpubs: string[],
) {
  if (!current) {
    return candidate;
  }
  const currentRelevant = isCoordinatorRelevant(current, coordinatorContextNpubs);
  const candidateRelevant = isCoordinatorRelevant(candidate, coordinatorContextNpubs);
  if (candidateRelevant !== currentRelevant) {
    return candidateRelevant ? candidate : current;
  }
  const currentActive = isActiveSelectorLifecycle(current.lifecycle);
  const candidateActive = isActiveSelectorLifecycle(candidate.lifecycle);
  if (candidateActive !== currentActive) {
    return candidateActive ? candidate : current;
  }
  return candidate.discoveredAt >= current.discoveredAt ? candidate : current;
}

function buildResponseAnswers(definition: QuestionnaireDefinition, answerState: QuestionnaireAnswerState): QuestionnaireResponseAnswer[] {
  const answers: QuestionnaireResponseAnswer[] = [];

  for (const question of definition.questions) {
    const value = answerState[question.questionId];

    if (question.type === "yes_no") {
      if (typeof value === "boolean") {
        answers.push({
          questionId: question.questionId,
          answerType: "yes_no",
          value,
        });
      }
      continue;
    }

    if (question.type === "multiple_choice") {
      const selectedOptionIds = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      if (selectedOptionIds.length > 0) {
        answers.push({
          questionId: question.questionId,
          answerType: "multiple_choice",
          selectedOptionIds,
        });
      }
      continue;
    }

    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 0) {
      answers.push({
        questionId: question.questionId,
        answerType: "free_text",
        text,
      });
    }
  }

  return answers;
}

function parseLatestResultSummary(events: Awaited<ReturnType<typeof fetchQuestionnaireEvents>>): QuestionnaireResultSummary | null {
  const sorted = [...events].sort((left, right) => right.created_at - left.created_at);
  for (const event of sorted) {
    const parsed = parseQuestionnaireResultSummaryEvent(event);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

type QuestionnaireVoterPanelProps = {
  onContextChange?: (context: { hasDefinition: boolean; state: string | null }) => void;
  participationHistory?: QuestionnaireParticipationHistoryEntry[];
  onParticipationHistoryChange?: (entries: QuestionnaireParticipationHistoryEntry[]) => void;
  announcedQuestionnaireIds?: string[];
  optionAAnnouncedQuestionnaireIds?: string[];
  localVoterNpub?: string;
  localVoterNsec?: string;
  autoSignerLogin?: boolean;
};

export default function QuestionnaireVoterPanel(props: QuestionnaireVoterPanelProps) {
  const globalFlags = globalThis as typeof globalThis & { __AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__?: boolean };
  const optionAMode = !globalFlags.__AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__;

  useEffect(() => {
    if (!optionAMode) {
      return;
    }
    props.onContextChange?.({ hasDefinition: true, state: "open" });
    return () => {
      props.onContextChange?.({ hasDefinition: false, state: null });
    };
  }, [optionAMode, props.onContextChange]);

  if (optionAMode) {
    return (
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={props.optionAAnnouncedQuestionnaireIds}
        localVoterNpub={props.localVoterNpub}
        localVoterNsec={props.localVoterNsec}
        autoSignerLogin={props.autoSignerLogin}
      />
    );
  }
  const onContextChange = props.onContextChange;
  const onParticipationHistoryChange = props.onParticipationHistoryChange;
  const incomingParticipationHistory = props.participationHistory;
  const announcedQuestionnaireIds = props.announcedQuestionnaireIds;
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [selectorEntries, setSelectorEntries] = useState<QuestionnaireSelectorEntry[]>([]);
  const [coordinatorContextNpubs, setCoordinatorContextNpubs] = useState<string[]>([]);
  const [restoredQuestionnaireIds, setRestoredQuestionnaireIds] = useState<string[]>([]);
  const [participationHistory, setParticipationHistory] = useState<QuestionnaireParticipationHistoryEntry[]>([]);
  const [voterNpub, setVoterNpub] = useState("");
  const [submittedQuestionnaireIds, setSubmittedQuestionnaireIds] = useState<string[]>([]);
  const [responseIdentityByQuestionnaireId, setResponseIdentityByQuestionnaireId] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [definition, setDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<QuestionnaireResultSummary | null>(null);
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const [responseSubmittedCount, setResponseSubmittedCount] = useState(0);
  const [tokenStatus, setTokenStatus] = useState<"ready" | "submitted">("ready");
  const [definitionEventCount, setDefinitionEventCount] = useState(0);
  const [stateEventCount, setStateEventCount] = useState(0);
  const [responseEventCount, setResponseEventCount] = useState(0);
  const [resultEventCount, setResultEventCount] = useState(0);
  const [definitionBackfillFilter, setDefinitionBackfillFilter] = useState<Record<string, unknown> | null>(null);
  const [stateBackfillFilter, setStateBackfillFilter] = useState<Record<string, unknown> | null>(null);
  const [resultBackfillFilter, setResultBackfillFilter] = useState<Record<string, unknown> | null>(null);
  const [definitionReadMode, setDefinitionReadMode] = useState<"filtered" | "kind_only_fallback">("filtered");
  const [stateReadMode, setStateReadMode] = useState<"filtered" | "kind_only_fallback">("filtered");
  const [resultReadMode, setResultReadMode] = useState<"filtered" | "kind_only_fallback">("filtered");
  const [definitionKindOnlyCount, setDefinitionKindOnlyCount] = useState(0);
  const [stateKindOnlyCount, setStateKindOnlyCount] = useState(0);
  const [resultKindOnlyCount, setResultKindOnlyCount] = useState(0);
  const [selectorDiagnostics, setSelectorDiagnostics] = useState<QuestionnaireSelectorDiagnostics>({
    scannedDefinitionEvents: 0,
    parsedDefinitionEvents: 0,
    scannedStateEvents: 0,
    parsedStateEvents: 0,
    includedQuestionnaireIds: [],
    rejectCounts: {},
    lastRejectedQuestionnaireId: null,
    lastRejectReason: null,
    lastFilterUsed: null,
  });
  const [questionnaireDefinitionsSeen, setQuestionnaireDefinitionsSeen] = useState(0);
  const [questionnaireOpenEventsSeen, setQuestionnaireOpenEventsSeen] = useState(0);
  const [definitionSeenLiveCount, setDefinitionSeenLiveCount] = useState(0);
  const [definitionSeenBackfillCount, setDefinitionSeenBackfillCount] = useState(0);
  const [openSeenLiveCount, setOpenSeenLiveCount] = useState(0);
  const [openSeenBackfillCount, setOpenSeenBackfillCount] = useState(0);
  const [lastQuestionnaireDefinitionId, setLastQuestionnaireDefinitionId] = useState<string | null>(null);
  const [lastQuestionnaireOpenId, setLastQuestionnaireOpenId] = useState<string | null>(null);
  const [lastQuestionnaireFilterUsed, setLastQuestionnaireFilterUsed] = useState<Record<string, unknown> | null>(null);
  const [lastQuestionnaireRejectReason, setLastQuestionnaireRejectReason] = useState<string | null>(null);
  const [discoverySubscriptionStartedAt, setDiscoverySubscriptionStartedAt] = useState<string | null>(null);
  const [firstDefinitionSeenAt, setFirstDefinitionSeenAt] = useState<string | null>(null);
  const [firstOpenSeenAt, setFirstOpenSeenAt] = useState<string | null>(null);
  const [discoveryBackfillStartedAt, setDiscoveryBackfillStartedAt] = useState<string | null>(null);
  const [discoveryBackfillCompletedAt, setDiscoveryBackfillCompletedAt] = useState<string | null>(null);
  const [discoveryBackfillAttemptCount, setDiscoveryBackfillAttemptCount] = useState(0);
  const [responsePipelineDiagnostics, setResponsePipelineDiagnostics] = useState<QuestionnaireResponsePipelineDiagnostics>({
    responseReady: false,
    submitHandlerEntered: false,
    submitClicked: false,
    responsePayloadBuilt: false,
    responsePayloadValidated: false,
    responsePublishStarted: false,
    responsePublishSucceeded: false,
    responseSeenBackLocally: false,
    responseSeenByCoordinator: false,
    lastResponseRejectReason: null,
    lastResponsePublishError: null,
    lastResponseEventId: null,
    lastResponseEventKind: null,
    lastResponseEventCreatedAt: null,
    lastResponseEventTags: [],
    lastResponseRelayTargets: [],
    lastResponseRelaySuccessCount: 0,
  });
  const actorId = useMemo(() => deriveActorDisplayId(voterNpub || "unknown"), [voterNpub]);
  const responderMarkerNpub = useMemo(
    () => resolveQuestionnaireResponderNpub({
      questionnaireId,
      responseIdentityByQuestionnaireId,
      fallbackVoterNpub: voterNpub,
    }),
    [questionnaireId, responseIdentityByQuestionnaireId, voterNpub],
  );
  const responderMarkerId = useMemo(
    () => deriveActorDisplayId(responderMarkerNpub || "unknown"),
    [responderMarkerNpub],
  );
  const restoredStorageKey = useMemo(
    () => buildRestoredStorageKey(actorId, coordinatorContextNpubs),
    [actorId, coordinatorContextNpubs],
  );
  const participationHistoryStorageKey = useMemo(
    () => buildParticipationHistoryStorageKey(actorId),
    [actorId],
  );
  const submittedQuestionnairesStorageKey = useMemo(
    () => buildSubmittedQuestionnairesStorageKey(actorId),
    [actorId],
  );
  const responseIdentityStorageKey = useMemo(
    () => buildResponseIdentityStorageKey(actorId),
    [actorId],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const fromQuery = new URLSearchParams(window.location.search).get("questionnaire")?.trim();
    if (fromQuery) {
      setQuestionnaireId(fromQuery);
      setRestoredQuestionnaireIds((current) => (
        current.includes(fromQuery) ? current : [...current, fromQuery]
      ));
    }
  }, []);

  useEffect(() => {
    void loadSimpleActorState("voter").then((stored) => {
      setVoterNpub(stored?.keypair?.npub ?? "");
      const cached = (stored?.cache ?? null) as { manualCoordinators?: unknown } | null;
      const manualCoordinators = Array.isArray(cached?.manualCoordinators)
        ? cached.manualCoordinators.filter((value): value is string => typeof value === "string" && value.trim().startsWith("npub"))
        : [];
      setCoordinatorContextNpubs([...new Set(manualCoordinators.map((value) => value.trim()))].sort());
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setRestoredQuestionnaireIds(readRestoredQuestionnaireIds(restoredStorageKey));
  }, [restoredStorageKey]);

  useEffect(() => {
    setParticipationHistory(readParticipationHistory(participationHistoryStorageKey));
  }, [participationHistoryStorageKey]);

  useEffect(() => {
    setSubmittedQuestionnaireIds(readStringList(submittedQuestionnairesStorageKey, 32));
  }, [submittedQuestionnairesStorageKey]);

  useEffect(() => {
    setResponseIdentityByQuestionnaireId(readResponseIdentityMap(responseIdentityStorageKey));
  }, [responseIdentityStorageKey]);

  useEffect(() => {
    const incoming = Array.isArray(incomingParticipationHistory)
      ? incomingParticipationHistory
      : [];
    if (incoming.length === 0) {
      return;
    }
    setParticipationHistory((current) => mergeParticipationHistory(current, incoming));
  }, [incomingParticipationHistory]);

  useEffect(() => {
    const announcedIds = Array.isArray(announcedQuestionnaireIds)
      ? announcedQuestionnaireIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
      : [];
    if (announcedIds.length === 0) {
      return;
    }
    const currentId = questionnaireId.trim();
    if (!currentId) {
      setQuestionnaireId(announcedIds[0]);
    }
    setRestoredQuestionnaireIds((current) => (
      [...new Set([...current, ...announcedIds])].slice(-8)
    ));
  }, [announcedQuestionnaireIds, questionnaireId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(restoredStorageKey, JSON.stringify(restoredQuestionnaireIds.slice(0, 8)));
  }, [restoredQuestionnaireIds, restoredStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      participationHistoryStorageKey,
      JSON.stringify(participationHistory.slice(0, MAX_PARTICIPATION_HISTORY_ENTRIES)),
    );
    onParticipationHistoryChange?.(participationHistory);
  }, [onParticipationHistoryChange, participationHistory, participationHistoryStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      submittedQuestionnairesStorageKey,
      JSON.stringify(submittedQuestionnaireIds.slice(-32)),
    );
  }, [submittedQuestionnaireIds, submittedQuestionnairesStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      responseIdentityStorageKey,
      JSON.stringify(responseIdentityByQuestionnaireId),
    );
  }, [responseIdentityByQuestionnaireId, responseIdentityStorageKey]);

  useEffect(() => {
    let cancelled = false;
    const loadQuestionnaireOptions = async () => {
      try {
        const relays = getQuestionnaireReadRelays();
        const pool = getSharedNostrPool();
        const authorScope = coordinatorContextNpubs.length > 0
          ? [...coordinatorContextNpubs]
          : undefined;
        let events: Awaited<ReturnType<typeof pool.querySync>> = [];
        let stateEvents: Awaited<ReturnType<typeof pool.querySync>> = [];
        for (let attempt = 0; attempt <= QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_MAX; attempt += 1) {
          events = await pool.querySync(relays, {
            kinds: [QUESTIONNAIRE_DEFINITION_KIND],
            ...(authorScope ? { authors: authorScope } : {}),
            limit: 400,
          });
          stateEvents = await pool.querySync(relays, {
            kinds: [QUESTIONNAIRE_STATE_KIND],
            ...(authorScope ? { authors: authorScope } : {}),
            limit: 400,
          });
          const hasAnyEvents = events.length > 0 || stateEvents.length > 0;
          if (hasAnyEvents || attempt >= QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_MAX) {
            break;
          }
          const delayMs = QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_BASE_DELAY_MS * (2 ** attempt);
          await new Promise((resolve) => {
            window.setTimeout(resolve, delayMs);
          });
        }
        if (cancelled) {
          return;
        }

        const rejectCounts: Record<string, number> = {};
        let lastRejectedQuestionnaireId: string | null = null;
        let lastRejectReason: string | null = null;
        let parsedDefinitionEvents = 0;
        const markRejected = (reason: string, questionnaireId: string | null) => {
          rejectCounts[reason] = (rejectCounts[reason] ?? 0) + 1;
          if (questionnaireId) {
            lastRejectedQuestionnaireId = questionnaireId;
          }
          lastRejectReason = reason;
        };

        const latestStateByQuestionnaireId = new Map<string, { state: string; createdAt: number }>();
        let parsedStateEvents = 0;
        for (const stateEvent of stateEvents) {
          const parsed = parseQuestionnaireStateEvent(stateEvent);
          if (!parsed?.questionnaireId) {
            continue;
          }
          parsedStateEvents += 1;
          const previous = latestStateByQuestionnaireId.get(parsed.questionnaireId);
          const createdAt = Number(stateEvent.created_at ?? 0);
          if (!previous || createdAt > previous.createdAt) {
            latestStateByQuestionnaireId.set(parsed.questionnaireId, {
              state: parsed.state,
              createdAt,
            });
          }
        }

        const byQuestionnaireId = new Map<string, QuestionnaireSelectorEntry>();
        const now = nowUnix();
        const minFreshUnix = now - VOTER_QUESTIONNAIRE_LOOKBACK_SECONDS;
        for (const event of events) {
          const parsed = parseQuestionnaireDefinitionEvent(event);
          if (!parsed) {
            markRejected("malformed_definition_event", null);
            continue;
          }
          parsedDefinitionEvents += 1;
          const id = parsed.questionnaireId.trim();
          if (!id) {
            markRejected("missing_questionnaire_id", null);
            continue;
          }
          const explicitState = latestStateByQuestionnaireId.get(id)?.state ?? null;
          const lifecycle = lifecycleFromExplicitState(explicitState);
          const restored = restoredQuestionnaireIds.includes(id);
          const createdAt = Number(parsed.createdAt ?? 0);
          const discoveredAt = Number(event.created_at ?? createdAt);
          const closeAt = Number.isFinite(parsed.closeAt) ? parsed.closeAt : null;
          const isExpired = closeAt !== null && closeAt < now;
          const isRecent = Math.max(createdAt, discoveredAt, parsed.openAt ?? 0) >= minFreshUnix;
          const stale = isDefinitionMarkedStale(parsed);
          const entry: QuestionnaireSelectorEntry = {
            questionnaireId: id,
            title: parsed.title?.trim() ?? "",
            description: parsed.description?.trim() ?? "",
            lifecycle,
            coordinatorPubkey: parsed.coordinatorPubkey,
            openAt: Number.isFinite(parsed.openAt) ? parsed.openAt : null,
            closeAt,
            createdAt,
            discoveredAt,
            restored,
          };
          const relevantByCoordinator = isCoordinatorRelevant(entry, coordinatorContextNpubs);
          const includeByDefault = isActiveSelectorLifecycle(entry.lifecycle)
            && !isExpired
            && !stale
            && isRecent
            && relevantByCoordinator;
          const includeByRestore = restored && !stale && isActiveSelectorLifecycle(entry.lifecycle);
          if (!includeByDefault && !includeByRestore) {
            if (!isActiveSelectorLifecycle(entry.lifecycle)) {
              markRejected(`state_not_visible:${entry.lifecycle}`, id);
            } else if (stale) {
              markRejected("stale_definition", id);
            } else if (!relevantByCoordinator) {
              markRejected("coordinator_scope_mismatch", id);
            } else if (isExpired) {
              markRejected("expired_questionnaire", id);
            } else if (!isRecent) {
              markRejected("outside_active_lookback_window", id);
            } else {
              markRejected("filtered_out", id);
            }
            continue;
          }
          byQuestionnaireId.set(
            id,
            choosePreferredEntry(byQuestionnaireId.get(id), entry, coordinatorContextNpubs),
          );
        }
        const entries = [...byQuestionnaireId.values()].sort(selectorComparator);
        setSelectorEntries(entries);
        setSelectorDiagnostics({
          scannedDefinitionEvents: events.length,
          parsedDefinitionEvents,
          scannedStateEvents: stateEvents.length,
          parsedStateEvents,
          includedQuestionnaireIds: entries.map((entry) => entry.questionnaireId),
          rejectCounts,
          lastRejectedQuestionnaireId,
          lastRejectReason,
          lastFilterUsed: {
            lookbackSeconds: VOTER_QUESTIONNAIRE_LOOKBACK_SECONDS,
            minFreshUnix,
            coordinatorContextNpubs: [...coordinatorContextNpubs],
            restoredQuestionnaireIds: [...restoredQuestionnaireIds],
          },
        });
      } catch {
        setSelectorEntries([]);
        setSelectorDiagnostics({
          scannedDefinitionEvents: 0,
          parsedDefinitionEvents: 0,
          scannedStateEvents: 0,
          parsedStateEvents: 0,
          includedQuestionnaireIds: [],
          rejectCounts: {},
          lastRejectedQuestionnaireId: null,
          lastRejectReason: "selector_load_failed",
          lastFilterUsed: null,
        });
      }
    };
    void loadQuestionnaireOptions();
    return () => {
      cancelled = true;
    };
  }, [coordinatorContextNpubs, restoredQuestionnaireIds]);

  const refresh = useCallback(async (source: QuestionnaireReadSource = "manual") => {
    const id = questionnaireId.trim();
    if (!id) {
      return null;
    }
    try {
      setDefinitionBackfillFilter({
        kinds: [QUESTIONNAIRE_DEFINITION_KIND],
        "#questionnaire-id": [id],
      });
      setStateBackfillFilter({
        kinds: [QUESTIONNAIRE_STATE_KIND],
        "#questionnaire-id": [id],
      });
      setResultBackfillFilter({
        kinds: [QUESTIONNAIRE_RESULT_SUMMARY_KIND],
        "#questionnaire-id": [id],
      });
      const [definitionFetch, stateFetch, responseFetch, resultFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireResponseEnvelope(event)?.questionnaireId ?? null,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
          parseQuestionnaireIdFromEvent: (event) => {
            try {
              const parsed = JSON.parse(event.content) as { questionnaireId?: string };
              return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
            } catch {
              return null;
            }
          },
        }),
      ]);
      const definitionEvents = definitionFetch.events;
      const stateEvents = stateFetch.events;
      const responseEvents = responseFetch.events;
      const resultEvents = resultFetch.events;
      setDefinitionReadMode(definitionFetch.diagnostics.mode);
      setStateReadMode(stateFetch.diagnostics.mode);
      setResultReadMode(resultFetch.diagnostics.mode);
      setDefinitionKindOnlyCount(definitionFetch.diagnostics.kindOnlyCount);
      setStateKindOnlyCount(stateFetch.diagnostics.kindOnlyCount);
      setResultKindOnlyCount(resultFetch.diagnostics.kindOnlyCount);
      setDefinitionEventCount(definitionEvents.length);
      setStateEventCount(stateEvents.length);
      setResponseEventCount(responseEvents.length);
      setResultEventCount(resultEvents.length);
      const parsedDefinitionEvents = definitionEvents
        .map((event) => parseQuestionnaireDefinitionEvent(event))
        .filter((value): value is QuestionnaireDefinition => Boolean(value));
      const parsedStateEvents = stateEvents
        .map((event) => parseQuestionnaireStateEvent(event))
        .filter((value): value is NonNullable<ReturnType<typeof parseQuestionnaireStateEvent>> => Boolean(value));
      const openStateEvents = parsedStateEvents.filter((entry) => entry.state === "open");
      const latestOpenState = openStateEvents.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
      setQuestionnaireDefinitionsSeen(parsedDefinitionEvents.length);
      setQuestionnaireOpenEventsSeen(openStateEvents.length);
      if (parsedDefinitionEvents.length > 0) {
        if (source === "live") {
          setDefinitionSeenLiveCount((current) => current + 1);
        } else if (source === "backfill") {
          setDefinitionSeenBackfillCount((current) => current + 1);
        }
      }
      if (openStateEvents.length > 0) {
        if (source === "live") {
          setOpenSeenLiveCount((current) => current + 1);
        } else if (source === "backfill") {
          setOpenSeenBackfillCount((current) => current + 1);
        }
      }
      const latestDefinition = selectLatestQuestionnaireDefinition(definitionEvents);
      const latestExplicitState = selectLatestQuestionnaireState(stateEvents);
      const latestResultSummary = parseLatestResultSummary(resultEvents);
      const ownResponseEvents = responseEvents
        .map((event) => ({
          event,
          envelope: parseQuestionnaireResponseEnvelope(event),
        }))
        .filter((entry) => entry.envelope?.authorPubkey === responderMarkerNpub);
      const latestOwnResponseEvent = ownResponseEvents
        .sort((left, right) => right.event.created_at - left.event.created_at)[0]?.event ?? null;
      const responseSeenBackLocally = ownResponseEvents.length > 0;
      const responseSeenByCoordinator = responseSeenBackLocally
        && (latestResultSummary?.acceptedResponseCount ?? 0) > 0;
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        responseSeenBackLocally,
        responseSeenByCoordinator,
        lastResponseEventId: current.lastResponseEventId ?? latestOwnResponseEvent?.id ?? null,
        lastResponseEventKind: current.lastResponseEventKind ?? latestOwnResponseEvent?.kind ?? null,
        lastResponseEventCreatedAt: current.lastResponseEventCreatedAt ?? latestOwnResponseEvent?.created_at ?? null,
        lastResponseEventTags: current.lastResponseEventTags.length > 0
          ? current.lastResponseEventTags
          : (latestOwnResponseEvent?.tags ?? []),
      }));
      setLastQuestionnaireDefinitionId(latestDefinition?.questionnaireId ?? null);
      setLastQuestionnaireOpenId(latestOpenState?.questionnaireId ?? null);
      const definitionFilter = {
        kinds: [QUESTIONNAIRE_DEFINITION_KIND],
        "#questionnaire-id": [id],
      };
      const stateFilter = {
        kinds: [QUESTIONNAIRE_STATE_KIND],
        "#questionnaire-id": [id],
      };
      const resultFilter = {
        kinds: [QUESTIONNAIRE_RESULT_SUMMARY_KIND],
        "#questionnaire-id": [id],
      };
      setLastQuestionnaireFilterUsed({
        questionnaireId: id,
        definition: definitionFilter,
        state: stateFilter,
        result: resultFilter,
        definitionReadMode: definitionFetch.diagnostics.mode,
        stateReadMode: stateFetch.diagnostics.mode,
        resultReadMode: resultFetch.diagnostics.mode,
      });
      const explicitState = latestExplicitState?.state ?? null;
      const lifecycle = lifecycleFromExplicitState(explicitState);
      if (definitionEvents.length === 0) {
        setLastQuestionnaireRejectReason("no_definition_events");
      } else if (parsedDefinitionEvents.length === 0) {
        setLastQuestionnaireRejectReason("no_parseable_definition_events");
      } else if (!latestDefinition) {
        setLastQuestionnaireRejectReason("latest_definition_missing");
      } else if (latestDefinition.questionnaireId !== id) {
        setLastQuestionnaireRejectReason("definition_id_mismatch");
      } else if (stateEvents.length === 0) {
        setLastQuestionnaireRejectReason("no_state_events");
      } else if (!isActiveSelectorLifecycle(lifecycle)) {
        setLastQuestionnaireRejectReason(`state_not_visible:${explicitState ?? "unknown"}`);
      } else {
        setLastQuestionnaireRejectReason(null);
      }
      if (!latestDefinition || !isActiveSelectorLifecycle(lifecycle)) {
        setDefinition(null);
        setState(null);
        setLatestResult(null);
        return {
          questionnaireSeen: false,
          questionnaireOpen: false,
          rejectReason: !latestDefinition ? "latest_definition_missing" : `state_not_visible:${explicitState ?? "unknown"}`,
        };
      }
      setDefinition(latestDefinition);
      setState(explicitState);
      setLatestResult(latestResultSummary);
      return {
        questionnaireSeen: true,
        questionnaireOpen: explicitState === "open",
        rejectReason: null,
      };
    } catch {
      setStatus("Questionnaire refresh failed.");
      return null;
    }
  }, [questionnaireId, responderMarkerNpub]);

  useEffect(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return undefined;
    }
    let cancelled = false;
    setDiscoverySubscriptionStartedAt(new Date().toISOString());
    setDiscoveryBackfillStartedAt(new Date().toISOString());
    setDiscoveryBackfillCompletedAt(null);
    setDiscoveryBackfillAttemptCount(0);

    const runBackfillWithRetry = async () => {
      let attempt = 0;
      while (!cancelled) {
        setDiscoveryBackfillAttemptCount(attempt + 1);
        const outcome = await refresh("backfill");
        if (cancelled) {
          return;
        }
        const done = outcome?.questionnaireSeen && outcome?.questionnaireOpen;
        if (done || attempt >= QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_MAX) {
          setDiscoveryBackfillCompletedAt(new Date().toISOString());
          return;
        }
        const delayMs = QUESTIONNAIRE_DISCOVERY_BACKFILL_RETRY_BASE_DELAY_MS * (2 ** attempt);
        await new Promise((resolve) => {
          window.setTimeout(resolve, delayMs);
        });
        attempt += 1;
      }
    };
    void runBackfillWithRetry();

    const unsubscribers = [
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_DEFINITION_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
        onEvent: () => {
          void refresh("live");
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_STATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
        onEvent: () => {
          void refresh("live");
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
        parseQuestionnaireIdFromEvent: (event) => {
          try {
            const parsed = JSON.parse(event.content) as { questionnaireId?: string };
            return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
          } catch {
            return null;
          }
        },
        onEvent: () => {
          void refresh("live");
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireResponseEnvelope(event)?.questionnaireId ?? null,
        onEvent: () => {
          void refresh("live");
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
    ];

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (definition && !firstDefinitionSeenAt) {
      setFirstDefinitionSeenAt(new Date().toISOString());
    }
  }, [definition, firstDefinitionSeenAt]);

  useEffect(() => {
    if (state === "open" && !firstOpenSeenAt) {
      setFirstOpenSeenAt(new Date().toISOString());
    }
  }, [firstOpenSeenAt, state]);

  const canSubmit = useMemo(() => {
    return Boolean(definition && state === "open" && tokenStatus === "ready");
  }, [definition, state, tokenStatus]);
  const selectedQuestionnaireOptions = selectorEntries.map((entry) => entry.questionnaireId);
  const selectedQuestionnaireEntry = selectorEntries.find((entry) => entry.questionnaireId === questionnaireId) ?? null;

  useEffect(() => {
    setResponsePipelineDiagnostics((current) => ({
      ...current,
      responseReady: canSubmit,
    }));
  }, [canSubmit]);

  useEffect(() => {
    setResponsePipelineDiagnostics({
      responseReady: false,
      submitHandlerEntered: false,
      submitClicked: false,
      responsePayloadBuilt: false,
      responsePayloadValidated: false,
      responsePublishStarted: false,
      responsePublishSucceeded: false,
      responseSeenBackLocally: false,
      responseSeenByCoordinator: false,
      lastResponseRejectReason: null,
      lastResponsePublishError: null,
      lastResponseEventId: null,
      lastResponseEventKind: null,
      lastResponseEventCreatedAt: null,
      lastResponseEventTags: [],
      lastResponseRelayTargets: [],
      lastResponseRelaySuccessCount: 0,
    });
    setResponseEventCount(0);
    setFirstDefinitionSeenAt(null);
    setFirstOpenSeenAt(null);
    setDiscoverySubscriptionStartedAt(null);
    setDiscoveryBackfillStartedAt(null);
    setDiscoveryBackfillCompletedAt(null);
    setDiscoveryBackfillAttemptCount(0);
    setDefinitionSeenLiveCount(0);
    setDefinitionSeenBackfillCount(0);
    setOpenSeenLiveCount(0);
    setOpenSeenBackfillCount(0);
  }, [questionnaireId]);

  useEffect(() => {
    const current = questionnaireId.trim();
    if (current && selectedQuestionnaireOptions.includes(current)) {
      return;
    }
    if (selectedQuestionnaireOptions.length > 0) {
      setQuestionnaireId(selectedQuestionnaireOptions[0]);
    }
  }, [questionnaireId, selectedQuestionnaireOptions]);

  useEffect(() => {
    const id = questionnaireId.trim();
    if (!id) {
      setTokenStatus("ready");
      return;
    }
    setTokenStatus(submittedQuestionnaireIds.includes(id) ? "submitted" : "ready");
  }, [questionnaireId, submittedQuestionnaireIds]);

  function getStableResponseNsec(questionnaireKey: string) {
    const existing = responseIdentityByQuestionnaireId[questionnaireKey]?.trim() ?? "";
    if (existing) {
      return existing;
    }
    const generated = nip19.nsecEncode(generateSecretKey());
    setResponseIdentityByQuestionnaireId((current) => ({
      ...current,
      [questionnaireKey]: generated,
    }));
    return generated;
  }

  function setYesNoAnswer(questionId: string, value: boolean) {
    setAnswerState((current) => ({ ...current, [questionId]: value }));
  }

  function setMultipleChoiceAnswer(questionId: string, optionId: string, multiSelect: boolean) {
    setAnswerState((current) => {
      const existing = Array.isArray(current[questionId])
        ? (current[questionId] as string[])
        : [];
      if (!multiSelect) {
        return { ...current, [questionId]: [optionId] };
      }
      if (existing.includes(optionId)) {
        return { ...current, [questionId]: existing.filter((entry) => entry !== optionId) };
      }
      return { ...current, [questionId]: [...existing, optionId] };
    });
  }

  async function submitResponse() {
    setResponsePipelineDiagnostics((current) => ({
      ...current,
      submitHandlerEntered: true,
      submitClicked: true,
      lastResponseRejectReason: null,
      lastResponsePublishError: null,
    }));
    if (!definition) {
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        lastResponseRejectReason: "no_definition_loaded",
      }));
      setStatus("No questionnaire loaded.");
      return;
    }
    if (state !== "open") {
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        lastResponseRejectReason: `questionnaire_not_open:${state ?? "unknown"}`,
      }));
      setStatus("Questionnaire is not open.");
      return;
    }
    if (submittedQuestionnaireIds.includes(definition.questionnaireId)) {
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        lastResponseRejectReason: "already_submitted",
      }));
      setTokenStatus("submitted");
      setStatus("Response already submitted for this questionnaire.");
      return;
    }

    const responseId = `resp_${crypto.randomUUID()}`;
    const payload: QuestionnaireResponsePayload = {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: definition.questionnaireId,
      responseId,
      submittedAt: nowUnix(),
      answers: buildResponseAnswers(definition, answerState),
    };
    setResponsePipelineDiagnostics((current) => ({
      ...current,
      responsePayloadBuilt: true,
    }));

    const validation = validateQuestionnaireResponsePayload({ definition, payload });
    if (!validation.valid) {
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        responsePayloadValidated: false,
        lastResponseRejectReason: `payload_invalid:${validation.errors[0] ?? "unknown_error"}`,
      }));
      setStatus(`Response is invalid: ${validation.errors[0] ?? "unknown_error"}.`);
      return;
    }
    setResponsePipelineDiagnostics((current) => ({
      ...current,
      responsePayloadValidated: true,
    }));

    const responseNsec = getStableResponseNsec(definition.questionnaireId);
    setResponsePipelineDiagnostics((current) => ({
      ...current,
      responsePublishStarted: true,
      responsePublishSucceeded: false,
      lastResponsePublishError: null,
      lastResponseRejectReason: null,
    }));
    setStatus("Submitting response...");

    try {
      const result = await publishEncryptedQuestionnaireResponse({
        responseNsec,
        coordinatorNpub: definition.coordinatorEncryptionPubkey,
        questionnaireId: definition.questionnaireId,
        responseId,
        payload,
      });
      setStatus(
        result.successes > 0
          ? "Response submitted"
          : "Response submit failed.",
      );
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        responsePublishSucceeded: result.successes > 0,
        lastResponsePublishError: result.successes > 0 ? null : "publish_zero_success_relays",
        lastResponseRejectReason: result.successes > 0 ? null : "publish_failed",
        lastResponseEventId: result.eventId ?? current.lastResponseEventId,
        lastResponseEventKind: result.event.kind ?? current.lastResponseEventKind,
        lastResponseEventCreatedAt: result.event.created_at ?? current.lastResponseEventCreatedAt,
        lastResponseEventTags: result.event.tags ?? current.lastResponseEventTags,
        lastResponseRelayTargets: result.relayResults.map((entry) => entry.relay),
        lastResponseRelaySuccessCount: result.successes,
      }));
      if (result.successes > 0) {
        setResponseSubmittedCount((current) => current + 1);
        setTokenStatus("submitted");
        setSubmittedQuestionnaireIds((current) => (
          current.includes(definition.questionnaireId)
            ? current
            : [...current, definition.questionnaireId].slice(-32)
        ));
        const submittedAt = Date.now();
        setParticipationHistory((current) => {
          const existing = current.find((entry) => entry.questionnaireId === definition.questionnaireId);
          const nextEntry: QuestionnaireParticipationHistoryEntry = {
            questionnaireId: definition.questionnaireId,
            title: definition.title?.trim() ?? "",
            coordinatorPubkey: definition.coordinatorPubkey,
            submissionCount: Math.max(1, (existing?.submissionCount ?? 0) + 1),
            lastSubmittedAt: submittedAt,
          };
          return mergeParticipationHistory(
            current.filter((entry) => entry.questionnaireId !== definition.questionnaireId),
            [nextEntry],
          );
        });
      }
    } catch (error) {
      setResponsePipelineDiagnostics((current) => ({
        ...current,
        responsePublishSucceeded: false,
        lastResponseRejectReason: "publish_exception",
        lastResponsePublishError: error instanceof Error ? error.message : String(error),
      }));
      setStatus("Response submit failed.");
    }
  }

  useEffect(() => {
    const submitButtonPresent = Boolean(definition);
    const submitButtonVisible = Boolean(definition);
    const submitButtonDisabled = !canSubmit;
    let submitButtonReasonBlocked: string = "none";
    if (!definition) {
      submitButtonReasonBlocked = "no_questionnaire";
    } else if (state !== "open") {
      submitButtonReasonBlocked = "not_open";
    } else if (tokenStatus === "submitted") {
      submitButtonReasonBlocked = "already_submitted";
    } else if (tokenStatus !== "ready") {
      submitButtonReasonBlocked = "no_token";
    } else if (!canSubmit) {
      submitButtonReasonBlocked = "response_not_ready";
    }
    const owner = globalThis as typeof globalThis & {
      __questionnaireVoterDebug?: unknown;
    };
    owner.__questionnaireVoterDebug = {
      questionnaireId: questionnaireId.trim(),
      loadedQuestionnaireId: definition?.questionnaireId ?? null,
      loadedQuestionCount: definition?.questions.length ?? 0,
      voterNpubLoaded: Boolean(voterNpub),
      questionnaireSeen: Boolean(definition),
      questionnaireOpen: state === "open",
      questionnaireState: state,
      questionnaireDefinitionLiveFilter: null,
      questionnaireDefinitionBackfillFilter: definitionBackfillFilter,
      questionnaireDefinitionReadMode: definitionReadMode,
      questionnaireStateLiveFilter: null,
      questionnaireStateBackfillFilter: stateBackfillFilter,
      questionnaireStateReadMode: stateReadMode,
      questionnaireResultLiveFilter: null,
      questionnaireResultBackfillFilter: resultBackfillFilter,
      questionnaireResultReadMode: resultReadMode,
      questionnaireDefinitionLiveResultCount: null,
      questionnaireDefinitionBackfillResultCount: definitionEventCount,
      questionnaireDefinitionKindOnlyCount: definitionKindOnlyCount,
      questionnaireDefinitionsSeen,
      questionnaireOpenEventsSeen,
      definitionSeenLive: definitionSeenLiveCount > 0,
      definitionSeenBackfill: definitionSeenBackfillCount > 0,
      openSeenLive: openSeenLiveCount > 0,
      openSeenBackfill: openSeenBackfillCount > 0,
      definitionSeenLiveCount,
      definitionSeenBackfillCount,
      openSeenLiveCount,
      openSeenBackfillCount,
      lastQuestionnaireDefinitionId,
      lastQuestionnaireOpenId,
      lastQuestionnaireFilterUsed,
      lastQuestionnaireRejectReason,
      discoverySubscriptionStartedAt,
      firstDefinitionSeenAt,
      firstOpenSeenAt,
      discoveryBackfillStartedAt,
      discoveryBackfillCompletedAt,
      discoveryBackfillAttemptCount,
      selectorDiagnostics,
      questionnaireStateLiveResultCount: null,
      questionnaireStateBackfillResultCount: stateEventCount,
      questionnaireStateKindOnlyCount: stateKindOnlyCount,
      questionnaireResultLiveResultCount: null,
      questionnaireResultBackfillResultCount: resultEventCount,
      questionnaireResultKindOnlyCount: resultKindOnlyCount,
      definitionEventCount,
      stateEventCount,
      responseEventCount,
      resultEventCount,
      latestResultAcceptedCount: latestResult?.acceptedResponseCount ?? null,
      responsePublished: responseSubmittedCount > 0,
      tokenRequested: Boolean(definition && state === "open"),
      tokenReceived: Boolean(definition && (tokenStatus === "ready" || tokenStatus === "submitted")),
      responseSubmittedCount,
      responseReady: responsePipelineDiagnostics.responseReady,
      submitHandlerEntered: responsePipelineDiagnostics.submitHandlerEntered,
      submitClicked: responsePipelineDiagnostics.submitClicked,
      submitButtonPresent,
      submitButtonVisible,
      submitButtonDisabled,
      submitButtonText: "Submit response",
      submitButtonReasonBlocked,
      responsePayloadBuilt: responsePipelineDiagnostics.responsePayloadBuilt,
      responsePayloadValidated: responsePipelineDiagnostics.responsePayloadValidated,
      responsePublishStarted: responsePipelineDiagnostics.responsePublishStarted,
      responsePublishSucceeded: responsePipelineDiagnostics.responsePublishSucceeded,
      responseSeenBackLocally: responsePipelineDiagnostics.responseSeenBackLocally,
      responseSeenByCoordinator: responsePipelineDiagnostics.responseSeenByCoordinator,
      lastResponseRejectReason: responsePipelineDiagnostics.lastResponseRejectReason,
      lastResponsePublishError: responsePipelineDiagnostics.lastResponsePublishError,
      lastResponseEventId: responsePipelineDiagnostics.lastResponseEventId,
      lastResponseEventKind: responsePipelineDiagnostics.lastResponseEventKind,
      lastResponseEventCreatedAt: responsePipelineDiagnostics.lastResponseEventCreatedAt,
      lastResponseEventTags: responsePipelineDiagnostics.lastResponseEventTags,
      lastResponseRelayTargets: responsePipelineDiagnostics.lastResponseRelayTargets,
      lastResponseRelaySuccessCount: responsePipelineDiagnostics.lastResponseRelaySuccessCount,
      status,
    };
  }, [
    definitionBackfillFilter,
    definitionEventCount,
    definitionKindOnlyCount,
    questionnaireDefinitionsSeen,
    questionnaireOpenEventsSeen,
    definitionSeenLiveCount,
    definitionSeenBackfillCount,
    openSeenLiveCount,
    openSeenBackfillCount,
    lastQuestionnaireDefinitionId,
    lastQuestionnaireOpenId,
    lastQuestionnaireFilterUsed,
    lastQuestionnaireRejectReason,
    discoverySubscriptionStartedAt,
    firstDefinitionSeenAt,
    firstOpenSeenAt,
    discoveryBackfillStartedAt,
    discoveryBackfillCompletedAt,
    discoveryBackfillAttemptCount,
    selectorDiagnostics,
    definitionReadMode,
    definition,
    latestResult?.acceptedResponseCount,
    questionnaireId,
    resultBackfillFilter,
    resultEventCount,
    resultKindOnlyCount,
    resultReadMode,
    responseEventCount,
    responsePipelineDiagnostics,
    responseSubmittedCount,
    state,
    stateBackfillFilter,
    stateEventCount,
    stateKindOnlyCount,
    stateReadMode,
    status,
    voterNpub,
    canSubmit,
    tokenStatus,
  ]);

  useEffect(() => {
    onContextChange?.({
      hasDefinition: Boolean(definition),
      state,
    });
  }, [definition, onContextChange, state]);

  return (
    <div className='simple-voter-card'>
      <h3 className='simple-voter-question'>Questionnaire</h3>
      <p className='simple-voter-note'>{definition?.title ?? "Questionnaire"}</p>
      <p className='simple-voter-note'>{definition?.description ?? "This response is submitted using a one-time token."}</p>
      <p className='simple-voter-note'>{definition?.responseVisibility === "private" ? "Answers are encrypted" : "Answers are public"}</p>
      {responderMarkerNpub ? (
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          <TokenFingerprint tokenId={responderMarkerNpub} compact showQr={false} hideMetadata />
          <div>
            <p className='simple-voter-note'>Your responder marker</p>
            <p className='simple-voter-note'>Voter ID {responderMarkerId}</p>
          </div>
        </div>
      ) : null}

      <label className='simple-voter-label' htmlFor='questionnaire-id-voter'>Questionnaire ID</label>
      {selectorEntries.length === 0 ? (
        <p className='simple-voter-note'>No active questionnaire yet.</p>
      ) : selectorEntries.length === 1 && selectedQuestionnaireEntry ? (
        <div className='simple-questionnaire-voter-card'>
          <p className='simple-questionnaire-voter-number'>{selectorStateBadge(selectedQuestionnaireEntry.lifecycle)}</p>
          <h4 className='simple-questionnaire-voter-prompt'>{selectedQuestionnaireEntry.title || selectedQuestionnaireEntry.questionnaireId}</h4>
          <p className='simple-questionnaire-voter-helper'>ID: {selectedQuestionnaireEntry.questionnaireId}</p>
          {selectedQuestionnaireEntry.restored ? (
            <p className='simple-questionnaire-voter-helper'>Restored questionnaire</p>
          ) : null}
        </div>
      ) : (
        <select
          id='questionnaire-id-voter'
          className='simple-voter-input'
          value={questionnaireId}
          onChange={(event) => setQuestionnaireId(event.target.value)}
        >
          {selectorEntries.map((entry) => (
            <option key={entry.questionnaireId} value={entry.questionnaireId}>
              {(entry.title || entry.questionnaireId)} · {entry.questionnaireId} · {selectorStateBadge(entry.lifecycle)}
            </option>
          ))}
        </select>
      )}
      {participationHistory.length > 0 ? (
        <>
          <p className='simple-voter-note'>Participation history</p>
          <ul className='simple-vote-status-list'>
            {participationHistory.slice(0, 6).map((entry) => (
              <li key={entry.questionnaireId}>
                <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => {
                    setQuestionnaireId(entry.questionnaireId);
                    setRestoredQuestionnaireIds((current) => (
                      current.includes(entry.questionnaireId)
                        ? current
                        : [...current, entry.questionnaireId].slice(-8)
                    ));
                  }}
                >
                  {(entry.title || entry.questionnaireId)} ({new Date(entry.lastSubmittedAt).toLocaleString()})
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <ul className='simple-vote-status-list'>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          State: {formatQuestionnaireStateLabel(state)}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          1. Token: Token ready
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          2. Response ready: {tokenStatus === "ready" || tokenStatus === "submitted" ? "Token ready" : "Waiting"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          3. Submitted: {tokenStatus === "submitted" ? "Response submitted" : "Not submitted"}
        </li>
      </ul>

      {definition ? (
        <div className='simple-questionnaire-voter-list'>
          {definition.questions.map((question, index) => {
            const questionPrompt = question.prompt.trim() || "Untitled question";
            const requirementLabel = question.required ? "Required" : "Optional";
            if (question.type === "yes_no") {
              const selected = answerState[question.questionId];
              return (
                <article key={question.questionId} className='simple-questionnaire-voter-card'>
                  <p className='simple-questionnaire-voter-number'>Question {index + 1}</p>
                  <h4 className='simple-questionnaire-voter-prompt'>{questionPrompt}</h4>
                  <p className='simple-questionnaire-voter-helper'>{requirementLabel}</p>
                  <div className='simple-vote-button-grid simple-questionnaire-yes-no-grid'>
                    <button
                      type='button'
                      className={`simple-voter-choice simple-questionnaire-yes-no-choice simple-voter-choice-yes${selected === true ? " is-active" : ""}`}
                      onClick={() => setYesNoAnswer(question.questionId, true)}
                    >
                      Yes
                    </button>
                    <button
                      type='button'
                      className={`simple-voter-choice simple-questionnaire-yes-no-choice simple-voter-choice-no${selected === false ? " is-active" : ""}`}
                      onClick={() => setYesNoAnswer(question.questionId, false)}
                    >
                      No
                    </button>
                  </div>
                </article>
              );
            }

            if (question.type === "multiple_choice") {
              const selected = Array.isArray(answerState[question.questionId])
                ? (answerState[question.questionId] as string[])
                : [];
              return (
                <article key={question.questionId} className='simple-questionnaire-voter-card'>
                  <p className='simple-questionnaire-voter-number'>Question {index + 1}</p>
                  <h4 className='simple-questionnaire-voter-prompt'>{questionPrompt}</h4>
                  <p className='simple-questionnaire-voter-helper'>{requirementLabel}</p>
                  <div className='simple-questionnaire-choice-list'>
                    {question.options.map((option) => (
                      <label key={option.optionId} className='simple-questionnaire-choice-row'>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={question.questionId}
                          checked={selected.includes(option.optionId)}
                          onChange={() => setMultipleChoiceAnswer(question.questionId, option.optionId, question.multiSelect)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </article>
              );
            }

            const text = typeof answerState[question.questionId] === "string"
              ? (answerState[question.questionId] as string)
              : "";
            return (
              <article key={question.questionId} className='simple-questionnaire-voter-card'>
                <p className='simple-questionnaire-voter-number'>Question {index + 1}</p>
                <h4 className='simple-questionnaire-voter-prompt'>{questionPrompt}</h4>
                <p className='simple-questionnaire-voter-helper'>{requirementLabel}</p>
                <label className='simple-voter-label simple-voter-label-tight' htmlFor={`questionnaire-free-text-${question.questionId}`}>
                  Additional comments
                </label>
                <textarea
                  id={`questionnaire-free-text-${question.questionId}`}
                  className='simple-voter-input simple-questionnaire-free-text'
                  rows={4}
                  maxLength={question.maxLength}
                  placeholder='Type your response here...'
                  value={text}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setAnswerState((current) => ({
                      ...current,
                      [question.questionId]: nextValue,
                    }));
                  }}
                />
                <p className='simple-questionnaire-voter-helper'>Max {question.maxLength} characters.</p>
              </article>
            );
          })}

          <button
            type='button'
            className='simple-voter-primary simple-voter-primary-wide'
            disabled={!canSubmit}
            onClick={() => void submitResponse()}
          >
            Submit response
          </button>
        </div>
      ) : (
        <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p>
      )}

      {status ? <p className='simple-voter-note'>{formatQuestionnaireTokenStatusLabel(status)}</p> : null}
      {tokenStatus === "submitted" ? <p className='simple-voter-note'>You can close this page.</p> : null}
    </div>
  );
}
