import type { NostrEvent } from "nostr-tools";
import { decryptQuestionnaireResponseEnvelope, parseQuestionnaireDefinitionEvent, parseQuestionnaireResponseEnvelope, parseQuestionnaireStateEvent } from "./questionnaireNostr";
import { validateQuestionnaireResponsePayload, type QuestionnaireDefinition, type QuestionnaireResponsePayload, type QuestionnaireResponsePrivateEnvelope, type QuestionnaireResultSummary, type QuestionnaireStateEvent } from "./questionnaireProtocol";

export type QuestionnaireRejectedReason =
  | "questionnaire_closed"
  | "unknown_question_id"
  | "missing_required_answer"
  | "invalid_option_id"
  | "free_text_too_long"
  | "duplicate_response"
  | "decryption_failed"
  | "invalid_payload_shape";

export type QuestionnaireAcceptedResponse = {
  eventId: string;
  authorPubkey: string;
  envelope: QuestionnaireResponsePrivateEnvelope;
  payload: QuestionnaireResponsePayload;
};

export type QuestionnaireRejectedResponse = {
  eventId: string;
  authorPubkey: string;
  responseId: string | null;
  reason: QuestionnaireRejectedReason;
  detail?: string;
};

function sortByCreatedAtAsc(events: NostrEvent[]) {
  return [...events].sort((left, right) => left.created_at - right.created_at);
}

function sortByCreatedAtDesc(events: NostrEvent[]) {
  return [...events].sort((left, right) => right.created_at - left.created_at);
}

export function selectLatestQuestionnaireDefinition(events: NostrEvent[]): QuestionnaireDefinition | null {
  for (const event of sortByCreatedAtDesc(events)) {
    const parsed = parseQuestionnaireDefinitionEvent(event);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function selectLatestQuestionnaireState(events: NostrEvent[]): QuestionnaireStateEvent | null {
  for (const event of sortByCreatedAtDesc(events)) {
    const parsed = parseQuestionnaireStateEvent(event);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function parseQuestionnaireResultSummaryEvent(event: NostrEvent): QuestionnaireResultSummary | null {
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireResultSummary;
    if (
      parsed.eventType !== "questionnaire_result_summary"
      || parsed.schemaVersion !== 1
      || typeof parsed.questionnaireId !== "string"
      || !Array.isArray(parsed.questionSummaries)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function selectLatestQuestionnaireResultSummary(events: NostrEvent[]): QuestionnaireResultSummary | null {
  for (const event of sortByCreatedAtDesc(events)) {
    const parsed = parseQuestionnaireResultSummaryEvent(event);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function toRejectedReason(errorCode: string): QuestionnaireRejectedReason {
  if (errorCode.startsWith("questionnaire_closed")) {
    return "questionnaire_closed";
  }
  if (errorCode.startsWith("unknown_question_id")) {
    return "unknown_question_id";
  }
  if (errorCode.startsWith("missing_required_answer")) {
    return "missing_required_answer";
  }
  if (errorCode.startsWith("invalid_option_id")) {
    return "invalid_option_id";
  }
  if (errorCode.startsWith("free_text_too_long")) {
    return "free_text_too_long";
  }
  return "invalid_payload_shape";
}

export function processQuestionnaireResponses(input: {
  responseEvents: NostrEvent[];
  definition: QuestionnaireDefinition;
  coordinatorNsec: string;
}): {
  accepted: QuestionnaireAcceptedResponse[];
  rejected: QuestionnaireRejectedResponse[];
} {
  const accepted: QuestionnaireAcceptedResponse[] = [];
  const rejected: QuestionnaireRejectedResponse[] = [];
  const acceptedByAuthor = new Set<string>();

  for (const event of sortByCreatedAtAsc(input.responseEvents)) {
    const parsedEnvelope = parseQuestionnaireResponseEnvelope(event);
    if (!parsedEnvelope) {
      rejected.push({
        eventId: event.id,
        authorPubkey: "",
        responseId: null,
        reason: "invalid_payload_shape",
      });
      continue;
    }

    const responseId = parsedEnvelope.responseId ?? null;

    let decrypted: { envelope: QuestionnaireResponsePrivateEnvelope; payload: QuestionnaireResponsePayload } | null = null;
    try {
      decrypted = decryptQuestionnaireResponseEnvelope({
        coordinatorNsec: input.coordinatorNsec,
        event,
      });
    } catch (error) {
      rejected.push({
        eventId: event.id,
        authorPubkey: parsedEnvelope.authorPubkey,
        responseId,
        reason: "decryption_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!decrypted) {
      rejected.push({
        eventId: event.id,
        authorPubkey: parsedEnvelope.authorPubkey,
        responseId,
        reason: "decryption_failed",
      });
      continue;
    }

    const authorPubkey = decrypted.envelope.authorPubkey;

    if (acceptedByAuthor.has(authorPubkey) && !input.definition.allowMultipleResponsesPerPubkey) {
      rejected.push({
        eventId: event.id,
        authorPubkey,
        responseId,
        reason: "duplicate_response",
      });
      continue;
    }

    if (
      decrypted.payload.submittedAt < input.definition.openAt
      || decrypted.payload.submittedAt > input.definition.closeAt
    ) {
      rejected.push({
        eventId: event.id,
        authorPubkey,
        responseId,
        reason: "questionnaire_closed",
      });
      continue;
    }

    const validation = validateQuestionnaireResponsePayload({
      definition: input.definition,
      payload: decrypted.payload,
    });

    if (!validation.valid) {
      const primaryError = validation.errors[0] ?? "invalid_payload_shape";
      rejected.push({
        eventId: event.id,
        authorPubkey,
        responseId,
        reason: toRejectedReason(primaryError),
        detail: primaryError,
      });
      continue;
    }

    acceptedByAuthor.add(authorPubkey);
    accepted.push({
      eventId: event.id,
      authorPubkey,
      envelope: decrypted.envelope,
      payload: decrypted.payload,
    });
  }

  return { accepted, rejected };
}

export function buildQuestionnaireResultSummary(input: {
  definition: QuestionnaireDefinition;
  coordinatorPubkey: string;
  acceptedResponses: QuestionnaireAcceptedResponse[];
  rejectedResponses: QuestionnaireRejectedResponse[];
}): QuestionnaireResultSummary {
  const questionSummaries = input.definition.questions.map((question) => {
    if (question.type === "yes_no") {
      let yesCount = 0;
      let noCount = 0;
      for (const response of input.acceptedResponses) {
        const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
        if (answer?.answerType === "yes_no") {
          if (answer.value) {
            yesCount += 1;
          } else {
            noCount += 1;
          }
        }
      }
      return {
        questionId: question.questionId,
        answerType: "yes_no" as const,
        yesCount,
        noCount,
      };
    }

    if (question.type === "multiple_choice") {
      const optionCounts = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
      for (const response of input.acceptedResponses) {
        const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
        if (answer?.answerType === "multiple_choice") {
          for (const optionId of answer.selectedOptionIds) {
            if (Object.prototype.hasOwnProperty.call(optionCounts, optionId)) {
              optionCounts[optionId] += 1;
            }
          }
        }
      }
      return {
        questionId: question.questionId,
        answerType: "multiple_choice" as const,
        optionCounts,
      };
    }

    let freeTextCount = 0;
    for (const response of input.acceptedResponses) {
      const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
      if (answer?.answerType === "free_text" && answer.text.trim().length > 0) {
        freeTextCount += 1;
      }
    }
    return {
      questionId: question.questionId,
      answerType: "free_text" as const,
      freeTextCount,
    };
  });

  return {
    schemaVersion: 1,
    eventType: "questionnaire_result_summary",
    questionnaireId: input.definition.questionnaireId,
    createdAt: Math.floor(Date.now() / 1000),
    coordinatorPubkey: input.coordinatorPubkey,
    acceptedResponseCount: input.acceptedResponses.length,
    rejectedResponseCount: input.rejectedResponses.length,
    questionSummaries,
  };
}
