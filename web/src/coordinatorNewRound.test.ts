import { describe, expect, it } from "vitest";
import { canStartInvitedQuestionnaireRound } from "./coordinatorNewRound";

describe("canStartInvitedQuestionnaireRound", () => {
  it("requires a non-draft questionnaire and an auto-ballot voter roster", () => {
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "open",
      autoApplyVoterCount: 1,
    })).toBe(true);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "closed",
      autoApplyVoterCount: 2,
    })).toBe(true);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "open",
      autoApplyVoterCount: 0,
    })).toBe(false);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "q_round_1",
      state: "draft",
      autoApplyVoterCount: 1,
    })).toBe(false);
    expect(canStartInvitedQuestionnaireRound({
      questionnaireId: "",
      state: "open",
      autoApplyVoterCount: 1,
    })).toBe(false);
  });
});
