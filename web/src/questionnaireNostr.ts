import { finalizeEvent, getPublicKey, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { getSharedNostrPool } from "./sharedNostrPool";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
} from "./simpleVotingSession";
import { normalizeRelaysRust, sha256HexRust } from "./wasm/auditableVotingCore";
import type {
  QuestionnaireDefinition,
  QuestionnaireResponsePayload,
  QuestionnaireResponsePrivateEnvelope,
  QuestionnaireResultSummary,
  QuestionnaireStateEvent,
} from "./questionnaireProtocol";

export const QUESTIONNAIRE_DEFINITION_KIND = 14120;
export const QUESTIONNAIRE_STATE_KIND = 14121;
export const QUESTIONNAIRE_RESPONSE_PRIVATE_KIND = 14122;
export const QUESTIONNAIRE_RESULT_SUMMARY_KIND = 14123;
const QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX = 2;

function buildPublicRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
}

function selectPublicReadRelays(relays: string[]) {
  const normalized = normalizeRelaysRust(relays);
  return normalized.slice(0, Math.min(QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX, normalized.length));
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
  nsec: string;
  kind: number;
  tags: string[][];
  content: string;
  relays?: string[];
  channel: string;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const event = finalizeEvent({
    kind: input.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: input.tags,
    content: input.content,
  }, secretKey);
  const relays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    { channel: input.channel, minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
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
  return {
    eventId: event.id,
    event,
    relayResults,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
  };
}

export async function publishQuestionnaireDefinition(input: {
  coordinatorNsec: string;
  definition: QuestionnaireDefinition;
  relays?: string[];
}) {
  return publishEvent({
    nsec: input.coordinatorNsec,
    kind: QUESTIONNAIRE_DEFINITION_KIND,
    tags: [
      ["t", "questionnaire_definition"],
      ["questionnaire-id", input.definition.questionnaireId],
      ["state", "draft"],
    ],
    content: JSON.stringify(input.definition),
    relays: input.relays,
    channel: "questionnaire-definition",
  });
}

export async function publishQuestionnaireState(input: {
  coordinatorNsec: string;
  stateEvent: QuestionnaireStateEvent;
  relays?: string[];
}) {
  return publishEvent({
    nsec: input.coordinatorNsec,
    kind: QUESTIONNAIRE_STATE_KIND,
    tags: [
      ["t", "questionnaire_state"],
      ["questionnaire-id", input.stateEvent.questionnaireId],
      ["state", input.stateEvent.state],
    ],
    content: JSON.stringify(input.stateEvent),
    relays: input.relays,
    channel: "questionnaire-state",
  });
}

export async function publishQuestionnaireResultSummary(input: {
  coordinatorNsec: string;
  resultSummary: QuestionnaireResultSummary;
  relays?: string[];
}) {
  return publishEvent({
    nsec: input.coordinatorNsec,
    kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
    tags: [
      ["t", "questionnaire_result_summary"],
      ["questionnaire-id", input.resultSummary.questionnaireId],
    ],
    content: JSON.stringify(input.resultSummary),
    relays: input.relays,
    channel: "questionnaire-results",
  });
}

export async function publishEncryptedQuestionnaireResponse(input: {
  responseNsec: string;
  coordinatorNpub: string;
  questionnaireId: string;
  responseId: string;
  payload: QuestionnaireResponsePayload;
  relays?: string[];
}) {
  const authorSecretKey = decodeNsecSecretKey(input.responseNsec);
  const authorPubkey = getPublicKey(authorSecretKey);
  const payloadJson = JSON.stringify(input.payload);
  const payloadHash = sha256HexRust(payloadJson);
  const recipientHexPubkey = decodeNpubHex(input.coordinatorNpub);
  const conversationKey = nip44.v2.utils.getConversationKey(authorSecretKey, recipientHexPubkey);
  const ciphertext = nip44.v2.encrypt(payloadJson, conversationKey);
  const envelope: QuestionnaireResponsePrivateEnvelope = {
    schemaVersion: 1,
    eventType: "questionnaire_response_private",
    questionnaireId: input.questionnaireId,
    responseId: input.responseId,
    createdAt: Math.floor(Date.now() / 1000),
    authorPubkey: nip19.npubEncode(authorPubkey),
    ciphertextScheme: "nip44v2",
    ciphertextRecipient: input.coordinatorNpub,
    ciphertext,
    payloadHash,
  };
  return publishEvent({
    nsec: input.responseNsec,
    kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
    tags: [
      ["t", "questionnaire_response_private"],
      ["questionnaire-id", input.questionnaireId],
      ["response-id", input.responseId],
      ["recipient", input.coordinatorNpub],
      ["payload-hash", payloadHash],
    ],
    content: JSON.stringify(envelope),
    relays: input.relays,
    channel: "questionnaire-response-private",
  });
}

export function parseQuestionnaireResponseEnvelope(
  event: Pick<NostrEvent, "kind" | "content" | "pubkey">,
): QuestionnaireResponsePrivateEnvelope | null {
  if (event.kind !== QUESTIONNAIRE_RESPONSE_PRIVATE_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireResponsePrivateEnvelope;
    if (
      parsed.eventType !== "questionnaire_response_private"
      || parsed.ciphertextScheme !== "nip44v2"
      || !parsed.questionnaireId
      || !parsed.responseId
      || !parsed.ciphertext
      || !parsed.payloadHash
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function decryptQuestionnaireResponseEnvelope(input: {
  coordinatorNsec: string;
  event: Pick<NostrEvent, "kind" | "content" | "pubkey">;
}): { envelope: QuestionnaireResponsePrivateEnvelope; payload: QuestionnaireResponsePayload } | null {
  const envelope = parseQuestionnaireResponseEnvelope(input.event);
  if (!envelope) {
    return null;
  }
  const coordinatorSecretKey = decodeNsecSecretKey(input.coordinatorNsec);
  const conversationKey = nip44.v2.utils.getConversationKey(coordinatorSecretKey, input.event.pubkey);
  const plaintext = nip44.v2.decrypt(envelope.ciphertext, conversationKey);
  const payloadHash = sha256HexRust(plaintext);
  if (payloadHash !== envelope.payloadHash) {
    throw new Error("Questionnaire response payload hash mismatch.");
  }
  const payload = JSON.parse(plaintext) as QuestionnaireResponsePayload;
  return { envelope, payload };
}

export async function fetchQuestionnaireEvents(input: {
  questionnaireId: string;
  kind: number;
  relays?: string[];
  limit?: number;
}) {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [input.kind],
    "#questionnaire-id": [input.questionnaireId],
    limit: input.limit ?? 200,
  });
  return events;
}

export function parseQuestionnaireDefinitionEvent(
  event: Pick<NostrEvent, "kind" | "content">,
): QuestionnaireDefinition | null {
  if (event.kind !== QUESTIONNAIRE_DEFINITION_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireDefinition;
    if (
      parsed?.eventType !== "questionnaire_definition"
      || parsed?.schemaVersion !== 1
      || typeof parsed.questionnaireId !== "string"
      || !Array.isArray(parsed.questions)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseQuestionnaireStateEvent(
  event: Pick<NostrEvent, "kind" | "content">,
): QuestionnaireStateEvent | null {
  if (event.kind !== QUESTIONNAIRE_STATE_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireStateEvent;
    if (
      parsed?.eventType !== "questionnaire_state"
      || parsed?.schemaVersion !== 1
      || typeof parsed.questionnaireId !== "string"
      || typeof parsed.state !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
