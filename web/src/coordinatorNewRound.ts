export function canStartInvitedQuestionnaireRound(input: {
  questionnaireId: string;
  state?: string | null;
  admittedVoterCount: number;
}) {
  const questionnaireId = input.questionnaireId.trim();
  const state = input.state?.trim() ?? "";
  return Boolean(questionnaireId && state && state !== "draft" && input.admittedVoterCount > 0);
}
