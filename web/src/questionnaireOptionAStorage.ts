import {
  buildCoordinatorStorageKeys,
  buildVoterStorageKeys,
  type BallotAcceptanceResult,
  type BallotSubmission,
  type BlindBallotIssuance,
  type BlindBallotRequest,
  type CoordinatorElectionState,
  type ElectionInviteMessage,
  type ElectionSummary,
  type Npub,
  type VoterElectionLocalState,
  type WhitelistEntry,
} from "./questionnaireOptionA";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";

function getKey(key: string) {
  return buildSimpleNamespacedLocalStorageKey(key);
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(getKey(key));
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(getKey(key), JSON.stringify(value));
}

const REGISTRY_KEY = "optiona:elections:registry";
const INVITE_MAILBOX_KEY = "optiona:invite:mailbox";
const REQUEST_QUEUE_KEY = "optiona:queue:requests";
const SUBMISSION_QUEUE_KEY = "optiona:queue:submissions";
const ISSUANCE_MAILBOX_KEY = "optiona:mailbox:issuances";
const ISSUANCE_DELIVERY_KEY = "optiona:mailbox:issuanceDelivery";
const REQUEST_ACK_DELIVERY_KEY = "optiona:mailbox:requestAckDelivery";
const REQUEST_ACK_KEY = "optiona:mailbox:requestAck";
const ISSUANCE_ACK_KEY = "optiona:mailbox:issuanceAck";
const SUBMISSION_ACK_DELIVERY_KEY = "optiona:mailbox:submissionAckDelivery";
const SUBMISSION_ACK_KEY = "optiona:mailbox:submissionAck";
const ACCEPTANCE_DELIVERY_KEY = "optiona:mailbox:acceptanceDelivery";
const ACCEPTANCE_MAILBOX_KEY = "optiona:mailbox:acceptance";
const PRIVATE_RELAY_PREFS_KEY = "optiona:dm:relayPrefs";

export type BlindIssuanceDeliveryRecord = {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  attempts: number;
  successes: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastEventId?: string | null;
  requestLastSentAt?: string | null;
};

export type BlindRequestAckDeliveryRecord = {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  attempts: number;
  successes: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
};

export type BallotSubmissionAckDeliveryRecord = {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  attempts: number;
  successes: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
};

export type BallotAcceptanceDeliveryRecord = {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  attempts: number;
  successes: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
};

export type BlindIssuanceAckRecord = {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  issuanceId: string;
  ackedAt: string;
  storedAt: string;
};

export type BlindRequestAckRecord = {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  ackedAt: string;
  storedAt: string;
};

export type BallotSubmissionAckRecord = {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  ackedAt: string;
  storedAt: string;
};

export function loadElectionRegistry() {
  return readJson<string[]>(REGISTRY_KEY, []);
}

export function saveElectionRegistry(ids: string[]) {
  writeJson(REGISTRY_KEY, [...new Set(ids.filter((id) => id.trim()))]);
}

export function upsertElectionSummary(summary: ElectionSummary) {
  const all = readJson<Record<string, ElectionSummary>>("optiona:elections:summaries", {});
  all[summary.electionId] = summary;
  writeJson("optiona:elections:summaries", all);
  saveElectionRegistry([...loadElectionRegistry(), summary.electionId]);
}

export function loadElectionSummary(electionId: string): ElectionSummary | null {
  const all = readJson<Record<string, ElectionSummary>>("optiona:elections:summaries", {});
  return all[electionId] ?? null;
}

export function saveCoordinatorState(input: {
  coordinatorNpub: Npub;
  state: CoordinatorElectionState;
}) {
  const keys = buildCoordinatorStorageKeys({
    npub: input.coordinatorNpub,
    electionId: input.state.election.electionId,
  });
  writeJson(keys.election, input.state.election);
  writeJson(keys.whitelist, input.state.whitelist);
  writeJson(keys.requests, input.state.pendingBlindRequests);
  writeJson(keys.issuances, input.state.issuedBlindResponses);
  writeJson(keys.submissions, input.state.receivedSubmissions);
  writeJson(`${keys.election}:blindSigningPrivateKey`, input.state.blindSigningPrivateKey ?? null);
  writeJson(keys.acceptance, {
    acceptedNullifiers: input.state.acceptedNullifiers,
    acceptanceResults: input.state.acceptanceResults,
    lastUpdatedAt: input.state.lastUpdatedAt,
  });
}

export function loadCoordinatorState(input: {
  coordinatorNpub: Npub;
  electionId: string;
}): CoordinatorElectionState | null {
  const summary = loadElectionSummary(input.electionId);
  if (!summary || summary.coordinatorNpub !== input.coordinatorNpub) {
    return null;
  }
  const keys = buildCoordinatorStorageKeys({
    npub: input.coordinatorNpub,
    electionId: input.electionId,
  });
  const whitelist = readJson<Record<Npub, WhitelistEntry>>(keys.whitelist, {});
  const pendingBlindRequests = readJson<Record<string, BlindBallotRequest>>(keys.requests, {});
  const issuedBlindResponses = readJson<Record<string, BlindBallotIssuance>>(keys.issuances, {});
  const receivedSubmissions = readJson<Record<string, BallotSubmission>>(keys.submissions, {});
  const blindSigningPrivateKey = readJson<CoordinatorElectionState["blindSigningPrivateKey"]>(
    `${keys.election}:blindSigningPrivateKey`,
    null,
  );
  const acceptance = readJson<{
    acceptedNullifiers: Record<string, string>;
    acceptanceResults: Record<string, BallotAcceptanceResult>;
    lastUpdatedAt?: string;
  }>(keys.acceptance, {
    acceptedNullifiers: {},
    acceptanceResults: {},
    lastUpdatedAt: new Date().toISOString(),
  });
  return {
    election: summary,
    whitelist,
    pendingBlindRequests,
    issuedBlindResponses,
    receivedSubmissions,
    acceptedNullifiers: acceptance.acceptedNullifiers,
    acceptanceResults: acceptance.acceptanceResults,
    blindSigningPrivateKey,
    lastUpdatedAt: acceptance.lastUpdatedAt ?? new Date().toISOString(),
  };
}

export function saveVoterState(input: {
  voterNpub: Npub;
  state: VoterElectionLocalState;
}) {
  const keys = buildVoterStorageKeys({
    npub: input.voterNpub,
    electionId: input.state.electionId,
  });
  writeJson(keys.invite, input.state.inviteMessage);
  writeJson(keys.login, {
    loginVerified: input.state.loginVerified,
    loginVerifiedAt: input.state.loginVerifiedAt,
  });
  writeJson(keys.blindRequest, {
    blindRequest: input.state.blindRequest,
    blindRequestSent: input.state.blindRequestSent,
    blindRequestSentAt: input.state.blindRequestSentAt,
    blindTokenSecret: input.state.blindTokenSecret,
  });
  writeJson(keys.issuance, input.state.blindIssuance);
  writeJson(keys.draftResponses, input.state.draftResponses);
  writeJson(keys.submission, {
    submission: input.state.submission,
    responseNsec: input.state.responseNsec ?? null,
    responseNpub: input.state.responseNpub ?? null,
  });
  writeJson(keys.acceptance, {
    submissionAccepted: input.state.submissionAccepted,
    submissionAcceptedAt: input.state.submissionAcceptedAt,
    lastUpdatedAt: input.state.lastUpdatedAt,
  });
}

export function loadVoterState(input: {
  voterNpub: Npub;
  electionId: string;
  coordinatorNpub?: string;
}): VoterElectionLocalState | null {
  const summary = loadElectionSummary(input.electionId);
  const keys = buildVoterStorageKeys({
    npub: input.voterNpub,
    electionId: input.electionId,
  });
  const inviteMessage = readJson<ElectionInviteMessage | null>(keys.invite, null);
  const login = readJson<{ loginVerified: boolean; loginVerifiedAt?: string | null }>(keys.login, {
    loginVerified: false,
    loginVerifiedAt: null,
  });
  const requestPart = readJson<{
    blindRequest: BlindBallotRequest | null;
    blindRequestSent: boolean;
    blindRequestSentAt?: string | null;
    blindTokenSecret?: VoterElectionLocalState["blindTokenSecret"];
  }>(keys.blindRequest, {
    blindRequest: null,
    blindRequestSent: false,
    blindRequestSentAt: null,
    blindTokenSecret: null,
  });
  const blindIssuance = readJson<BlindBallotIssuance | null>(keys.issuance, null);
  const draftResponses = readJson<VoterElectionLocalState["draftResponses"]>(keys.draftResponses, []);
  const submissionPart = readJson<{
    submission?: BallotSubmission | null;
    responseNsec?: string | null;
    responseNpub?: string | null;
  } | BallotSubmission | null>(keys.submission, null);
  const submission = submissionPart && "type" in submissionPart
    ? submissionPart
    : (submissionPart?.submission ?? null);
  const acceptance = readJson<{
    submissionAccepted?: boolean | null;
    submissionAcceptedAt?: string | null;
    lastUpdatedAt?: string;
  }>(keys.acceptance, {
    submissionAccepted: null,
    submissionAcceptedAt: null,
    lastUpdatedAt: new Date().toISOString(),
  });

  const anyState = Boolean(inviteMessage || login.loginVerified || requestPart.blindRequest || blindIssuance || submission || draftResponses.length > 0);
  if (!anyState && !summary) {
    return null;
  }

  return {
    electionId: input.electionId,
    invitedNpub: input.voterNpub,
    coordinatorNpub: input.coordinatorNpub ?? inviteMessage?.coordinatorNpub ?? summary?.coordinatorNpub ?? "",
    loginVerified: login.loginVerified,
    loginVerifiedAt: login.loginVerifiedAt ?? null,
    inviteMessage,
    blindRequest: requestPart.blindRequest,
    blindRequestSent: requestPart.blindRequestSent,
    blindRequestSentAt: requestPart.blindRequestSentAt ?? null,
    blindIssuance,
    credentialReady: Boolean(blindIssuance),
    blindTokenSecret: requestPart.blindTokenSecret ?? null,
    responseNsec: submissionPart && !("type" in submissionPart) ? submissionPart.responseNsec ?? null : null,
    responseNpub: submissionPart && !("type" in submissionPart) ? submissionPart.responseNpub ?? null : submission?.responseNpub ?? null,
    draftResponses,
    submission,
    submissionAccepted: acceptance.submissionAccepted ?? null,
    submissionAcceptedAt: acceptance.submissionAcceptedAt ?? null,
    lastUpdatedAt: acceptance.lastUpdatedAt ?? new Date().toISOString(),
  };
}

export function publishInviteToMailbox(invite: ElectionInviteMessage) {
  const mailbox = readJson<Record<string, Record<string, ElectionInviteMessage>>>(INVITE_MAILBOX_KEY, {});
  const byElection = mailbox[invite.invitedNpub] ?? {};
  byElection[invite.electionId] = invite;
  mailbox[invite.invitedNpub] = byElection;
  writeJson(INVITE_MAILBOX_KEY, mailbox);
}

export function readInviteFromMailbox(input: { invitedNpub: string; electionId: string }) {
  const mailbox = readJson<Record<string, Record<string, ElectionInviteMessage>>>(INVITE_MAILBOX_KEY, {});
  return mailbox[input.invitedNpub]?.[input.electionId] ?? null;
}

export function listInvitesFromMailbox(invitedNpub: string) {
  const mailbox = readJson<Record<string, Record<string, ElectionInviteMessage>>>(INVITE_MAILBOX_KEY, {});
  return Object.values(mailbox[invitedNpub] ?? {});
}

export function listInvitesForElectionFromMailbox(electionId: string) {
  const mailbox = readJson<Record<string, Record<string, ElectionInviteMessage>>>(INVITE_MAILBOX_KEY, {});
  const id = electionId.trim();
  if (!id) {
    return [];
  }
  const invites: ElectionInviteMessage[] = [];
  for (const byElection of Object.values(mailbox)) {
    const invite = byElection?.[id] ?? null;
    if (invite) {
      invites.push(invite);
    }
  }
  return invites;
}

export function enqueueBlindRequest(request: BlindBallotRequest) {
  const queue = readJson<BlindBallotRequest[]>(REQUEST_QUEUE_KEY, []);
  const next = queue.filter((entry) => entry.requestId !== request.requestId);
  next.push(request);
  writeJson(REQUEST_QUEUE_KEY, next);
}

export function listBlindRequests(electionId: string) {
  const queue = readJson<BlindBallotRequest[]>(REQUEST_QUEUE_KEY, []);
  return queue.filter((entry) => entry.electionId === electionId);
}

export function dequeueBlindRequest(requestId: string) {
  const queue = readJson<BlindBallotRequest[]>(REQUEST_QUEUE_KEY, []);
  const next = queue.filter((entry) => entry.requestId !== requestId);
  writeJson(REQUEST_QUEUE_KEY, next);
}

export function storeBlindIssuance(issuance: BlindBallotIssuance) {
  const mailbox = readJson<Record<string, BlindBallotIssuance>>(ISSUANCE_MAILBOX_KEY, {});
  mailbox[issuance.requestId] = issuance;
  writeJson(ISSUANCE_MAILBOX_KEY, mailbox);
}

export function readBlindIssuance(requestId: string) {
  const mailbox = readJson<Record<string, BlindBallotIssuance>>(ISSUANCE_MAILBOX_KEY, {});
  return mailbox[requestId] ?? null;
}

export function readBlindIssuanceDeliveryRecord(requestId: string) {
  const records = readJson<Record<string, BlindIssuanceDeliveryRecord>>(ISSUANCE_DELIVERY_KEY, {});
  return records[requestId] ?? null;
}

export function recordBlindIssuanceDeliveryAttempt(input: {
  issuance: BlindBallotIssuance;
  attemptedAt: string;
  delivered: boolean;
  eventId?: string | null;
  requestLastSentAt?: string | null;
}) {
  const records = readJson<Record<string, BlindIssuanceDeliveryRecord>>(ISSUANCE_DELIVERY_KEY, {});
  const existing = records[input.issuance.requestId];
  records[input.issuance.requestId] = {
    requestId: input.issuance.requestId,
    electionId: input.issuance.electionId,
    invitedNpub: input.issuance.invitedNpub,
    attempts: (existing?.attempts ?? 0) + 1,
    successes: (existing?.successes ?? 0) + (input.delivered ? 1 : 0),
    lastAttemptAt: input.attemptedAt,
    lastSuccessAt: input.delivered ? input.attemptedAt : existing?.lastSuccessAt ?? null,
    lastEventId: input.eventId ?? existing?.lastEventId ?? null,
    requestLastSentAt: input.requestLastSentAt ?? existing?.requestLastSentAt ?? null,
  };
  writeJson(ISSUANCE_DELIVERY_KEY, records);
}

export function readBlindRequestAckDeliveryRecord(requestId: string) {
  const records = readJson<Record<string, BlindRequestAckDeliveryRecord>>(REQUEST_ACK_DELIVERY_KEY, {});
  return records[requestId] ?? null;
}

export function recordBlindRequestAckDeliveryAttempt(input: {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  attemptedAt: string;
  delivered: boolean;
}) {
  const records = readJson<Record<string, BlindRequestAckDeliveryRecord>>(REQUEST_ACK_DELIVERY_KEY, {});
  const existing = records[input.requestId];
  records[input.requestId] = {
    requestId: input.requestId,
    electionId: input.electionId,
    invitedNpub: input.invitedNpub,
    attempts: (existing?.attempts ?? 0) + 1,
    successes: (existing?.successes ?? 0) + (input.delivered ? 1 : 0),
    lastAttemptAt: input.attemptedAt,
    lastSuccessAt: input.delivered ? input.attemptedAt : existing?.lastSuccessAt ?? null,
  };
  writeJson(REQUEST_ACK_DELIVERY_KEY, records);
}

export function storeBlindIssuanceAckRecord(input: {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  issuanceId: string;
  ackedAt: string;
}) {
  const records = readJson<Record<string, BlindIssuanceAckRecord>>(ISSUANCE_ACK_KEY, {});
  records[input.requestId] = {
    requestId: input.requestId,
    electionId: input.electionId,
    invitedNpub: input.invitedNpub,
    issuanceId: input.issuanceId,
    ackedAt: input.ackedAt,
    storedAt: new Date().toISOString(),
  };
  writeJson(ISSUANCE_ACK_KEY, records);
}

export function readBlindIssuanceAckRecord(requestId: string) {
  const records = readJson<Record<string, BlindIssuanceAckRecord>>(ISSUANCE_ACK_KEY, {});
  return records[requestId] ?? null;
}

export function storeBlindRequestAckRecord(input: {
  requestId: string;
  electionId: string;
  invitedNpub: string;
  ackedAt: string;
}) {
  const records = readJson<Record<string, BlindRequestAckRecord>>(REQUEST_ACK_KEY, {});
  records[input.requestId] = {
    requestId: input.requestId,
    electionId: input.electionId,
    invitedNpub: input.invitedNpub,
    ackedAt: input.ackedAt,
    storedAt: new Date().toISOString(),
  };
  writeJson(REQUEST_ACK_KEY, records);
}

export function readBlindRequestAckRecord(requestId: string) {
  const records = readJson<Record<string, BlindRequestAckRecord>>(REQUEST_ACK_KEY, {});
  return records[requestId] ?? null;
}

export function enqueueSubmission(submission: BallotSubmission) {
  const queue = readJson<BallotSubmission[]>(SUBMISSION_QUEUE_KEY, []);
  const next = queue.filter((entry) => entry.submissionId !== submission.submissionId);
  next.push(submission);
  writeJson(SUBMISSION_QUEUE_KEY, next);
}

export function listSubmissions(electionId: string) {
  const queue = readJson<BallotSubmission[]>(SUBMISSION_QUEUE_KEY, []);
  return queue.filter((entry) => entry.electionId === electionId);
}

export function dequeueSubmission(submissionId: string) {
  const queue = readJson<BallotSubmission[]>(SUBMISSION_QUEUE_KEY, []);
  const next = queue.filter((entry) => entry.submissionId !== submissionId);
  writeJson(SUBMISSION_QUEUE_KEY, next);
}

export function storeBallotSubmissionAckRecord(input: {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  ackedAt: string;
}) {
  const records = readJson<Record<string, BallotSubmissionAckRecord>>(SUBMISSION_ACK_KEY, {});
  records[input.submissionId] = {
    submissionId: input.submissionId,
    electionId: input.electionId,
    responseNpub: input.responseNpub,
    ackedAt: input.ackedAt,
    storedAt: new Date().toISOString(),
  };
  writeJson(SUBMISSION_ACK_KEY, records);
}

export function readBallotSubmissionAckRecord(submissionId: string) {
  const records = readJson<Record<string, BallotSubmissionAckRecord>>(SUBMISSION_ACK_KEY, {});
  return records[submissionId] ?? null;
}

export function readBallotSubmissionAckDeliveryRecord(submissionId: string) {
  const records = readJson<Record<string, BallotSubmissionAckDeliveryRecord>>(SUBMISSION_ACK_DELIVERY_KEY, {});
  return records[submissionId] ?? null;
}

export function recordBallotSubmissionAckDeliveryAttempt(input: {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  attemptedAt: string;
  delivered: boolean;
}) {
  const records = readJson<Record<string, BallotSubmissionAckDeliveryRecord>>(SUBMISSION_ACK_DELIVERY_KEY, {});
  const existing = records[input.submissionId];
  records[input.submissionId] = {
    submissionId: input.submissionId,
    electionId: input.electionId,
    responseNpub: input.responseNpub,
    attempts: (existing?.attempts ?? 0) + 1,
    successes: (existing?.successes ?? 0) + (input.delivered ? 1 : 0),
    lastAttemptAt: input.attemptedAt,
    lastSuccessAt: input.delivered ? input.attemptedAt : existing?.lastSuccessAt ?? null,
  };
  writeJson(SUBMISSION_ACK_DELIVERY_KEY, records);
}

export function storeAcceptance(result: BallotAcceptanceResult) {
  const mailbox = readJson<Record<string, BallotAcceptanceResult>>(ACCEPTANCE_MAILBOX_KEY, {});
  mailbox[result.submissionId] = result;
  writeJson(ACCEPTANCE_MAILBOX_KEY, mailbox);
}

export function readAcceptance(submissionId: string) {
  const mailbox = readJson<Record<string, BallotAcceptanceResult>>(ACCEPTANCE_MAILBOX_KEY, {});
  return mailbox[submissionId] ?? null;
}

export function readBallotAcceptanceDeliveryRecord(submissionId: string) {
  const records = readJson<Record<string, BallotAcceptanceDeliveryRecord>>(ACCEPTANCE_DELIVERY_KEY, {});
  return records[submissionId] ?? null;
}

export function recordBallotAcceptanceDeliveryAttempt(input: {
  submissionId: string;
  electionId: string;
  responseNpub: string;
  attemptedAt: string;
  delivered: boolean;
}) {
  const records = readJson<Record<string, BallotAcceptanceDeliveryRecord>>(ACCEPTANCE_DELIVERY_KEY, {});
  const existing = records[input.submissionId];
  records[input.submissionId] = {
    submissionId: input.submissionId,
    electionId: input.electionId,
    responseNpub: input.responseNpub,
    attempts: (existing?.attempts ?? 0) + 1,
    successes: (existing?.successes ?? 0) + (input.delivered ? 1 : 0),
    lastAttemptAt: input.attemptedAt,
    lastSuccessAt: input.delivered ? input.attemptedAt : existing?.lastSuccessAt ?? null,
  };
  writeJson(ACCEPTANCE_DELIVERY_KEY, records);
}

export function readElectionPrivateRelayPrefs(electionId: string) {
  const all = readJson<Record<string, string[]>>(PRIVATE_RELAY_PREFS_KEY, {});
  return [...new Set((all[electionId] ?? []).map((relay) => relay.trim()).filter(Boolean))].slice(0, 5);
}

export function recordElectionPrivateRelaySuccesses(electionId: string, relays: string[]) {
  const nextRelays = [...new Set(relays.map((relay) => relay.trim()).filter(Boolean))];
  if (!electionId.trim() || nextRelays.length === 0) {
    return;
  }
  const all = readJson<Record<string, string[]>>(PRIVATE_RELAY_PREFS_KEY, {});
  const current = all[electionId] ?? [];
  all[electionId] = [...new Set([...nextRelays, ...current])].slice(0, 5);
  writeJson(PRIVATE_RELAY_PREFS_KEY, all);
}
