import type { QuestionnaireDefinition, QuestionnaireQuestion } from "./questionnaireProtocol";
import { resolveLocalised } from "./i18n/resolveLocale";

export type PaperBallotQuestion = QuestionnaireQuestion & { conditionInstruction?: string };

export interface PaperBallot {
  questionnaireId: string;
  questionnaireTitle: string;
  questions: PaperBallotQuestion[];
  masterlistNumber: string;
  code: string;
  expiresAt: string;
  generatedAt: number;
}

// This object is for the current print session only. Never persist it.
export function generatePaperBallot(input: {
  definition: QuestionnaireDefinition;
  masterlistNumber: string;
  code: string;
  expiresAt: string;
}): PaperBallot {
  return {
    questionnaireId: input.definition.questionnaireId,
    questionnaireTitle: resolveLocalised(input.definition.title, "en"),
    masterlistNumber: input.masterlistNumber,
    code: input.code,
    expiresAt: input.expiresAt,
    generatedAt: Date.now(),
    questions: input.definition.questions.map((question) => {
      const condition = question.showIf;
      if (!condition) return { ...question };
      const index = input.definition.questions.findIndex((candidate) => candidate.questionId === condition.dependsOnQuestionId);
      const parent = input.definition.questions[index];
      const answer = condition.requiredAnswer;
      const requirement = answer.answerType === "yes_no"
        ? `answered ${answer.value ? "Yes" : "No"}.`
        : `includes all of: ${answer.selectedOptionIds.map((id) => parent?.type === "multiple_choice"
          ? resolveLocalised(parent.options.find((option) => option.optionId === id)?.label, "en") || id : id).join("; ")}. Other selections are allowed.`;
      return { ...question, conditionInstruction: `Answer only if question ${index + 1} (${resolveLocalised(parent?.prompt, "en") || condition.dependsOnQuestionId}) is applicable and ${requirement} Otherwise leave blank.` };
    }),
  };
}
