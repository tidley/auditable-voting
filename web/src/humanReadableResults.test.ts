import { describe, expect, it } from "vitest";
import {
  deriveHumanReadableResults,
  type HumanReadableResults,
} from "./humanReadableResults";
import type {
  QuestionnaireQuestion,
  QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";

function yesNoQuestion(questionId: string, prompt: string): QuestionnaireQuestion {
  return {
    questionId,
    prompt,
    required: true,
    type: "yes_no",
  };
}

function multipleChoiceQuestion(
  questionId: string,
  prompt: string,
  options: Array<[string, string]>,
): QuestionnaireQuestion {
  return {
    questionId,
    prompt,
    required: true,
    type: "multiple_choice",
    multiSelect: false,
    options: options.map(([optionId, label]) => ({ optionId, label })),
  };
}

function rankQuestion(
  questionId: string,
  prompt: string,
  options: Array<[string, string]>,
): QuestionnaireQuestion {
  return {
    questionId,
    prompt,
    required: true,
    type: "rank",
    options: options.map(([optionId, label]) => ({ optionId, label })),
    minimumRanked: 1,
  };
}

describe("deriveHumanReadableResults", () => {
  it('keeps hierarchical labels when summaries are filtered or arrive in a different order', () => {
    const questions: QuestionnaireQuestion[] = [
      yesNoQuestion('q1', 'Parent'),
      { ...yesNoQuestion('q2', 'Follow-up'), showIf: { dependsOnQuestionId: 'q1', requiredAnswer: { answerType: 'yes_no', value: true } } },
      yesNoQuestion('q3', 'Next parent'),
    ];
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 1, rejectedResponseCount: 0, questions,
      questionSummaries: [
        { questionId: 'q3', answerType: 'yes_no', yesCount: 1, noCount: 0 },
        { questionId: 'q2', answerType: 'yes_no', yesCount: 1, noCount: 0 },
      ],
    });
    expect(result.breakdowns.map(entry => entry.questionNumber)).toEqual(['2', '1-A']);
  });
  it("returns plain counts with zero-answer breakdown when there are no questions", () => {
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 7,
      rejectedResponseCount: 3,
      questionSummaries: [],
      questions: [],
    });
    expect(result.totalResponseCount).toBe(10);
    expect(result.acceptedResponseCount).toBe(7);
    expect(result.rejectedResponseCount).toBe(3);
    expect(result.acceptedPercent).toBe(70);
    expect(result.breakdowns).toEqual([]);
  });

  it("computes acceptedPercent correctly when total is zero (no division by zero)", () => {
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 0,
      rejectedResponseCount: 0,
      questionSummaries: [],
      questions: [],
    });
    expect(result.acceptedPercent).toBe(0);
    expect(result.totalResponseCount).toBe(0);
  });

  it("maps option ids to labels and sorts entries descending by count for multiple-choice", () => {
    const summaries: QuestionnaireResultQuestionSummary[] = [
      {
        questionId: "community",
        answerType: "multiple_choice",
        optionCounts: { north: 2, south: 7, east: 4 },
      },
    ];
    const questions: QuestionnaireQuestion[] = [
      multipleChoiceQuestion("community", "Which community are you in?", [
        ["north", "North"],
        ["south", "South"],
        ["east", "East"],
      ]),
    ];
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 13,
      rejectedResponseCount: 0,
      questionSummaries: summaries,
      questions,
    });
    const breakdown = result.breakdowns[0];
    expect(breakdown.questionId).toBe("community");
    expect(breakdown.prompt).toBe("Which community are you in?");
    expect(breakdown.responseCount).toBe(13);
    // descending by count: south(7), east(4), north(2)
    expect(breakdown.entries.map((entry) => entry.label)).toEqual(["South", "East", "North"]);
    expect(breakdown.entries.map((entry) => entry.count)).toEqual([7, 4, 2]);
    // percent of total selections: 7/13, 4/13, 2/13 (rounded to 1 decimal)
    expect(breakdown.entries[0].percent).toBeCloseTo(53.8, 1);
    expect(breakdown.entries[1].percent).toBeCloseTo(30.8, 1);
    expect(breakdown.entries[2].percent).toBeCloseTo(15.4, 1);
  });

  it("renders yes/no summaries as Yes/No entries with correct percentages", () => {
    const summaries: QuestionnaireResultQuestionSummary[] = [
      { questionId: "ratify", answerType: "yes_no", yesCount: 8, noCount: 2 },
    ];
    const questions: QuestionnaireQuestion[] = [yesNoQuestion("ratify", "Ratify the budget?")];
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 10,
      rejectedResponseCount: 0,
      questionSummaries: summaries,
      questions,
    });
    const breakdown = result.breakdowns[0];
    expect(breakdown.responseCount).toBe(10);
    expect(breakdown.entries.map((entry) => entry.label)).toEqual(["Yes", "No"]);
    expect(breakdown.entries.map((entry) => entry.count)).toEqual([8, 2]);
    expect(breakdown.entries[0].percent).toBe(80);
    expect(breakdown.entries[1].percent).toBe(20);
  });

  it("falls back to the option id when the question label cannot be resolved", () => {
    const summaries: QuestionnaireResultQuestionSummary[] = [
      {
        questionId: "missing",
        answerType: "multiple_choice",
        optionCounts: { a: 3 },
      },
    ];
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 3,
      rejectedResponseCount: 0,
      questionSummaries: summaries,
      questions: [],
    });
    expect(result.breakdowns[0].entries[0].label).toBe("a");
    expect(result.breakdowns[0].prompt).toBe("missing");
  });

  it("sorts ties by label for deterministic output", () => {
    const summaries: QuestionnaireResultQuestionSummary[] = [
      {
        questionId: "q",
        answerType: "multiple_choice",
        optionCounts: { b: 5, a: 5 },
      },
    ];
    const results: HumanReadableResults = deriveHumanReadableResults({
      acceptedResponseCount: 10,
      rejectedResponseCount: 0,
      questionSummaries: summaries,
      questions: [
        multipleChoiceQuestion("q", "prompt", [
          ["a", "Alpha"],
          ["b", "Beta"],
        ]),
      ],
    });
    expect(results.breakdowns[0].entries.map((entry) => entry.label)).toEqual(["Alpha", "Beta"]);
  });

  it("produces first-choice counts for rank summaries and count-only for free text", () => {
    const summaries: QuestionnaireResultQuestionSummary[] = [
      {
        questionId: "rank",
        answerType: "rank",
        optionScores: { a: 2, b: 1 },
        rankCounts: { a: { "1": 6 }, b: { "1": 4 } },
        responseCount: 10,
        blankResponseCount: 0,
      },
      {
        questionId: "feedback",
        answerType: "free_text",
        freeTextCount: 9,
      },
    ];
    const questions: QuestionnaireQuestion[] = [
      rankQuestion("rank", "Rank the options", [["a", "Option A"], ["b", "Option B"]]),
      { questionId: "feedback", prompt: "Any comments?", required: false, type: "free_text", maxLength: 200 },
    ];
    const result = deriveHumanReadableResults({
      acceptedResponseCount: 10,
      rejectedResponseCount: 0,
      questionSummaries: summaries,
      questions,
    });
    const rank = result.breakdowns.find((entry) => entry.questionId === "rank");
    expect(rank?.entries.map((entry) => entry.label)).toEqual(["Option A", "Option B"]);
    expect(rank?.entries.map((entry) => entry.count)).toEqual([6, 4]);
    expect(rank?.responseCount).toBe(10);

    const freeText = result.breakdowns.find((entry) => entry.questionId === "feedback");
    expect(freeText?.responseCount).toBe(9);
    expect(freeText?.entries).toEqual([]);
  });
});
