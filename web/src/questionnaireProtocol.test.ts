import { describe, expect, it } from "vitest";
import {
  validateQuestionnaireDefinition,
  validateQuestionnaireResponsePayload,
  type QuestionnaireDefinition,
  type QuestionnaireResponsePayload,
} from "./questionnaireProtocol";

function buildDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    questionnaireId: "course_feedback_2026_term1",
    title: "Course feedback",
    description: "Please answer all required questions.",
    createdAt: 1712530000,
    openAt: 1712533600,
    closeAt: 1712619999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinatorenc",
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Was the course material clear?",
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        prompt: "How would you rate the pace?",
        required: true,
        multiSelect: false,
        options: [
          { optionId: "slow", label: "Too slow" },
          { optionId: "good", label: "About right" },
          { optionId: "fast", label: "Too fast" },
        ],
      },
      {
        questionId: "q3",
        type: "free_text",
        prompt: "What should be improved?",
        required: false,
        maxLength: 1000,
      },
    ],
  };
}

describe("questionnaireProtocol", () => {
  it("validates a well-formed questionnaire definition", () => {
    const result = validateQuestionnaireDefinition(buildDefinition());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a malformed questionnaire definition", () => {
    const malformed: QuestionnaireDefinition = {
      ...buildDefinition(),
      openAt: 200,
      closeAt: 100,
      coordinatorPubkey: "",
      questions: [
        {
          questionId: "q1",
          type: "multiple_choice",
          prompt: "Broken",
          required: true,
          multiSelect: false,
          options: [{ optionId: "only", label: "Only one" }],
        },
      ],
    };
    const result = validateQuestionnaireDefinition(malformed);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("coordinator_pubkey_missing");
    expect(result.errors).toContain("invalid_open_close_window");
    expect(result.errors).toContain("multiple_choice_insufficient_options:q1");
  });

  it("validates a matching response payload", () => {
    const payload: QuestionnaireResponsePayload = {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: "course_feedback_2026_term1",
      responseId: "resp_1",
      submittedAt: 1712537200,
      answers: [
        { questionId: "q1", answerType: "yes_no", value: true },
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["good"] },
      ],
    };
    const result = validateQuestionnaireResponsePayload({
      definition: buildDefinition(),
      payload,
    });
    expect(result.valid).toBe(true);
  });

  it("classifies response payload shape errors", () => {
    const payload: QuestionnaireResponsePayload = {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: "course_feedback_2026_term1",
      responseId: "resp_2",
      submittedAt: 1712537200,
      answers: [
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["invalid-option"] },
      ],
    };
    const result = validateQuestionnaireResponsePayload({
      definition: buildDefinition(),
      payload,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("invalid_option_id:q2:invalid-option");
    expect(result.errors).toContain("missing_required_answer:q1");
  });
});
