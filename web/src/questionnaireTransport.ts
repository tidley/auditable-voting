import type { NostrEvent } from "nostr-tools";
import {
  fetchQuestionnaireEventsWithFallback,
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

type QuestionnaireBlindResponseEntry = {
  event: NostrEvent;
  response: QuestionnaireBlindResponseEvent;
};

export type QuestionnaireBlindAdmissionDecision = {
  event: NostrEvent;
  response: QuestionnaireBlindResponseEvent;
  accepted: boolean;
  rejectionReason: "duplicate_nullifier" | null;
};

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
    limit: input.limit ?? 200,
  });

  return events
    .map((event) => ({ event, definition: parseQuestionnaireDefinitionEvent(event) }))
    .filter((entry) => (
      !input.questionnaireId
      || entry.definition?.questionnaireId === input.questionnaireId
    ))
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
  }, {
    onevent(event) {
      const definition = parseQuestionnaireDefinitionEvent(event);
      if (!definition) {
        return;
      }
      if (input.questionnaireId && definition.questionnaireId !== input.questionnaireId) {
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
    limit: input.limit ?? 200,
  });

  return events
    .map((event) => ({ event, response: parseQuestionnaireBlindResponseEvent(event.content) }))
    .filter((entry) => entry.response?.questionnaireId === input.questionnaireId)
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
  }, {
    onevent(event) {
      const response = parseQuestionnaireBlindResponseEvent(event.content);
      if (!response) {
        return;
      }
      if (response.questionnaireId !== input.questionnaireId) {
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

function canonicalBlindResponseOrder(
  left: QuestionnaireBlindResponseEntry,
  right: QuestionnaireBlindResponseEntry,
) {
  const createdAtDelta = Number(left.event.created_at ?? 0) - Number(right.event.created_at ?? 0);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }
  return String(left.event.id ?? "").localeCompare(String(right.event.id ?? ""));
}

export function evaluateQuestionnaireBlindAdmissions(input: {
  entries: QuestionnaireBlindResponseEntry[];
}) {
  const ordered = [...input.entries].sort(canonicalBlindResponseOrder);
  const acceptedNullifiers = new Set<string>();
  const decisions: QuestionnaireBlindAdmissionDecision[] = [];

  for (const entry of ordered) {
    const nullifier = entry.response.tokenNullifier.trim();
    if (acceptedNullifiers.has(nullifier)) {
      decisions.push({
        ...entry,
        accepted: false,
        rejectionReason: "duplicate_nullifier",
      });
      continue;
    }

    acceptedNullifiers.add(nullifier);
    decisions.push({
      ...entry,
      accepted: true,
      rejectionReason: null,
    });
  }

  return {
    decisions,
    accepted: decisions.filter((entry) => entry.accepted),
    rejected: decisions.filter((entry) => !entry.accepted),
    acceptedCountByNullifier: Object.fromEntries(
      [...acceptedNullifiers.values()].map((nullifier) => [nullifier, 1]),
    ),
  };
}

export async function fetchQuestionnaireState(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_STATE_KIND,
    relays: input.relays,
    limit: input.limit,
    parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
  })).events;

  return events
    .map((event) => ({ event, state: parseQuestionnaireStateEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; state: QuestionnaireStateEvent } => Boolean(entry.state));
}

export async function fetchQuestionnaireResultSummary(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
    relays: input.relays,
    limit: input.limit,
    parseQuestionnaireIdFromEvent: (event) => {
      try {
        const parsed = JSON.parse(event.content) as { questionnaireId?: string };
        return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
      } catch {
        return null;
      }
    },
  })).events;

  return events
    .map((event) => ({ event, summary: parseQuestionnaireResultSummaryEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; summary: QuestionnaireResultSummary } => Boolean(entry.summary));
}
