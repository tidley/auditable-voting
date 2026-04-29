import {
  QUESTIONNAIRE_FLOW_MODE_LEGACY_PRIVATE_DM,
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_PROTOCOL_VERSION_V1,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
  QUESTIONNAIRE_RESPONSE_MODE_LEGACY_PRIVATE_ENVELOPE,
  type QuestionnaireFlowMode,
  type QuestionnaireResponseMode,
} from "./questionnaireProtocolConstants";
import type { QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";

export type QuestionnaireQuestionBase = {
  questionId: string;
  prompt: string;
  required: boolean;
};

export type QuestionnaireYesNoQuestion = QuestionnaireQuestionBase & {
  type: "yes_no";
};

export type QuestionnaireMultipleChoiceOption = {
  optionId: string;
  label: string;
};

export type QuestionnaireMultipleChoiceQuestion = QuestionnaireQuestionBase & {
  type: "multiple_choice";
  multiSelect: boolean;
  options: QuestionnaireMultipleChoiceOption[];
};

export type QuestionnaireFreeTextQuestion = QuestionnaireQuestionBase & {
  type: "free_text";
  maxLength: number;
};

export type QuestionnaireQuestion =
  | QuestionnaireYesNoQuestion
  | QuestionnaireMultipleChoiceQuestion
  | QuestionnaireFreeTextQuestion;

export type QuestionnaireDefinition = {
  schemaVersion: 1;
  eventType: "questionnaire_definition";
  protocolVersion?: 1 | 2;
  flowMode?: QuestionnaireFlowMode;
  responseMode: QuestionnaireResponseMode;
  questionnaireId: string;
  title: string;
  description?: string;
  createdAt: number;
  openAt: number;
  closeAt: number;
  coordinatorPubkey: string;
  coordinatorEncryptionPubkey: string;
  responseVisibility: "public" | "private";
  eligibilityMode: "open" | "allowlist";
  allowMultipleResponsesPerPubkey: boolean;
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireParticipantCountEvent = {
  schemaVersion: 1;
  eventType: "questionnaire_participant_count";
  questionnaireId: string;
  expectedInviteeCount: number;
  createdAt: number;
  coordinatorPubkey: string;
};

export type QuestionnaireStateValue = "draft" | "open" | "closed" | "results_published";

export type QuestionnaireStateEvent = {
  schemaVersion: 1;
  eventType: "questionnaire_state";
  questionnaireId: string;
  state: QuestionnaireStateValue;
  createdAt: number;
  coordinatorPubkey: string;
};

export type QuestionnaireResponseAnswer =
  | {
      questionId: string;
      answerType: "yes_no";
      value: boolean;
    }
  | {
      questionId: string;
      answerType: "multiple_choice";
      selectedOptionIds: string[];
    }
  | {
      questionId: string;
      answerType: "free_text";
      text: string;
    };

export type QuestionnaireResponsePayload = {
  schemaVersion: 1;
  kind: "questionnaire_response_payload";
  questionnaireId: string;
  responseId: string;
  submittedAt: number;
  answers: QuestionnaireResponseAnswer[];
};

export type QuestionnaireResponsePrivateEnvelope = {
  schemaVersion: 1;
  eventType: "questionnaire_response_private";
  questionnaireId: string;
  responseId: string;
  createdAt: number;
  authorPubkey: string;
  ciphertextScheme: "nip44v2";
  ciphertextRecipient: string;
  ciphertext: string;
  payloadHash: string;
};

export type QuestionnaireResultQuestionSummary =
  | {
      questionId: string;
      answerType: "yes_no";
      yesCount: number;
      noCount: number;
    }
  | {
      questionId: string;
      answerType: "multiple_choice";
      optionCounts: Record<string, number>;
    }
  | {
      questionId: string;
      answerType: "free_text";
      freeTextCount: number;
    };

export type QuestionnairePublishedResponseRef = {
  responseId: string;
  authorPubkey: string;
  submittedAt: number;
  accepted: boolean;
  answers?: QuestionnaireResponseAnswer[];
};

export type QuestionnaireResultSummary = {
  schemaVersion: 1;
  eventType: "questionnaire_result_summary";
  questionnaireId: string;
  createdAt: number;
  coordinatorPubkey: string;
  acceptedResponseCount: number;
  rejectedResponseCount: number;
  acceptedNullifierCount?: number;
  questionSummaries: QuestionnaireResultQuestionSummary[];
  publishedResponseRefs?: QuestionnairePublishedResponseRef[];
  resultHash?: string;
};

export type QuestionnaireSubmissionDecisionReason =
  | "accepted"
  | "duplicate_nullifier"
  | "invalid_token_proof"
  | "invalid_payload_shape"
  | "questionnaire_closed";

export type QuestionnaireSubmissionDecision = {
  schemaVersion: 1;
  eventType: "questionnaire_submission_decision";
  questionnaireId: string;
  submissionId: string;
  tokenNullifier: string;
  accepted: boolean;
  reason: QuestionnaireSubmissionDecisionReason;
  decidedAt: number;
  coordinatorPubkey: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

function isNonEmpty(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateQuestionnaireDefinition(input: QuestionnaireDefinition): ValidationResult {
  const errors: string[] = [];
  if (
    input.flowMode !== undefined
    && input.flowMode !== QUESTIONNAIRE_FLOW_MODE_LEGACY_PRIVATE_DM
    && input.flowMode !== QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1
  ) {
    errors.push("flow_mode_invalid");
  }
  if (
    input.responseMode !== QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN
    && input.responseMode !== QUESTIONNAIRE_RESPONSE_MODE_LEGACY_PRIVATE_ENVELOPE
  ) {
    errors.push("response_mode_invalid");
  }
  if (!isNonEmpty(input.questionnaireId)) {
    errors.push("questionnaire_id_missing");
  }
  if (!isNonEmpty(input.coordinatorPubkey)) {
    errors.push("coordinator_pubkey_missing");
  }
  if (!isNonEmpty(input.coordinatorEncryptionPubkey)) {
    errors.push("coordinator_encryption_pubkey_missing");
  }
  if (!Number.isFinite(input.openAt) || !Number.isFinite(input.closeAt) || input.openAt >= input.closeAt) {
    errors.push("invalid_open_close_window");
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    errors.push("questions_missing");
  } else {
    const questionIds = new Set<string>();
    for (const question of input.questions) {
      if (!isNonEmpty(question.questionId)) {
        errors.push("question_id_missing");
        continue;
      }
      if (questionIds.has(question.questionId)) {
        errors.push(`question_id_duplicate:${question.questionId}`);
      }
      questionIds.add(question.questionId);

      if (question.type === "multiple_choice") {
        if (!Array.isArray(question.options) || question.options.length < 2) {
          errors.push(`multiple_choice_insufficient_options:${question.questionId}`);
          continue;
        }
        const optionIds = new Set<string>();
        for (const option of question.options) {
          if (!isNonEmpty(option.optionId)) {
            errors.push(`option_id_missing:${question.questionId}`);
            continue;
          }
          if (optionIds.has(option.optionId)) {
            errors.push(`option_id_duplicate:${question.questionId}:${option.optionId}`);
          }
          optionIds.add(option.optionId);
        }
      }

      if (question.type === "free_text") {
        if (!Number.isFinite(question.maxLength) || question.maxLength <= 0) {
          errors.push(`invalid_free_text_max_length:${question.questionId}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeQuestionnaireDefinition(
  input: Omit<QuestionnaireDefinition, "responseMode" | "flowMode"> & {
    responseMode?: QuestionnaireResponseMode | null;
    flowMode?: QuestionnaireFlowMode | null;
  },
): QuestionnaireDefinition {
  const responseMode = input.responseMode ?? QUESTIONNAIRE_RESPONSE_MODE_LEGACY_PRIVATE_ENVELOPE;
  const flowMode = input.flowMode
    ?? (responseMode === QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN
      ? QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1
      : QUESTIONNAIRE_FLOW_MODE_LEGACY_PRIVATE_DM);
  return {
    ...input,
    responseMode,
    flowMode,
    protocolVersion: input.protocolVersion ?? QUESTIONNAIRE_PROTOCOL_VERSION_V1,
  };
}

export function validateQuestionnaireResponsePayload(input: {
  definition: QuestionnaireDefinition;
  payload: QuestionnaireResponsePayload;
}): ValidationResult {
  const errors: string[] = [];
  const { definition, payload } = input;
  if (payload.questionnaireId !== definition.questionnaireId) {
    errors.push("questionnaire_id_mismatch");
  }
  const byQuestionId = new Map(definition.questions.map((question) => [question.questionId, question]));
  const seenAnswers = new Set<string>();

  for (const answer of payload.answers) {
    const question = byQuestionId.get(answer.questionId);
    if (!question) {
      errors.push(`unknown_question_id:${answer.questionId}`);
      continue;
    }
    if (seenAnswers.has(answer.questionId)) {
      errors.push(`duplicate_answer:${answer.questionId}`);
      continue;
    }
    seenAnswers.add(answer.questionId);

    if (question.type === "yes_no") {
      if (answer.answerType !== "yes_no") {
        errors.push(`invalid_answer_type:${answer.questionId}`);
      }
      continue;
    }

    if (question.type === "multiple_choice") {
      if (answer.answerType !== "multiple_choice") {
        errors.push(`invalid_answer_type:${answer.questionId}`);
        continue;
      }
      const selected = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [];
      if (!question.multiSelect && selected.length !== 1) {
        errors.push(`invalid_selection_count:${answer.questionId}`);
      }
      const validOptions = new Set(question.options.map((option) => option.optionId));
      for (const optionId of selected) {
        if (!validOptions.has(optionId)) {
          errors.push(`invalid_option_id:${answer.questionId}:${optionId}`);
        }
      }
      continue;
    }

    if (answer.answerType !== "free_text") {
      errors.push(`invalid_answer_type:${answer.questionId}`);
      continue;
    }
    if (answer.text.length > question.maxLength) {
      errors.push(`free_text_too_long:${answer.questionId}`);
    }
  }

  for (const question of definition.questions) {
    if (question.required && !seenAnswers.has(question.questionId)) {
      errors.push(`missing_required_answer:${question.questionId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
