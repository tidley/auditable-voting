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
const ACCEPTANCE_MAILBOX_KEY = "optiona:mailbox:acceptance";

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
  });
  writeJson(keys.issuance, input.state.blindIssuance);
  writeJson(keys.draftResponses, input.state.draftResponses);
  writeJson(keys.submission, input.state.submission);
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
  }>(keys.blindRequest, {
    blindRequest: null,
    blindRequestSent: false,
    blindRequestSentAt: null,
  });
  const blindIssuance = readJson<BlindBallotIssuance | null>(keys.issuance, null);
  const draftResponses = readJson<VoterElectionLocalState["draftResponses"]>(keys.draftResponses, []);
  const submission = readJson<BallotSubmission | null>(keys.submission, null);
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

export function enqueueBlindRequest(request: BlindBallotRequest) {
  const queue = readJson<BlindBallotRequest[]>(REQUEST_QUEUE_KEY, []);
  queue.push(request);
  writeJson(REQUEST_QUEUE_KEY, queue);
}

export function listBlindRequests(electionId: string) {
  const queue = readJson<BlindBallotRequest[]>(REQUEST_QUEUE_KEY, []);
  return queue.filter((entry) => entry.electionId === electionId);
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

export function enqueueSubmission(submission: BallotSubmission) {
  const queue = readJson<BallotSubmission[]>(SUBMISSION_QUEUE_KEY, []);
  queue.push(submission);
  writeJson(SUBMISSION_QUEUE_KEY, queue);
}

export function listSubmissions(electionId: string) {
  const queue = readJson<BallotSubmission[]>(SUBMISSION_QUEUE_KEY, []);
  return queue.filter((entry) => entry.electionId === electionId);
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
