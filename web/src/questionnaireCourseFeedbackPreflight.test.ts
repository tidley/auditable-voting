import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { getPublicKey, nip19 } from "nostr-tools";
import { buildQuestionnaireResultSummary } from "./questionnaireRuntime";
import { validateQuestionnaireDefinition, validateQuestionnaireResponsePayload, type QuestionnaireDefinition } from "./questionnaireProtocol";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import { resolveQuestionnaireResponderNpub } from "./questionnaireResponderIdentity";
import { evaluateQuestionnaireBlindAdmissions } from "./questionnaireTransport";

const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
  questionnaireId: "q_preflight_2026",
  title: "Preflight",
  description: "Preflight validation fixture.",
  createdAt: 1712530000,
  openAt: 1712531000,
  closeAt: 1712539999,
  coordinatorPubkey: "npub1coordinator",
  coordinatorEncryptionPubkey: "npub1coordinator",
  responseVisibility: "private",
  eligibilityMode: "open",
  allowMultipleResponsesPerPubkey: false,
  questions: [
    {
      questionId: "q1",
      type: "yes_no",
      prompt: "Proceed?",
      required: true,
    },
  ],
};

describe("course feedback preflight", () => {
  it("validates questionnaire definition and response payload shape", () => {
    const definitionResult = validateQuestionnaireDefinition(definition);
    expect(definitionResult.valid).toBe(true);

    const payloadResult = validateQuestionnaireResponsePayload({
      definition,
      payload: {
        schemaVersion: 1,
        kind: "questionnaire_response_payload",
        questionnaireId: definition.questionnaireId,
        responseId: "resp_1",
        submittedAt: definition.openAt + 10,
        answers: [
          { questionId: "q1", answerType: "yes_no", value: true },
        ],
      },
    });
    expect(payloadResult.valid).toBe(true);
  });

  it("keeps responder identity stable per questionnaire", () => {
    const secret = new Uint8Array(32).fill(7);
    const responseNsec = nip19.nsecEncode(secret);
    const responseNpub = nip19.npubEncode(getPublicKey(secret));
    const resolved = resolveQuestionnaireResponderNpub({
      voterNpub: "npub1fallback",
      questionnaireId: definition.questionnaireId,
      responseIdentityByQuestionnaireId: {
        [definition.questionnaireId]: responseNsec,
      },
    });
    expect(resolved).toBe(responseNpub);
  });

  it("rejects duplicate nullifier submissions and preserves unique acceptance accounting", () => {
    const entries = [
      {
        event: { id: "a", created_at: 10 } as NostrEvent,
        response: {
          schemaVersion: 1,
          eventType: "questionnaire_response_blind",
          questionnaireId: definition.questionnaireId,
          responseId: "resp-a",
          authorPubkey: "npub1voter",
          tokenNullifier: "nullifier-1",
          submittedAt: definition.openAt + 20,
          tokenProof: {
            tokenCommitment: "token-1",
            questionnaireId: definition.questionnaireId,
            signature: "sig-1",
          },
          answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
        },
      },
      {
        event: { id: "b", created_at: 11 } as NostrEvent,
        response: {
          schemaVersion: 1,
          eventType: "questionnaire_response_blind",
          questionnaireId: definition.questionnaireId,
          responseId: "resp-b",
          authorPubkey: "npub1voter",
          tokenNullifier: "nullifier-1",
          submittedAt: definition.openAt + 21,
          tokenProof: {
            tokenCommitment: "token-1",
            questionnaireId: definition.questionnaireId,
            signature: "sig-2",
          },
          answers: [{ questionId: "q1", answerType: "yes_no", value: false }],
        },
      },
    ];
    const admissions = evaluateQuestionnaireBlindAdmissions({ entries });
    expect(admissions.accepted).toHaveLength(1);
    expect(admissions.rejected).toHaveLength(1);
    expect(admissions.rejected[0]?.rejectionReason).toBe("duplicate_nullifier");
    expect(admissions.acceptedCountByNullifier["nullifier-1"]).toBe(1);
  });

  it("derives coordinator acceptance summary from accepted/rejected accounting", () => {
    const summary = buildQuestionnaireResultSummary({
      definition,
      coordinatorPubkey: definition.coordinatorPubkey,
      acceptedResponses: [
        {
          eventId: "event-1",
          authorPubkey: "npub1a",
          envelope: {
            schemaVersion: 1,
            eventType: "questionnaire_response_private",
            questionnaireId: definition.questionnaireId,
            responseId: "resp-1",
            createdAt: definition.openAt + 20,
            authorPubkey: "npub1a",
            ciphertextScheme: "nip44v2",
            ciphertextRecipient: definition.coordinatorEncryptionPubkey,
            ciphertext: "cipher",
            payloadHash: "hash1",
          },
          payload: {
            schemaVersion: 1,
            kind: "questionnaire_response_payload",
            questionnaireId: definition.questionnaireId,
            responseId: "resp-1",
            submittedAt: definition.openAt + 20,
            answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
          },
        },
      ],
      rejectedResponses: [
        {
          eventId: "event-2",
          authorPubkey: "npub1b",
          responseId: "resp-2",
          reason: "duplicate_response",
        },
      ],
    });
    expect(summary.acceptedResponseCount).toBe(1);
    expect(summary.rejectedResponseCount).toBe(1);
    expect(summary.acceptedNullifierCount).toBe(1);
  });
});
