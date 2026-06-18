import { describe, expect, it } from "vitest";
import { selectNewestMatchingQuestionnaireDefinition } from "./questionnaireDefinitionReference";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";

function definition(questionnaireId: string, title: string, createdAt: number): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: "blind_token",
    questionnaireId,
    title,
    description: "",
    createdAt,
    openAt: createdAt,
    closeAt: createdAt + 3600,
    coordinatorPubkey: "npub1organiser",
    coordinatorEncryptionPubkey: "npub1organiser",
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    questions: [{
      questionId: "q1",
      prompt: "Proceed?",
      required: true,
      type: "yes_no",
    }],
  };
}

describe("selectNewestMatchingQuestionnaireDefinition", () => {
  it("selects the newest matching definition and ignores stale state for the same questionnaire", () => {
    const stale = definition("q_same", "stale", 1781200000);
    const fresh = definition("q_same", "fresh", 1781200100);
    const unrelated = definition("q_other", "unrelated", 1781200200);

    expect(selectNewestMatchingQuestionnaireDefinition("q_same", [
      stale,
      null,
      unrelated,
      fresh,
    ])).toBe(fresh);
  });

  it("returns null when there is no matching questionnaire id", () => {
    expect(selectNewestMatchingQuestionnaireDefinition("q_missing", [
      definition("q_other", "unrelated", 1781200000),
      undefined,
    ])).toBeNull();
  });
});
