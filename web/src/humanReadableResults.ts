import type {
  QuestionnaireQuestion,
  QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";
import { resolveLocalised } from "./i18n/resolveLocale";

/** Resolve a localisable field to a plain string (English fallback). */
function toPlainText(value: string | { en: string } | undefined): string {
  if (value === undefined) {
    return "";
  }
  return resolveLocalised(value, "en");
}

export type HumanReadableResultEntry = {
  /** Human-facing name of the choice: an option label, or "Yes"/"No". */
  label: string;
  count: number;
  /** Share of this question's response count, 0-100, rounded to 1 decimal. */
  percent: number;
};

export type HumanReadableQuestionBreakdown = {
  questionId: string;
  /** 1-based position of this question in the questionnaire (for "Q1" labels). */
  questionNumber: number | null;
  prompt: string;
  answerType: QuestionnaireResultQuestionSummary["answerType"];
  /** Total responses/scored entries for this question (used as the percent base). */
  responseCount: number;
  /** Choice-level tallies, sorted by count descending (ties by label). */
  entries: HumanReadableResultEntry[];
};

export type HumanReadableResults = {
  acceptedResponseCount: number;
  rejectedResponseCount: number;
  totalResponseCount: number;
  /** Whole-number percentage of responses that were accepted, 0-100. */
  acceptedPercent: number;
  breakdowns: HumanReadableQuestionBreakdown[];
};

/**
 * Project a published result summary into the plain, human-readable shape that
 * stakeholders read by default: plain counts plus a per-question demographic
 * breakdown (community/country and other multiple-choice or yes/no tallies).
 *
 * This derives from the SAME question summaries the cryptographic result pack
 * commits to (`resultHash` is SHA-256 over the canonical summary), so the
 * numbers here are exactly the numbers an auditor re-folds — "same numbers,
 * two presentations".
 */
export function deriveHumanReadableResults(input: {
  acceptedResponseCount: number;
  rejectedResponseCount: number;
  questionSummaries: QuestionnaireResultQuestionSummary[];
  questions: QuestionnaireQuestion[];
}): HumanReadableResults {
  const acceptedResponseCount = Math.max(0, input.acceptedResponseCount);
  const rejectedResponseCount = Math.max(0, input.rejectedResponseCount);
  const totalResponseCount = acceptedResponseCount + rejectedResponseCount;
  const acceptedPercent = totalResponseCount > 0
    ? Math.round((acceptedResponseCount / totalResponseCount) * 100)
    : 0;

  const questionById = new Map(input.questions.map((question) => [question.questionId, question]));
  const questionNumberById = new Map(input.questions.map((question, index) => [question.questionId, index + 1]));

  const breakdowns = input.questionSummaries.map((summary): HumanReadableQuestionBreakdown => {
    const question = questionById.get(summary.questionId);
    const questionNumber = questionNumberById.get(summary.questionId) ?? null;
    return buildBreakdown(summary, question, questionNumber);
  });

  return {
    acceptedResponseCount,
    rejectedResponseCount,
    totalResponseCount,
    acceptedPercent,
    breakdowns,
  };
}

function buildBreakdown(
  summary: QuestionnaireResultQuestionSummary,
  question: QuestionnaireQuestion | undefined,
  questionNumber: number | null,
): HumanReadableQuestionBreakdown {
  const prompt = toPlainText(question?.prompt) || summary.questionId;
  const labelFor = (optionId: string): string => {
    if (question && (question.type === "multiple_choice" || question.type === "rank")) {
      return toPlainText(question.options.find((option) => option.optionId === optionId)?.label) || optionId;
    }
    return optionId;
  };

  switch (summary.answerType) {
    case "yes_no": {
      const responseCount = summary.yesCount + summary.noCount;
      return {
        questionId: summary.questionId,
        questionNumber,
        prompt,
        answerType: summary.answerType,
        responseCount,
        entries: sortEntries([
          makeEntry("Yes", summary.yesCount, responseCount),
          makeEntry("No", summary.noCount, responseCount),
        ]),
      };
    }
    case "multiple_choice": {
      const responseCount = Object.values(summary.optionCounts).reduce((sum, count) => sum + (count || 0), 0);
      const entries = Object.entries(summary.optionCounts)
        .map(([optionId, count]) => makeEntry(labelFor(optionId), count || 0, responseCount));
      return {
        questionId: summary.questionId,
        questionNumber,
        prompt,
        answerType: summary.answerType,
        responseCount,
        entries: sortEntries(entries),
      };
    }
    case "rank": {
      const responseCount = summary.responseCount;
      const entries = Object.entries(summary.rankCounts)
        .map(([optionId, counts]) => makeEntry(labelFor(optionId), Number(counts?.["1"] ?? 0) || 0, responseCount));
      return {
        questionId: summary.questionId,
        questionNumber,
        prompt,
        answerType: summary.answerType,
        responseCount,
        entries: sortEntries(entries),
      };
    }
    case "free_text": {
      return {
        questionId: summary.questionId,
        questionNumber,
        prompt,
        answerType: summary.answerType,
        responseCount: summary.freeTextCount,
        entries: [],
      };
    }
  }
}

function makeEntry(label: string, count: number, responseCount: number): HumanReadableResultEntry {
  const percent = responseCount > 0
    ? Math.round((count / responseCount) * 1000) / 10
    : 0;
  return { label, count, percent };
}

function sortEntries(entries: HumanReadableResultEntry[]): HumanReadableResultEntry[] {
  return [...entries].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return left.label.localeCompare(right.label);
  });
}
