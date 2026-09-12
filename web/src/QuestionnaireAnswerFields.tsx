/**
 * Reusable questionnaire answer controls (F3-T4).
 *
 * These are the question input components the digital voter flow renders,
 * lifted out of `QuestionnaireVoterPanel.tsx` so both the digital flow and the
 * paper-ballot manual entry mode render the *same* markup and apply the *same*
 * answer semantics (F2 conditional visibility included).  The digital panel and
 * `ManualBallotEntry` both render `<QuestionnaireAnswerFields>`; keeping one
 * implementation is what makes "manual entry renders like the digital flow" a
 * structural guarantee instead of a promise.
 *
 * The markup and class names are intentionally identical to the voter panel's
 * original inline rendering (including the English control copy) so this
 * extraction is a pure move: no visual or behavioural change to digital voting.
 */
import { useTSafe } from "./i18n/LanguageContext";
import { resolveLocalised } from "./i18n/resolveLocale";
import type { SupportedLocale } from "./i18n/types";
import type {
  QuestionnaireDefinition,
  QuestionnaireQuestion,
  QuestionnaireResponseAnswer,
} from "./questionnaireProtocol";
import { shouldShowQuestion } from "./questionConditionEvaluator";
import { UiButton, UiTextArea } from "./ui/DesignLayer";

/** Local answer state: one entry per question id, shaped by question type. */
export type QuestionnaireAnswerState = Record<string, boolean | string | string[]>;

export function getRankRequirementState(optionCount: number, minimumRanked: number, selectedCount: number) {
  const minimum = Math.max(0, Math.min(optionCount, Math.floor(minimumRanked)));
  const missing = Math.max(0, minimum - selectedCount);
  return {
    minimum,
    missing,
    label: minimum > 0
      ? missing > 0
        ? `Choose ${missing} more`
        : null
      : selectedCount > 0
        ? null
        : "Optional",
  };
}

/**
 * Turn local answer state into protocol answers, skipping unanswered questions
 * (and questions whose answer is empty) so a partially filled questionnaire
 * still produces a valid payload.
 */
export function buildQuestionnaireAnswers(
  definition: QuestionnaireDefinition,
  answerState: QuestionnaireAnswerState,
): QuestionnaireResponseAnswer[] {
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

    if (question.type === "rank") {
      const validOptions = new Set(question.options.map((option) => option.optionId));
      const rankedOptionIds = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string" && validOptions.has(entry))
        : [];
      if (rankedOptionIds.length > 0) {
        answers.push({
          questionId: question.questionId,
          answerType: "rank",
          rankedOptionIds,
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

/** Name the voter panel already used for this builder. */
export const buildResponseAnswers = buildQuestionnaireAnswers;

export function buildAnsweredMap(
  definition: QuestionnaireDefinition,
  answerState: QuestionnaireAnswerState,
): Map<string, QuestionnaireResponseAnswer> {
  const answers = buildQuestionnaireAnswers(definition, answerState);
  const map = new Map<string, QuestionnaireResponseAnswer>();
  for (const answer of answers) {
    map.set(answer.questionId, answer);
  }
  return map;
}

/**
 * Answers for questions that are currently visible.  A question hidden by an
 * F2 `showIf` rule is excluded from the payload even if it was answered before
 * it became hidden.
 */
export function buildVisibleResponseAnswers(
  definition: QuestionnaireDefinition,
  answerState: QuestionnaireAnswerState,
): QuestionnaireResponseAnswer[] {
  const answeredMap = buildAnsweredMap(definition, answerState);
  const questionMap = new Map(definition.questions.map((question) => [question.questionId, question]));
  return buildQuestionnaireAnswers(definition, answerState).filter((answer) => {
    const question = questionMap.get(answer.questionId);
    if (!question) {
      return false;
    }
    return shouldShowQuestion(question, answeredMap, questionMap);
  });
}

/**
 * The questions that are currently visible under the F2 conditional rules.
 * Callers that need to know which questions count as "required right now" (for
 * example the paper-ballot manual entry screen) read them from here so the
 * visibility decision is made in exactly one place.
 */
export function visibleQuestions(
  definition: QuestionnaireDefinition,
  answerState: QuestionnaireAnswerState,
): QuestionnaireQuestion[] {
  const answeredMap = buildAnsweredMap(definition, answerState);
  const questionMap = new Map(definition.questions.map((question) => [question.questionId, question]));
  return definition.questions.filter((question) => shouldShowQuestion(question, answeredMap, questionMap));
}

export type QuestionnaireAnswerFieldsProps = {
  definition: QuestionnaireDefinition;
  answerState: QuestionnaireAnswerState;
  locale: SupportedLocale;
  /** Renders the controls read-only once the responder has submitted. */
  responseLocked?: boolean;
  /**
   * Override the F2 conditional-visibility decision.  Defaults to the shared
   * `shouldShowQuestion` evaluation against `definition` + `answerState`, which
   * is what the digital voter flow uses.
   */
  isQuestionVisible?: (question: QuestionnaireQuestion) => boolean;
  onYesNoAnswer: (questionId: string, value: boolean) => void;
  onMultipleChoiceAnswer: (questionId: string, optionId: string, multiSelect: boolean) => void;
  onAddRankedAnswer: (questionId: string, optionId: string) => void;
  onRemoveRankedAnswer: (questionId: string, optionId: string) => void;
  onMoveRankedAnswer: (questionId: string, optionId: string, direction: -1 | 1) => void;
  onFreeTextAnswer: (questionId: string, value: string) => void;
};

/**
 * Renders one `<article>` per visible question with the input control matching
 * the question type: Yes/No buttons, a radio/checkbox option list, a rank
 * builder, or a free-text area.
 */
export default function QuestionnaireAnswerFields({
  definition,
  answerState,
  locale,
  responseLocked = false,
  isQuestionVisible,
  onYesNoAnswer,
  onMultipleChoiceAnswer,
  onAddRankedAnswer,
  onRemoveRankedAnswer,
  onMoveRankedAnswer,
  onFreeTextAnswer,
}: QuestionnaireAnswerFieldsProps) {
  const t = useTSafe();
  const answeredMap = isQuestionVisible ? null : buildAnsweredMap(definition, answerState);
  const questionMap = isQuestionVisible
    ? null
    : new Map(definition.questions.map((question) => [question.questionId, question]));

  return (
    <>
      {definition.questions.map((question, index) => {
        const visible = isQuestionVisible
          ? isQuestionVisible(question)
          : shouldShowQuestion(question, answeredMap ?? new Map(), questionMap ?? undefined);
        if (!visible) {
          return null;
        }
        const questionPrompt = resolveLocalised(question.prompt, locale).trim() || t("voterUntitledQuestion");
        const requirementLabel = question.required ? t("statusRequired") : t("statusOptional");

        if (question.type === "yes_no") {
          const selected = answerState[question.questionId];
          const requirementText = typeof selected === "boolean" ? null : requirementLabel;
          return (
            <article key={question.questionId} className={`simple-questionnaire-voter-card${responseLocked ? " is-response-locked" : ""}`}>
              <div className='simple-questionnaire-voter-heading'>
                <h4 className='simple-questionnaire-voter-prompt'>Q{index + 1}: {questionPrompt}</h4>
                {requirementText ? (
                  <p className={`simple-questionnaire-voter-requirement${question.required ? "" : " is-optional"}`}>
                    {requirementText}
                  </p>
                ) : null}
              </div>
              <div className='simple-vote-button-grid simple-questionnaire-yes-no-grid'>
                <UiButton
                  icon='check'
                  className={`simple-voter-choice simple-questionnaire-yes-no-choice simple-voter-choice-yes${selected === true ? " is-active" : ""}`}
                  onPress={() => onYesNoAnswer(question.questionId, true)}
                  isDisabled={responseLocked}
                >
                  Yes
                </UiButton>
                <UiButton
                  icon='cancel'
                  className={`simple-voter-choice simple-questionnaire-yes-no-choice simple-voter-choice-no${selected === false ? " is-active" : ""}`}
                  onPress={() => onYesNoAnswer(question.questionId, false)}
                  isDisabled={responseLocked}
                >
                  No
                </UiButton>
              </div>
            </article>
          );
        }

        if (question.type === "multiple_choice") {
          const selected = Array.isArray(answerState[question.questionId])
            ? (answerState[question.questionId] as string[])
            : [];
          const requirementText = selected.length > 0 ? null : requirementLabel;
          return (
            <article key={question.questionId} className={`simple-questionnaire-voter-card${responseLocked ? " is-response-locked" : ""}`}>
              <div className='simple-questionnaire-voter-heading'>
                <h4 className='simple-questionnaire-voter-prompt'>Q{index + 1}: {questionPrompt}</h4>
                {requirementText ? (
                  <p className={`simple-questionnaire-voter-requirement${question.required ? "" : " is-optional"}`}>
                    {requirementText}
                  </p>
                ) : null}
              </div>
              <div className='simple-questionnaire-choice-list'>
                {question.options.map((option) => (
                  <label key={option.optionId} className='simple-questionnaire-choice-row'>
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={question.questionId}
                      checked={selected.includes(option.optionId)}
                      disabled={responseLocked}
                      onChange={() => onMultipleChoiceAnswer(question.questionId, option.optionId, Boolean(question.multiSelect))}
                    />
                    <span>{resolveLocalised(option.label, locale)}</span>
                  </label>
                ))}
              </div>
            </article>
          );
        }

        if (question.type === "rank") {
          const ranked = Array.isArray(answerState[question.questionId])
            ? (answerState[question.questionId] as string[])
            : [];
          const rankedSet = new Set(ranked);
          const unrankedOptions = question.options.filter((option) => !rankedSet.has(option.optionId));
          const minimumRanked = Math.max(0, Math.min(question.options.length, Math.floor(question.minimumRanked)));
          const rankRequirement = getRankRequirementState(question.options.length, minimumRanked, ranked.length);
          const requirementText = rankRequirement.label;
          return (
            <article key={question.questionId} className={`simple-questionnaire-voter-card${responseLocked ? " is-response-locked" : ""}`}>
              <div className='simple-questionnaire-voter-heading'>
                <h4 className='simple-questionnaire-voter-prompt'>Q{index + 1}: {questionPrompt}</h4>
                {requirementText ? (
                  <p className={`simple-questionnaire-voter-requirement${rankRequirement.missing > 0 ? " is-needed" : " is-optional"}`}>
                    {requirementText}
                  </p>
                ) : null}
              </div>
              <div className='simple-questionnaire-rank-voter-grid'>
                <div className='simple-questionnaire-choice-list'>
                  {ranked.length > 0 ? ranked.map((optionId, rankedIndex) => {
                    const option = question.options.find((entry) => entry.optionId === optionId);
                    if (!option) {
                      return null;
                    }
                    return (
                      <div
                        key={option.optionId}
                        className={`simple-questionnaire-rank-row${responseLocked ? " is-response-locked" : ""}`}
                        role='button'
                        tabIndex={responseLocked ? -1 : 0}
                        aria-label={`Remove ${option.label} as #${rankedIndex + 1}`}
                        aria-disabled={responseLocked}
                        onClick={() => {
                          if (responseLocked) {
                            return;
                          }
                          onRemoveRankedAnswer(question.questionId, option.optionId);
                        }}
                        onKeyDown={(event) => {
                          if (responseLocked) {
                            return;
                          }
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
                          onRemoveRankedAnswer(question.questionId, option.optionId);
                        }}
                      >
                        <span className='simple-questionnaire-rank-selected'>
                          <span className='simple-questionnaire-rank-selected-option'>
                            <span className='simple-questionnaire-rank-inline-number'>{rankedIndex + 1}. </span>
                            <span>{resolveLocalised(option.label, locale)}</span>
                          </span>
                          <span className='simple-questionnaire-rank-remove-prefix'>Remove as #{rankedIndex + 1}</span>
                        </span>
                        <div className='simple-questionnaire-rank-actions'>
                          <UiButton
                            icon='uploadLine'
                            iconOnly
                            className='simple-voter-secondary simple-questionnaire-rank-action'
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveRankedAnswer(question.questionId, option.optionId, -1);
                            }}
                            isDisabled={responseLocked || rankedIndex === 0}
                            aria-label='Move up'
                          />
                          <UiButton
                            icon='downloadLine'
                            iconOnly
                            className='simple-voter-secondary simple-questionnaire-rank-action'
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveRankedAnswer(question.questionId, option.optionId, 1);
                            }}
                            isDisabled={responseLocked || rankedIndex === ranked.length - 1}
                            aria-label='Move down'
                          />
                        </div>
                      </div>
                    );
                  }) : null}
                </div>
                {unrankedOptions.length > 0 ? (
                  <div className='simple-questionnaire-choice-list'>
                    {unrankedOptions.map((option) => (
                      <UiButton
                        key={option.optionId}
                        icon='add'
                        className='simple-voter-secondary simple-questionnaire-rank-add'
                        onPress={() => onAddRankedAnswer(question.questionId, option.optionId)}
                        isDisabled={responseLocked}
                      >
                        <span className='simple-questionnaire-rank-add-option'>{resolveLocalised(option.label, locale)}</span>
                        <span className='simple-questionnaire-rank-add-prefix'>Add as #{ranked.length + 1}</span>
                      </UiButton>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          );
        }

        const text = typeof answerState[question.questionId] === "string"
          ? (answerState[question.questionId] as string)
          : "";
        const requirementText = text.trim() ? null : requirementLabel;
        return (
          <article key={question.questionId} className={`simple-questionnaire-voter-card${responseLocked ? " is-response-locked" : ""}`}>
            <div className='simple-questionnaire-voter-heading'>
              <h4 className='simple-questionnaire-voter-prompt'>Q{index + 1}: {questionPrompt}</h4>
              {requirementText ? (
                <p className={`simple-questionnaire-voter-requirement${question.required ? "" : " is-optional"}`}>
                  {requirementText}
                </p>
              ) : null}
            </div>
            <UiTextArea
              label='Additional comments'
              textAreaClassName='simple-voter-input simple-questionnaire-free-text'
              isDisabled={responseLocked}
              textAreaProps={{
                id: `questionnaire-free-text-${question.questionId}`,
                rows: 4,
                maxLength: question.maxLength,
                placeholder: 'Type your response here...',
                value: text,
                onChange: (event) => {
                  if (responseLocked) {
                    return;
                  }
                  onFreeTextAnswer(question.questionId, event.target.value);
                },
              }}
            />
            <p className='simple-questionnaire-voter-helper'>Max {question.maxLength} characters.</p>
          </article>
        );
      })}
    </>
  );
}
