import { describe, expect, it } from "vitest";
import {
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
});
