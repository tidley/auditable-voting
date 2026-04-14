import { useCallback, useEffect, useMemo, useState } from "react";
import { generateSecretKey, nip19 } from "nostr-tools";
import { fetchQuestionnaireEvents, publishEncryptedQuestionnaireResponse, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND } from "./questionnaireNostr";
import { parseQuestionnaireResultSummaryEvent, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireState } from "./questionnaireRuntime";
import { loadSimpleActorState } from "./simpleLocalState";
import { validateQuestionnaireResponsePayload, type QuestionnaireDefinition, type QuestionnaireResponseAnswer, type QuestionnaireResponsePayload, type QuestionnaireResultSummary } from "./questionnaireProtocol";

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
  const [voterNpub, setVoterNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [definition, setDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<QuestionnaireResultSummary | null>(null);
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const [responseSubmittedCount, setResponseSubmittedCount] = useState(0);

  useEffect(() => {
    void loadSimpleActorState("voter").then((stored) => {
      setVoterNpub(stored?.keypair?.npub ?? "");
    }).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const id = questionnaireId.trim();
    if (!id) {
      return;
    }
    try {
      const [definitionEvents, stateEvents, resultEvents] = await Promise.all([
        fetchQuestionnaireEvents({ questionnaireId: id, kind: QUESTIONNAIRE_DEFINITION_KIND }),
        fetchQuestionnaireEvents({ questionnaireId: id, kind: QUESTIONNAIRE_STATE_KIND }),
        fetchQuestionnaireEvents({ questionnaireId: id, kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND }),
      ]);
      setDefinition(selectLatestQuestionnaireDefinition(definitionEvents));
      setState(selectLatestQuestionnaireState(stateEvents)?.state ?? null);
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
    return Boolean(definition && state === "open");
  }, [definition, state]);

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
    setStatus("Submitting encrypted response...");

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
          ? `Encrypted response submitted (${result.successes}/${result.relayResults.length} relays).`
          : "Encrypted response submit failed.",
      );
      if (result.successes > 0) {
        setResponseSubmittedCount((current) => current + 1);
      }
    } catch {
      setStatus("Encrypted response submit failed.");
    }
  }

  useEffect(() => {
    const owner = globalThis as typeof globalThis & {
      __questionnaireVoterDebug?: unknown;
    };
    owner.__questionnaireVoterDebug = {
      questionnaireId: questionnaireId.trim(),
      voterNpubLoaded: Boolean(voterNpub),
      questionnaireSeen: Boolean(definition),
      questionnaireState: state,
      latestResultAcceptedCount: latestResult?.acceptedResponseCount ?? null,
      responseSubmittedCount,
      status,
    };
  }, [
    definition,
    latestResult?.acceptedResponseCount,
    questionnaireId,
    responseSubmittedCount,
    state,
    status,
    voterNpub,
  ]);

  return (
    <div className='simple-voter-card'>
      <h3 className='simple-voter-question'>Private questionnaire response</h3>
      <p className='simple-voter-note'>Uses an ephemeral response key, encrypted payload to coordinator, and public aggregate results.</p>

      <label className='simple-voter-label' htmlFor='questionnaire-id-voter'>Questionnaire id</label>
      <input
        id='questionnaire-id-voter'
        className='simple-voter-input'
        value={questionnaireId}
        onChange={(event) => setQuestionnaireId(event.target.value)}
      />

      <div className='simple-voter-action-row simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
          Refresh questionnaire
        </button>
      </div>

      <ul className='simple-vote-status-list'>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Voter key loaded: {voterNpub ? "yes" : "no"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Questionnaire state: {state ?? "none"}
        </li>
        <li>
          <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
          Latest aggregate accepted count: {latestResult?.acceptedResponseCount ?? "none"}
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
            Submit encrypted response
          </button>
        </div>
      ) : (
        <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p>
      )}

      {status ? <p className='simple-voter-note'>{status}</p> : null}
    </div>
  );
}
