import { useCallback, useEffect, useMemo, useState } from "react";
import { generateSecretKey, nip19 } from "nostr-tools";
import { fetchQuestionnaireEvents, fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishEncryptedQuestionnaireResponse, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND } from "./questionnaireNostr";
import { deriveEffectiveQuestionnaireState, formatQuestionnaireStateLabel, formatQuestionnaireTokenStatusLabel, parseQuestionnaireResultSummaryEvent, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { loadSimpleActorState } from "./simpleLocalState";
import { validateQuestionnaireResponsePayload, type QuestionnaireDefinition, type QuestionnaireResponseAnswer, type QuestionnaireResponsePayload, type QuestionnaireResultSummary } from "./questionnaireProtocol";
import { getSharedNostrPool } from "./sharedNostrPool";

const DEFAULT_QUESTIONNAIRE_ID = "course_feedback_2026_term1";
const REFRESH_INTERVAL_MS = 15000;

type QuestionnaireAnswerState = Record<string, boolean | string | string[]>;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
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

export default function QuestionnaireVoterPanel() {
  const [questionnaireId, setQuestionnaireId] = useState(DEFAULT_QUESTIONNAIRE_ID);
  const [availableQuestionnaireIds, setAvailableQuestionnaireIds] = useState<string[]>([]);
  const [voterNpub, setVoterNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [definition, setDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<QuestionnaireResultSummary | null>(null);
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const [responseSubmittedCount, setResponseSubmittedCount] = useState(0);
  const [tokenStatus, setTokenStatus] = useState<"idle" | "waiting" | "ready" | "submitted">("idle");
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const fromQuery = new URLSearchParams(window.location.search).get("questionnaire")?.trim();
    if (fromQuery) {
      setQuestionnaireId(fromQuery);
    }
  }, []);

  useEffect(() => {
    void loadSimpleActorState("voter").then((stored) => {
      setVoterNpub(stored?.keypair?.npub ?? "");
    }).catch(() => undefined);
  }, []);

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
        const ids = new Set<string>();
        for (const event of events) {
          const parsed = parseQuestionnaireDefinitionEvent(event);
          if (!parsed) {
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
  }, [questionnaireId]);

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
      setDefinition(latestDefinition);
      setState(deriveEffectiveQuestionnaireState({
        definition: latestDefinition,
        latestState: latestExplicitState,
      }));
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
  const selectedQuestionnaireOptions = availableQuestionnaireIds.length > 0
    ? availableQuestionnaireIds
    : (questionnaireId.trim() ? [questionnaireId.trim()] : []);

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
    if (tokenStatus !== "ready" && tokenStatus !== "submitted") {
      setStatus("Token ready");
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
      }
    } catch {
      setStatus("Response submit failed.");
    }
  }

  function requestToken() {
    setTokenStatus("waiting");
    setStatus("Waiting for token");
    window.setTimeout(() => {
      setTokenStatus("ready");
      setStatus("Token ready");
    }, 300);
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

  return (
    <div className='simple-voter-card'>
      <h3 className='simple-voter-question'>Questionnaire</h3>
      <p className='simple-voter-note'>{definition?.title ?? "Questionnaire"}</p>
      <p className='simple-voter-note'>{definition?.description ?? "This response is submitted using a one-time token."}</p>
      <p className='simple-voter-note'>{definition?.responseVisibility === "private" ? "Answers are encrypted" : "Answers are public"}</p>

      <label className='simple-voter-label' htmlFor='questionnaire-id-voter'>Questionnaire ID</label>
      <select
        id='questionnaire-id-voter'
        className='simple-voter-input'
        value={questionnaireId}
        onChange={(event) => setQuestionnaireId(event.target.value)}
      >
        {selectedQuestionnaireOptions.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>

      <div className='simple-voter-action-row simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
          Refresh questionnaire
        </button>
        <button
          type='button'
          className='simple-voter-secondary'
          onClick={requestToken}
          disabled={tokenStatus === "waiting" || tokenStatus === "ready" || tokenStatus === "submitted"}
        >
          Request token
        </button>
      </div>

      <ul className='simple-vote-status-list'>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          State: {formatQuestionnaireStateLabel(state)}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          1. Request token: {tokenStatus === "idle" ? "Request token" : "Done"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          2. Token received: {tokenStatus === "waiting" ? "Waiting for token" : tokenStatus === "ready" || tokenStatus === "submitted" ? "Token ready" : "Waiting for token"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          3. Response ready: {tokenStatus === "ready" || tokenStatus === "submitted" ? "Token ready" : "Waiting for token"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          4. Submitted: {tokenStatus === "submitted" ? "Response submitted" : "Not submitted"}
        </li>
      </ul>

      {definition ? (
        <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
          {definition.questions.map((question) => {
            if (question.type === "yes_no") {
              const selected = answerState[question.questionId];
              return (
                <div key={question.questionId} className='simple-voter-card'>
                  <p className='simple-voter-question'>{question.prompt}</p>
                  <div className='simple-vote-button-grid'>
                    <button
                      type='button'
                      className={`simple-voter-choice simple-voter-choice-yes${selected === true ? " is-active" : ""}`}
                      onClick={() => setYesNoAnswer(question.questionId, true)}
                    >
                      Yes
                    </button>
                    <button
                      type='button'
                      className={`simple-voter-choice simple-voter-choice-no${selected === false ? " is-active" : ""}`}
                      onClick={() => setYesNoAnswer(question.questionId, false)}
                    >
                      No
                    </button>
                  </div>
                </div>
              );
            }

            if (question.type === "multiple_choice") {
              const selected = Array.isArray(answerState[question.questionId])
                ? (answerState[question.questionId] as string[])
                : [];
              return (
                <div key={question.questionId} className='simple-voter-card'>
                  <p className='simple-voter-question'>{question.prompt}</p>
                  <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                    {question.options.map((option) => (
                      <label key={option.optionId} className='simple-voter-note'>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={question.questionId}
                          checked={selected.includes(option.optionId)}
                          onChange={() => setMultipleChoiceAnswer(question.questionId, option.optionId, question.multiSelect)}
                        />
                        {" "}
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            }

            const text = typeof answerState[question.questionId] === "string"
              ? (answerState[question.questionId] as string)
              : "";
            return (
              <div key={question.questionId} className='simple-voter-card'>
                <p className='simple-voter-question'>{question.prompt}</p>
                <textarea
                  className='simple-voter-input'
                  rows={4}
                  maxLength={question.maxLength}
                  value={text}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setAnswerState((current) => ({
                      ...current,
                      [question.questionId]: nextValue,
                    }));
                  }}
                />
                <p className='simple-voter-note'>Max {question.maxLength} characters.</p>
              </div>
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
