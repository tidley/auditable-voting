import { sha256HexRust } from "./wasm/auditableVotingCore";
import {
  QUESTIONNAIRE_BLIND_TOKEN_MESSAGE_DOMAIN,
  QUESTIONNAIRE_NULLIFIER_DOMAIN,
  QUESTIONNAIRE_RESULT_HASH_DOMAIN,
} from "./questionnaireProtocolConstants";
import {
  normaliseQuestionnaireAllowedScopes,
  normaliseQuestionnaireBallotGroup,
  type QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";

export type QuestionnaireBlindTokenScope = {
  questionId?: string | null;
  slotId?: string | null;
  slotIndex?: number | null;
  version?: number | null;
  credentialIndex?: number | null;
  allowedScopes?: string[] | null;
  /** Legacy alias for allowedScopes. */
  ballotGroup?: string | null;
};

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
  ballotScope?: QuestionnaireBlindTokenScope | null;
}) {
  const ballotScope = normaliseBlindTokenScope(input.ballotScope);
  return canonicalJsonStringify({
    questionnaire_id: input.questionnaireId,
    response_mode: "blind_token",
    schema_version: 1,
    token_secret_commitment: input.tokenSecretCommitment,
    ...(ballotScope ? { ballot_scope: ballotScope } : {}),
  });
}

export function deriveQuestionnaireBlindTokenMessageHash(input: {
  questionnaireId: string;
  tokenSecretCommitment: string;
  ballotScope?: QuestionnaireBlindTokenScope | null;
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
  ballotScope?: QuestionnaireBlindTokenScope | null;
}) {
  const ballotScope = normaliseBlindTokenScope(input.ballotScope);
  const payload = canonicalJsonStringify({
    domain: QUESTIONNAIRE_NULLIFIER_DOMAIN,
    questionnaire_id: input.questionnaireId,
    token_secret: input.tokenSecret,
    ...(ballotScope ? { ballot_scope: ballotScope } : {}),
  });
  return sha256HexRust(payload);
}

export function normaliseBlindTokenScope(scope: QuestionnaireBlindTokenScope | null | undefined) {
  if (!scope) {
    return null;
  }
  const questionId = scope.questionId?.trim() ?? "";
  const slotId = scope.slotId?.trim() ?? "";
  const slotIndex = Number.isFinite(scope.slotIndex)
    ? Math.max(1, Math.floor(scope.slotIndex as number))
    : null;
  const version = Number.isFinite(scope.version)
    ? Math.max(1, Math.floor(scope.version as number))
    : null;
  const credentialIndex = Number.isFinite(scope.credentialIndex)
    ? Math.max(1, Math.floor(scope.credentialIndex as number))
    : null;
  const ballotGroup = normaliseQuestionnaireBallotGroup(scope.ballotGroup);
  const allowedScopes = normaliseQuestionnaireAllowedScopes(scope.allowedScopes, ballotGroup);
  const includeAllowedScopes = Array.isArray(scope.allowedScopes) || Boolean(ballotGroup);
  if (!questionId && !slotId && !slotIndex && !version && (!credentialIndex || credentialIndex <= 1) && !includeAllowedScopes) {
    return null;
  }
  return {
    ...(questionId ? { question_id: questionId } : {}),
    ...(slotId ? { slot_id: slotId } : {}),
    ...(slotIndex ? { slot_index: slotIndex } : {}),
    ...(version ? { version } : {}),
    ...(credentialIndex && credentialIndex > 1 ? { credential_index: credentialIndex } : {}),
    ...(includeAllowedScopes ? { allowed_scopes: allowedScopes } : {}),
  };
}

function sortQuestionSummariesCanonical(summaries: QuestionnaireResultQuestionSummary[]) {
  return [...summaries]
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .map((summary) => {
      if (summary.answerType !== "multiple_choice" && summary.answerType !== "rank") {
        return summary;
      }
      if (summary.answerType === "multiple_choice") {
        const optionCounts = Object.fromEntries(
          Object.entries(summary.optionCounts).sort(([left], [right]) => left.localeCompare(right)),
        );
        return { ...summary, optionCounts };
      }
      const optionScores = Object.fromEntries(
        Object.entries(summary.optionScores).sort(([left], [right]) => left.localeCompare(right)),
      );
      const rankCounts = Object.fromEntries(
        Object.entries(summary.rankCounts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([optionId, counts]) => [
            optionId,
            Object.fromEntries(Object.entries(counts).sort(([left], [right]) => Number(left) - Number(right))),
          ]),
      );
      return { ...summary, optionScores, rankCounts };
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
