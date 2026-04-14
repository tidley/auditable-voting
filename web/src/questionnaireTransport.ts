import type { NostrEvent } from "nostr-tools";
import {
  fetchQuestionnaireEvents,
  parseQuestionnaireDefinitionEvent,
  parseQuestionnaireStateEvent,
  QUESTIONNAIRE_DEFINITION_KIND,
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  QUESTIONNAIRE_STATE_KIND,
} from "./questionnaireNostr";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_PUBLIC_RELAYS } from "./simpleVotingSession";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import type {
  QuestionnaireDefinition,
  QuestionnaireResultSummary,
  QuestionnaireStateEvent,
} from "./questionnaireProtocol";
import {
  parseQuestionnaireBlindResponseEvent,
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  type QuestionnaireBlindResponseEvent,
} from "./questionnaireResponsePublish";
import { parseQuestionnaireResultSummaryEvent } from "./questionnaireRuntime";

const QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX = 2;

function buildPublicRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
}

function selectPublicReadRelays(relays: string[]) {
  const normalized = normalizeRelaysRust(relays);
  return normalized.slice(0, Math.min(QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX, normalized.length));
}

export async function fetchQuestionnaireDefinitions(input: {
  questionnaireId?: string;
  relays?: string[];
  limit?: number;
}) {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [QUESTIONNAIRE_DEFINITION_KIND],
    ...(input.questionnaireId ? { "#questionnaire-id": [input.questionnaireId] } : {}),
    limit: input.limit ?? 200,
  });

  return events
    .map((event) => ({ event, definition: parseQuestionnaireDefinitionEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; definition: QuestionnaireDefinition } => Boolean(entry.definition));
}

export function subscribeQuestionnaireDefinitions(input: {
  questionnaireId?: string;
  relays?: string[];
  onDefinitions: (entries: Array<{ event: NostrEvent; definition: QuestionnaireDefinition }>) => void;
}) {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const eventsById = new Map<string, { event: NostrEvent; definition: QuestionnaireDefinition }>();

  const subscription = pool.subscribeMany(relays, {
    kinds: [QUESTIONNAIRE_DEFINITION_KIND],
    ...(input.questionnaireId ? { "#questionnaire-id": [input.questionnaireId] } : {}),
  }, {
    onevent(event) {
      const definition = parseQuestionnaireDefinitionEvent(event);
      if (!definition) {
        return;
      }
      eventsById.set(event.id, { event, definition });
      input.onDefinitions([...eventsById.values()]);
    },
  });

  return () => {
    subscription.close();
  };
}

export async function fetchQuestionnaireBlindResponses(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
}) {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [QUESTIONNAIRE_RESPONSE_BLIND_KIND],
    "#questionnaire": [input.questionnaireId],
    limit: input.limit ?? 200,
  });

  return events
    .map((event) => ({ event, response: parseQuestionnaireBlindResponseEvent(event.content) }))
    .filter((entry): entry is { event: NostrEvent; response: QuestionnaireBlindResponseEvent } => Boolean(entry.response));
}

export function subscribeQuestionnaireBlindResponses(input: {
  questionnaireId: string;
  relays?: string[];
  onResponses: (entries: Array<{ event: NostrEvent; response: QuestionnaireBlindResponseEvent }>) => void;
}) {
  const relays = selectPublicReadRelays(buildPublicRelays(input.relays));
  const pool = getSharedNostrPool();
  const eventsById = new Map<string, { event: NostrEvent; response: QuestionnaireBlindResponseEvent }>();

  const subscription = pool.subscribeMany(relays, {
    kinds: [QUESTIONNAIRE_RESPONSE_BLIND_KIND],
    "#questionnaire": [input.questionnaireId],
  }, {
    onevent(event) {
      const response = parseQuestionnaireBlindResponseEvent(event.content);
      if (!response) {
        return;
      }
      eventsById.set(event.id, { event, response });
      input.onResponses([...eventsById.values()]);
    },
  });

  return () => {
    subscription.close();
  };
}

export async function fetchQuestionnaireState(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
}) {
  const events = await fetchQuestionnaireEvents({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_STATE_KIND,
    relays: input.relays,
    limit: input.limit,
  });

  return events
    .map((event) => ({ event, state: parseQuestionnaireStateEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; state: QuestionnaireStateEvent } => Boolean(entry.state));
}

export async function fetchQuestionnaireResultSummary(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
}) {
  const events = await fetchQuestionnaireEvents({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
    relays: input.relays,
    limit: input.limit,
  });

  return events
    .map((event) => ({ event, summary: parseQuestionnaireResultSummaryEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; summary: QuestionnaireResultSummary } => Boolean(entry.summary));
}
