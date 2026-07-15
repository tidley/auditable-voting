import { nip19, type Filter, type NostrEvent } from "nostr-tools";
import { recordRelayCloseReasons, selectRelaysWithBackoff, rankRelaysByBackoff } from "./relayBackoff";
import {
  fetchQuestionnaireEventsWithFallback,
  getQuestionnaireReadRelays,
  parseQuestionnaireDefinitionEvent,
  parseQuestionnaireParticipantCountEvent,
  parseQuestionnairePrivateInviteStatusEvent,
  parseQuestionnaireStateEvent,
  QUESTIONNAIRE_DEFINITION_KIND,
  QUESTIONNAIRE_PARTICIPANT_COUNT_KIND,
  QUESTIONNAIRE_PRIVATE_INVITE_STATUS_KIND,
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  QUESTIONNAIRE_STATE_KIND,
  queryQuestionnaireEvents,
} from "./questionnaireNostr";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_PUBLIC_RELAYS } from "./simpleVotingSession";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import type {
  QuestionnaireDefinition,
  QuestionnaireParticipantCountEvent,
  QuestionnairePrivateInviteStatusEvent,
  QuestionnaireResultSummary,
  QuestionnaireStateEvent,
} from "./questionnaireProtocol";
import type { QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import { buildQuestionnaireDefinitionReference, questionnaireDefinitionEventHash } from "./questionnaireDefinitionReference";
import { storeCachedQuestionnaireDefinitionReference } from "./questionnaireDefinitionCache";
import { verifyQuestionnaireBlindSignature } from "./questionnaireBlindSignature";
import { buildQuestionnaireBlindTokenSignedMessage } from "./questionnaireBlindToken";
import {
  parseQuestionnaireSubmissionDecisionEvent,
  parseQuestionnaireBlindResponseEvent,
  parseQuestionnaireProvisionalResponseEvent,
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_RESPONSE_PROVISIONAL_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
  type QuestionnaireBlindResponseEvent,
  type QuestionnaireProvisionalResponseEvent,
  type QuestionnaireSubmissionDecisionEvent,
} from "./questionnaireResponsePublish";
import { parseQuestionnaireResultSummaryEvent } from "./questionnaireRuntime";
import {
  OPTIONA_WORKER_DELEGATION_KIND,
  OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
  parseWorkerDelegationEvent,
  parseWorkerDelegationRevocationEvent,
  type WorkerCapability,
  type WorkerDelegationCertificate,
  type WorkerDelegationRevocation,
} from "./questionnaireWorkerDelegation";

const QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX = 3;

type QuestionnaireBlindResponseEntry = {
  event: NostrEvent;
  response: QuestionnaireBlindResponseEvent;
};

export type QuestionnaireProvisionalResponseEntry = {
  event: NostrEvent;
  response: QuestionnaireProvisionalResponseEvent;
};

export type QuestionnaireBlindAdmissionDecision = {
  event: NostrEvent;
  response: QuestionnaireBlindResponseEvent;
  accepted: boolean;
  rejectionReason: "duplicate_nullifier" | "duplicate_response" | "invalid_token_proof" | "invalid_payload_shape" | "questionnaire_closed" | null;
  decidedAt?: number | null;
  decisionEventId?: string | null;
};

type QuestionnaireSubmissionDecisionEntry = {
  event: NostrEvent;
  decision: QuestionnaireSubmissionDecisionEvent;
};

export type QuestionnaireWorkerDelegationStatus = {
  state: "active" | "revoked" | "expired" | "none";
  delegationId: string | null;
  workerNpub: string | null;
  expiresAt: string | null;
  updatedAt: number | null;
};

function buildPublicRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]));
}

function selectPublicReadRelays(relays: string[]) {
  return selectRelaysWithBackoff(relays, QUESTIONNAIRE_PUBLIC_READ_RELAYS_MAX);
}

function toHexPubkey(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub" ? decoded.data as string : "";
    } catch {
      return "";
    }
  }
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : "";
}

async function fetchWorkerControlEventsByCoordinator(input: {
  questionnaireId: string;
  kind: number;
  relays?: string[];
  readRelayLimit?: number;
  coordinatorNpub?: string | null;
}) {
  const coordinatorHex = toHexPubkey(input.coordinatorNpub);
  if (!coordinatorHex) {
    return [] as NostrEvent[];
  }
  const relays = getQuestionnaireReadRelays(input.relays, input.readRelayLimit);
  const filter: Filter = {
    kinds: [input.kind],
    authors: [coordinatorHex],
    limit: 200,
  };
  return queryQuestionnaireEvents(relays, filter)
    .then((events) => events.filter((event) => {
      if (input.kind !== event.kind) {
        return false;
      }
      if (input.kind === OPTIONA_WORKER_DELEGATION_KIND) {
        return parseWorkerDelegationEvent(event)?.electionId === input.questionnaireId;
      }
      return parseWorkerDelegationRevocationEvent(event)?.electionId === input.questionnaireId;
    }))
    .catch(() => [] as NostrEvent[]);
}

function mergeEventsById(...groups: NostrEvent[][]) {
  const byId = new Map<string, NostrEvent>();
  for (const event of groups.flat()) {
    byId.set(event.id, event);
  }
  return [...byId.values()];
}

export async function fetchQuestionnaireDefinitions(input: {
  questionnaireId?: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_DEFINITION_KIND,
    relays: input.relays,
    limit: input.limit,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: input.preferKindOnly,
    parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
  })).events;

  return events
    .map((event) => ({ event, definition: parseQuestionnaireDefinitionEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; definition: QuestionnaireDefinition } => Boolean(entry.definition));
}

export async function fetchLatestQuestionnaireDefinitionByCoordinator(input: {
  questionnaireId: string;
  coordinatorNpub: string;
  relays?: string[];
}) {
  const coordinatorHex = toHexPubkey(input.coordinatorNpub);
  if (!coordinatorHex) {
    return null;
  }
  const entries = await fetchQuestionnaireDefinitions({
    questionnaireId: input.questionnaireId,
    relays: input.relays,
    limit: 100,
    preferKindOnly: true,
  });
  const latest = entries
    .filter((entry) => entry.event.pubkey === coordinatorHex)
    .filter((entry) => toHexPubkey(entry.definition.coordinatorPubkey) === coordinatorHex)
    .filter((entry) => entry.definition.questionnaireId === input.questionnaireId)
    .sort((left, right) => (
      Number(right.event.created_at ?? right.definition.createdAt ?? 0)
      - Number(left.event.created_at ?? left.definition.createdAt ?? 0)
    ))[0] ?? null;
  if (!latest) {
    return null;
  }
  const definitionHash = questionnaireDefinitionEventHash(latest.event.content);
  storeCachedQuestionnaireDefinitionReference(buildQuestionnaireDefinitionReference({
    definition: latest.definition,
    definitionEventId: latest.event.id,
    definitionHash,
    relays: latest.definition.questionnaireRelays ?? input.relays,
  }));
  return { ...latest, definitionHash };
}

export async function fetchQuestionnaireParticipantCount(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_PARTICIPANT_COUNT_KIND,
    relays: input.relays,
    limit: input.limit,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: input.preferKindOnly,
    parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireParticipantCountEvent(event)?.questionnaireId ?? null,
  })).events;

  return events
    .map((event) => ({ event, participantCount: parseQuestionnaireParticipantCountEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; participantCount: QuestionnaireParticipantCountEvent } => Boolean(entry.participantCount));
}

export async function fetchQuestionnairePrivateInviteStatus(input: {
  questionnaireId: string;
  codeHash: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const normalizedCodeHash = input.codeHash.trim().toLowerCase();
  if (!normalizedCodeHash) {
    return null;
  }
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_PRIVATE_INVITE_STATUS_KIND,
    relays: input.relays,
    limit: input.limit ?? 40,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: input.preferKindOnly,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    parseQuestionnaireIdFromEvent: (event) => parseQuestionnairePrivateInviteStatusEvent(event)?.questionnaireId ?? null,
  })).events;

  const statuses = events
    .map((event) => ({ event, status: parseQuestionnairePrivateInviteStatusEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; status: QuestionnairePrivateInviteStatusEvent } => (
      Boolean(entry.status) && entry.status.codeHash === normalizedCodeHash
    ))
    .sort((left, right) => {
      const createdDelta = Number(right.status.createdAt ?? 0) - Number(left.status.createdAt ?? 0);
      if (createdDelta !== 0) {
        return createdDelta;
      }
      return String(right.event.id ?? "").localeCompare(String(left.event.id ?? ""));
    });

  return statuses[0] ?? null;
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
    onclose: (reasons) => {
      recordRelayCloseReasons(reasons);
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
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit ?? 8,
    preferKindOnly: input.preferKindOnly,
    limit: input.limit ?? 200,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    parseQuestionnaireIdFromEvent: (event) => {
      const parsed = parseQuestionnaireBlindResponseEvent(event.content);
      return parsed?.questionnaireId ?? null;
    },
  })).events;

  return events
    .map((event) => ({ event, response: parseQuestionnaireBlindResponseEvent(event.content) }))
    .filter((entry) => entry.response?.questionnaireId === input.questionnaireId)
    .filter((entry): entry is { event: NostrEvent; response: QuestionnaireBlindResponseEvent } => Boolean(entry.response));
}

export async function fetchQuestionnaireProvisionalResponses(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_RESPONSE_PROVISIONAL_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit ?? 8,
    preferKindOnly: input.preferKindOnly,
    limit: input.limit ?? 200,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    parseQuestionnaireIdFromEvent: (event) => {
      const parsed = parseQuestionnaireProvisionalResponseEvent(event.content);
      return parsed?.questionnaireId ?? null;
    },
  })).events;

  return events
    .map((event) => ({ event, response: parseQuestionnaireProvisionalResponseEvent(event.content) }))
    .filter((entry) => entry.response?.questionnaireId === input.questionnaireId)
    .filter((entry): entry is QuestionnaireProvisionalResponseEntry => Boolean(entry.response));
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
    onclose: (reasons) => {
      recordRelayCloseReasons(reasons);
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

function dedupeBlindResponseEntries(entries: QuestionnaireBlindResponseEntry[]) {
  const seenEventIds = new Set<string>();
  const seenLogicalPayloads = new Set<string>();
  const deduped: QuestionnaireBlindResponseEntry[] = [];
  for (const entry of [...entries].sort(canonicalBlindResponseOrder)) {
    const responseId = entry.response.responseId.trim();
    const eventId = String(entry.event.id ?? "").trim();
    if (eventId && seenEventIds.has(eventId)) {
      continue;
    }
    if (eventId) {
      seenEventIds.add(eventId);
    }
    const logicalPayloadKey = responseId
      ? `${responseId}:${fingerprintBlindResponsePayload(entry.response)}`
      : "";
    if (logicalPayloadKey && seenLogicalPayloads.has(logicalPayloadKey)) {
      continue;
    }
    if (logicalPayloadKey) {
      seenLogicalPayloads.add(logicalPayloadKey);
    }
    deduped.push(entry);
  }
  return deduped;
}

function fingerprintBlindResponsePayload(response: QuestionnaireBlindResponseEvent) {
  return JSON.stringify({
    schemaVersion: response.schemaVersion,
    eventType: response.eventType,
    questionnaireId: response.questionnaireId.trim(),
    responseId: response.responseId.trim(),
    submittedAt: response.submittedAt,
    authorPubkey: response.authorPubkey.trim(),
    tokenNullifier: response.tokenNullifier.trim(),
    tokenNullifiers: response.tokenNullifiers ?? [],
    tokenProof: response.tokenProof,
    tokenProofs: response.tokenProofs ?? [],
    answers: response.answers ?? [],
  });
}

function responseNullifiers(response: QuestionnaireBlindResponseEvent) {
  const values = (response.tokenNullifiers ?? [])
    .map((entry) => entry.tokenNullifier.trim())
    .filter(Boolean);
  const legacy = response.tokenNullifier.trim();
  return [...new Set(values.length > 0 ? values : [legacy].filter(Boolean))];
}

function responseTokenProofs(response: QuestionnaireBlindResponseEvent) {
  return response.tokenProofs?.length ? response.tokenProofs : [response.tokenProof];
}

function choosePreferredSubmissionDecision(
  existing: QuestionnaireSubmissionDecisionEntry | undefined,
  next: QuestionnaireSubmissionDecisionEntry,
) {
  if (!existing) {
    return next;
  }
  if (existing.decision.accepted !== next.decision.accepted) {
    return existing.decision.accepted ? existing : next;
  }
  const existingCreatedAt = Number(existing.event.created_at ?? existing.decision.decidedAt ?? 0);
  const nextCreatedAt = Number(next.event.created_at ?? next.decision.decidedAt ?? 0);
  return nextCreatedAt >= existingCreatedAt ? next : existing;
}

export function evaluateQuestionnaireBlindAdmissions(input: {
  entries: QuestionnaireBlindResponseEntry[];
  decisionEntries?: QuestionnaireSubmissionDecisionEntry[];
  verifiedResponseIds?: Iterable<string>;
  requireVerifiedProofs?: boolean;
}) {
  const ordered = dedupeBlindResponseEntries(input.entries);
  const verifiedResponseIds = new Set(Array.from(input.verifiedResponseIds ?? []).map((entry) => entry.trim()).filter(Boolean));
  const requireVerifiedProofs = input.requireVerifiedProofs ?? Boolean(input.verifiedResponseIds);
  const latestDecisionBySubmissionId = new Map<string, QuestionnaireSubmissionDecisionEntry>();
  for (const entry of input.decisionEntries ?? []) {
    const submissionId = entry.decision.submissionId.trim();
    if (!submissionId) {
      continue;
    }
    latestDecisionBySubmissionId.set(
      submissionId,
      choosePreferredSubmissionDecision(latestDecisionBySubmissionId.get(submissionId), entry),
    );
  }
  const acceptedNullifiers = new Set<string>();
  const acceptedResponseIds = new Set<string>();
  const decisions: QuestionnaireBlindAdmissionDecision[] = [];

  for (const entry of ordered) {
    const responseId = entry.response.responseId.trim();
    const explicitDecision = latestDecisionBySubmissionId.get(responseId);
    const proofVerified = Boolean(responseId && verifiedResponseIds.has(responseId));
    if (requireVerifiedProofs && !proofVerified) {
      decisions.push({
        ...entry,
        accepted: false,
        rejectionReason: "invalid_token_proof",
        decidedAt: explicitDecision?.decision.accepted === false ? explicitDecision.decision.decidedAt : null,
        decisionEventId: explicitDecision?.decision.accepted === false ? explicitDecision.event.id : null,
      });
      continue;
    }
    const verifiedResponseOverridesInvalidProof = Boolean(
      proofVerified
      && explicitDecision
      && !explicitDecision.decision.accepted
      && explicitDecision.decision.reason === "invalid_token_proof",
    );
    if (explicitDecision && !verifiedResponseOverridesInvalidProof) {
      decisions.push({
        ...entry,
        accepted: explicitDecision.decision.accepted,
        rejectionReason: explicitDecision.decision.accepted ? null : explicitDecision.decision.reason,
        decidedAt: explicitDecision.decision.decidedAt,
        decisionEventId: explicitDecision.event.id,
      });
      if (explicitDecision.decision.accepted) {
        for (const nullifier of responseNullifiers(entry.response)) {
          acceptedNullifiers.add(nullifier);
        }
        if (responseId) {
          acceptedResponseIds.add(responseId);
        }
      }
      continue;
    }
    if (responseId && acceptedResponseIds.has(responseId)) {
      decisions.push({
        ...entry,
        accepted: false,
        rejectionReason: "duplicate_response",
        decidedAt: null,
        decisionEventId: null,
      });
      continue;
    }
    const nullifiers = responseNullifiers(entry.response);
    if (nullifiers.some((nullifier) => acceptedNullifiers.has(nullifier))) {
      decisions.push({
        ...entry,
        accepted: false,
        rejectionReason: "duplicate_nullifier",
        decidedAt: null,
        decisionEventId: null,
      });
      continue;
    }

    for (const nullifier of nullifiers) {
      acceptedNullifiers.add(nullifier);
    }
    if (responseId) {
      acceptedResponseIds.add(responseId);
    }
    decisions.push({
      ...entry,
      accepted: true,
      rejectionReason: null,
      decidedAt: null,
      decisionEventId: null,
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

export async function verifyQuestionnaireBlindResponseProofs(input: {
  entries: QuestionnaireBlindResponseEntry[];
  publicKey?: QuestionnaireBlindPublicKey | null;
}) {
  const publicKey = input.publicKey ?? null;
  if (!publicKey) {
    return new Set<string>();
  }
  const verifiedResponseIds = new Set<string>();
  await Promise.all(input.entries.map(async (entry) => {
    const responseId = entry.response.responseId.trim();
    if (!responseId) {
      return;
    }
    const proofs = responseTokenProofs(entry.response);
    const valid = (await Promise.all(proofs.map((proof) => verifyQuestionnaireBlindSignature({
      publicKey,
      message: buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId: entry.response.questionnaireId,
        tokenSecretCommitment: proof.tokenCommitment,
        ballotScope: proof.ballotScope
          ?? (proof.questionId ? { questionId: proof.questionId } : null),
      }),
      signature: proof.signature,
    })))).every(Boolean);
    if (valid) {
      verifiedResponseIds.add(responseId);
    }
  }));
  return verifiedResponseIds;
}

export async function fetchQuestionnaireSubmissionDecisions(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit ?? 8,
    preferKindOnly: input.preferKindOnly,
    limit: input.limit ?? 400,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
    parseQuestionnaireIdFromEvent: (event) => {
      const parsed = parseQuestionnaireSubmissionDecisionEvent(event.content);
      return parsed?.questionnaireId ?? null;
    },
  })).events;
  return events
    .map((event) => ({ event, decision: parseQuestionnaireSubmissionDecisionEvent(event.content) }))
    .filter((entry) => entry.decision?.questionnaireId === input.questionnaireId)
    .filter((entry): entry is { event: NostrEvent; decision: QuestionnaireSubmissionDecisionEvent } => Boolean(entry.decision));
}

export async function fetchQuestionnaireState(input: {
  questionnaireId: string;
  relays?: string[];
  limit?: number;
  readRelayLimit?: number;
  preferKindOnly?: boolean;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_STATE_KIND,
    relays: input.relays,
    limit: input.limit,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: input.preferKindOnly,
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
  readRelayLimit?: number;
  preferKindOnly?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
}) {
  const events = (await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
    relays: input.relays,
    limit: input.limit,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: input.preferKindOnly,
    maxPages: input.maxPages,
    timeBudgetMs: input.timeBudgetMs,
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

function toEventUnix(event: NostrEvent, fallbackIso?: string | null) {
  const eventUnix = Number(event.created_at ?? 0);
  if (Number.isFinite(eventUnix) && eventUnix > 0) {
    return eventUnix;
  }
  const isoUnix = fallbackIso ? Math.floor(Date.parse(fallbackIso) / 1000) : 0;
  return Number.isFinite(isoUnix) && isoUnix > 0 ? isoUnix : 0;
}

export async function fetchQuestionnaireWorkerDelegationStatus(input: {
  questionnaireId: string;
  relays?: string[];
  readRelayLimit?: number;
}) {
  const delegationEvents = await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: true,
    limit: 200,
    parseQuestionnaireIdFromEvent: (event) => parseWorkerDelegationEvent(event)?.electionId ?? null,
  });
  const revocationEvents = await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: true,
    limit: 200,
    parseQuestionnaireIdFromEvent: (event) => parseWorkerDelegationRevocationEvent(event)?.electionId ?? null,
  });

  const delegations = delegationEvents.events
    .map((event) => ({ event, delegation: parseWorkerDelegationEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; delegation: WorkerDelegationCertificate } => Boolean(entry.delegation))
    .filter((entry) => entry.delegation.electionId === input.questionnaireId)
    .sort((left, right) => (
      toEventUnix(right.event, right.delegation.issuedAt)
      - toEventUnix(left.event, left.delegation.issuedAt)
    ));

  if (delegations.length === 0) {
    return {
      state: "none",
      delegationId: null,
      workerNpub: null,
      expiresAt: null,
      updatedAt: null,
    } satisfies QuestionnaireWorkerDelegationStatus;
  }

  const latestDelegation = delegations[0];
  const revocationsByDelegationId = new Map<string, { event: NostrEvent; revocation: WorkerDelegationRevocation }>();
  for (const event of revocationEvents.events) {
    const revocation = parseWorkerDelegationRevocationEvent(event);
    if (!revocation || revocation.electionId !== input.questionnaireId) {
      continue;
    }
    const existing = revocationsByDelegationId.get(revocation.delegationId);
    if (!existing || toEventUnix(event, revocation.revokedAt) >= toEventUnix(existing.event, existing.revocation.revokedAt)) {
      revocationsByDelegationId.set(revocation.delegationId, { event, revocation });
    }
  }

  const delegationRevoked = revocationsByDelegationId.has(latestDelegation.delegation.delegationId);
  const expiresAtMs = Date.parse(latestDelegation.delegation.expiresAt);
  const isExpired = Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;

  const state: QuestionnaireWorkerDelegationStatus["state"] = delegationRevoked
    ? "revoked"
    : isExpired
      ? "expired"
      : "active";

  return {
    state,
    delegationId: latestDelegation.delegation.delegationId,
    workerNpub: latestDelegation.delegation.workerNpub,
    expiresAt: latestDelegation.delegation.expiresAt,
    updatedAt: toEventUnix(latestDelegation.event, latestDelegation.delegation.issuedAt),
  } satisfies QuestionnaireWorkerDelegationStatus;
}

export async function fetchQuestionnaireActiveWorkerDelegationForCapability(input: {
  questionnaireId: string;
  capability: WorkerCapability;
  relays?: string[];
  readRelayLimit?: number;
  coordinatorNpub?: string | null;
}) {
  const delegationEvents = await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: true,
    limit: 200,
    parseQuestionnaireIdFromEvent: (event) => parseWorkerDelegationEvent(event)?.electionId ?? null,
  });
  const coordinatorDelegationEvents = await fetchWorkerControlEventsByCoordinator({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    coordinatorNpub: input.coordinatorNpub,
  });
  const revocationEvents = await fetchQuestionnaireEventsWithFallback({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    preferKindOnly: true,
    limit: 200,
    parseQuestionnaireIdFromEvent: (event) => parseWorkerDelegationRevocationEvent(event)?.electionId ?? null,
  });
  const coordinatorRevocationEvents = await fetchWorkerControlEventsByCoordinator({
    questionnaireId: input.questionnaireId,
    kind: OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
    relays: input.relays,
    readRelayLimit: input.readRelayLimit,
    coordinatorNpub: input.coordinatorNpub,
  });
  const revocationIds = new Set(
    mergeEventsById(revocationEvents.events, coordinatorRevocationEvents)
      .map((event) => parseWorkerDelegationRevocationEvent(event))
      .filter((entry): entry is WorkerDelegationRevocation => Boolean(entry))
      .filter((entry) => entry.electionId === input.questionnaireId)
      .map((entry) => entry.delegationId),
  );
  const nowMs = Date.now();
  const active = mergeEventsById(delegationEvents.events, coordinatorDelegationEvents)
    .map((event) => ({ event, delegation: parseWorkerDelegationEvent(event) }))
    .filter((entry): entry is { event: NostrEvent; delegation: WorkerDelegationCertificate } => Boolean(entry.delegation))
    .filter((entry) => entry.delegation.electionId === input.questionnaireId)
    .filter((entry) => entry.delegation.capabilities.includes(input.capability))
    .filter((entry) => !revocationIds.has(entry.delegation.delegationId))
    .filter((entry) => {
      const expiresAtMs = Date.parse(entry.delegation.expiresAt);
      return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
    })
    .sort((left, right) => (
      toEventUnix(right.event, right.delegation.issuedAt)
      - toEventUnix(left.event, left.delegation.issuedAt)
    ))[0] ?? null;
  return active?.delegation ?? null;
}
