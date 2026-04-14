import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQuestionnaireEventsWithFallback, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishQuestionnaireDefinition, publishQuestionnaireResultSummary, publishQuestionnaireState, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND } from "./questionnaireNostr";
import { buildQuestionnaireResultSummary, processQuestionnaireResponses, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireResultSummary, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { loadSimpleActorState } from "./simpleLocalState";
import { validateQuestionnaireDefinition, type QuestionnaireDefinition, type QuestionnaireStateValue } from "./questionnaireProtocol";

const DEFAULT_QUESTIONNAIRE_ID = "course_feedback_2026_term1";
const REFRESH_INTERVAL_MS = 15000;

type QuestionnairePublishDiagnostic = {
  attempted: boolean;
  succeeded: boolean;
  eventId: string | null;
  kind: number | null;
  tags: string[][];
  relayTargets: string[];
  relaySuccessCount: number;
};

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
}): QuestionnaireDefinition {
  const createdAt = nowUnix();
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
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
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Was the course material clear?",
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        prompt: "How would you rate the pace?",
        required: true,
        multiSelect: false,
        options: [
          { optionId: "slow", label: "Too slow" },
          { optionId: "good", label: "About right" },
          { optionId: "fast", label: "Too fast" },
        ],
      },
      {
        questionId: "q3",
        type: "free_text",
        prompt: "What should be improved?",
        required: false,
        maxLength: 1000,
      },
    ],
  };
}

export default function QuestionnaireCoordinatorPanel() {
  const [questionnaireId, setQuestionnaireId] = useState(DEFAULT_QUESTIONNAIRE_ID);
  const [title, setTitle] = useState("Course feedback");
  const [description, setDescription] = useState("Please answer all required questions.");
  const [closeAfterMinutes, setCloseAfterMinutes] = useState("60");
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
    void loadSimpleActorState("coordinator").then((state) => {
      if (!state?.keypair) {
        return;
      }
      setCoordinatorNsec(state.keypair.nsec);
      setCoordinatorNpub(state.keypair.npub);
    }).catch(() => undefined);
  }, []);

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
      setLatestState(state?.state ?? null);
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

  const builtDefinition = useMemo(() => {
    const closeMinutes = Number.parseInt(closeAfterMinutes, 10);
    if (!coordinatorNpub.trim() || !questionnaireId.trim() || !Number.isFinite(closeMinutes) || closeMinutes <= 0) {
      return null;
    }
    return buildDefinition({
      questionnaireId: questionnaireId.trim(),
      coordinatorPubkey: coordinatorNpub,
      title: title.trim() || "Course feedback",
      description: description.trim(),
      closeAfterMinutes: closeMinutes,
    });
  }, [closeAfterMinutes, coordinatorNpub, description, questionnaireId, title]);

  async function publishDefinition() {
    if (!coordinatorNsec.trim() || !builtDefinition) {
      setStatus("Coordinator key or questionnaire definition is missing.");
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
      setStatus(
        result.successes > 0
          ? `Questionnaire definition published (${result.successes}/${result.relayResults.length} relays).`
          : "Questionnaire definition publish failed.",
      );
      await refresh();
    } catch {
      setDefinitionPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Questionnaire definition publish failed.");
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
    <div className='simple-voter-card'>
      <h3 className='simple-voter-question'>Private questionnaire coordinator</h3>
      <p className='simple-voter-note'>Phase 17 private-first flow: public questionnaire, private encrypted responses, public aggregate summary.</p>

      <label className='simple-voter-label' htmlFor='questionnaire-id'>Questionnaire id</label>
      <input
        id='questionnaire-id'
        className='simple-voter-input'
        value={questionnaireId}
        onChange={(event) => setQuestionnaireId(event.target.value)}
      />

      <label className='simple-voter-label' htmlFor='questionnaire-title'>Title</label>
      <input
        id='questionnaire-title'
        className='simple-voter-input'
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <label className='simple-voter-label' htmlFor='questionnaire-description'>Description</label>
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

      <div className='simple-voter-action-row simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
          Refresh
        </button>
        <button type='button' className='simple-voter-primary' onClick={() => void publishDefinition()}>
          Publish definition
        </button>
      </div>

      <div className='simple-voter-action-row simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => void publishState("open")}>
          Set open
        </button>
        <button type='button' className='simple-voter-secondary' onClick={() => void publishState("closed")}>
          Set closed
        </button>
        <button type='button' className='simple-voter-primary' onClick={() => void publishResults()}>
          Publish results
        </button>
      </div>

      <ul className='simple-vote-status-list'>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Coordinator key loaded: {coordinatorNpub ? "yes" : "no"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Latest state: {latestState ?? "none"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Decrypted responses: accepted {latestAcceptedCount}, rejected {latestRejectedCount}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Latest published result accepted count: {latestResultAcceptedCount ?? "none"}
        </li>
      </ul>

      {status ? <p className='simple-voter-note'>{status}</p> : null}
      {!latestDefinition ? <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p> : null}
    </div>
  );
}
