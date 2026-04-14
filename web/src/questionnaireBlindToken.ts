import { sha256HexRust } from "./wasm/auditableVotingCore";
import {
  QUESTIONNAIRE_BLIND_TOKEN_MESSAGE_DOMAIN,
  QUESTIONNAIRE_NULLIFIER_DOMAIN,
  QUESTIONNAIRE_RESULT_HASH_DOMAIN,
} from "./questionnaireProtocolConstants";
import type { QuestionnaireResultQuestionSummary } from "./questionnaireProtocol";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJsonStringify(value: CanonicalValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`).join(",")}}`;
}

export function buildQuestionnaireBlindTokenSignedMessage(input: {
  questionnaireId: string;
  tokenSecretCommitment: string;
}) {
  return canonicalJsonStringify({
    questionnaire_id: input.questionnaireId,
    response_mode: "blind_token",
    schema_version: 1,
    token_secret_commitment: input.tokenSecretCommitment,
  });
}

export function deriveQuestionnaireBlindTokenMessageHash(input: {
  questionnaireId: string;
  tokenSecretCommitment: string;
}) {
  const payload = canonicalJsonStringify({
    domain: QUESTIONNAIRE_BLIND_TOKEN_MESSAGE_DOMAIN,
    message: JSON.parse(buildQuestionnaireBlindTokenSignedMessage(input)),
  });
  return sha256HexRust(payload);
}

export function deriveQuestionnaireTokenNullifier(input: {
  questionnaireId: string;
  tokenSecret: string;
}) {
  const payload = canonicalJsonStringify({
    domain: QUESTIONNAIRE_NULLIFIER_DOMAIN,
    questionnaire_id: input.questionnaireId,
    token_secret: input.tokenSecret,
  });
  return sha256HexRust(payload);
}

function sortQuestionSummariesCanonical(summaries: QuestionnaireResultQuestionSummary[]) {
  return [...summaries]
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .map((summary) => {
      if (summary.answerType !== "multiple_choice") {
        return summary;
      }
      const optionCounts = Object.fromEntries(
        Object.entries(summary.optionCounts).sort(([left], [right]) => left.localeCompare(right)),
      );
      return { ...summary, optionCounts };
    });
}

export function deriveQuestionnaireResultHash(input: {
  questionnaireId: string;
  acceptedResponseCount: number;
  rejectedResponseCount: number;
  acceptedNullifierCount: number;
  questionSummaries: QuestionnaireResultQuestionSummary[];
}) {
  const payload = canonicalJsonStringify({
    domain: QUESTIONNAIRE_RESULT_HASH_DOMAIN,
    questionnaire_id: input.questionnaireId,
    accepted_response_count: input.acceptedResponseCount,
    rejected_response_count: input.rejectedResponseCount,
    accepted_nullifier_count: input.acceptedNullifierCount,
    question_summaries: sortQuestionSummariesCanonical(input.questionSummaries),
  });
  return sha256HexRust(payload);
}
