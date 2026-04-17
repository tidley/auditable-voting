export type ElectionId = string;
export type Npub = string;
export type Hex = string;
export type IsoTime = string;
export type RequestId = string;
export type IssuanceId = string;
export type SubmissionId = string;
export type Nullifier = string;
export type EventId = string;

export type ElectionState = "draft" | "published" | "open" | "closed" | "counted";
export type WhitelistClaimState =
  | "whitelisted"
  | "invited"
  | "claimed"
  | "blind_request_received"
  | "blind_signature_issued"
  | "vote_received"
  | "vote_accepted"
  | "vote_rejected";

export type BallotRejectReason =
  | "duplicate_nullifier"
  | "invalid_credential"
  | "election_closed"
  | "schema_invalid"
  | "not_whitelisted"
  | "issuance_missing"
  | "already_voted";

export interface ElectionSummary {
  electionId: ElectionId;
  title: string;
  description: string;
  state: ElectionState;
  openedAt?: IsoTime | null;
  closedAt?: IsoTime | null;
  coordinatorNpub: Npub;
}

export interface WhitelistEntry {
  electionId: ElectionId;
  invitedNpub: Npub;
  addedAt: IsoTime;
  inviteSentAt?: IsoTime | null;
  inviteEventId?: EventId | null;
  claimState: WhitelistClaimState;
  issuanceId?: IssuanceId | null;
  submissionId?: SubmissionId | null;
}

export interface ElectionInviteMessage {
  type: "election_invite";
  schemaVersion: 1;
  electionId: ElectionId;
  title: string;
  description: string;
  voteUrl: string;
  invitedNpub: Npub;
  coordinatorNpub: Npub;
  expiresAt?: IsoTime | null;
}

export interface LoginChallenge {
  type: "login_challenge";
  schemaVersion: 1;
  domain: string;
  electionId: ElectionId;
  npub: Npub;
  nonce: string;
  issuedAt: IsoTime;
  expiresAt: IsoTime;
}

export interface SignedLoginProof {
  type: "signed_login_proof";
  schemaVersion: 1;
  electionId: ElectionId;
  npub: Npub;
  challenge: LoginChallenge;
  signature: string;
}

export interface BlindBallotRequest {
  type: "blind_ballot_request";
  schemaVersion: 1;
  electionId: ElectionId;
  requestId: RequestId;
  invitedNpub: Npub;
  blindedMessage: string;
  clientNonce: string;
  createdAt: IsoTime;
}

export interface BlindBallotIssuance {
  type: "blind_ballot_response";
  schemaVersion: 1;
  electionId: ElectionId;
  requestId: RequestId;
  issuanceId: IssuanceId;
  invitedNpub: Npub;
  blindSignature: string;
  issuedAt: IsoTime;
}

export type QuestionnaireAnswer =
  | { questionId: string; type: "yes_no"; answer: "yes" | "no" }
  | { questionId: string; type: "multiple_choice"; answer: string[] }
  | { questionId: string; type: "text"; answer: string };

export interface QuestionnaireBallotPayload {
  electionId: ElectionId;
  responses: QuestionnaireAnswer[];
}

export interface BallotSubmission {
  type: "ballot_submission";
  schemaVersion: 1;
  electionId: ElectionId;
  submissionId: SubmissionId;
  invitedNpub: Npub;
  credential: string;
  nullifier: Nullifier;
  payload: QuestionnaireBallotPayload;
  submittedAt: IsoTime;
}

export interface BallotAcceptanceResult {
  type: "ballot_acceptance_result";
  schemaVersion: 1;
  electionId: ElectionId;
  submissionId: SubmissionId;
  accepted: boolean;
  reason?: BallotRejectReason;
  decidedAt: IsoTime;
}

export interface VoterElectionLocalState {
  electionId: ElectionId;
  invitedNpub: Npub;
  coordinatorNpub: Npub;
  loginVerified: boolean;
  loginVerifiedAt?: IsoTime | null;
  inviteMessage?: ElectionInviteMessage | null;
  blindRequest?: BlindBallotRequest | null;
  blindRequestSent: boolean;
  blindRequestSentAt?: IsoTime | null;
  blindIssuance?: BlindBallotIssuance | null;
  credentialReady: boolean;
  draftResponses: QuestionnaireAnswer[];
  submission?: BallotSubmission | null;
  submissionAccepted?: boolean | null;
  submissionAcceptedAt?: IsoTime | null;
  lastUpdatedAt: IsoTime;
}

export interface CoordinatorElectionState {
  election: ElectionSummary;
  whitelist: Record<Npub, WhitelistEntry>;
  pendingBlindRequests: Record<RequestId, BlindBallotRequest>;
  issuedBlindResponses: Record<RequestId, BlindBallotIssuance>;
  receivedSubmissions: Record<SubmissionId, BallotSubmission>;
  acceptedNullifiers: Record<Nullifier, SubmissionId>;
  acceptanceResults: Record<SubmissionId, BallotAcceptanceResult>;
  lastUpdatedAt: IsoTime;
}

export type CoordinatorEvent =
  | { type: "WHITELIST_ADDED"; entry: WhitelistEntry }
  | { type: "INVITE_SENT"; electionId: ElectionId; invitedNpub: Npub; inviteEventId: EventId; sentAt: IsoTime }
  | { type: "LOGIN_VERIFIED"; electionId: ElectionId; invitedNpub: Npub }
  | { type: "BLIND_REQUEST_RECEIVED"; request: BlindBallotRequest }
  | { type: "BLIND_SIGNATURE_ISSUED"; issuance: BlindBallotIssuance }
  | { type: "BALLOT_SUBMISSION_RECEIVED"; submission: BallotSubmission }
  | { type: "BALLOT_ACCEPTED"; result: BallotAcceptanceResult }
  | { type: "BALLOT_REJECTED"; result: BallotAcceptanceResult };

export type VoterEvent =
  | { type: "INVITE_LOADED"; invite: ElectionInviteMessage }
  | { type: "LOGIN_VERIFIED"; electionId: ElectionId; npub: Npub; verifiedAt?: IsoTime }
  | { type: "BLIND_REQUEST_CREATED"; request: BlindBallotRequest }
  | { type: "BLIND_REQUEST_SENT"; electionId: ElectionId; requestId: RequestId; sentAt: IsoTime }
  | { type: "BLIND_ISSUANCE_RECEIVED"; issuance: BlindBallotIssuance }
  | { type: "DRAFT_RESPONSES_UPDATED"; electionId: ElectionId; responses: QuestionnaireAnswer[] }
  | { type: "BALLOT_SUBMISSION_CREATED"; submission: BallotSubmission }
  | { type: "BALLOT_SUBMISSION_ACCEPTED"; submissionId: SubmissionId; decidedAt: IsoTime }
  | { type: "BALLOT_SUBMISSION_REJECTED"; submissionId: SubmissionId; reason: string; decidedAt: IsoTime };

export type ReducerResult<TState, TError extends string> = {
  state: TState;
  ok: boolean;
  error?: TError;
};

type CoordinatorReduceError =
  | "election_id_mismatch"
  | "whitelist_missing"
  | "state_transition_rejected"
  | "election_not_open"
  | "already_issued"
  | "issuance_conflict"
  | "request_missing"
  | "submission_missing"
  | "duplicate_nullifier"
  | "already_voted"
  | "not_whitelisted"
  | "issuance_missing"
  | "schema_invalid";

type VoterReduceError =
  | "invite_npub_mismatch"
  | "election_id_mismatch"
  | "login_not_verified"
  | "blind_request_missing"
  | "issuance_conflict"
  | "credential_not_ready"
  | "already_submitted"
  | "schema_invalid";

const CLAIM_STATE_ORDER: Record<WhitelistClaimState, number> = {
  whitelisted: 0,
  invited: 1,
  claimed: 2,
  blind_request_received: 3,
  blind_signature_issued: 4,
  vote_received: 5,
  vote_accepted: 6,
  vote_rejected: 6,
};

function cloneCoordinatorState(state: CoordinatorElectionState): CoordinatorElectionState {
  return {
    ...state,
    whitelist: { ...state.whitelist },
    pendingBlindRequests: { ...state.pendingBlindRequests },
    issuedBlindResponses: { ...state.issuedBlindResponses },
    receivedSubmissions: { ...state.receivedSubmissions },
    acceptedNullifiers: { ...state.acceptedNullifiers },
    acceptanceResults: { ...state.acceptanceResults },
  };
}

function cloneVoterState(state: VoterElectionLocalState): VoterElectionLocalState {
  return {
    ...state,
    draftResponses: [...state.draftResponses],
  };
}

function maxClaimState(left: WhitelistClaimState, right: WhitelistClaimState): WhitelistClaimState {
  return CLAIM_STATE_ORDER[left] >= CLAIM_STATE_ORDER[right] ? left : right;
}

function findIssuanceByNpub(
  issuedBlindResponses: Record<RequestId, BlindBallotIssuance>,
  invitedNpub: Npub,
): BlindBallotIssuance | null {
  for (const issuance of Object.values(issuedBlindResponses)) {
    if (issuance.invitedNpub === invitedNpub) {
      return issuance;
    }
  }
  return null;
}

function findAcceptedSubmissionByNpub(
  receivedSubmissions: Record<SubmissionId, BallotSubmission>,
  acceptanceResults: Record<SubmissionId, BallotAcceptanceResult>,
  invitedNpub: Npub,
): BallotSubmission | null {
  for (const [submissionId, result] of Object.entries(acceptanceResults)) {
    if (!result.accepted) {
      continue;
    }
    const submission = receivedSubmissions[submissionId];
    if (submission?.invitedNpub === invitedNpub) {
      return submission;
    }
  }
  return null;
}

function reduceCoordinatorError(
  state: CoordinatorElectionState,
  error: CoordinatorReduceError,
): ReducerResult<CoordinatorElectionState, CoordinatorReduceError> {
  return { state, ok: false, error };
}

function reduceVoterError(
  state: VoterElectionLocalState,
  error: VoterReduceError,
): ReducerResult<VoterElectionLocalState, VoterReduceError> {
  return { state, ok: false, error };
}

function validateResponsesSchema(responses: QuestionnaireAnswer[]) {
  const seen = new Set<string>();
  for (const answer of responses) {
    if (!answer.questionId.trim() || seen.has(answer.questionId)) {
      return false;
    }
    seen.add(answer.questionId);
    if (answer.type === "yes_no" && answer.answer !== "yes" && answer.answer !== "no") {
      return false;
    }
    if (answer.type === "multiple_choice") {
      if (!Array.isArray(answer.answer) || answer.answer.length === 0 || answer.answer.some((option) => !option.trim())) {
        return false;
      }
    }
    if (answer.type === "text" && typeof answer.answer !== "string") {
      return false;
    }
  }
  return true;
}

export function createEmptyVoterElectionLocalState(input: {
  electionId: ElectionId;
  invitedNpub: Npub;
  coordinatorNpub: Npub;
  now: IsoTime;
}): VoterElectionLocalState {
  return {
    electionId: input.electionId,
    invitedNpub: input.invitedNpub,
    coordinatorNpub: input.coordinatorNpub,
    loginVerified: false,
    loginVerifiedAt: null,
    inviteMessage: null,
    blindRequest: null,
    blindRequestSent: false,
    blindRequestSentAt: null,
    blindIssuance: null,
    credentialReady: false,
    draftResponses: [],
    submission: null,
    submissionAccepted: null,
    submissionAcceptedAt: null,
    lastUpdatedAt: input.now,
  };
}

export function reduceVoterEvent(
  state: VoterElectionLocalState,
  event: VoterEvent,
): ReducerResult<VoterElectionLocalState, VoterReduceError> {
  const next = cloneVoterState(state);

  if (event.type === "INVITE_LOADED") {
    if (event.invite.electionId !== next.electionId || event.invite.invitedNpub !== next.invitedNpub) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    next.inviteMessage = event.invite;
    next.lastUpdatedAt = new Date().toISOString();
    return { state: next, ok: true };
  }

  if (event.type === "LOGIN_VERIFIED") {
    if (event.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (event.npub !== next.invitedNpub) {
      return reduceVoterError(state, "invite_npub_mismatch");
    }
    next.loginVerified = true;
    next.loginVerifiedAt = event.verifiedAt ?? new Date().toISOString();
    next.lastUpdatedAt = next.loginVerifiedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_REQUEST_CREATED") {
    if (event.request.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (!next.loginVerified) {
      return reduceVoterError(state, "login_not_verified");
    }
    if (next.blindIssuance) {
      return reduceVoterError(state, "issuance_conflict");
    }
    next.blindRequest = event.request;
    next.lastUpdatedAt = new Date().toISOString();
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_REQUEST_SENT") {
    if (event.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (!next.blindRequest || next.blindRequest.requestId !== event.requestId) {
      return reduceVoterError(state, "blind_request_missing");
    }
    next.blindRequestSent = true;
    next.blindRequestSentAt = event.sentAt;
    next.lastUpdatedAt = event.sentAt;
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_ISSUANCE_RECEIVED") {
    if (event.issuance.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (!next.blindRequest || next.blindRequest.requestId !== event.issuance.requestId) {
      return reduceVoterError(state, "issuance_conflict");
    }
    if (next.blindIssuance) {
      const sameIssuance = next.blindIssuance.issuanceId === event.issuance.issuanceId
        && next.blindIssuance.blindSignature === event.issuance.blindSignature;
      if (!sameIssuance) {
        return reduceVoterError(state, "issuance_conflict");
      }
    }
    next.blindIssuance = event.issuance;
    next.credentialReady = true;
    next.lastUpdatedAt = event.issuance.issuedAt;
    return { state: next, ok: true };
  }

  if (event.type === "DRAFT_RESPONSES_UPDATED") {
    if (event.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    next.draftResponses = [...event.responses];
    next.lastUpdatedAt = new Date().toISOString();
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_CREATED") {
    if (event.submission.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (!next.credentialReady) {
      return reduceVoterError(state, "credential_not_ready");
    }
    if (next.submissionAccepted === true) {
      return reduceVoterError(state, "already_submitted");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceVoterError(state, "schema_invalid");
    }
    next.submission = event.submission;
    next.lastUpdatedAt = event.submission.submittedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_ACCEPTED") {
    if (next.submission?.submissionId !== event.submissionId) {
      return reduceVoterError(state, "schema_invalid");
    }
    next.submissionAccepted = true;
    next.submissionAcceptedAt = event.decidedAt;
    next.lastUpdatedAt = event.decidedAt;
    return { state: next, ok: true };
  }

  if (next.submission?.submissionId !== event.submissionId) {
    return reduceVoterError(state, "schema_invalid");
  }
  next.submissionAccepted = false;
  next.submissionAcceptedAt = event.decidedAt;
  next.lastUpdatedAt = event.decidedAt;
  return { state: next, ok: true };
}

export function reduceCoordinatorEvent(
  state: CoordinatorElectionState,
  event: CoordinatorEvent,
): ReducerResult<CoordinatorElectionState, CoordinatorReduceError> {
  const next = cloneCoordinatorState(state);

  if (event.type === "WHITELIST_ADDED") {
    if (event.entry.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    const existing = next.whitelist[event.entry.invitedNpub];
    if (existing) {
      return { state, ok: true };
    }
    next.whitelist[event.entry.invitedNpub] = {
      ...event.entry,
      claimState: "whitelisted",
    };
    next.lastUpdatedAt = new Date().toISOString();
    return { state: next, ok: true };
  }

  if (event.type === "INVITE_SENT") {
    if (event.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    const entry = next.whitelist[event.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "whitelist_missing");
    }
    entry.inviteEventId = event.inviteEventId;
    entry.inviteSentAt = event.sentAt;
    entry.claimState = maxClaimState(entry.claimState, "invited");
    next.lastUpdatedAt = event.sentAt;
    return { state: next, ok: true };
  }

  if (event.type === "LOGIN_VERIFIED") {
    if (event.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    const entry = next.whitelist[event.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    if (entry.claimState === "whitelisted" || entry.claimState === "invited") {
      entry.claimState = "claimed";
      next.lastUpdatedAt = new Date().toISOString();
    }
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_REQUEST_RECEIVED") {
    if (event.request.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    if (next.election.state === "closed" || next.election.state === "counted") {
      return reduceCoordinatorError(state, "election_not_open");
    }
    const entry = next.whitelist[event.request.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    if (CLAIM_STATE_ORDER[entry.claimState] < CLAIM_STATE_ORDER.claimed) {
      return reduceCoordinatorError(state, "state_transition_rejected");
    }
    const existingRequest = next.pendingBlindRequests[event.request.requestId];
    if (existingRequest) {
      const same = JSON.stringify(existingRequest) === JSON.stringify(event.request);
      return same
        ? { state, ok: true }
        : reduceCoordinatorError(state, "issuance_conflict");
    }
    const existingIssuance = findIssuanceByNpub(next.issuedBlindResponses, event.request.invitedNpub);
    if (existingIssuance) {
      return reduceCoordinatorError(state, "already_issued");
    }
    next.pendingBlindRequests[event.request.requestId] = event.request;
    entry.claimState = maxClaimState(entry.claimState, "blind_request_received");
    next.lastUpdatedAt = event.request.createdAt;
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_SIGNATURE_ISSUED") {
    if (event.issuance.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    const entry = next.whitelist[event.issuance.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    const request = next.pendingBlindRequests[event.issuance.requestId];
    if (!request) {
      return reduceCoordinatorError(state, "request_missing");
    }
    const existing = next.issuedBlindResponses[event.issuance.requestId];
    if (existing) {
      const same = existing.issuanceId === event.issuance.issuanceId
        && existing.blindSignature === event.issuance.blindSignature;
      return same
        ? { state, ok: true }
        : reduceCoordinatorError(state, "issuance_conflict");
    }
    const existingForVoter = findIssuanceByNpub(next.issuedBlindResponses, event.issuance.invitedNpub);
    if (existingForVoter) {
      return reduceCoordinatorError(state, "already_issued");
    }
    next.issuedBlindResponses[event.issuance.requestId] = event.issuance;
    entry.issuanceId = event.issuance.issuanceId;
    entry.claimState = maxClaimState(entry.claimState, "blind_signature_issued");
    next.lastUpdatedAt = event.issuance.issuedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_RECEIVED") {
    if (event.submission.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    if (next.election.state !== "open") {
      return reduceCoordinatorError(state, "election_not_open");
    }
    const entry = next.whitelist[event.submission.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    if (!findIssuanceByNpub(next.issuedBlindResponses, event.submission.invitedNpub)) {
      return reduceCoordinatorError(state, "issuance_missing");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceCoordinatorError(state, "schema_invalid");
    }
    next.receivedSubmissions[event.submission.submissionId] = event.submission;
    entry.claimState = maxClaimState(entry.claimState, "vote_received");
    next.lastUpdatedAt = event.submission.submittedAt;
    return { state: next, ok: true };
  }

  const result = event.result;
  if (result.electionId !== next.election.electionId) {
    return reduceCoordinatorError(state, "election_id_mismatch");
  }
  const submission = next.receivedSubmissions[result.submissionId];
  if (!submission) {
    return reduceCoordinatorError(state, "submission_missing");
  }
  const entry = next.whitelist[submission.invitedNpub];
  if (!entry) {
    return reduceCoordinatorError(state, "not_whitelisted");
  }

  if (event.type === "BALLOT_ACCEPTED") {
    if (next.acceptedNullifiers[submission.nullifier]) {
      return reduceCoordinatorError(state, "duplicate_nullifier");
    }
    if (findAcceptedSubmissionByNpub(next.receivedSubmissions, next.acceptanceResults, submission.invitedNpub)) {
      return reduceCoordinatorError(state, "already_voted");
    }
    next.acceptedNullifiers[submission.nullifier] = submission.submissionId;
    next.acceptanceResults[submission.submissionId] = result;
    entry.submissionId = submission.submissionId;
    entry.claimState = "vote_accepted";
    next.lastUpdatedAt = result.decidedAt;
    return { state: next, ok: true };
  }

  next.acceptanceResults[submission.submissionId] = result;
  entry.claimState = "vote_rejected";
  next.lastUpdatedAt = result.decidedAt;
  return { state: next, ok: true };
}

export function restoreCoordinatorElectionState(input: {
  persisted: CoordinatorElectionState;
  canonicalRequests?: Record<RequestId, BlindBallotRequest>;
  canonicalIssuances?: Record<RequestId, BlindBallotIssuance>;
  canonicalSubmissions?: Record<SubmissionId, BallotSubmission>;
  canonicalAcceptance?: Record<SubmissionId, BallotAcceptanceResult>;
}): CoordinatorElectionState {
  const merged = cloneCoordinatorState(input.persisted);
  merged.pendingBlindRequests = {
    ...merged.pendingBlindRequests,
    ...(input.canonicalRequests ?? {}),
  };
  merged.issuedBlindResponses = {
    ...merged.issuedBlindResponses,
    ...(input.canonicalIssuances ?? {}),
  };
  merged.receivedSubmissions = {
    ...merged.receivedSubmissions,
    ...(input.canonicalSubmissions ?? {}),
  };
  merged.acceptanceResults = {
    ...merged.acceptanceResults,
    ...(input.canonicalAcceptance ?? {}),
  };

  for (const [submissionId, result] of Object.entries(merged.acceptanceResults)) {
    if (!result.accepted) {
      continue;
    }
    const submission = merged.receivedSubmissions[submissionId];
    if (submission) {
      merged.acceptedNullifiers[submission.nullifier] = submissionId;
    }
  }

  for (const entry of Object.values(merged.whitelist)) {
    const issuance = findIssuanceByNpub(merged.issuedBlindResponses, entry.invitedNpub);
    if (issuance) {
      entry.issuanceId = issuance.issuanceId;
      entry.claimState = maxClaimState(entry.claimState, "blind_signature_issued");
    }
    const accepted = findAcceptedSubmissionByNpub(
      merged.receivedSubmissions,
      merged.acceptanceResults,
      entry.invitedNpub,
    );
    if (accepted) {
      entry.submissionId = accepted.submissionId;
      entry.claimState = "vote_accepted";
      continue;
    }
    const rejected = Object.entries(merged.acceptanceResults).find(([submissionId, result]) => {
      if (result.accepted) {
        return false;
      }
      const submission = merged.receivedSubmissions[submissionId];
      return submission?.invitedNpub === entry.invitedNpub;
    });
    if (rejected) {
      entry.claimState = maxClaimState(entry.claimState, "vote_rejected");
    }
  }

  return merged;
}

export function restoreVoterElectionLocalState(input: {
  persisted: VoterElectionLocalState;
  canonicalIssuance?: BlindBallotIssuance | null;
  canonicalAcceptance?: BallotAcceptanceResult | null;
}): VoterElectionLocalState {
  const next = cloneVoterState(input.persisted);
  const issuance = input.canonicalIssuance ?? next.blindIssuance ?? null;
  if (issuance && (!next.blindIssuance || next.blindIssuance.requestId === issuance.requestId)) {
    next.blindIssuance = issuance;
    next.credentialReady = true;
  }
  const acceptance = input.canonicalAcceptance ?? null;
  if (acceptance && next.submission?.submissionId === acceptance.submissionId) {
    next.submissionAccepted = acceptance.accepted;
    next.submissionAcceptedAt = acceptance.decidedAt;
  }
  return next;
}

export interface VoterUiFlags {
  canLogin: boolean;
  canRequestBallot: boolean;
  canSubmitVote: boolean;
  alreadySubmitted: boolean;
  resumeAvailable: boolean;
}

export interface CoordinatorUiFlags {
  canSendInvites: boolean;
  canIssueBlindResponses: boolean;
  canAcceptVotes: boolean;
  canPublishResults: boolean;
}

export function deriveVoterUiFlags(state: VoterElectionLocalState): VoterUiFlags {
  return {
    canLogin: !state.loginVerified,
    canRequestBallot: state.loginVerified && !state.credentialReady && !state.blindRequestSent,
    canSubmitVote: state.credentialReady && state.submissionAccepted !== true,
    alreadySubmitted: state.submissionAccepted === true,
    resumeAvailable: state.loginVerified || state.blindRequestSent || state.credentialReady || state.submissionAccepted !== null,
  };
}

export function deriveCoordinatorUiFlags(state: CoordinatorElectionState): CoordinatorUiFlags {
  return {
    canSendInvites:
      state.election.state === "draft"
      || state.election.state === "published"
      || state.election.state === "open",
    canIssueBlindResponses:
      state.election.state === "draft"
      || state.election.state === "published"
      || state.election.state === "open",
    canAcceptVotes: state.election.state === "open",
    canPublishResults: state.election.state === "closed" || state.election.state === "counted",
  };
}

export function buildVoterStorageKeys(input: { npub: Npub; electionId: ElectionId }) {
  const prefix = `app:auditable-voting:voter:${input.npub}:${input.electionId}`;
  return {
    invite: `${prefix}:invite`,
    login: `${prefix}:login`,
    blindRequest: `${prefix}:blindRequest`,
    issuance: `${prefix}:issuance`,
    draftResponses: `${prefix}:draftResponses`,
    submission: `${prefix}:submission`,
    acceptance: `${prefix}:acceptance`,
  };
}

export function buildCoordinatorStorageKeys(input: { npub: Npub; electionId: ElectionId }) {
  const prefix = `app:auditable-voting:coordinator:${input.npub}:${input.electionId}`;
  return {
    election: `${prefix}:election`,
    whitelist: `${prefix}:whitelist`,
    requests: `${prefix}:requests`,
    issuances: `${prefix}:issuances`,
    submissions: `${prefix}:submissions`,
    acceptance: `${prefix}:acceptance`,
  };
}

export interface SignerService {
  getPublicKey(): Promise<Npub>;
  signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
  signMessage(message: string): Promise<string>;
}

export interface InviteService {
  sendElectionInvite(recipientNpub: Npub, invite: ElectionInviteMessage): Promise<{ eventId: EventId }>;
}

export interface BlindIssuanceService {
  verifyLoginProof(proof: SignedLoginProof): Promise<boolean>;
  issueBlindSignature(request: BlindBallotRequest, proof: SignedLoginProof): Promise<BlindBallotIssuance>;
}

export interface VoteAcceptanceService {
  validateSubmission(submission: BallotSubmission): Promise<boolean>;
  acceptOrRejectSubmission(submission: BallotSubmission): Promise<BallotAcceptanceResult>;
}

function parseIso(value: string) {
  return Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.NaN;
}

export function validateLoginProof(input: {
  proof: SignedLoginProof;
  expectedDomain: string;
  expectedElectionId: ElectionId;
  nonceAlreadyUsed: boolean;
  nowIso: IsoTime;
  verifySignature: (message: string, signature: string, npub: Npub) => boolean;
}) {
  const { proof } = input;
  if (proof.challenge.domain !== input.expectedDomain) {
    return false;
  }
  if (proof.electionId !== input.expectedElectionId || proof.challenge.electionId !== input.expectedElectionId) {
    return false;
  }
  if (proof.npub !== proof.challenge.npub) {
    return false;
  }
  if (parseIso(proof.challenge.expiresAt) <= parseIso(input.nowIso)) {
    return false;
  }
  if (input.nonceAlreadyUsed) {
    return false;
  }
  return input.verifySignature(JSON.stringify(proof.challenge), proof.signature, proof.npub);
}

export function validateBlindBallotRequest(input: {
  request: BlindBallotRequest;
  electionState: ElectionState;
  isWhitelisted: boolean;
  loginVerified: boolean;
  requestSeen: boolean;
}) {
  if (input.electionState !== "open") {
    return false;
  }
  if (!input.isWhitelisted || !input.loginVerified) {
    return false;
  }
  if (!input.requestSeen && !input.request.blindedMessage.trim()) {
    return false;
  }
  return true;
}

export function validateBallotSubmission(input: {
  submission: BallotSubmission;
  electionId: ElectionId;
  electionState: ElectionState;
  requiredQuestionIds: string[];
}) {
  if (input.submission.electionId !== input.electionId || input.submission.payload.electionId !== input.electionId) {
    return false;
  }
  if (input.electionState !== "open") {
    return false;
  }
  if (!input.submission.credential.trim() || !input.submission.nullifier.trim()) {
    return false;
  }
  if (!validateResponsesSchema(input.submission.payload.responses)) {
    return false;
  }
  const answered = new Set(input.submission.payload.responses.map((entry) => entry.questionId));
  return input.requiredQuestionIds.every((questionId) => answered.has(questionId));
}

export function countAcceptedUniqueVoters(state: CoordinatorElectionState) {
  return Object.values(state.whitelist)
    .filter((entry) => entry.claimState === "vote_accepted")
    .length;
}
