import { describe, expect, it } from "vitest";
import { buildQuestionnaireResultSummary, type QuestionnaireAcceptedResponse } from "./questionnaireRuntime";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";

const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  questionnaireId: "course_feedback_2026_term1",
  title: "Course feedback",
  createdAt: 1712530000,
  openAt: 1712533600,
  closeAt: 1712619999,
  coordinatorPubkey: "npub1coordinator",
  coordinatorEncryptionPubkey: "npub1coordinator",
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

function response(id: string, yes: boolean, option: string, freeText: string): QuestionnaireAcceptedResponse {
  return {
    eventId: `event-${id}`,
    authorPubkey: `npub1author${id}`,
    envelope: {
      schemaVersion: 1,
      eventType: "questionnaire_response_private",
      questionnaireId: definition.questionnaireId,
      responseId: id,
      createdAt: 1712537200,
      authorPubkey: `npub1author${id}`,
      ciphertextScheme: "nip44v2",
      ciphertextRecipient: definition.coordinatorEncryptionPubkey,
      ciphertext: "ciphertext",
      payloadHash: "hash",
    },
    payload: {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: definition.questionnaireId,
      responseId: id,
      submittedAt: 1712537200,
      answers: [
        { questionId: "q1", answerType: "yes_no", value: yes },
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: [option] },
        { questionId: "q3", answerType: "free_text", text: freeText },
      ],
    },
  };
}

describe("questionnaireRuntime", () => {
  it("builds aggregate summary counts from accepted responses", () => {
    const summary = buildQuestionnaireResultSummary({
      definition,
      coordinatorPubkey: definition.coordinatorPubkey,
      acceptedResponses: [
        response("1", true, "good", "More examples"),
        response("2", false, "fast", ""),
      ],
      rejectedResponses: [{
        eventId: "event-3",
        authorPubkey: "npub1author3",
        responseId: "3",
        reason: "invalid_option_id",
      }],
    });

    expect(summary.acceptedResponseCount).toBe(2);
    expect(summary.rejectedResponseCount).toBe(1);

    const yesNo = summary.questionSummaries.find((entry) => entry.questionId === "q1");
    expect(yesNo).toMatchObject({ answerType: "yes_no", yesCount: 1, noCount: 1 });

    const multipleChoice = summary.questionSummaries.find((entry) => entry.questionId === "q2");
    expect(multipleChoice).toMatchObject({
      answerType: "multiple_choice",
      optionCounts: {
        slow: 0,
        good: 1,
        fast: 1,
      },
    });

    const freeText = summary.questionSummaries.find((entry) => entry.questionId === "q3");
    expect(freeText).toMatchObject({ answerType: "free_text", freeTextCount: 1 });
  });
});
