import { useCallback, useEffect, useMemo, useState } from "react";
import { generateSecretKey, nip19 } from "nostr-tools";
import { fetchQuestionnaireEvents, fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishEncryptedQuestionnaireResponse, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND } from "./questionnaireNostr";
import { formatQuestionnaireStateLabel, formatQuestionnaireTokenStatusLabel, parseQuestionnaireResultSummaryEvent, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { buildSimpleNamespacedLocalStorageKey, loadSimpleActorState } from "./simpleLocalState";
import { validateQuestionnaireResponsePayload, type QuestionnaireDefinition, type QuestionnaireResponseAnswer, type QuestionnaireResponsePayload, type QuestionnaireResultSummary } from "./questionnaireProtocol";
import { getSharedNostrPool } from "./sharedNostrPool";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";

const RESTORED_QUESTIONNAIRE_IDS_STORAGE_KEY = "voter.restored-questionnaire-ids.v1";
const PARTICIPATION_HISTORY_STORAGE_KEY = "voter.questionnaire-participation-history.v1";
const VOTER_QUESTIONNAIRE_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_INTERVAL_MS = 15000;
const MAX_PARTICIPATION_HISTORY_ENTRIES = 16;

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
};

export default function QuestionnaireVoterPanel(props: QuestionnaireVoterPanelProps) {
  const onContextChange = props.onContextChange;
  const onParticipationHistoryChange = props.onParticipationHistoryChange;
  const incomingParticipationHistory = props.participationHistory;
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [selectorEntries, setSelectorEntries] = useState<QuestionnaireSelectorEntry[]>([]);
  const [coordinatorContextNpubs, setCoordinatorContextNpubs] = useState<string[]>([]);
  const [restoredQuestionnaireIds, setRestoredQuestionnaireIds] = useState<string[]>([]);
  const [restoreQuestionnaireIdInput, setRestoreQuestionnaireIdInput] = useState("");
  const [participationHistory, setParticipationHistory] = useState<QuestionnaireParticipationHistoryEntry[]>([]);
  const [voterNpub, setVoterNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [definition, setDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<QuestionnaireResultSummary | null>(null);
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const [responseSubmittedCount, setResponseSubmittedCount] = useState(0);
  const [tokenStatus, setTokenStatus] = useState<"ready" | "submitted">("ready");
  const [definitionEventCount, setDefinitionEventCount] = useState(0);
  const [stateEventCount, setStateEventCount] = useState(0);
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
  const actorId = useMemo(() => deriveActorDisplayId(voterNpub || "unknown"), [voterNpub]);
  const restoredStorageKey = useMemo(
    () => buildRestoredStorageKey(actorId, coordinatorContextNpubs),
    [actorId, coordinatorContextNpubs],
  );
  const participationHistoryStorageKey = useMemo(
    () => buildParticipationHistoryStorageKey(actorId),
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
    const incoming = Array.isArray(incomingParticipationHistory)
      ? incomingParticipationHistory
      : [];
    if (incoming.length === 0) {
      return;
    }
    setParticipationHistory((current) => mergeParticipationHistory(current, incoming));
  }, [incomingParticipationHistory]);

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
    let cancelled = false;
    const loadQuestionnaireOptions = async () => {
      try {
        const relays = getQuestionnaireReadRelays();
        const pool = getSharedNostrPool();
        const events = await pool.querySync(relays, {
          kinds: [QUESTIONNAIRE_DEFINITION_KIND],
          limit: 400,
        });
        const stateEvents = await pool.querySync(relays, {
          kinds: [QUESTIONNAIRE_STATE_KIND],
          limit: 400,
        });
        if (cancelled) {
          return;
        }

        const latestStateByQuestionnaireId = new Map<string, { state: string; createdAt: number }>();
        for (const stateEvent of stateEvents) {
          const parsed = parseQuestionnaireStateEvent(stateEvent);
          if (!parsed?.questionnaireId) {
            continue;
          }
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
            continue;
          }
          const id = parsed.questionnaireId.trim();
          if (!id) {
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
            continue;
          }
          byQuestionnaireId.set(
            id,
            choosePreferredEntry(byQuestionnaireId.get(id), entry, coordinatorContextNpubs),
          );
        }
        const entries = [...byQuestionnaireId.values()].sort(selectorComparator);
        setSelectorEntries(entries);
      } catch {
        setSelectorEntries([]);
      }
    };
    void loadQuestionnaireOptions();
    return () => {
      cancelled = true;
    };
  }, [coordinatorContextNpubs, restoredQuestionnaireIds]);

  const refresh = useCallback(async () => {
    const id = questionnaireId.trim();
    if (!id) {
      return;
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
      const [definitionFetch, stateFetch, resultFetch] = await Promise.all([
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
      const resultEvents = resultFetch.events;
      setDefinitionReadMode(definitionFetch.diagnostics.mode);
      setStateReadMode(stateFetch.diagnostics.mode);
      setResultReadMode(resultFetch.diagnostics.mode);
      setDefinitionKindOnlyCount(definitionFetch.diagnostics.kindOnlyCount);
      setStateKindOnlyCount(stateFetch.diagnostics.kindOnlyCount);
      setResultKindOnlyCount(resultFetch.diagnostics.kindOnlyCount);
      setDefinitionEventCount(definitionEvents.length);
      setStateEventCount(stateEvents.length);
      setResultEventCount(resultEvents.length);
      const latestDefinition = selectLatestQuestionnaireDefinition(definitionEvents);
      const latestExplicitState = selectLatestQuestionnaireState(stateEvents);
      const explicitState = latestExplicitState?.state ?? null;
      const lifecycle = lifecycleFromExplicitState(explicitState);
      if (!latestDefinition || !isActiveSelectorLifecycle(lifecycle)) {
        setDefinition(null);
        setState(null);
        setLatestResult(null);
        return;
      }
      setDefinition(latestDefinition);
      setState(explicitState);
      setLatestResult(parseLatestResultSummary(resultEvents));
    } catch {
      setStatus("Questionnaire refresh failed.");
    }
  }, [questionnaireId]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const canSubmit = useMemo(() => {
    return Boolean(definition && state === "open" && (tokenStatus === "ready" || tokenStatus === "submitted"));
  }, [definition, state, tokenStatus]);
  const selectedQuestionnaireOptions = selectorEntries.map((entry) => entry.questionnaireId);
  const selectedQuestionnaireEntry = selectorEntries.find((entry) => entry.questionnaireId === questionnaireId) ?? null;

  useEffect(() => {
    const current = questionnaireId.trim();
    if (current && selectedQuestionnaireOptions.includes(current)) {
      return;
    }
    if (selectedQuestionnaireOptions.length > 0) {
      setQuestionnaireId(selectedQuestionnaireOptions[0]);
    }
  }, [questionnaireId, selectedQuestionnaireOptions]);

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
    if (!definition) {
      setStatus("No questionnaire loaded.");
      return;
    }
    if (state !== "open") {
      setStatus("Questionnaire is not open.");
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

    const validation = validateQuestionnaireResponsePayload({ definition, payload });
    if (!validation.valid) {
      setStatus(`Response is invalid: ${validation.errors[0] ?? "unknown_error"}.`);
      return;
    }

    const ephemeralNsec = nip19.nsecEncode(generateSecretKey());
    setStatus("Submitting response...");

    try {
      const result = await publishEncryptedQuestionnaireResponse({
        responseNsec: ephemeralNsec,
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
      if (result.successes > 0) {
        setResponseSubmittedCount((current) => current + 1);
        setTokenStatus("submitted");
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
    } catch {
      setStatus("Response submit failed.");
    }
  }

  useEffect(() => {
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
      questionnaireStateLiveResultCount: null,
      questionnaireStateBackfillResultCount: stateEventCount,
      questionnaireStateKindOnlyCount: stateKindOnlyCount,
      questionnaireResultLiveResultCount: null,
      questionnaireResultBackfillResultCount: resultEventCount,
      questionnaireResultKindOnlyCount: resultKindOnlyCount,
      definitionEventCount,
      stateEventCount,
      resultEventCount,
      latestResultAcceptedCount: latestResult?.acceptedResponseCount ?? null,
      responsePublished: responseSubmittedCount > 0,
      responseSubmittedCount,
      status,
    };
  }, [
    definitionBackfillFilter,
    definitionEventCount,
    definitionKindOnlyCount,
    definitionReadMode,
    definition,
    latestResult?.acceptedResponseCount,
    questionnaireId,
    resultBackfillFilter,
    resultEventCount,
    resultKindOnlyCount,
    resultReadMode,
    responseSubmittedCount,
    state,
    stateBackfillFilter,
    stateEventCount,
    stateKindOnlyCount,
    stateReadMode,
    status,
    voterNpub,
  ]);

  useEffect(() => {
    onContextChange?.({
      hasDefinition: Boolean(definition),
      state,
    });
  }, [definition, onContextChange, state]);

  async function restoreQuestionnaireId() {
    const restoredId = restoreQuestionnaireIdInput.trim();
    if (!restoredId) {
      return;
    }
    setStatus("Restoring questionnaire...");
    try {
      const [definitionFetch, stateFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: restoredId,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: restoredId,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
        }),
      ]);
      const restoredDefinition = selectLatestQuestionnaireDefinition(definitionFetch.events);
      if (!restoredDefinition || isDefinitionMarkedStale(restoredDefinition)) {
        setStatus("Restore failed. Questionnaire not found.");
        return;
      }
      const restoredState = selectLatestQuestionnaireState(stateFetch.events)?.state ?? null;
      const lifecycle = lifecycleFromExplicitState(restoredState);
      if (!isActiveSelectorLifecycle(lifecycle)) {
        setStatus("Restore failed. Questionnaire is not published.");
        return;
      }
      setRestoredQuestionnaireIds((current) => (
        current.includes(restoredId) ? current : [...current, restoredId].slice(-8)
      ));
      setQuestionnaireId(restoredId);
      setRestoreQuestionnaireIdInput("");
      setStatus("Questionnaire ID restored.");
    } catch {
      setStatus("Restore failed. Questionnaire not found.");
    }
  }

  return (
    <div className='simple-voter-card'>
      <h3 className='simple-voter-question'>Questionnaire</h3>
      <p className='simple-voter-note'>{definition?.title ?? "Questionnaire"}</p>
      <p className='simple-voter-note'>{definition?.description ?? "This response is submitted using a one-time token."}</p>
      <p className='simple-voter-note'>{definition?.responseVisibility === "private" ? "Answers are encrypted" : "Answers are public"}</p>
      {voterNpub ? (
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          <TokenFingerprint tokenId={voterNpub} compact showQr={false} hideMetadata />
          <p className='simple-voter-note'>Your responder marker</p>
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
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
        <input
          className='simple-voter-input simple-voter-input-inline'
          value={restoreQuestionnaireIdInput}
          placeholder='Restore questionnaire ID'
          onChange={(event) => setRestoreQuestionnaireIdInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              restoreQuestionnaireId();
            }
          }}
        />
        <button
          type='button'
          className='simple-voter-secondary'
          disabled={!restoreQuestionnaireIdInput.trim()}
          onClick={restoreQuestionnaireId}
        >
          Restore ID
        </button>
      </div>

      <div className='simple-voter-action-row simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
          Refresh questionnaire
        </button>
      </div>
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
