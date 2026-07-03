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
import {
  normalizeQuestionnaireRelays,
  questionnaireRelaysForMetadata,
} from "./questionnaireRelays";

export type QuestionnaireQuestionBase = {
  questionId: string;
  prompt: string;
  required: boolean;
  ballotSlot?: QuestionnaireBallotSlot | null;
};

export type QuestionnaireBallotCredentialMode = "questionnaire" | "per_question";

export type QuestionnaireBallotSlot = {
  slotId: string;
  slotIndex: number;
  version: number;
};

export type QuestionnaireCredentialsPerVoter = 1 | 2;

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

export type QuestionnaireRankQuestion = QuestionnaireQuestionBase & {
  type: "rank";
  options: QuestionnaireMultipleChoiceOption[];
  minimumRanked: number;
};

export type QuestionnaireFreeTextQuestion = QuestionnaireQuestionBase & {
  type: "free_text";
  maxLength: number;
  encryptResponses?: boolean;
};

export type QuestionnaireQuestion =
  | QuestionnaireYesNoQuestion
  | QuestionnaireMultipleChoiceQuestion
  | QuestionnaireRankQuestion
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
  ballotCredentialMode?: QuestionnaireBallotCredentialMode;
  credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  questionnaireRelays?: string[];
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireDefinitionReference = {
  questionnaireId: string;
  coordinatorNpub?: string | null;
  relays?: string[];
  definitionHash?: string | null;
  definitionEventId?: string | null;
  createdAt?: number | null;
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
  closedBy?: "audit_proxy" | "coordinator";
  delegationId?: string;
  workerPubkey?: string;
};

export type QuestionnairePrivateInviteStatusEvent = {
  schemaVersion: 1;
  eventType: "questionnaire_private_invite_status";
  questionnaireId: string;
  codeHash: string;
  state: "available" | "redeemed" | "revoked";
  createdAt: number;
  coordinatorPubkey: string;
  redeemedNpubHash?: string | null;
  redeemedAt?: string | null;
  revokedAt?: string | null;
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
      answerType: "rank";
      rankedOptionIds: string[];
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
      answerType: "rank";
      optionScores: Record<string, number>;
      rankCounts: Record<string, Record<string, number>>;
      responseCount: number;
      blankResponseCount: number;
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
  rejectionReason?: string | null;
};

export type QuestionnaireResultPackReference = {
  url: string;
  sha256: string;
  size: number;
  type: "application/vnd.auditable-voting.result-pack+json";
  compression: "gzip";
  uploadEncoding?: "gzip" | "json+base64url-gzip";
  payloadSha256?: string;
  payloadSize?: number;
  uploadedAt: number;
  server?: string;
  mirrors?: Array<{
    url: string;
    server?: string;
  }>;
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
  resultPack?: QuestionnaireResultPackReference;
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

export function questionnaireUsesPerQuestionCredentials(definition: Pick<QuestionnaireDefinition, "ballotCredentialMode"> | null | undefined) {
  return definition?.ballotCredentialMode === "per_question";
}

export function questionnaireCredentialsPerVoter(definition: Pick<QuestionnaireDefinition, "credentialsPerVoter"> | null | undefined): QuestionnaireCredentialsPerVoter {
  return normaliseQuestionnaireCredentialsPerVoter(definition?.credentialsPerVoter);
}

export function normaliseQuestionnaireCredentialsPerVoter(value: unknown): QuestionnaireCredentialsPerVoter {
  return value === 2 ? 2 : 1;
}

export function normaliseQuestionBallotSlot(question: QuestionnaireQuestion, index: number): QuestionnaireBallotSlot {
  const slot = question.ballotSlot ?? null;
  const rawSlotIndex = slot?.slotIndex;
  const rawVersion = slot?.version;
  const slotIndex = Number.isFinite(rawSlotIndex)
    ? Math.max(1, Math.floor(rawSlotIndex as number))
    : index + 1;
  const version = Number.isFinite(rawVersion)
    ? Math.max(1, Math.floor(rawVersion as number))
    : 1;
  const slotId = typeof slot?.slotId === "string" && slot.slotId.trim()
    ? slot.slotId.trim()
    : question.questionId.trim();
  return {
    slotId,
    slotIndex,
    version,
  };
}

export function questionBallotScopeKey(question: QuestionnaireQuestion, index: number, credentialIndex = 1) {
  const slot = normaliseQuestionBallotSlot(question, index);
  const credentialSuffix = Number.isFinite(credentialIndex) && Math.floor(credentialIndex) > 1
    ? `:c${Math.floor(credentialIndex)}`
    : "";
  return `slot:${slot.slotIndex}:v${slot.version}${credentialSuffix}`;
}

export function questionBallotCredentialScope(question: QuestionnaireQuestion, index: number, credentialIndex = 1) {
  const slot = normaliseQuestionBallotSlot(question, index);
  const normalizedCredentialIndex = Number.isFinite(credentialIndex)
    ? Math.max(1, Math.floor(credentialIndex))
    : 1;
  return {
    slotIndex: slot.slotIndex,
    version: slot.version,
    ...(normalizedCredentialIndex > 1 ? { credentialIndex: normalizedCredentialIndex } : {}),
  };
}

export function clampRankMinimum(question: Pick<QuestionnaireRankQuestion, "options" | "minimumRanked">) {
  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  if (!Number.isFinite(question.minimumRanked)) {
    return 0;
  }
  return Math.min(optionCount, Math.max(0, Math.floor(question.minimumRanked)));
}

export function normaliseRankedOptionIds(question: Pick<QuestionnaireRankQuestion, "options">, rankedOptionIds: unknown) {
  const validOptions = new Set(question.options.map((option) => option.optionId));
  const seen = new Set<string>();
  const normalised: string[] = [];
  if (!Array.isArray(rankedOptionIds)) {
    return normalised;
  }
  for (const optionId of rankedOptionIds) {
    if (typeof optionId !== "string" || !validOptions.has(optionId) || seen.has(optionId)) {
      continue;
    }
    seen.add(optionId);
    normalised.push(optionId);
  }
  return normalised.slice(0, question.options.length);
}

export function calculateRankQuestionScores(
  question: Pick<QuestionnaireRankQuestion, "options">,
  rankedOptionIds: unknown,
) {
  const normalised = normaliseRankedOptionIds(question, rankedOptionIds);
  const optionCount = question.options.length;
  const optionScores = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
  normalised.forEach((optionId, index) => {
    optionScores[optionId] = optionCount - index;
  });
  return optionScores;
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
    input.ballotCredentialMode !== undefined
    && input.ballotCredentialMode !== "questionnaire"
    && input.ballotCredentialMode !== "per_question"
  ) {
    errors.push("ballot_credential_mode_invalid");
  }
  if (
    input.credentialsPerVoter !== undefined
    && input.credentialsPerVoter !== 1
    && input.credentialsPerVoter !== 2
  ) {
    errors.push("credentials_per_voter_invalid");
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
  if (input.questionnaireRelays !== undefined) {
    const normalizedRelays = normalizeQuestionnaireRelays(input.questionnaireRelays);
    if (!Array.isArray(input.questionnaireRelays) || normalizedRelays.length !== input.questionnaireRelays.length) {
      errors.push("questionnaire_relays_invalid");
    }
  }
  if (!Number.isFinite(input.openAt) || !Number.isFinite(input.closeAt) || input.openAt >= input.closeAt) {
    errors.push("invalid_open_close_window");
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    errors.push("questions_missing");
  } else {
    const questionIds = new Set<string>();
    for (const [index, question] of input.questions.entries()) {
      if (!isNonEmpty(question.questionId)) {
        errors.push("question_id_missing");
        continue;
      }
      if (questionIds.has(question.questionId)) {
        errors.push(`question_id_duplicate:${question.questionId}`);
      }
      questionIds.add(question.questionId);
      if (input.ballotCredentialMode === "per_question") {
        const slot = normaliseQuestionBallotSlot(question, index);
        if (!isNonEmpty(slot.slotId)) {
          errors.push(`ballot_slot_id_missing:${question.questionId}`);
        }
        if (!Number.isFinite(slot.slotIndex) || slot.slotIndex <= 0) {
          errors.push(`ballot_slot_index_invalid:${question.questionId}`);
        }
        if (!Number.isFinite(slot.version) || slot.version <= 0) {
          errors.push(`ballot_slot_version_invalid:${question.questionId}`);
        }
      }

      if (question.type === "multiple_choice" || question.type === "rank") {
        if (!Array.isArray(question.options) || question.options.length < 2) {
          errors.push(`${question.type}_insufficient_options:${question.questionId}`);
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

      if (question.type === "rank") {
        if (
          !Number.isFinite(question.minimumRanked)
          || Math.floor(question.minimumRanked) !== question.minimumRanked
          || question.minimumRanked < 0
          || question.minimumRanked > question.options.length
        ) {
          errors.push(`rank_minimum_invalid:${question.questionId}`);
        }
      }

      if (question.type === "free_text") {
        if (!Number.isFinite(question.maxLength) || question.maxLength <= 0) {
          errors.push(`invalid_free_text_max_length:${question.questionId}`);
        }
        if (question.encryptResponses !== undefined && typeof question.encryptResponses !== "boolean") {
          errors.push(`invalid_free_text_encrypt_responses:${question.questionId}`);
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
  const questionnaireRelays = questionnaireRelaysForMetadata(input.questionnaireRelays ?? []);
  return {
    ...input,
    responseMode,
    flowMode,
    protocolVersion: input.protocolVersion ?? QUESTIONNAIRE_PROTOCOL_VERSION_V1,
    ...(questionnaireRelays ? { questionnaireRelays } : { questionnaireRelays: undefined }),
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

    if (question.type === "rank") {
      if (answer.answerType !== "rank") {
        errors.push(`invalid_answer_type:${answer.questionId}`);
        continue;
      }
      const ranked = Array.isArray(answer.rankedOptionIds) ? answer.rankedOptionIds : [];
      const minimumRanked = clampRankMinimum(question);
      if (ranked.length < minimumRanked) {
        errors.push(`rank_selection_count:${answer.questionId}`);
      }
      if (ranked.length > question.options.length) {
        errors.push(`rank_selection_count:${answer.questionId}`);
      }
      const validOptions = new Set(question.options.map((option) => option.optionId));
      const seenRankedOptions = new Set<string>();
      for (const optionId of ranked) {
        if (typeof optionId !== "string" || !validOptions.has(optionId)) {
          errors.push(`invalid_option_id:${answer.questionId}:${String(optionId)}`);
          continue;
        }
        if (seenRankedOptions.has(optionId)) {
          errors.push(`duplicate_ranked_option:${answer.questionId}:${optionId}`);
        }
        seenRankedOptions.add(optionId);
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
    const rankMinimumMissing = question.type === "rank"
      && clampRankMinimum(question) > 0
      && !seenAnswers.has(question.questionId);
    if ((question.required && !seenAnswers.has(question.questionId)) || rankMinimumMissing) {
      errors.push(`missing_required_answer:${question.questionId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
