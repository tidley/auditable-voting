import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { evaluateQuestionnaireBlindAdmissions } from "./questionnaireTransport";
import {
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
  type QuestionnaireBlindResponseEvent,
  type QuestionnaireSubmissionDecisionEvent,
} from "./questionnaireResponsePublish";

function blindResponse(input: {
  responseId: string;
  nullifier: string;
  createdAt: number;
  eventId: string;
  submittedAt?: number;
  answerText?: string;
}): { event: NostrEvent; response: QuestionnaireBlindResponseEvent } {
  return {
    event: {
      id: input.eventId,
      kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
      pubkey: "pubkey",
      created_at: input.createdAt,
      tags: [],
      content: "",
      sig: "sig",
    },
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: "course_feedback_2026_term1",
      responseId: input.responseId,
      submittedAt: input.submittedAt ?? input.createdAt,
      authorPubkey: "npub1author",
      tokenNullifier: input.nullifier,
      tokenProof: {
        tokenCommitment: "commitment",
        questionnaireId: "course_feedback_2026_term1",
        signature: "signature",
      },
      answers: input.answerText
        ? [{ questionId: "q1", answerType: "free_text", text: input.answerText }]
        : [],
    },
  };
}

function submissionDecision(input: {
  submissionId: string;
  nullifier: string;
  accepted: boolean;
  reason?: QuestionnaireSubmissionDecisionEvent["reason"];
  createdAt: number;
  eventId: string;
}): { event: NostrEvent; decision: QuestionnaireSubmissionDecisionEvent } {
  return {
    event: {
      id: input.eventId,
      kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
      pubkey: "decision-pubkey",
      created_at: input.createdAt,
      tags: [],
      content: "",
      sig: "sig",
    },
    decision: {
      schemaVersion: 1,
      eventType: "questionnaire_submission_decision",
      questionnaireId: "course_feedback_2026_term1",
      submissionId: input.submissionId,
      tokenNullifier: input.nullifier,
      accepted: input.accepted,
      reason: input.reason ?? (input.accepted ? "accepted" : "invalid_token_proof"),
      decidedAt: input.createdAt,
      coordinatorPubkey: "npub1coordinator",
    },
  };
}

describe("questionnaireTransport blind admissions", () => {
  it("accepts first response and rejects later duplicate nullifier", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const second = blindResponse({
      responseId: "resp-2",
      nullifier: "nullifier-x",
      createdAt: 1712537201,
      eventId: "event-bbb",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [second, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.accepted[0].response.responseId).toBe("resp-1");
    expect(result.rejected[0].response.responseId).toBe("resp-2");
    expect(result.rejected[0].rejectionReason).toBe("duplicate_nullifier");
    expect(result.acceptedCountByNullifier["nullifier-x"]).toBe(1);
  });

  it("rejects bundled responses when any scoped nullifier was already accepted", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-q1",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    first.response.tokenNullifiers = [
      { questionId: "q1", tokenNullifier: "nullifier-q1", ballotScope: { questionId: "q1", slotId: "q1", slotIndex: 1, version: 1 } },
      { questionId: "q2", tokenNullifier: "nullifier-q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];
    first.response.tokenProofs = [
      { ...first.response.tokenProof, questionId: "q1", ballotScope: { questionId: "q1", slotId: "q1", slotIndex: 1, version: 1 } },
      { ...first.response.tokenProof, tokenCommitment: "commitment-q2", questionId: "q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];
    const second = blindResponse({
      responseId: "resp-2",
      nullifier: "nullifier-q2",
      createdAt: 1712537201,
      eventId: "event-bbb",
    });
    second.response.tokenNullifiers = [
      { questionId: "q2", tokenNullifier: "nullifier-q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [second, first],
    });

    expect(result.accepted.map((entry) => entry.response.responseId)).toEqual(["resp-1"]);
    expect(result.rejected.map((entry) => entry.response.responseId)).toEqual(["resp-2"]);
    expect(result.rejected[0].rejectionReason).toBe("duplicate_nullifier");
    expect(result.acceptedCountByNullifier).toMatchObject({
      "nullifier-q1": 1,
      "nullifier-q2": 1,
    });
  });

  it("does not reject the same relay event when it is returned more than once", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response, response],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].response.responseId).toBe("resp-1");
  });

  it("treats a republished response id as one logical submission", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const republished = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537300,
      submittedAt: 1712537200,
      eventId: "event-bbb",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [republished, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].event.id).toBe("event-aaa");
  });

  it("rejects a repeated response id with a conflicting payload", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
      answerText: "Original answer",
    });
    const conflicting = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-y",
      createdAt: 1712537300,
      eventId: "event-bbb",
      answerText: "Changed answer",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [conflicting, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.accepted[0].event.id).toBe("event-aaa");
    expect(result.rejected[0].event.id).toBe("event-bbb");
    expect(result.rejected[0].rejectionReason).toBe("duplicate_response");
  });

  it("keeps a submission accepted when a later rejection conflicts with an accepted decision", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const accepted = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: true,
      createdAt: 1712537300,
      eventId: "decision-accepted",
    });
    const laterInvalid = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: false,
      reason: "invalid_token_proof",
      createdAt: 1712537400,
      eventId: "decision-invalid",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [accepted, laterInvalid],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].decisionEventId).toBe("decision-accepted");
    expect(result.accepted[0].rejectionReason).toBe(null);
  });

  it("ignores an invalid-token-proof decision for a locally verified response", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const invalid = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: false,
      reason: "invalid_token_proof",
      createdAt: 1712537300,
      eventId: "decision-invalid",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [invalid],
      verifiedResponseIds: ["resp-1"],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].decisionEventId).toBe(null);
    expect(result.accepted[0].rejectionReason).toBe(null);
  });
});
