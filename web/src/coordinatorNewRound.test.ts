import { describe, expect, it } from "vitest";
import { canStartQuestionnaireRound } from "./coordinatorNewRound";

describe("canStartQuestionnaireRound", () => {
  it("allows any published questionnaire state without an invited-voter roster", () => {
    for (const state of ["published", "open", "closed", "counted", "results_published"]) {
      expect(canStartQuestionnaireRound({
        questionnaireId: "q_round_1",
        state,
      })).toBe(true);
    }
  });

  it("falls back to the cached election summary when the live announcement state is unknown", () => {
    expect(canStartQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: null,
      summaryState: "closed",
    })).toBe(true);
    expect(canStartQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "",
      summaryState: "open",
    })).toBe(true);
  });

  it("rejects drafts, unknown states and a missing questionnaire id", () => {
    expect(canStartQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "draft",
    })).toBe(false);
    expect(canStartQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "archived",
    })).toBe(false);
    expect(canStartQuestionnaireRound({
      questionnaireId: "q_round_1",
    })).toBe(false);
    expect(canStartQuestionnaireRound({
      questionnaireId: "",
      state: "open",
    })).toBe(false);
  });
});
