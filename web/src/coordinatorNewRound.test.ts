import { describe, expect, it } from "vitest";
import { canStartInvitedQuestionnaireRound } from "./coordinatorNewRound";

describe("canStartInvitedQuestionnaireRound", () => {
  it("requires a non-draft questionnaire and an admitted voter roster", () => {
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "open",
      admittedVoterCount: 1,
    })).toBe(true);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "closed",
      admittedVoterCount: 2,
    })).toBe(true);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "open",
      admittedVoterCount: 0,
    })).toBe(false);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "draft",
      admittedVoterCount: 1,
    })).toBe(false);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "",
      state: "open",
      admittedVoterCount: 1,
    })).toBe(false);
  });
});
