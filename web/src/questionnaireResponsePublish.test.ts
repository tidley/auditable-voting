import { describe, expect, it } from "vitest";
import { getPublicKey, nip19, nip44 } from "nostr-tools";
import {
  decryptQuestionnaireBlindResponseAnswers,
  parseQuestionnaireBlindResponseEncryptedPayload,
  type QuestionnaireBlindResponseEvent,
} from "./questionnaireResponsePublish";
import { sha256HexRust } from "./wasm/auditableVotingCore";

describe("questionnaire response publish helpers", () => {
  it("decrypts an encrypted blind response payload with the coordinator nsec", () => {
    const coordinatorSecret = new Uint8Array(32).fill(1);
    const responseSecret = new Uint8Array(32).fill(2);
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const coordinatorHex = getPublicKey(coordinatorSecret);
    const responseHex = getPublicKey(responseSecret);
    const payloadJson = JSON.stringify({
      schemaVersion: 1,
      eventType: "questionnaire_response_blind_payload",
      questionnaireId: "q1",
      responseId: "resp1",
      submittedAt: 100,
      answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
    });
    const conversationKey = nip44.v2.utils.getConversationKey(responseSecret, coordinatorHex);
    const encryptedPayload = nip44.v2.encrypt(payloadJson, conversationKey);
    const response: QuestionnaireBlindResponseEvent = {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: "q1",
      responseId: "resp1",
      submittedAt: 100,
      authorPubkey: nip19.npubEncode(responseHex),
      tokenNullifier: "nullifier1",
      tokenProof: {
        tokenCommitment: "commitment1",
        questionnaireId: "q1",
        signature: "sig1",
      },
      encryptedPayload,
      payloadHash: sha256HexRust(payloadJson),
    };

    const decrypted = decryptQuestionnaireBlindResponseAnswers({
      coordinatorNsec,
      eventPubkey: responseHex,
      response,
    });

    expect(decrypted.encryptedPayloadDecrypted).toBe(true);
    expect(decrypted.answers).toEqual([{ questionId: "q1", answerType: "yes_no", value: true }]);
    expect(parseQuestionnaireBlindResponseEncryptedPayload(payloadJson)?.responseId).toBe("resp1");
  });

  it("decrypts encrypted free-text answers in public blind responses", () => {
    const coordinatorSecret = new Uint8Array(32).fill(3);
    const responseSecret = new Uint8Array(32).fill(4);
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const coordinatorHex = getPublicKey(coordinatorSecret);
    const responseHex = getPublicKey(responseSecret);
    const conversationKey = nip44.v2.utils.getConversationKey(responseSecret, coordinatorHex);
    const ciphertext = nip44.v2.encrypt("private comment", conversationKey);
    const response: QuestionnaireBlindResponseEvent = {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: "q1",
      responseId: "resp1",
      submittedAt: 100,
      authorPubkey: nip19.npubEncode(responseHex),
      tokenNullifier: "nullifier1",
      tokenProof: {
        tokenCommitment: "commitment1",
        questionnaireId: "q1",
        signature: "sig1",
      },
      answers: [
        { questionId: "q1", answerType: "free_text", text: `enc:nip44v2:${ciphertext}` },
      ],
    };

    const decrypted = decryptQuestionnaireBlindResponseAnswers({
      coordinatorNsec,
      eventPubkey: response.authorPubkey,
      response,
    });

    expect(decrypted.encryptedFreeTextDecryptedCount).toBe(1);
    expect(decrypted.answers).toEqual([
      { questionId: "q1", answerType: "free_text", text: "private comment" },
    ]);
  });
});
