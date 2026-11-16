const ELIGIBLE_ROUND_STATES = new Set([
  "published",
  "open",
  "closed",
  "counted",
  "results_published",
]);

/**
 * A new round only needs an existing questionnaire that has moved past draft.
 * It deliberately does not require an invited-voter roster: email, paper and
 * general-admission questionnaires are all valid starting points, and each
 * round receives a fresh questionnaire id and blind-signing key.
 */
export function canStartQuestionnaireRound(input: {
  questionnaireId: string;
  state?: string | null;
  summaryState?: string | null;
}) {
  const questionnaireId = input.questionnaireId.trim();
  const state = (input.state?.trim() || input.summaryState?.trim() || "").toLowerCase();
  return Boolean(questionnaireId && ELIGIBLE_ROUND_STATES.has(state));
}
