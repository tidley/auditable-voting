import { finalizeEvent, getPublicKey, nip19, nip44 } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { recordRelayOutcome, rankRelaysByBackoff } from "./relayBackoff";
import { getSharedNostrPool } from "./sharedNostrPool";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
} from "./simpleVotingSession";
import { normalizeRelaysRust, sha256HexRust } from "./wasm/auditableVotingCore";
import type {
  QuestionnaireResponseAnswer,
  QuestionnaireSubmissionDecision,
  QuestionnaireSubmissionDecisionReason,
} from "./questionnaireProtocol";
import {
  IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION,
} from "./questionnaireProtocolConstants";

export const QUESTIONNAIRE_RESPONSE_BLIND_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND;
export const QUESTIONNAIRE_SUBMISSION_DECISION_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION;

export type BlindTokenProof = {
  tokenCommitment: string;
  questionnaireId: string;
  signature: string;
};

export type QuestionnaireBlindResponseEvent = {
  schemaVersion: 1;
  eventType: "questionnaire_response_blind";
  questionnaireId: string;
  responseId: string;
  submittedAt: number;
  authorPubkey: string;
  tokenNullifier: string;
  tokenProof: BlindTokenProof;
  answers?: QuestionnaireResponseAnswer[];
  encryptedPayload?: string;
  payloadHash?: string;
};

export type QuestionnaireBlindResponseEncryptedPayload = {
  schemaVersion: 1;
  eventType: "questionnaire_response_blind_payload";
  questionnaireId: string;
  responseId: string;
  submittedAt: number;
  answers: QuestionnaireResponseAnswer[];
};

export type QuestionnaireBlindResponseDecryptionResult = {
  answers: QuestionnaireResponseAnswer[];
  encryptedPayloadDecrypted: boolean;
  encryptedFreeTextDecryptedCount: number;
};

export type QuestionnaireSubmissionDecisionEvent = QuestionnaireSubmissionDecision;

function buildPublicRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]));
}

function decodeNsecSecretKey(nsec: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Expected nsec.");
  }
  return decoded.data as Uint8Array;
}

function decodeNpubHex(npub: string) {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Expected npub.");
  }
  return decoded.data as string;
}

function toHexPubkey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("npub1")) {
    return decodeNpubHex(trimmed);
  }
  return trimmed;
}

async function publishEvent(input: {
  nsec: string;
  eventPayload: QuestionnaireBlindResponseEvent;
  tags: string[][];
  relays?: string[];
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const event = finalizeEvent({
    kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: input.tags,
    content: JSON.stringify(input.eventPayload),
  }, secretKey);

  const relays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    { channel: "questionnaire-response-blind", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
  );

  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true as const }
      : {
          relay: relays[index],
          success: false as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }

  return {
    eventId: event.id,
    event,
    relayResults,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
  };
}

export async function publishQuestionnaireBlindResponsePublic(input: {
  responseNsec: string;
  questionnaireId: string;
  questionnaireDefinitionEventId?: string | null;
  responseId: string;
  submittedAt?: number;
  tokenNullifier: string;
  tokenProof: BlindTokenProof;
  answers: QuestionnaireResponseAnswer[];
  relays?: string[];
}) {
  const authorPubkey = nip19.npubEncode(getPublicKey(decodeNsecSecretKey(input.responseNsec)));
  const eventPayload: QuestionnaireBlindResponseEvent = {
    schemaVersion: 1,
    eventType: "questionnaire_response_blind",
    questionnaireId: input.questionnaireId,
    responseId: input.responseId,
    submittedAt: input.submittedAt ?? Math.floor(Date.now() / 1000),
    authorPubkey,
    tokenNullifier: input.tokenNullifier,
    tokenProof: input.tokenProof,
    answers: input.answers,
  };

  return publishEvent({
    nsec: input.responseNsec,
    eventPayload,
    tags: [
      ["t", "questionnaire_response_blind"],
      ["q", input.questionnaireId],
      ["questionnaire", input.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_response_blind"],
      ["nullifier", input.tokenNullifier],
      ...(input.questionnaireDefinitionEventId?.trim()
        ? [["e", input.questionnaireDefinitionEventId.trim()] as string[]]
        : []),
    ],
    relays: input.relays,
  });
}

export async function publishQuestionnaireBlindResponseEncrypted(input: {
  responseNsec: string;
  coordinatorNpub: string;
  questionnaireId: string;
  questionnaireDefinitionEventId: string;
  responseId: string;
  submittedAt?: number;
  tokenNullifier: string;
  tokenProof: BlindTokenProof;
  answers: QuestionnaireResponseAnswer[];
  relays?: string[];
}) {
  const authorSecretKey = decodeNsecSecretKey(input.responseNsec);
  const authorPubkey = nip19.npubEncode(getPublicKey(authorSecretKey));
  const answersJson = JSON.stringify({
    schemaVersion: 1,
    eventType: "questionnaire_response_blind_payload",
    questionnaireId: input.questionnaireId,
    responseId: input.responseId,
    submittedAt: input.submittedAt ?? Math.floor(Date.now() / 1000),
    answers: input.answers,
  });
  const payloadHash = sha256HexRust(answersJson);
  const recipientHex = decodeNpubHex(input.coordinatorNpub);
  const conversationKey = nip44.v2.utils.getConversationKey(authorSecretKey, recipientHex);
  const encryptedPayload = nip44.v2.encrypt(answersJson, conversationKey);

  const eventPayload: QuestionnaireBlindResponseEvent = {
    schemaVersion: 1,
    eventType: "questionnaire_response_blind",
    questionnaireId: input.questionnaireId,
    responseId: input.responseId,
    submittedAt: input.submittedAt ?? Math.floor(Date.now() / 1000),
    authorPubkey,
    tokenNullifier: input.tokenNullifier,
    tokenProof: input.tokenProof,
    encryptedPayload,
    payloadHash,
  };

  return publishEvent({
    nsec: input.responseNsec,
    eventPayload,
    tags: [
      ["t", "questionnaire_response_blind"],
      ["q", input.questionnaireId],
      ["questionnaire", input.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_response_blind"],
      ["nullifier", input.tokenNullifier],
      ["e", input.questionnaireDefinitionEventId],
      ["payload-mode", "encrypted"],
    ],
    relays: input.relays,
  });
}

export async function publishQuestionnaireBlindResponsePublicByCoordinator(input: {
  coordinatorNsec: string;
  questionnaireId: string;
  responseId: string;
  submittedAt?: number;
  authorPubkey: string;
  tokenNullifier: string;
  tokenCommitment: string;
  answers: QuestionnaireResponseAnswer[];
  questionnaireDefinitionEventId?: string | null;
  relays?: string[];
}) {
  const eventPayload: QuestionnaireBlindResponseEvent = {
    schemaVersion: 1,
    eventType: "questionnaire_response_blind",
    questionnaireId: input.questionnaireId,
    responseId: input.responseId,
    submittedAt: input.submittedAt ?? Math.floor(Date.now() / 1000),
    authorPubkey: input.authorPubkey,
    tokenNullifier: input.tokenNullifier,
    tokenProof: {
      tokenCommitment: input.tokenCommitment,
      questionnaireId: input.questionnaireId,
      signature: `coordinator_publication:${input.responseId}`,
    },
    answers: input.answers,
  };

  const tags: string[][] = [
    ["t", "questionnaire_response_blind"],
    ["q", input.questionnaireId],
    ["questionnaire", input.questionnaireId],
    ["schema", "1"],
    ["etype", "questionnaire_response_blind"],
    ["nullifier", input.tokenNullifier],
    ["source", "coordinator_publication"],
  ];
  if (input.questionnaireDefinitionEventId?.trim()) {
    tags.push(["e", input.questionnaireDefinitionEventId.trim()]);
  }

  return publishEvent({
    nsec: input.coordinatorNsec,
    eventPayload,
    tags,
    relays: input.relays,
  });
}

export function parseQuestionnaireBlindResponseEvent(content: string): QuestionnaireBlindResponseEvent | null {
  try {
    const parsed = JSON.parse(content) as QuestionnaireBlindResponseEvent;
    if (
      parsed?.schemaVersion !== 1
      || parsed?.eventType !== "questionnaire_response_blind"
      || typeof parsed?.questionnaireId !== "string"
      || typeof parsed?.responseId !== "string"
      || typeof parsed?.authorPubkey !== "string"
      || typeof parsed?.tokenNullifier !== "string"
      || typeof parsed?.tokenProof?.tokenCommitment !== "string"
      || typeof parsed?.tokenProof?.questionnaireId !== "string"
      || typeof parsed?.tokenProof?.signature !== "string"
    ) {
      return null;
    }
    if (parsed.answers && parsed.encryptedPayload) {
      return null;
    }
    if (!parsed.answers && !parsed.encryptedPayload) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseQuestionnaireBlindResponseEncryptedPayload(
  plaintext: string,
): QuestionnaireBlindResponseEncryptedPayload | null {
  try {
    const parsed = JSON.parse(plaintext) as QuestionnaireBlindResponseEncryptedPayload;
    if (
      parsed?.schemaVersion !== 1
      || parsed?.eventType !== "questionnaire_response_blind_payload"
      || typeof parsed?.questionnaireId !== "string"
      || typeof parsed?.responseId !== "string"
      || typeof parsed?.submittedAt !== "number"
      || !Array.isArray(parsed?.answers)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function decryptQuestionnaireBlindResponseAnswers(input: {
  coordinatorNsec: string;
  eventPubkey: string;
  response: QuestionnaireBlindResponseEvent;
}): QuestionnaireBlindResponseDecryptionResult {
  const coordinatorSecretKey = decodeNsecSecretKey(input.coordinatorNsec);
  const authorHex = toHexPubkey(input.eventPubkey || input.response.authorPubkey);
  const conversationKey = nip44.v2.utils.getConversationKey(coordinatorSecretKey, authorHex);
  let answers = input.response.answers ? [...input.response.answers] : null;
  let encryptedPayloadDecrypted = false;

  if (!answers && input.response.encryptedPayload) {
    const plaintext = nip44.v2.decrypt(input.response.encryptedPayload, conversationKey);
    if (input.response.payloadHash && sha256HexRust(plaintext) !== input.response.payloadHash) {
      throw new Error("Questionnaire blind response payload hash mismatch.");
    }
    const payload = parseQuestionnaireBlindResponseEncryptedPayload(plaintext);
    if (
      !payload
      || payload.questionnaireId !== input.response.questionnaireId
      || payload.responseId !== input.response.responseId
    ) {
      throw new Error("Questionnaire blind response payload shape mismatch.");
    }
    answers = payload.answers;
    encryptedPayloadDecrypted = true;
  }

  if (!answers) {
    throw new Error("Questionnaire blind response has no decryptable answer payload.");
  }

  let encryptedFreeTextDecryptedCount = 0;
  const decryptedAnswers = answers.map((answer) => {
    if (answer.answerType !== "free_text") {
      return answer;
    }
    const trimmed = answer.text.trim();
    if (!trimmed.startsWith("enc:nip44v2:")) {
      return answer;
    }
    const ciphertext = trimmed.slice("enc:nip44v2:".length);
    if (!ciphertext) {
      throw new Error("Encrypted free-text answer is empty.");
    }
    const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
    encryptedFreeTextDecryptedCount += 1;
    return {
      ...answer,
      text: plaintext.trim() || "(empty)",
    };
  });

  return {
    answers: decryptedAnswers,
    encryptedPayloadDecrypted,
    encryptedFreeTextDecryptedCount,
  };
}

export async function publishQuestionnaireSubmissionDecisionPublic(input: {
  coordinatorNsec: string;
  questionnaireId: string;
  submissionId: string;
  tokenNullifier: string;
  accepted: boolean;
  reason: QuestionnaireSubmissionDecisionReason;
  coordinatorNpub: string;
  decidedAt?: number;
  relays?: string[];
}) {
  const eventPayload: QuestionnaireSubmissionDecisionEvent = {
    schemaVersion: 1,
    eventType: "questionnaire_submission_decision",
    questionnaireId: input.questionnaireId,
    submissionId: input.submissionId,
    tokenNullifier: input.tokenNullifier,
    accepted: input.accepted,
    reason: input.reason,
    decidedAt: input.decidedAt ?? Math.floor(Date.now() / 1000),
    coordinatorPubkey: input.coordinatorNpub,
  };
  const secretKey = decodeNsecSecretKey(input.coordinatorNsec);
  const event = finalizeEvent({
    kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
    created_at: eventPayload.decidedAt,
    tags: [
      ["t", "questionnaire_submission_decision"],
      ["q", input.questionnaireId],
      ["questionnaire", input.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_submission_decision"],
      ["submission-id", input.submissionId],
      ["nullifier", input.tokenNullifier],
      ["accepted", input.accepted ? "1" : "0"],
      ["reason", input.reason],
    ],
    content: JSON.stringify(eventPayload),
  }, secretKey);
  const relays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    { channel: "questionnaire-submission-decision", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true as const }
      : {
          relay: relays[index],
          success: false as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }
  return {
    eventId: event.id,
    event,
    relayResults,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
  };
}

export function parseQuestionnaireSubmissionDecisionEvent(content: string): QuestionnaireSubmissionDecisionEvent | null {
  try {
    const parsed = JSON.parse(content) as QuestionnaireSubmissionDecisionEvent;
    if (
      parsed?.schemaVersion !== 1
      || parsed?.eventType !== "questionnaire_submission_decision"
      || typeof parsed?.questionnaireId !== "string"
      || typeof parsed?.submissionId !== "string"
      || typeof parsed?.tokenNullifier !== "string"
      || typeof parsed?.accepted !== "boolean"
      || typeof parsed?.reason !== "string"
      || typeof parsed?.decidedAt !== "number"
      || typeof parsed?.coordinatorPubkey !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
