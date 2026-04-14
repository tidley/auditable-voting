import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQuestionnaireEventsWithFallback, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishQuestionnaireDefinition, publishQuestionnaireResultSummary, publishQuestionnaireState, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND } from "./questionnaireNostr";
import { buildQuestionnaireResultSummary, deriveEffectiveQuestionnaireState, formatQuestionnaireStateLabel, processQuestionnaireResponses, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireResultSummary, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { loadSimpleActorState } from "./simpleLocalState";
import {
  validateQuestionnaireDefinition,
  type QuestionnaireDefinition,
  type QuestionnaireQuestion,
  type QuestionnaireStateValue,
} from "./questionnaireProtocol";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import SimpleQrPanel from "./SimpleQrPanel";

const DEFAULT_QUESTIONNAIRE_ID = "course_feedback_2026_term1";
const REFRESH_INTERVAL_MS = 15000;
const IDENTITY_REFRESH_INTERVAL_MS = 2000;

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
  onStatusChange?: (status: {
    state: QuestionnaireStateValue | null;
    acceptedCount: number;
    rejectedCount: number;
    payloadMode: "Encrypted" | "Public";
  }) => void;
};

type QuestionnaireQuestionDraft = QuestionnaireQuestion;
type QuestionnaireTab = "build" | "audience" | "publish" | "responses" | "results";
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
  const [title, setTitle] = useState("Course feedback");
  const [description, setDescription] = useState("Please answer all required questions.");
  const [closeAfterMinutes, setCloseAfterMinutes] = useState("60");
  const [questions, setQuestions] = useState<QuestionnaireQuestionDraft[]>([]);
  const [activeTab, setActiveTab] = useState<QuestionnaireTab>("build");
  const [showNpubQr, setShowNpubQr] = useState(false);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [coordinatorNsec, setCoordinatorNsec] = useState("");
  const [coordinatorNpub, setCoordinatorNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [latestDefinition, setLatestDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [latestState, setLatestState] = useState<QuestionnaireStateValue | null>(null);
  const [latestAcceptedCount, setLatestAcceptedCount] = useState(0);
  const [latestRejectedCount, setLatestRejectedCount] = useState(0);
  const [latestResultAcceptedCount, setLatestResultAcceptedCount] = useState<number | null>(null);
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
  }, [props.coordinatorNpub, props.coordinatorNsec]);

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
      const definitionEvents = definitionFetch.events;
      const stateEvents = stateFetch.events;
      const responseEvents = responseFetch.events;
      const resultEvents = resultFetch.events;
      setDefinitionReadDiagnostics(definitionFetch.diagnostics);
      setStateReadDiagnostics(stateFetch.diagnostics);
      setResponseReadDiagnostics(responseFetch.diagnostics);
      setResultReadDiagnostics(resultFetch.diagnostics);

      const definition = selectLatestQuestionnaireDefinition(definitionEvents);
      const state = selectLatestQuestionnaireState(stateEvents);
      const resultSummary = selectLatestQuestionnaireResultSummary(resultEvents);
      setDefinitionEventCount(definitionEvents.length);
      setStateEventCount(stateEvents.length);
      setResponseEventCount(responseEvents.length);
      setResultEventCount(resultEvents.length);

      setLatestDefinition(definition);
      setLatestState(deriveEffectiveQuestionnaireState({
        definition,
        latestState: state,
      }));
      setLatestResultAcceptedCount(resultSummary?.acceptedResponseCount ?? null);

      if (definition && coordinatorNsec.trim()) {
        const processed = processQuestionnaireResponses({
          definition,
          responseEvents,
          coordinatorNsec,
        });
        setLatestAcceptedCount(processed.accepted.length);
        setLatestRejectedCount(processed.rejected.length);
      } else {
        setLatestAcceptedCount(0);
        setLatestRejectedCount(0);
      }
    } catch {
      setStatus("Questionnaire refresh failed.");
    }
  }, [coordinatorNsec, questionnaireId]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

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

  return (
    <div className='simple-voter-card simple-questionnaire-panel'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>{title.trim() || "Untitled questionnaire"}</h3>
          <p className='simple-voter-note'>Status: {formatQuestionnaireStateLabel(currentState)}</p>
        </div>
        <div className='simple-voter-action-row-inline'>
          <button
            type='button'
            className='simple-voter-secondary'
            disabled={!coordinatorNpub.trim()}
            onClick={() => {
              if (!coordinatorNpub.trim()) {
                return;
              }
              void navigator.clipboard.writeText(coordinatorNpub.trim());
            }}
          >
            Copy npub
          </button>
          <button
            type='button'
            className='simple-voter-secondary'
            disabled={!coordinatorNpub.trim()}
            onClick={() => setShowNpubQr((current) => !current)}
          >
            Show QR
          </button>
        </div>
      </div>
      {showNpubQr && coordinatorNpub.trim() ? (
        <SimpleQrPanel
          value={coordinatorNpub.trim()}
          title='Coordinator npub'
          copyLabel='Copy npub'
          downloadLabel='Download QR'
          downloadFilename='coordinator-npub-qr.png'
        />
      ) : null}

      <div
        className='simple-questionnaire-tabs'
        role='tablist'
        aria-label='Questionnaire workflow'
      >
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === "build"}
          className={`simple-voter-tab${activeTab === "build" ? " is-active" : ""}`}
          onClick={() => setActiveTab("build")}
        >
          Build
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === "audience"}
          className={`simple-voter-tab${activeTab === "audience" ? " is-active" : ""}`}
          onClick={() => setActiveTab("audience")}
        >
          Audience
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === "publish"}
          className={`simple-voter-tab${activeTab === "publish" ? " is-active" : ""}`}
          onClick={() => setActiveTab("publish")}
        >
          Publish
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === "responses"}
          className={`simple-voter-tab${activeTab === "responses" ? " is-active" : ""}`}
          onClick={() => setActiveTab("responses")}
        >
          Responses
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === "results"}
          className={`simple-voter-tab${activeTab === "results" ? " is-active" : ""}`}
          onClick={() => setActiveTab("results")}
        >
          Results
        </button>
      </div>

      {activeTab === "build" ? (
        <section className='simple-voter-tab-panel' role='tabpanel' aria-label='Build questionnaire'>
          <h4 className='simple-voter-section-title'>Questionnaire details</h4>
          <label className='simple-voter-label' htmlFor='questionnaire-id'>Questionnaire ID</label>
          <input
            id='questionnaire-id'
            className='simple-voter-input'
            value={questionnaireId}
            onChange={(event) => setQuestionnaireId(event.target.value)}
          />

          <label className='simple-voter-label' htmlFor='questionnaire-title'>Questionnaire name</label>
          <input
            id='questionnaire-title'
            className='simple-voter-input'
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <label className='simple-voter-label' htmlFor='questionnaire-description'>Short description</label>
          <textarea
            id='questionnaire-description'
            className='simple-voter-input'
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />

          <label className='simple-voter-label' htmlFor='questionnaire-close-minutes'>Close after (minutes)</label>
          <input
            id='questionnaire-close-minutes'
            className='simple-voter-input'
            value={closeAfterMinutes}
            onChange={(event) => setCloseAfterMinutes(event.target.value)}
          />

          <div className='simple-voter-action-row simple-voter-action-row-inline'>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => setStatus("Draft saved locally.")}
            >
              Save draft
            </button>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => setShowPreview((current) => !current)}
            >
              Preview questionnaire
            </button>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => setActiveTab("audience")}
            >
              Invite voters
            </button>
            <button
              type='button'
              className='simple-voter-primary'
              disabled={!canPublishDraft}
              onClick={() => void publishDefinition()}
            >
              Publish draft
            </button>
          </div>
          <p className='simple-voter-note'>
            Publishing is available after at least 1 voter is known and the questionnaire has at least 1 question.
          </p>
          {!coordinatorNsec.trim() ? (
            <p className='simple-voter-note'>Coordinator key is not loaded yet.</p>
          ) : null}
          {publishValidation && !publishValidation.valid ? (
            <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
          ) : null}

          <h4 className='simple-voter-section-title'>Questions</h4>
          {questions.length === 0 ? (
            <div className='simple-vote-empty-state'>
              <p className='simple-voter-question'>No questions yet. Add your first question to begin building the questionnaire.</p>
              <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                <button type='button' className='simple-voter-secondary' onClick={addYesNoQuestion}>Add text question</button>
                <button type='button' className='simple-voter-secondary' onClick={addMultipleChoiceQuestion}>Add multiple choice question</button>
                <button type='button' className='simple-voter-secondary' onClick={addFreeTextQuestion}>Add free text question</button>
              </div>
            </div>
          ) : (
            <>
              <div className='simple-voter-action-row simple-voter-action-row-inline'>
                <button type='button' className='simple-voter-secondary' onClick={addYesNoQuestion}>Add text question</button>
                <button type='button' className='simple-voter-secondary' onClick={addMultipleChoiceQuestion}>Add multiple choice question</button>
                <button type='button' className='simple-voter-secondary' onClick={addFreeTextQuestion}>Add free text question</button>
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

          {showPreview ? (
            <div className='simple-questionnaire-preview'>
              <h4 className='simple-voter-section-title'>Draft preview</h4>
              <pre>{JSON.stringify(builtDefinition, null, 2)}</pre>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeTab === "audience" ? (
        <section className='simple-voter-tab-panel' role='tabpanel' aria-label='Audience'>
          <h4 className='simple-voter-section-title'>Invited voters</h4>
          <p className='simple-voter-question'>{props.knownVoterCount ?? 0} known voter(s)</p>
          <p className='simple-voter-note'>Share the invite link after the questionnaire draft is published.</p>
          <div className='simple-voter-action-row simple-voter-action-row-inline'>
            <button
              type='button'
              className='simple-voter-secondary'
              disabled={!publishedDefinition || !inviteLink}
              onClick={() => {
                if (!inviteLink) {
                  return;
                }
                void navigator.clipboard.writeText(inviteLink);
              }}
            >
              Copy link
            </button>
            <button
              type='button'
              className='simple-voter-secondary'
              disabled={!publishedDefinition || !inviteLink}
              onClick={() => setShowInviteQr((current) => !current)}
            >
              Show QR
            </button>
          </div>
          {!publishedDefinition ? (
            <p className='simple-voter-note'>QR available after questionnaire is published.</p>
          ) : null}
          {showInviteQr && publishedDefinition && inviteLink ? (
            <SimpleQrPanel
              value={inviteLink}
              title='Questionnaire invite link'
              description='Voters can open this link to join and respond.'
              copyLabel='Copy link'
              downloadLabel='Download QR'
              downloadFilename='questionnaire-invite-qr.png'
            />
          ) : null}

          <h4 className='simple-voter-section-title'>Coordinator status</h4>
          <p className='simple-voter-note'>Lead coordinator: {coordinatorNpub ? "This coordinator" : "Not loaded"}</p>
          <p className='simple-voter-note'>Additional coordinators: 0</p>
          <p className='simple-voter-note'>Threshold: 1 of 1</p>
          <p className='simple-voter-note'>Default: all included coordinators.</p>
        </section>
      ) : null}

      {activeTab === "publish" ? (
        <section className='simple-voter-tab-panel' role='tabpanel' aria-label='Publish'>
          <h4 className='simple-voter-section-title'>Readiness</h4>
          <ul className='simple-vote-status-list'>
            <li className={titleReady ? "is-complete" : "is-pending"}>
              <span className='simple-vote-status-icon' aria-hidden='true'>{titleReady ? "✓" : "•"}</span>
              Questionnaire title added
            </li>
            <li className={hasQuestion ? "is-complete" : "is-pending"}>
              <span className='simple-vote-status-icon' aria-hidden='true'>{hasQuestion ? "✓" : "•"}</span>
              At least one question added
            </li>
            <li className={hasKnownVoter ? "is-complete" : "is-pending"}>
              <span className='simple-vote-status-icon' aria-hidden='true'>{hasKnownVoter ? "✓" : "•"}</span>
              At least one voter invited
            </li>
            <li className={questionsValid ? "is-complete" : "is-pending"}>
              <span className='simple-vote-status-icon' aria-hidden='true'>{questionsValid ? "✓" : "•"}</span>
              All questions valid
            </li>
          </ul>

          {!publishedDefinition ? (
            <>
              <div className='simple-voter-action-row simple-voter-action-row-inline'>
                <button type='button' className='simple-voter-secondary' onClick={() => setStatus("Draft saved locally.")}>
                  Save draft
                </button>
                <button type='button' className='simple-voter-secondary' onClick={() => setActiveTab("audience")}>
                  Invite voters
                </button>
                <button type='button' className='simple-voter-secondary' onClick={() => setShowPreview((current) => !current)}>
                  Preview
                </button>
                <button type='button' className='simple-voter-primary' disabled={!canPublishDraft} onClick={() => void publishDefinition()}>
                  Publish draft
                </button>
              </div>
              <p className='simple-voter-note'>
                Publishing is available after at least 1 voter is known and the questionnaire has at least 1 question.
              </p>
            </>
          ) : null}

          {publishedDefinition && currentState !== "open" && currentState !== "closed" && currentState !== "results_published" ? (
            <div className='simple-voter-action-row simple-voter-action-row-inline'>
              <button
                type='button'
                className='simple-voter-primary'
                disabled={!canOpenQuestionnaire}
                onClick={() => void publishState("open")}
              >
                Start accepting responses
              </button>
              <button type='button' className='simple-voter-secondary' disabled={!inviteLink} onClick={() => {
                if (!inviteLink) {
                  return;
                }
                void navigator.clipboard.writeText(inviteLink);
              }}
              >
                Copy link
              </button>
              <button type='button' className='simple-voter-secondary' disabled={!inviteLink} onClick={() => setShowInviteQr((current) => !current)}>
                Show QR
              </button>
            </div>
          ) : null}

          {currentState === "open" ? (
            <div className='simple-voter-action-row simple-voter-action-row-inline'>
              <button
                type='button'
                className='simple-voter-primary'
                disabled={!canCloseQuestionnaire}
                onClick={() => void publishState("closed")}
              >
                Stop accepting responses
              </button>
              <button type='button' className='simple-voter-secondary' onClick={() => setActiveTab("responses")}>
                View live responses
              </button>
            </div>
          ) : null}

          {(currentState === "closed" || currentState === "results_published") ? (
            <div className='simple-voter-action-row simple-voter-action-row-inline'>
              <button
                type='button'
                className='simple-voter-primary'
                disabled={!canPublishResults}
                onClick={() => void publishResults()}
              >
                Publish summary results
              </button>
            </div>
          ) : null}

          <p className='simple-voter-note'>Current state: {formatQuestionnaireStateLabel(currentState)}</p>
        </section>
      ) : null}

      {activeTab === "responses" ? (
        <section className='simple-voter-tab-panel' role='tabpanel' aria-label='Responses'>
          <h4 className='simple-voter-section-title'>Live responses</h4>
          <div className='simple-voter-action-row simple-voter-action-row-inline'>
            <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <ul className='simple-vote-status-list'>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Latest state: {formatQuestionnaireStateLabel(currentState)}
            </li>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Accepted responses: {latestAcceptedCount}
            </li>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Rejected responses: {latestRejectedCount}
            </li>
          </ul>
        </section>
      ) : null}

      {activeTab === "results" ? (
        <section className='simple-voter-tab-panel' role='tabpanel' aria-label='Results'>
          <h4 className='simple-voter-section-title'>Results</h4>
          <ul className='simple-vote-status-list'>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Latest published result: {latestResultAcceptedCount === null ? "none" : `${latestResultAcceptedCount} accepted`}
            </li>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Accepted responses: {latestAcceptedCount}
            </li>
            <li>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              Rejected responses: {latestRejectedCount}
            </li>
          </ul>
          <div className='simple-voter-action-row simple-voter-action-row-inline'>
            <button
              type='button'
              className='simple-voter-primary'
              disabled={!canPublishResults}
              onClick={() => void publishResults()}
            >
              Publish summary results
            </button>
          </div>
          <p className='simple-voter-note'>State must be Closed before publishing summary results.</p>
        </section>
      ) : null}

      {status ? <p className='simple-voter-note'>{status}</p> : null}
      {!latestDefinition ? <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p> : null}
    </div>
  );
}
