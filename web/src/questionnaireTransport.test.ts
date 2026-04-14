import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { evaluateQuestionnaireBlindAdmissions } from "./questionnaireTransport";
import type { QuestionnaireBlindResponseEvent } from "./questionnaireResponsePublish";

function blindResponse(input: {
  responseId: string;
  nullifier: string;
  createdAt: number;
  eventId: string;
}): { event: NostrEvent; response: QuestionnaireBlindResponseEvent } {
  return {
    event: {
      id: input.eventId,
      kind: 14124,
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
      submittedAt: input.createdAt,
      authorPubkey: "npub1author",
      tokenNullifier: input.nullifier,
      tokenProof: {
        tokenCommitment: "commitment",
        questionnaireId: "course_feedback_2026_term1",
        signature: "signature",
      },
      answers: [],
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
});
