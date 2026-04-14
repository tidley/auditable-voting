import { useCallback, useEffect, useMemo, useState } from "react";
import type { NostrEvent } from "nostr-tools";
import { fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishQuestionnaireDefinition, publishQuestionnaireResultSummary, publishQuestionnaireState, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND, subscribeQuestionnaireEvents } from "./questionnaireNostr";
import { buildQuestionnaireResultSummary, deriveEffectiveQuestionnaireState, processQuestionnaireResponses, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireResultSummary, selectLatestQuestionnaireState, type QuestionnaireAcceptedResponse } from "./questionnaireRuntime";
import { loadSimpleActorState } from "./simpleLocalState";
import {
  validateQuestionnaireDefinition,
  type QuestionnaireDefinition,
  type QuestionnaireQuestion,
  type QuestionnaireStateValue,
} from "./questionnaireProtocol";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import SimpleQrPanel from "./SimpleQrPanel";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import { getSharedNostrPool } from "./sharedNostrPool";

const DEFAULT_QUESTIONNAIRE_ID = "course_feedback_2026_term1";
const IDENTITY_REFRESH_INTERVAL_MS = 10000;

type QuestionnairePublishDiagnostic = {
  attempted: boolean;
  succeeded: boolean;
  eventId: string | null;
  kind: number | null;
  tags: string[][];
  relayTargets: string[];
  relaySuccessCount: number;
};

type QuestionnaireCoordinatorPanelProps = {
  coordinatorNsec?: string | null;
  coordinatorNpub?: string | null;
  knownVoterCount?: number;
  view?: "build" | "responses";
  onStatusChange?: (status: {
    state: QuestionnaireStateValue | null;
    acceptedCount: number;
    rejectedCount: number;
    payloadMode: "Encrypted" | "Public";
  }) => void;
};

type QuestionnaireQuestionDraft = QuestionnaireQuestion;
type QuestionCardTypeLabel = "Text" | "Multiple choice" | "Free text";

function questionTypeLabel(type: QuestionnaireQuestionDraft["type"]): QuestionCardTypeLabel {
  if (type === "multiple_choice") {
    return "Multiple choice";
  }
  if (type === "free_text") {
    return "Free text";
  }
  return "Text";
}

function isQuestionDraftValid(question: QuestionnaireQuestionDraft): boolean {
  if (!question.prompt.trim()) {
    return false;
  }
  if (question.type === "multiple_choice") {
    if (question.options.length < 2) {
      return false;
    }
    return question.options.every((option) => option.label.trim().length > 0);
  }
  if (question.type === "free_text") {
    return Number.isFinite(question.maxLength) && question.maxLength > 0;
  }
  return true;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function generateQuestionnaireId() {
  return `${DEFAULT_QUESTIONNAIRE_ID}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatUnixTimestamp(timestampSeconds?: number | null) {
  if (!timestampSeconds || !Number.isFinite(timestampSeconds)) {
    return "Not set";
  }
  return new Date(timestampSeconds * 1000).toLocaleString();
}

function formatQuestionnaireMetadataState(state: QuestionnaireStateValue | null, hasDefinition: boolean) {
  if (!hasDefinition) {
    return "Draft";
  }
  if (state === "open") {
    return "Open";
  }
  if (state === "closed") {
    return "Closed";
  }
  if (state === "results_published") {
    return "Counted";
  }
  return "Published";
}

function percentageLabel(count: number, total: number) {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((count / total) * 100)}%`;
}

function parseQuestionnaireIdFromResponseContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { questionnaireId?: string };
    return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
  } catch {
    return null;
  }
}

function buildDefinition(input: {
  questionnaireId: string;
  coordinatorPubkey: string;
  title: string;
  description: string;
  closeAfterMinutes: number;
  questions: QuestionnaireQuestionDraft[];
}): QuestionnaireDefinition {
  const createdAt = nowUnix();
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: input.questionnaireId,
    title: input.title,
    description: input.description,
    createdAt,
    openAt: createdAt,
    closeAt: createdAt + (input.closeAfterMinutes * 60),
    coordinatorPubkey: input.coordinatorPubkey,
    coordinatorEncryptionPubkey: input.coordinatorPubkey,
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: input.questions,
  };
}

export default function QuestionnaireCoordinatorPanel(props: QuestionnaireCoordinatorPanelProps) {
  const [questionnaireId, setQuestionnaireId] = useState(DEFAULT_QUESTIONNAIRE_ID);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [closeAfterMinutes, setCloseAfterMinutes] = useState("60");
  const [questions, setQuestions] = useState<QuestionnaireQuestionDraft[]>([]);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [coordinatorNsec, setCoordinatorNsec] = useState("");
  const [coordinatorNpub, setCoordinatorNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [latestDefinition, setLatestDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [latestState, setLatestState] = useState<QuestionnaireStateValue | null>(null);
  const [latestAcceptedCount, setLatestAcceptedCount] = useState(0);
  const [latestRejectedCount, setLatestRejectedCount] = useState(0);
  const [latestAcceptedResponses, setLatestAcceptedResponses] = useState<QuestionnaireAcceptedResponse[]>([]);
  const [latestResultAcceptedCount, setLatestResultAcceptedCount] = useState<number | null>(null);
  const [availableQuestionnaireIds, setAvailableQuestionnaireIds] = useState<string[]>([]);
  const [expandedTextQuestionIds, setExpandedTextQuestionIds] = useState<Record<string, boolean>>({});
  const [definitionEventCount, setDefinitionEventCount] = useState(0);
  const [stateEventCount, setStateEventCount] = useState(0);
  const [responseEventCount, setResponseEventCount] = useState(0);
  const [resultEventCount, setResultEventCount] = useState(0);
  const [definitionPublishDiagnostic, setDefinitionPublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [statePublishDiagnostic, setStatePublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [resultPublishDiagnostic, setResultPublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [definitionReadDiagnostics, setDefinitionReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [stateReadDiagnostics, setStateReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [resultReadDiagnostics, setResultReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [responseReadDiagnostics, setResponseReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });

  useEffect(() => {
    const nextNsec = typeof props.coordinatorNsec === "string" ? props.coordinatorNsec.trim() : "";
    const nextNpub = typeof props.coordinatorNpub === "string" ? props.coordinatorNpub.trim() : "";
    if (nextNsec) {
      setCoordinatorNsec((current) => (current === nextNsec ? current : nextNsec));
    }
    if (nextNpub) {
      setCoordinatorNpub((current) => (current === nextNpub ? current : nextNpub));
    }
  }, [props.coordinatorNsec, props.coordinatorNpub]);

  useEffect(() => {
    let cancelled = false;
    const refreshIdentity = () => {
      if (coordinatorNsec.trim() && coordinatorNpub.trim()) {
        return;
      }
      void loadSimpleActorState("coordinator").then((state) => {
        if (cancelled || !state?.keypair) {
          return;
        }
        if (props.coordinatorNsec?.trim() && props.coordinatorNpub?.trim()) {
          return;
        }
        setCoordinatorNsec((current) => (current === state.keypair.nsec ? current : state.keypair.nsec));
        setCoordinatorNpub((current) => (current === state.keypair.npub ? current : state.keypair.npub));
      }).catch(() => undefined);
    };
    refreshIdentity();
    const intervalId = window.setInterval(refreshIdentity, IDENTITY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [coordinatorNpub, coordinatorNsec, props.coordinatorNpub, props.coordinatorNsec]);

  const applyQuestionnaireSnapshot = useCallback((input: {
    definitionEvents: NostrEvent[];
    stateEvents: NostrEvent[];
    responseEvents: NostrEvent[];
    resultEvents: NostrEvent[];
    diagnostics?: {
      definition: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      state: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      response: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      result: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
    };
  }) => {
    if (input.diagnostics) {
      setDefinitionReadDiagnostics(input.diagnostics.definition);
      setStateReadDiagnostics(input.diagnostics.state);
      setResponseReadDiagnostics(input.diagnostics.response);
      setResultReadDiagnostics(input.diagnostics.result);
    }

    const definition = selectLatestQuestionnaireDefinition(input.definitionEvents);
    const state = selectLatestQuestionnaireState(input.stateEvents);
    const resultSummary = selectLatestQuestionnaireResultSummary(input.resultEvents);
    setDefinitionEventCount(input.definitionEvents.length);
    setStateEventCount(input.stateEvents.length);
    setResponseEventCount(input.responseEvents.length);
    setResultEventCount(input.resultEvents.length);

    setLatestDefinition(definition);
    setLatestState(deriveEffectiveQuestionnaireState({
      definition,
      latestState: state,
    }));
    setLatestResultAcceptedCount(resultSummary?.acceptedResponseCount ?? null);

    if (definition && coordinatorNsec.trim()) {
      const processed = processQuestionnaireResponses({
        definition,
        responseEvents: input.responseEvents,
        coordinatorNsec,
      });
      setLatestAcceptedCount(processed.accepted.length);
      setLatestRejectedCount(processed.rejected.length);
      setLatestAcceptedResponses(processed.accepted);
    } else {
      setLatestAcceptedCount(0);
      setLatestRejectedCount(0);
      setLatestAcceptedResponses([]);
    }
  }, [coordinatorNsec]);

  const refresh = useCallback(async () => {
    const id = questionnaireId.trim();
    if (!id) {
      return;
    }

    try {
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
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseContent(event.content),
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
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        resultEvents: resultFetch.events,
        diagnostics: {
          definition: definitionFetch.diagnostics,
          state: stateFetch.diagnostics,
          response: responseFetch.diagnostics,
          result: resultFetch.diagnostics,
        },
      });
    } catch {
      setStatus("Questionnaire refresh failed.");
    }
  }, [applyQuestionnaireSnapshot, questionnaireId]);

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
        if (cancelled) {
          return;
        }

        const coordinatorFilter = coordinatorNpub.trim();
        const ids = new Set<string>();
        for (const event of events) {
          const parsed = parseQuestionnaireDefinitionEvent(event);
          if (!parsed) {
            continue;
          }
          if (coordinatorFilter && parsed.coordinatorPubkey !== coordinatorFilter) {
            continue;
          }
          if (parsed.questionnaireId.trim()) {
            ids.add(parsed.questionnaireId.trim());
          }
        }
        const selectedId = questionnaireId.trim();
        if (selectedId) {
          ids.add(selectedId);
        }
        setAvailableQuestionnaireIds([...ids].sort((left, right) => left.localeCompare(right)));
      } catch {
        const selectedId = questionnaireId.trim();
        setAvailableQuestionnaireIds(selectedId ? [selectedId] : []);
      }
    };
    void loadQuestionnaireOptions();
    return () => {
      cancelled = true;
    };
  }, [coordinatorNpub, questionnaireId]);

  useEffect(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return undefined;
    }

    let cancelled = false;
    const definitionById = new Map<string, NostrEvent>();
    const stateById = new Map<string, NostrEvent>();
    const responseById = new Map<string, NostrEvent>();
    const resultById = new Map<string, NostrEvent>();
    const applyFromMaps = () => {
      if (cancelled) {
        return;
      }
      applyQuestionnaireSnapshot({
        definitionEvents: [...definitionById.values()],
        stateEvents: [...stateById.values()],
        responseEvents: [...responseById.values()],
        resultEvents: [...resultById.values()],
      });
    };

    const loadInitialBackfill = async () => {
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
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseContent(event.content),
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
      if (cancelled) {
        return;
      }
      definitionById.clear();
      stateById.clear();
      responseById.clear();
      resultById.clear();
      for (const event of definitionFetch.events) {
        definitionById.set(event.id, event);
      }
      for (const event of stateFetch.events) {
        stateById.set(event.id, event);
      }
      for (const event of responseFetch.events) {
        responseById.set(event.id, event);
      }
      for (const event of resultFetch.events) {
        resultById.set(event.id, event);
      }
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        resultEvents: resultFetch.events,
        diagnostics: {
          definition: definitionFetch.diagnostics,
          state: stateFetch.diagnostics,
          response: responseFetch.diagnostics,
          result: resultFetch.diagnostics,
        },
      });
    };

    void loadInitialBackfill().catch(() => {
      if (!cancelled) {
        setStatus("Questionnaire refresh failed.");
      }
    });

    const unsubscribers = [
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_DEFINITION_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
        onEvent: (event) => {
          definitionById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_STATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
        onEvent: (event) => {
          stateById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => setStatus("Questionnaire live stream disconnected."),
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseContent(event.content),
        onEvent: (event) => {
          responseById.set(event.id, event);
          applyFromMaps();
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
        onEvent: (event) => {
          resultById.set(event.id, event);
          applyFromMaps();
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
  }, [applyQuestionnaireSnapshot, questionnaireId]);

  useEffect(() => {
    const owner = globalThis as typeof globalThis & {
      __questionnaireCoordinatorDebug?: unknown;
    };
    owner.__questionnaireCoordinatorDebug = {
      questionnaireId: questionnaireId.trim(),
      coordinatorNpubLoaded: Boolean(coordinatorNpub),
      latestState,
      latestAcceptedCount,
      latestRejectedCount,
      latestResultAcceptedCount,
      definitionEventCount,
      stateEventCount,
      responseEventCount,
      resultEventCount,
      definitionReadDiagnostics,
      stateReadDiagnostics,
      responseReadDiagnostics,
      resultReadDiagnostics,
      definitionPublishDiagnostic,
      statePublishDiagnostic,
      resultPublishDiagnostic,
      latestDefinitionQuestionCount: latestDefinition?.questions.length ?? 0,
      latestDefinitionId: latestDefinition?.questionnaireId ?? null,
      localSummaryMatchesPublished: latestResultAcceptedCount === null
        ? null
        : latestResultAcceptedCount === latestAcceptedCount,
      hasDefinition: Boolean(latestDefinition),
      status,
    };
  }, [
    coordinatorNpub,
    definitionEventCount,
    definitionPublishDiagnostic,
    definitionReadDiagnostics,
    latestAcceptedCount,
    latestDefinition,
    latestRejectedCount,
    latestResultAcceptedCount,
    latestState,
    questionnaireId,
    responseReadDiagnostics,
    resultReadDiagnostics,
    resultPublishDiagnostic,
    responseEventCount,
    statePublishDiagnostic,
    stateReadDiagnostics,
    resultEventCount,
    stateEventCount,
    status,
  ]);

  useEffect(() => {
    props.onStatusChange?.({
      state: latestState,
      acceptedCount: latestAcceptedCount,
      rejectedCount: latestRejectedCount,
      payloadMode: "Encrypted",
    });
  }, [latestAcceptedCount, latestRejectedCount, latestState, props]);

  function addYesNoQuestion() {
    const index = questions.length + 1;
    setQuestions((current) => [
      ...current,
      {
        questionId: `q${index}`,
        type: "yes_no",
        prompt: "",
        required: true,
      },
    ]);
  }

  function addMultipleChoiceQuestion() {
    const index = questions.length + 1;
    setQuestions((current) => [
      ...current,
      {
        questionId: `q${index}`,
        type: "multiple_choice",
        prompt: "",
        required: true,
        multiSelect: false,
        options: [
          { optionId: "option_1", label: "Option 1" },
          { optionId: "option_2", label: "Option 2" },
        ],
      },
    ]);
  }

  function addFreeTextQuestion() {
    const index = questions.length + 1;
    setQuestions((current) => [
      ...current,
      {
        questionId: `q${index}`,
        type: "free_text",
        prompt: "",
        required: false,
        maxLength: 500,
      },
    ]);
  }

  function duplicateQuestion(index: number) {
    setQuestions((current) => {
      const source = current[index];
      if (!source) {
        return current;
      }
      const duplicated = {
        ...source,
        questionId: `${source.questionId}_copy`,
      };
      return [...current.slice(0, index + 1), duplicated, ...current.slice(index + 1)];
    });
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    setQuestions((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      return next;
    });
  }

  function deleteQuestion(index: number) {
    setQuestions((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  const builtDefinition = useMemo(() => {
    const closeMinutes = Number.parseInt(closeAfterMinutes, 10);
    if (!coordinatorNpub.trim() || !questionnaireId.trim() || !Number.isFinite(closeMinutes) || closeMinutes <= 0) {
      return null;
    }
    return buildDefinition({
      questionnaireId: questionnaireId.trim(),
      coordinatorPubkey: coordinatorNpub,
      title: title.trim(),
      description: description.trim(),
      closeAfterMinutes: closeMinutes,
      questions,
    });
  }, [closeAfterMinutes, coordinatorNpub, description, questionnaireId, questions, title]);

  const inviteLink = useMemo(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return "";
    }
    try {
      const next = new URL("vote.html", window.location.href);
      next.searchParams.set("questionnaire", id);
      return next.toString();
    } catch {
      return "";
    }
  }, [questionnaireId]);

  const titleReady = title.trim().length > 0;
  const hasQuestion = questions.length > 0;
  const hasKnownVoter = (props.knownVoterCount ?? 0) > 0;
  const questionsValid = questions.length > 0 && questions.every((question) => isQuestionDraftValid(question));
  const publishPreconditionsReady = titleReady && hasQuestion && hasKnownVoter && questionsValid;
  const publishValidation = useMemo(
    () => (builtDefinition ? validateQuestionnaireDefinition(builtDefinition) : null),
    [builtDefinition],
  );
  const canPublishDraft = Boolean(
    builtDefinition
    && coordinatorNsec.trim()
    && publishValidation?.valid
    && publishPreconditionsReady,
  );
  const canOpenQuestionnaire = latestState !== "open" && Boolean(latestDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canCloseQuestionnaire = latestState === "open" && Boolean(latestDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canPublishResults = Boolean(
    latestDefinition
    && coordinatorNsec.trim()
    && coordinatorNpub.trim()
    && (latestState === "closed" || latestState === "results_published"),
  );
  const publishedDefinition = Boolean(latestDefinition);
  const currentState: QuestionnaireStateValue = latestState ?? "draft";
  const knownVoterCount = props.knownVoterCount ?? 0;
  const responseCompletionPercent = knownVoterCount > 0
    ? Math.round((latestAcceptedCount / knownVoterCount) * 100)
    : 0;
  const responseCompletionRatio = knownVoterCount > 0
    ? Math.min(100, Math.max(0, (latestAcceptedCount / knownVoterCount) * 100))
    : 0;
  const buildStateLabel = !publishedDefinition
    ? "Draft"
    : currentState === "results_published"
      ? "Counted"
      : currentState === "closed"
        ? "Ended"
        : currentState === "open"
          ? "Open"
      : "Published";
  const checklistDescriptionAdded = description.trim().length > 0;
  const checklistNotPublished = !publishedDefinition;
  const metadataStateLabel = formatQuestionnaireMetadataState(latestState, Boolean(latestDefinition));
  const selectedQuestionnaireOptions = availableQuestionnaireIds.length > 0
    ? availableQuestionnaireIds
    : (questionnaireId.trim() ? [questionnaireId.trim()] : []);
  const questionResultCards = useMemo(() => {
    if (!latestDefinition) {
      return [];
    }
    const acceptedTotal = latestAcceptedResponses.length;
    return latestDefinition.questions.map((question, index) => {
      if (question.type === "yes_no") {
        let yesCount = 0;
        let noCount = 0;
        for (const response of latestAcceptedResponses) {
          const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
          if (answer?.answerType === "yes_no") {
            if (answer.value) {
              yesCount += 1;
            } else {
              noCount += 1;
            }
          }
        }
        return {
          questionId: question.questionId,
          index,
          prompt: question.prompt,
          typeBadge: "Yes / No",
          kind: "yes_no" as const,
          yesCount,
          noCount,
          acceptedTotal,
        };
      }
      if (question.type === "multiple_choice") {
        const optionCounts = new Map(question.options.map((option) => [option.optionId, 0]));
        for (const response of latestAcceptedResponses) {
          const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
          if (answer?.answerType === "multiple_choice") {
            for (const optionId of answer.selectedOptionIds) {
              optionCounts.set(optionId, (optionCounts.get(optionId) ?? 0) + 1);
            }
          }
        }
        return {
          questionId: question.questionId,
          index,
          prompt: question.prompt,
          typeBadge: "Multiple choice",
          kind: "multiple_choice" as const,
          rows: question.options.map((option) => ({
            optionId: option.optionId,
            label: option.label,
            count: optionCounts.get(option.optionId) ?? 0,
          })),
          acceptedTotal,
        };
      }

      const responses = latestAcceptedResponses
        .map((entry) => {
          const answer = entry.payload.answers.find((answerEntry) => answerEntry.questionId === question.questionId);
          if (answer?.answerType !== "free_text") {
            return null;
          }
          const trimmed = answer.text.trim();
          if (!trimmed) {
            return null;
          }
          return {
            responderId: deriveActorDisplayId(entry.authorPubkey),
            text: trimmed,
            submittedAt: entry.payload.submittedAt,
          };
        })
        .filter((entry): entry is { responderId: string; text: string; submittedAt: number } => Boolean(entry));

      return {
        questionId: question.questionId,
        index,
        prompt: question.prompt,
        typeBadge: "Text",
        kind: "text" as const,
        responses,
      };
    });
  }, [latestAcceptedResponses, latestDefinition]);
  const responders = useMemo(() => (
    latestAcceptedResponses
      .map((response) => ({
        markerToken: response.authorPubkey,
        responderId: deriveActorDisplayId(response.authorPubkey),
        submittedAt: response.payload.submittedAt,
      }))
      .sort((left, right) => left.responderId.localeCompare(right.responderId))
  ), [latestAcceptedResponses]);
  const publishButtonDisabled = !canPublishResults || latestAcceptedCount <= 0;
  const publishStatusText = useMemo(() => {
    if (status === "Computing and publishing questionnaire results...") {
      return "Publishing...";
    }
    if (status === "Result publishing failed." || status === "Result publish partially failed.") {
      return "Publish failed";
    }
    if (latestState === "results_published") {
      return "Already published";
    }
    if (latestAcceptedCount <= 0) {
      return "Nothing to publish yet";
    }
    if (canPublishResults) {
      return "Ready to publish";
    }
    return "Nothing to publish yet";
  }, [canPublishResults, latestAcceptedCount, latestState, status]);

  async function publishDefinition() {
    if (!coordinatorNsec.trim() || !builtDefinition) {
      setStatus("Coordinator key or questionnaire definition is missing.");
      return;
    }

    if (!publishPreconditionsReady) {
      setStatus("Publish draft is blocked until all readiness checks are complete.");
      return;
    }

    const validation = validateQuestionnaireDefinition(builtDefinition);
    if (!validation.valid) {
      setStatus(`Definition invalid: ${validation.errors[0] ?? "unknown_error"}.`);
      return;
    }

    setStatus("Publishing questionnaire definition...");
    setDefinitionPublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const result = await publishQuestionnaireDefinition({
        coordinatorNsec,
        definition: builtDefinition,
      });
      setDefinitionPublishDiagnostic({
        attempted: true,
        succeeded: result.successes > 0,
        eventId: result.eventId,
        kind: result.event.kind,
        tags: result.event.tags,
        relayTargets: result.relayResults.map((entry) => entry.relay),
        relaySuccessCount: result.successes,
      });
      if (result.successes > 0) {
        setStatus(`Questionnaire draft published (${result.successes}/${result.relayResults.length} relays).`);
        await publishState("draft");
      } else {
        setStatus("Questionnaire draft publish failed.");
        await refresh();
      }
    } catch {
      setDefinitionPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Questionnaire draft publish failed.");
    }
  }

  async function publishState(state: QuestionnaireStateValue) {
    const id = questionnaireId.trim();
    if (!coordinatorNsec.trim() || !coordinatorNpub.trim() || !id) {
      setStatus("Coordinator key or questionnaire id is missing.");
      return;
    }

    setStatus(`Publishing questionnaire state (${state})...`);
    setStatePublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const result = await publishQuestionnaireState({
        coordinatorNsec,
        stateEvent: {
          schemaVersion: 1,
          eventType: "questionnaire_state",
          questionnaireId: id,
          state,
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpub,
        },
      });
      setStatePublishDiagnostic({
        attempted: true,
        succeeded: result.successes > 0,
        eventId: result.eventId,
        kind: result.event.kind,
        tags: result.event.tags,
        relayTargets: result.relayResults.map((entry) => entry.relay),
        relaySuccessCount: result.successes,
      });
      setStatus(
        result.successes > 0
          ? `Questionnaire state '${state}' published (${result.successes}/${result.relayResults.length} relays).`
          : `Questionnaire state '${state}' publish failed.`,
      );
      await refresh();
    } catch {
      setStatePublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus(`Questionnaire state '${state}' publish failed.`);
    }
  }

  async function publishResults() {
    if (!latestDefinition || !coordinatorNsec.trim() || !coordinatorNpub.trim()) {
      setStatus("Load the questionnaire definition before publishing results.");
      return;
    }

    setStatus("Computing and publishing questionnaire results...");
    setResultPublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const responseEvents = (await fetchQuestionnaireEventsWithFallback({
        questionnaireId: latestDefinition.questionnaireId,
        kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseContent(event.content),
      })).events;
      const processed = processQuestionnaireResponses({
        definition: latestDefinition,
        responseEvents,
        coordinatorNsec,
      });
      const summary = buildQuestionnaireResultSummary({
        definition: latestDefinition,
        coordinatorPubkey: coordinatorNpub,
        acceptedResponses: processed.accepted,
        rejectedResponses: processed.rejected,
      });

      const publishSummary = await publishQuestionnaireResultSummary({
        coordinatorNsec,
        resultSummary: summary,
      });
      const publishStateResult = await publishQuestionnaireState({
        coordinatorNsec,
        stateEvent: {
          schemaVersion: 1,
          eventType: "questionnaire_state",
          questionnaireId: latestDefinition.questionnaireId,
          state: "results_published",
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpub,
        },
      });

      if (publishSummary.successes > 0 && publishStateResult.successes > 0) {
        setResultPublishDiagnostic({
          attempted: true,
          succeeded: true,
          eventId: publishSummary.eventId,
          kind: publishSummary.event.kind,
          tags: publishSummary.event.tags,
          relayTargets: publishSummary.relayResults.map((entry) => entry.relay),
          relaySuccessCount: publishSummary.successes,
        });
        setStatus(`Results published. Accepted=${summary.acceptedResponseCount}, Rejected=${summary.rejectedResponseCount}.`);
      } else {
        setResultPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
        setStatus("Result publish partially failed.");
      }
      await refresh();
    } catch {
      setResultPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Result publishing failed.");
    }
  }

  const view = props.view ?? "build";

  if (view === "responses") {
    return (
      <div className='simple-voter-card simple-questionnaire-panel'>
        <h3 className='simple-voter-question'>Responses</h3>
        <p className='simple-voter-note'>View submitted responses and publish the response summary.</p>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Questionnaire</h4>
          <label className='simple-voter-label' htmlFor='questionnaire-select'>Questionnaire</label>
          <select
            id='questionnaire-select'
            className='simple-voter-input'
            value={questionnaireId}
            onChange={(event) => setQuestionnaireId(event.target.value)}
          >
            {selectedQuestionnaireOptions.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Metadata</h4>
          <dl className='simple-questionnaire-metadata-grid'>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Questionnaire ID</dt>
              <dd>{questionnaireId.trim() || "Not set"}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>State</dt>
              <dd>{metadataStateLabel}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Opened</dt>
              <dd>{latestDefinition?.openAt ? formatUnixTimestamp(latestDefinition.openAt) : "Not opened"}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Closing / Closed</dt>
              <dd>{latestDefinition?.closeAt ? formatUnixTimestamp(latestDefinition.closeAt) : "Not scheduled"}</dd>
            </div>
          </dl>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Responses</h4>
          <div className='simple-questionnaire-summary-card' aria-live='polite'>
            <p className='simple-questionnaire-summary-label'>Responses</p>
            <p className='simple-questionnaire-summary-value'>{latestAcceptedCount} / {knownVoterCount}</p>
            <p className='simple-questionnaire-summary-label'>Completion</p>
            <p className='simple-questionnaire-summary-value'>{responseCompletionPercent}%</p>
            <div className='simple-questionnaire-progress' aria-hidden='true'>
              <span style={{ width: `${responseCompletionRatio}%` }} />
            </div>
          </div>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <button
              type='button'
              className='simple-voter-primary'
              disabled={publishButtonDisabled}
              onClick={() => void publishResults()}
            >
              Publish summary
            </button>
            <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <p className='simple-voter-note'>{publishStatusText}</p>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Question results</h4>
          {questionResultCards.length === 0 ? (
            <p className='simple-voter-empty'>No question results yet.</p>
          ) : (
            <div className='simple-questionnaire-question-list'>
              {questionResultCards.map((card) => (
                <article key={card.questionId} className='simple-questionnaire-question-card'>
                  <div className='simple-questionnaire-question-head'>
                    <p className='simple-voter-question'>Question {card.index + 1}</p>
                    <span className='simple-questionnaire-question-type'>{card.typeBadge}</span>
                  </div>
                  <p className='simple-voter-note'>{card.prompt || "Untitled question"}</p>
                  {card.kind === "yes_no" ? (
                    <div className='simple-questionnaire-results-stack'>
                      <div className='simple-questionnaire-progress' aria-hidden='true'>
                        <span style={{ width: percentageLabel(card.yesCount, card.acceptedTotal) }} />
                      </div>
                      <p className='simple-voter-note'>
                        Yes - {percentageLabel(card.yesCount, card.acceptedTotal)} ({card.yesCount})
                      </p>
                      <p className='simple-voter-note'>
                        No - {percentageLabel(card.noCount, card.acceptedTotal)} ({card.noCount})
                      </p>
                    </div>
                  ) : null}
                  {card.kind === "multiple_choice" ? (
                    <div className='simple-questionnaire-results-stack'>
                      {card.rows.map((row) => (
                        <div key={row.optionId} className='simple-questionnaire-option-row'>
                          <div className='simple-questionnaire-progress' aria-hidden='true'>
                            <span style={{ width: percentageLabel(row.count, card.acceptedTotal) }} />
                          </div>
                          <p className='simple-voter-note'>
                            {row.label} - {percentageLabel(row.count, card.acceptedTotal)} ({row.count})
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {card.kind === "text" ? (
                    <div className='simple-questionnaire-results-stack'>
                      <p className='simple-voter-note'>Responses: {card.responses.length}</p>
                      <button
                        type='button'
                        className='simple-voter-secondary'
                        onClick={() => setExpandedTextQuestionIds((current) => ({
                          ...current,
                          [card.questionId]: !current[card.questionId],
                        }))}
                      >
                        {expandedTextQuestionIds[card.questionId] ? "Hide responses" : "Show responses"}
                      </button>
                      {expandedTextQuestionIds[card.questionId] ? (
                        card.responses.length > 0 ? (
                          <ul className='simple-voter-list'>
                            {card.responses.map((entry, index) => (
                              <li key={`${card.questionId}-${index}`} className='simple-voter-list-item'>
                                {entry.text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className='simple-voter-empty'>No text responses yet.</p>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Responders</h4>
          {responders.length === 0 ? (
            <p className='simple-voter-empty'>No responders yet. Responders will appear here after submitting a response.</p>
          ) : (
            <ul className='simple-questionnaire-responder-list'>
              {responders.map((responder) => (
                <li key={responder.markerToken} className='simple-questionnaire-responder-row'>
                  <TokenFingerprint tokenId={responder.markerToken} compact showQr={false} hideMetadata />
                  <p className='simple-voter-question'>{responder.responderId}</p>
                  <p className='simple-voter-note'>Submitted {formatUnixTimestamp(responder.submittedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {status ? <p className='simple-voter-note'>{status}</p> : null}
      </div>
    );
  }

  return (
    <div className='simple-voter-card simple-questionnaire-panel'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>{title.trim() || "Untitled questionnaire"}</h3>
          <p className='simple-voter-note'>State: {buildStateLabel}</p>
        </div>
      </div>

      <h4 className='simple-voter-section-title'>Questionnaire identity</h4>
      <label className='simple-voter-label' htmlFor='questionnaire-id'>Questionnaire ID</label>
      <input
        id='questionnaire-id'
        className='simple-voter-input'
        value={questionnaireId}
        onChange={(event) => setQuestionnaireId(event.target.value)}
      />
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => setQuestionnaireId(generateQuestionnaireId())}>
          Generate ID
        </button>
        <button type='button' className='simple-voter-secondary' onClick={() => void navigator.clipboard.writeText(questionnaireId)}>
          Copy ID
        </button>
        <button type='button' className='simple-voter-secondary' onClick={() => setShowInviteQr((current) => !current)}>
          Show QR
        </button>
      </div>
      {showInviteQr && questionnaireId.trim() ? (
        <SimpleQrPanel
          value={inviteLink || questionnaireId.trim()}
          title='Voter link'
          copyLabel='Copy link'
          downloadLabel='Download QR'
          downloadFilename='questionnaire-voter-link-qr.png'
        />
      ) : null}
      <label className='simple-voter-label' htmlFor='questionnaire-title'>Name</label>
      <input
        id='questionnaire-title'
        className='simple-voter-input'
        value={title}
        placeholder='Enter questionnaire name'
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className='simple-voter-label' htmlFor='questionnaire-description'>Description</label>
      <textarea
        id='questionnaire-description'
        className='simple-voter-input'
        rows={3}
        value={description}
        placeholder='Describe what this questionnaire is for'
        onChange={(event) => setDescription(event.target.value)}
      />
      <label className='simple-voter-label' htmlFor='questionnaire-close-minutes'>Close after (minutes)</label>
      <input
        id='questionnaire-close-minutes'
        className='simple-voter-input'
        value={closeAfterMinutes}
        onChange={(event) => setCloseAfterMinutes(event.target.value)}
      />

      <h4 className='simple-voter-section-title'>Questionnaire state</h4>
      <ul className='simple-vote-status-list'>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> State: {buildStateLabel}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Opened: {formatUnixTimestamp(latestDefinition?.openAt ?? null)}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Closing / Closed: {formatUnixTimestamp(latestDefinition?.closeAt ?? null)}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Responses: {latestAcceptedCount} / {knownVoterCount} ({responseCompletionPercent}%)</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Coordinators: 1 of 1</li>
      </ul>

      <h4 className='simple-voter-section-title'>Questions</h4>
      {questions.length === 0 ? (
        <div className='simple-vote-empty-state'>
          <p className='simple-voter-question'>No questions yet. Add your first question to begin building the questionnaire.</p>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <button type='button' className='simple-voter-secondary' onClick={addYesNoQuestion}>Add yes/no question</button>
            <button type='button' className='simple-voter-secondary' onClick={addMultipleChoiceQuestion}>Add multiple choice question</button>
            <button type='button' className='simple-voter-secondary' onClick={addFreeTextQuestion}>Add text question</button>
          </div>
        </div>
      ) : (
        <>
          <div className='simple-voter-action-row simple-voter-action-row-inline'>
            <button type='button' className='simple-voter-secondary' onClick={addYesNoQuestion}>Add yes/no question</button>
            <button type='button' className='simple-voter-secondary' onClick={addMultipleChoiceQuestion}>Add multiple choice question</button>
            <button type='button' className='simple-voter-secondary' onClick={addFreeTextQuestion}>Add text question</button>
          </div>
          <div className='simple-questionnaire-question-list'>
            {questions.map((question, index) => (
              <div key={`${question.questionId}-${index}`} className='simple-questionnaire-question-card'>
                <div className='simple-questionnaire-question-head'>
                  <p className='simple-voter-question'>Question {index + 1}</p>
                  <span className='simple-questionnaire-question-type'>{questionTypeLabel(question.type)}</span>
                </div>
                <label className='simple-voter-label' htmlFor={`question-prompt-${index}`}>Prompt</label>
                <input
                  id={`question-prompt-${index}`}
                  className='simple-voter-input'
                  value={question.prompt}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setQuestions((current) => current.map((entry, entryIndex) => (
                      entryIndex === index ? { ...entry, prompt: nextValue } : entry
                    )));
                  }}
                />
                <label className='simple-voter-note'>
                  <input
                    type='checkbox'
                    checked={question.required}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setQuestions((current) => current.map((entry, entryIndex) => (
                        entryIndex === index ? { ...entry, required: checked } : entry
                      )));
                    }}
                  />
                  {" "}
                  Required
                </label>
                {question.type === "multiple_choice" ? (
                  <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                    <p className='simple-voter-note'>Options</p>
                    {question.options.map((option, optionIndex) => (
                      <input
                        key={`${question.questionId}-option-${optionIndex}`}
                        className='simple-voter-input'
                        value={option.label}
                        onChange={(event) => {
                          const nextLabel = event.target.value;
                          setQuestions((current) => current.map((entry, entryIndex) => {
                            if (entryIndex !== index || entry.type !== "multiple_choice") {
                              return entry;
                            }
                            return {
                              ...entry,
                              options: entry.options.map((entryOption, entryOptionIndex) => (
                                entryOptionIndex === optionIndex ? { ...entryOption, label: nextLabel } : entryOption
                              )),
                            };
                          }));
                        }}
                      />
                    ))}
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      onClick={() => {
                        setQuestions((current) => current.map((entry, entryIndex) => {
                          if (entryIndex !== index || entry.type !== "multiple_choice") {
                            return entry;
                          }
                          const nextIndex = entry.options.length + 1;
                          return {
                            ...entry,
                            options: [...entry.options, { optionId: `option_${nextIndex}`, label: `Option ${nextIndex}` }],
                          };
                        }));
                      }}
                    >
                      Add option
                    </button>
                    <label className='simple-voter-note'>
                      <input
                        type='checkbox'
                        checked={question.multiSelect}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setQuestions((current) => current.map((entry, entryIndex) => (
                            entryIndex === index && entry.type === "multiple_choice"
                              ? { ...entry, multiSelect: checked }
                              : entry
                          )));
                        }}
                      />
                      {" "}
                      Allow multiple selections
                    </label>
                  </div>
                ) : null}
                {question.type === "free_text" ? (
                  <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                    <label className='simple-voter-label' htmlFor={`question-max-${index}`}>Maximum length</label>
                    <input
                      id={`question-max-${index}`}
                      className='simple-voter-input'
                      value={String(question.maxLength)}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        setQuestions((current) => current.map((entry, entryIndex) => (
                          entryIndex === index && entry.type === "free_text"
                            ? { ...entry, maxLength: Number.isFinite(parsed) && parsed > 0 ? parsed : entry.maxLength }
                            : entry
                        )));
                      }}
                    />
                  </div>
                ) : null}
                <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                  <button type='button' className='simple-voter-secondary' onClick={() => duplicateQuestion(index)}>Duplicate</button>
                  <button type='button' className='simple-voter-secondary' onClick={() => moveQuestion(index, -1)}>Move up</button>
                  <button type='button' className='simple-voter-secondary' onClick={() => moveQuestion(index, 1)}>Move down</button>
                  <button type='button' className='simple-voter-secondary' onClick={() => deleteQuestion(index)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 className='simple-voter-section-title'>Readiness checklist</h4>
      <ul className='simple-vote-status-list'>
        <li className={titleReady ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{titleReady ? "✓" : "•"}</span> Title added</li>
        <li className={checklistDescriptionAdded ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{checklistDescriptionAdded ? "✓" : "•"}</span> Description added</li>
        <li className={hasQuestion ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{hasQuestion ? "✓" : "•"}</span> At least one question added</li>
        <li className={hasKnownVoter ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{hasKnownVoter ? "✓" : "•"}</span> Respondents known</li>
        <li className={checklistNotPublished ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{checklistNotPublished ? "✓" : "•"}</span> Questionnaire not yet published</li>
      </ul>

      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <button type='button' className='simple-voter-secondary' onClick={() => setShowPreview((current) => !current)}>
          Preview questionnaire
        </button>
        <button type='button' className='simple-voter-secondary' disabled={!inviteLink} onClick={() => {
          if (!inviteLink) {
            return;
          }
          void navigator.clipboard.writeText(inviteLink);
        }}
        >
          Copy invite link
        </button>
        {!publishedDefinition ? (
          <button type='button' className='simple-voter-primary' disabled={!canPublishDraft} onClick={() => void publishDefinition()}>
            Publish Questionnaire
          </button>
        ) : currentState === "open" ? (
          <button type='button' className='simple-voter-primary' disabled={!canCloseQuestionnaire} onClick={() => void publishState("closed")}>
            Close Questionnaire
          </button>
        ) : currentState === "closed" ? (
          <button type='button' className='simple-voter-primary' disabled={!canPublishResults} onClick={() => void publishResults()}>
            Count Responses
          </button>
        ) : currentState === "results_published" ? (
          <button type='button' className='simple-voter-primary' disabled>
            Counted
          </button>
        ) : (
          <button type='button' className='simple-voter-primary' disabled={!canOpenQuestionnaire} onClick={() => void publishState("open")}>
            Open Questionnaire
          </button>
        )}
      </div>
      {!coordinatorNsec.trim() ? (
        <p className='simple-voter-note'>Coordinator key is not loaded yet.</p>
      ) : null}
      {publishValidation && !publishValidation.valid ? (
        <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
      ) : null}
      {showPreview ? (
        <div className='simple-questionnaire-preview'>
          <h4 className='simple-voter-section-title'>Draft preview</h4>
          <pre>{JSON.stringify(builtDefinition, null, 2)}</pre>
        </div>
      ) : null}
      {status ? <p className='simple-voter-note'>{status}</p> : null}
      {!latestDefinition ? <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p> : null}
    </div>
  );
}
