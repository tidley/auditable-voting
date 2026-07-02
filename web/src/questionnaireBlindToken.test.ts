import { describe, expect, it } from "vitest";
import {
  buildQuestionnaireBlindTokenSignedMessage,
  canonicalJsonStringify,
  deriveQuestionnaireBlindTokenMessageHash,
  deriveQuestionnaireTokenNullifier,
} from "./questionnaireBlindToken";

describe("questionnaireBlindToken", () => {
  it("canonicalizes object keys deterministically", () => {
    const left = canonicalJsonStringify({ b: 2, a: 1 });
    const right = canonicalJsonStringify({ a: 1, b: 2 });
    expect(left).toBe(right);
  });

  it("derives stable questionnaire-bound nullifiers", () => {
    const tokenSecret = "0123456789abcdef";
    const first = deriveQuestionnaireTokenNullifier({
      questionnaireId: "q-1",
      tokenSecret,
    });
    const second = deriveQuestionnaireTokenNullifier({
      questionnaireId: "q-1",
      tokenSecret,
    });
    const differentQuestionnaire = deriveQuestionnaireTokenNullifier({
      questionnaireId: "q-2",
      tokenSecret,
    });

    expect(first).toBe(second);
    expect(differentQuestionnaire).not.toBe(first);
  });

  it("derives stable blind-token message hash", () => {
    const first = deriveQuestionnaireBlindTokenMessageHash({
      questionnaireId: "q-1",
      tokenSecretCommitment: "commitment-a",
    });
    const second = deriveQuestionnaireBlindTokenMessageHash({
      questionnaireId: "q-1",
      tokenSecretCommitment: "commitment-a",
    });
    expect(first).toBe(second);
  });

  it("binds blind-token messages and nullifiers to a question slot when scoped", () => {
    const ballotScope = {
      questionId: "q1",
      slotId: "director_1",
      slotIndex: 1,
      version: 2,
    };
    const message = buildQuestionnaireBlindTokenSignedMessage({
      questionnaireId: "agm-1",
      tokenSecretCommitment: "commitment-a",
      ballotScope,
    });
    expect(JSON.parse(message)).toEqual({
      ballot_scope: {
        question_id: "q1",
        slot_id: "director_1",
        slot_index: 1,
        version: 2,
      },
      questionnaire_id: "agm-1",
      response_mode: "blind_token",
      schema_version: 1,
      token_secret_commitment: "commitment-a",
    });

    const first = deriveQuestionnaireTokenNullifier({
      questionnaireId: "agm-1",
      tokenSecret: "secret-a",
      ballotScope,
    });
    const changedVersion = deriveQuestionnaireTokenNullifier({
      questionnaireId: "agm-1",
      tokenSecret: "secret-a",
      ballotScope: { ...ballotScope, version: 3 },
    });
    const unscoped = deriveQuestionnaireTokenNullifier({
      questionnaireId: "agm-1",
      tokenSecret: "secret-a",
    });

    expect(changedVersion).not.toBe(first);
    expect(unscoped).not.toBe(first);
  });

  it("separates proxy credential indexes in signed messages and nullifiers", () => {
    const firstScope = {
      questionId: "q1",
      slotId: "director_1",
      slotIndex: 1,
      version: 1,
    };
    const secondScope = {
      ...firstScope,
      credentialIndex: 2,
    };
    const firstMessage = buildQuestionnaireBlindTokenSignedMessage({
      questionnaireId: "agm-1",
      tokenSecretCommitment: "commitment-a",
      ballotScope: firstScope,
    });
    const secondMessage = buildQuestionnaireBlindTokenSignedMessage({
      questionnaireId: "agm-1",
      tokenSecretCommitment: "commitment-a",
      ballotScope: secondScope,
    });

    expect(firstMessage).not.toBe(secondMessage);
    expect(JSON.parse(secondMessage).ballot_scope).toMatchObject({
      credential_index: 2,
      question_id: "q1",
      slot_id: "director_1",
    });
    expect(deriveQuestionnaireTokenNullifier({
      questionnaireId: "agm-1",
      tokenSecret: "secret-a",
      ballotScope: firstScope,
    })).not.toBe(deriveQuestionnaireTokenNullifier({
      questionnaireId: "agm-1",
      tokenSecret: "secret-a",
      ballotScope: secondScope,
    }));
  });
});
