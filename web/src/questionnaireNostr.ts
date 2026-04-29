import { finalizeEvent, getPublicKey, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { getSharedNostrPool } from "./sharedNostrPool";
import { recordRelayCloseReasons, recordRelayOutcome, rankRelaysByBackoff, selectRelaysWithBackoff } from "./relayBackoff";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
} from "./simpleVotingSession";
import { normalizeRelaysRust, sha256HexRust } from "./wasm/auditableVotingCore";
import type {
  QuestionnaireDefinition,
  QuestionnaireParticipantCountEvent,
  QuestionnaireResponsePayload,
  QuestionnaireResponsePrivateEnvelope,
  QuestionnaireResultSummary,
  QuestionnaireStateEvent,
} from "./questionnaireProtocol";
import { normalizeQuestionnaireDefinition } from "./questionnaireProtocol";
import {
  IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_PARTICIPANT_COUNT,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_PRIVATE,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE,
} from "./questionnaireProtocolConstants";

export const QUESTIONNAIRE_DEFINITION_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION;
export const QUESTIONNAIRE_PARTICIPANT_COUNT_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_PARTICIPANT_COUNT;
export const QUESTIONNAIRE_STATE_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE;
export const QUESTIONNAIRE_RESPONSE_PRIVATE_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_PRIVATE;
export const QUESTIONNAIRE_RESULT_SUMMARY_KIND = IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY;
const QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX = 2;
const QUESTIONNAIRE_PUBLIC_READ_UNINDEXED_TAG_RELAYS = new Set([
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.wine",
  "wss://nostr.mom",
]);

function buildPublicRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]));
}

function selectPublicReadRelays(relays: string[], maxRelays = QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX) {
  const indexedRelays = relays.filter((relay) => !QUESTIONNAIRE_PUBLIC_READ_UNINDEXED_TAG_RELAYS.has(relay));
  return selectRelaysWithBackoff(indexedRelays.length > 0 ? indexedRelays : relays, maxRelays);
}

export function getQuestionnaireReadRelays(relays?: string[], maxRelays = QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX) {
  return selectPublicReadRelays(buildPublicRelays(relays), maxRelays);
}

function eventHasQuestionnaireIdTag(event: Pick<NostrEvent, "tags">, questionnaireId: string) {
  return event.tags.some((tag) => (
    tag[0] === "questionnaire-id"
    && tag[1] === questionnaireId
  ));
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

export async function publishQuestionnaireParticipantCount(input: {
  coordinatorNsec: string;
  participantCount: QuestionnaireParticipantCountEvent;
  relays?: string[];
}) {
  return publishEvent({
    nsec: input.coordinatorNsec,
    kind: QUESTIONNAIRE_PARTICIPANT_COUNT_KIND,
    tags: [
      ["d", input.participantCount.questionnaireId],
      ["t", "questionnaire_participant_count"],
      ["questionnaire-id", input.participantCount.questionnaireId],
    ],
    content: JSON.stringify(input.participantCount),
    relays: input.relays,
    channel: "questionnaire-participant-count",
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
  readRelayLimit?: number;
}) {
  const relays = getQuestionnaireReadRelays(input.relays, input.readRelayLimit);
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [input.kind],
    limit: input.limit ?? 200,
  });
  return events.filter((event) => eventHasQuestionnaireIdTag(event, input.questionnaireId));
}

export type QuestionnaireFetchDiagnostics = {
  mode: "filtered" | "kind_only_fallback";
  filteredCount: number;
  kindOnlyCount: number;
};

export async function fetchQuestionnaireEventsWithFallback(input: {
  questionnaireId?: string;
  kind: number;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  parseQuestionnaireIdFromEvent: (event: Pick<NostrEvent, "kind" | "content">) => string | null;
}) {
  const relays = getQuestionnaireReadRelays(input.relays, input.readRelayLimit);
  const pool = getSharedNostrPool();
  const questionnaireId = input.questionnaireId?.trim() ?? "";
  const kindOnlyEvents = await pool.querySync(relays, {
    kinds: [input.kind],
    limit: input.limit ?? 200,
  });
  const locallyMatched = kindOnlyEvents.filter((event) => {
    if (!questionnaireId) {
      return true;
    }
    const matchedQuestionnaireId = input.parseQuestionnaireIdFromEvent(event);
    return matchedQuestionnaireId === questionnaireId;
  });
  return {
    events: locallyMatched,
    diagnostics: {
      mode: "kind_only_fallback" as const,
      filteredCount: 0,
      kindOnlyCount: kindOnlyEvents.length,
    },
  };
}

export function subscribeQuestionnaireEvents(input: {
  questionnaireId: string;
  kind: number;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  useQuestionnaireIdTagFilter?: boolean;
  parseQuestionnaireIdFromEvent: (event: Pick<NostrEvent, "kind" | "content">) => string | null;
  onEvent: (event: NostrEvent) => void;
  onError?: (error: Error) => void;
}) {
  const pool = getSharedNostrPool();
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let subscription: { close: (reason?: string) => Promise<void> | void } | null = null;
  const reconnectDelaysMs = [2000, 5000, 10_000, 30_000] as const;

  const connect = () => {
    if (closed) {
      return;
    }
    const relays = getQuestionnaireReadRelays(input.relays, input.readRelayLimit);
    if (relays.length === 0) {
      scheduleReconnect();
      return;
    }
    const baseFilter: {
      kinds: number[];
      limit: number;
    } = {
      kinds: [input.kind],
      limit: input.limit ?? 200,
    };
    subscription = pool.subscribeMany(relays, baseFilter, {
      onevent: (event) => {
        reconnectAttempt = 0;
        const matchedQuestionnaireId = input.parseQuestionnaireIdFromEvent(event);
        if (matchedQuestionnaireId !== input.questionnaireId) {
          return;
        }
        input.onEvent(event);
      },
      onclose: (reasons) => {
        recordRelayCloseReasons(reasons);
        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          input.onError?.(new Error(errors.join("; ")));
          if (!closed) {
            scheduleReconnect();
          }
        }
      },
    });
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) {
      return;
    }
    const delay = reconnectDelaysMs[Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (subscription) {
        void subscription.close("closed by caller");
        subscription = null;
      }
      connect();
    }, delay);
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (subscription) {
      void subscription.close("closed by caller");
      subscription = null;
    }
  };
}

export function parseQuestionnaireDefinitionEvent(
  event: Pick<NostrEvent, "kind" | "content">,
): QuestionnaireDefinition | null {
  if (event.kind !== QUESTIONNAIRE_DEFINITION_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireDefinition & { responseMode?: QuestionnaireDefinition["responseMode"] };
    if (
      parsed?.eventType !== "questionnaire_definition"
      || parsed?.schemaVersion !== 1
      || typeof parsed.questionnaireId !== "string"
      || !Array.isArray(parsed.questions)
    ) {
      return null;
    }
    return normalizeQuestionnaireDefinition(parsed);
  } catch {
    return null;
  }
}

export function parseQuestionnaireParticipantCountEvent(
  event: Pick<NostrEvent, "kind" | "content">,
): QuestionnaireParticipantCountEvent | null {
  if (event.kind !== QUESTIONNAIRE_PARTICIPANT_COUNT_KIND) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.content) as QuestionnaireParticipantCountEvent;
    if (
      parsed?.eventType !== "questionnaire_participant_count"
      || parsed?.schemaVersion !== 1
      || typeof parsed.questionnaireId !== "string"
      || !Number.isFinite(parsed.expectedInviteeCount)
      || parsed.expectedInviteeCount < 0
      || !Number.isFinite(parsed.createdAt)
      || typeof parsed.coordinatorPubkey !== "string"
    ) {
      return null;
    }
    return {
      ...parsed,
      expectedInviteeCount: Math.max(0, Math.floor(parsed.expectedInviteeCount)),
    };
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
