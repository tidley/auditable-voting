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
import type { QuestionnaireResponseAnswer } from "./questionnaireProtocol";
import { IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND } from "./questionnaireProtocolConstants";

export const QUESTIONNAIRE_RESPONSE_BLIND_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND;

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

async function publishEvent(input: {
  responseNsec: string;
  eventPayload: QuestionnaireBlindResponseEvent;
  tags: string[][];
  relays?: string[];
}) {
  const secretKey = decodeNsecSecretKey(input.responseNsec);
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
  questionnaireDefinitionEventId: string;
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
    responseNsec: input.responseNsec,
    eventPayload,
    tags: [
      ["t", "questionnaire_response_blind"],
      ["questionnaire", input.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_response_blind"],
      ["nullifier", input.tokenNullifier],
      ["e", input.questionnaireDefinitionEventId],
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
    responseNsec: input.responseNsec,
    eventPayload,
    tags: [
      ["t", "questionnaire_response_blind"],
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
