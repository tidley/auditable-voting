import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import type { QuestionnaireBlindPrivateKey, QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import type { QuestionnaireFlowMode, QuestionnaireResponseMode } from "./questionnaireProtocolConstants";

export type ElectionId = string;
export type Npub = string;
export type Hex = string;
export type IsoTime = string;
export type RequestId = string;
export type IssuanceId = string;
export type SubmissionId = string;
export type Nullifier = string;
export type EventId = string;

export interface BallotScope {
  questionId?: string | null;
  slotId?: string | null;
  slotIndex?: number | null;
  version?: number | null;
}

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
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  questionnaireRelays?: string[];
  issueBlindTokensWorker?: IssueBlindTokensWorkerRouting | null;
  protocolVersion?: 1 | 2;
  flowMode?: QuestionnaireFlowMode;
  responseMode?: QuestionnaireResponseMode;
}

export interface IssueBlindTokensWorkerRouting {
  delegationId: string;
  workerNpub: Npub;
  controlRelays?: string[];
  expiresAt?: IsoTime | null;
}

export interface WhitelistEntry {
  electionId: ElectionId;
  invitedNpub: Npub;
  addedAt: IsoTime;
  inviteSentAt?: IsoTime | null;
  inviteEventId?: EventId | null;
  inviteCodeHash?: Hex | null;
  inviteCodeRedeemedAt?: IsoTime | null;
  claimState: WhitelistClaimState;
  issuanceId?: IssuanceId | null;
  submissionId?: SubmissionId | null;
}

export type BearerInviteCodeState = "available" | "redeemed" | "revoked";

export interface BearerInviteCodeEntry {
  electionId: ElectionId;
  codeHash: Hex;
  createdAt: IsoTime;
  state: BearerInviteCodeState;
  note?: string | null;
  autoRequestBallot?: boolean;
  markedUsedAt?: IsoTime | null;
  redeemedAt?: IsoTime | null;
  redeemedNpub?: Npub | null;
  revokedAt?: IsoTime | null;
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
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  issueBlindTokensWorker?: IssueBlindTokensWorkerRouting | null;
  definition?: QuestionnaireDefinition | null;
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
  tokenCommitment: string;
  blindSigningKeyId: string;
  clientNonce: string;
  createdAt: IsoTime;
  inviteCodeHash?: Hex | null;
  ballotScope?: BallotScope | null;
  lastSentAt?: IsoTime | null;
}

export interface BlindBallotIssuance {
  type: "blind_ballot_response";
  schemaVersion: 1;
  electionId: ElectionId;
  requestId: RequestId;
  issuanceId: IssuanceId;
  invitedNpub: Npub;
  tokenCommitment: string;
  blindSigningKeyId: string;
  blindSignature: string;
  ballotScope?: BallotScope | null;
  definition?: QuestionnaireDefinition | null;
  issuedAt: IsoTime;
}

export type QuestionnaireAnswer =
  | { questionId: string; type: "yes_no"; answer: "yes" | "no" }
  | { questionId: string; type: "multiple_choice"; answer: string[] }
  | { questionId: string; type: "rank"; answer: string[] }
  | { questionId: string; type: "text"; answer: string; encryptForCoordinator?: boolean };

export interface QuestionnaireBallotPayload {
  electionId: ElectionId;
  responses: QuestionnaireAnswer[];
}

export interface BallotCredentialProof {
  questionId?: string | null;
  tokenCommitment: string;
  blindSigningKeyId: string;
  credential: string;
  nullifier: Nullifier;
  ballotScope?: BallotScope | null;
}

export interface BallotSubmission {
  type: "ballot_submission";
  schemaVersion: 1;
  electionId: ElectionId;
  submissionId: SubmissionId;
  invitedNpub: Npub;
  responseNpub?: Npub;
  tokenCommitment: string;
  blindSigningKeyId: string;
  credential: string;
  nullifier: Nullifier;
  credentialBundle?: BallotCredentialProof[];
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
  blindRequests?: Record<string, BlindBallotRequest>;
  blindIssuances?: Record<string, BlindBallotIssuance>;
  credentialReady: boolean;
  blindTokenSecret?: {
    tokenSecret: string;
    tokenCommitment: string;
    blindingFactor: string;
    blindSigningPublicKey: QuestionnaireBlindPublicKey;
    ballotScope?: BallotScope | null;
  } | null;
  blindTokenSecrets?: Record<string, {
    tokenSecret: string;
    tokenCommitment: string;
    blindingFactor: string;
    blindSigningPublicKey: QuestionnaireBlindPublicKey;
    ballotScope?: BallotScope | null;
  }>;
  responseNsec?: string | null;
  responseNpub?: string | null;
  draftResponses: QuestionnaireAnswer[];
  submission?: BallotSubmission | null;
  submissions?: Record<string, BallotSubmission>;
  submissionAccepted?: boolean | null;
  submissionAcceptedAt?: IsoTime | null;
  submissionDecisions?: Record<string, {
    submissionId: SubmissionId;
    accepted: boolean;
    decidedAt: IsoTime;
    reason?: string | null;
  }>;
  lastUpdatedAt: IsoTime;
}

export interface CoordinatorElectionState {
  election: ElectionSummary;
  whitelist: Record<Npub, WhitelistEntry>;
  bearerInviteCodes: Record<Hex, BearerInviteCodeEntry>;
  pendingBlindRequests: Record<RequestId, BlindBallotRequest>;
  issuedBlindResponses: Record<RequestId, BlindBallotIssuance>;
  receivedSubmissions: Record<SubmissionId, BallotSubmission>;
  acceptedNullifiers: Record<Nullifier, SubmissionId>;
  acceptanceResults: Record<SubmissionId, BallotAcceptanceResult>;
  blindSigningPrivateKey?: QuestionnaireBlindPrivateKey | null;
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
  | "invalid_credential"
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
    bearerInviteCodes: { ...(state.bearerInviteCodes ?? {}) },
    pendingBlindRequests: { ...state.pendingBlindRequests },
    issuedBlindResponses: { ...state.issuedBlindResponses },
    receivedSubmissions: { ...state.receivedSubmissions },
    acceptedNullifiers: { ...state.acceptedNullifiers },
    acceptanceResults: { ...state.acceptanceResults },
    blindSigningPrivateKey: state.blindSigningPrivateKey ?? null,
  };
}

function cloneVoterState(state: VoterElectionLocalState): VoterElectionLocalState {
  return {
    ...state,
    blindTokenSecret: state.blindTokenSecret ? { ...state.blindTokenSecret } : null,
    blindRequests: { ...(state.blindRequests ?? {}) },
    blindIssuances: { ...(state.blindIssuances ?? {}) },
    blindTokenSecrets: { ...(state.blindTokenSecrets ?? {}) },
    submissions: { ...(state.submissions ?? {}) },
    submissionDecisions: { ...(state.submissionDecisions ?? {}) },
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

function ballotScopeKey(scope: BallotScope | null | undefined) {
  const questionId = scope?.questionId?.trim() ?? "";
  const slotId = scope?.slotId?.trim() ?? "";
  const version = Number.isFinite(scope?.version) ? Math.max(1, Math.floor(scope?.version as number)) : 0;
  const slotIndex = Number.isFinite(scope?.slotIndex) ? Math.max(1, Math.floor(scope?.slotIndex as number)) : 0;
  if (!questionId && !slotId && !version && !slotIndex) {
    return "__questionnaire__";
  }
  return `${questionId || slotId}:${slotId}:${slotIndex}:v${version || 1}`;
}

function sameBallotScope(left: BallotScope | null | undefined, right: BallotScope | null | undefined) {
  return ballotScopeKey(left) === ballotScopeKey(right);
}

function findIssuanceByNpubAndScope(
  issuedBlindResponses: Record<RequestId, BlindBallotIssuance>,
  invitedNpub: Npub,
  scope: BallotScope | null | undefined,
): BlindBallotIssuance | null {
  for (const issuance of Object.values(issuedBlindResponses)) {
    if (issuance.invitedNpub === invitedNpub && sameBallotScope(issuance.ballotScope, scope)) {
      return issuance;
    }
  }
  return null;
}

function sameBlindBallotRequest(left: BlindBallotRequest, right: BlindBallotRequest) {
  return left.type === right.type
    && left.schemaVersion === right.schemaVersion
    && left.electionId === right.electionId
    && left.requestId === right.requestId
    && left.invitedNpub === right.invitedNpub
    && left.blindedMessage === right.blindedMessage
    && left.tokenCommitment === right.tokenCommitment
    && left.blindSigningKeyId === right.blindSigningKeyId
    && left.clientNonce === right.clientNonce
    && left.createdAt === right.createdAt
    && (left.inviteCodeHash ?? null) === (right.inviteCodeHash ?? null)
    && sameBallotScope(left.ballotScope, right.ballotScope);
}

function findIssuanceByTokenCommitment(
  issuedBlindResponses: Record<RequestId, BlindBallotIssuance>,
  tokenCommitment: string,
): BlindBallotIssuance | null {
  for (const issuance of Object.values(issuedBlindResponses)) {
    if (issuance.tokenCommitment === tokenCommitment) {
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

function submissionCredentialBundle(submission: BallotSubmission): BallotCredentialProof[] {
  if (Array.isArray(submission.credentialBundle) && submission.credentialBundle.length > 0) {
    return submission.credentialBundle;
  }
  return [{
    tokenCommitment: submission.tokenCommitment,
    blindSigningKeyId: submission.blindSigningKeyId,
    credential: submission.credential,
    nullifier: submission.nullifier,
    ballotScope: null,
  }];
}

function ballotCredentialProofQuestionId(proof: BallotCredentialProof) {
  return proof.questionId?.trim() || proof.ballotScope?.questionId?.trim() || "";
}

function ballotSubmissionQuestionKey(submission: BallotSubmission): string {
  const proofQuestionId = submission.credentialBundle?.[0]
    ? ballotCredentialProofQuestionId(submission.credentialBundle[0])
    : "";
  if (proofQuestionId && submission.payload.responses.length === 1) {
    return proofQuestionId;
  }
  return "";
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
    if (answer.type === "rank") {
      if (!Array.isArray(answer.answer) || answer.answer.length === 0 || answer.answer.some((option) => !option.trim())) {
        return false;
      }
      if (new Set(answer.answer).size !== answer.answer.length) {
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
    blindRequests: {},
    blindIssuances: {},
    credentialReady: false,
    blindTokenSecret: null,
    blindTokenSecrets: {},
    responseNsec: null,
    responseNpub: null,
    draftResponses: [],
    submission: null,
    submissions: {},
    submissionAccepted: null,
    submissionAcceptedAt: null,
    submissionDecisions: {},
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
    const scopeKey = ballotScopeKey(event.request.ballotScope);
    if (
      next.blindIssuances?.[scopeKey]
      || (next.blindIssuance && sameBallotScope(next.blindIssuance.ballotScope, event.request.ballotScope))
    ) {
      return reduceVoterError(state, "issuance_conflict");
    }
    const existingScopedRequest = next.blindRequests?.[scopeKey] ?? null;
    if (existingScopedRequest) {
      const sameRequest = sameBlindBallotRequest(existingScopedRequest, event.request);
      if (sameRequest && existingScopedRequest.lastSentAt !== event.request.lastSentAt) {
        const updatedRequest = {
          ...existingScopedRequest,
          lastSentAt: event.request.lastSentAt ?? existingScopedRequest.lastSentAt ?? null,
        };
        next.blindRequests = {
          ...(next.blindRequests ?? {}),
          [scopeKey]: updatedRequest,
        };
        if (next.blindRequest?.requestId === updatedRequest.requestId) {
          next.blindRequest = updatedRequest;
        }
      }
      return sameRequest
        ? { state: next, ok: true }
        : reduceVoterError(state, "issuance_conflict");
    }
    if (next.blindRequest && ballotScopeKey(next.blindRequest.ballotScope) === "__questionnaire__") {
      const sameRequest = sameBlindBallotRequest(next.blindRequest, event.request);
      return sameRequest
        ? { state: next, ok: true }
        : reduceVoterError(state, "issuance_conflict");
    }
    next.blindRequest = next.blindRequest ?? event.request;
    next.blindRequests = {
      ...(next.blindRequests ?? {}),
      [scopeKey]: event.request,
    };
    next.lastUpdatedAt = new Date().toISOString();
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_REQUEST_SENT") {
    if (event.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    const scopedRequestEntry = Object.entries(next.blindRequests ?? {})
      .find(([, request]) => request.requestId === event.requestId) ?? null;
    const scopedRequestKey = scopedRequestEntry?.[0] ?? "";
    const scopedRequest = scopedRequestEntry?.[1] ?? null;
    if ((!next.blindRequest || next.blindRequest.requestId !== event.requestId) && !scopedRequest) {
      return reduceVoterError(state, "blind_request_missing");
    }
    const updatedRequest = {
      ...(scopedRequest ?? next.blindRequest!),
      lastSentAt: event.sentAt,
    };
    next.blindRequests = {
      ...(next.blindRequests ?? {}),
      [scopedRequestKey || ballotScopeKey(updatedRequest.ballotScope)]: updatedRequest,
    };
    if (!next.blindRequest || next.blindRequest.requestId === event.requestId) {
      next.blindRequest = updatedRequest;
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
    const issuanceScopeKey = ballotScopeKey(event.issuance.ballotScope);
    const scopedRequest = next.blindRequests?.[issuanceScopeKey] ?? null;
    if (
      (!next.blindRequest || next.blindRequest.requestId !== event.issuance.requestId)
      && (!scopedRequest || scopedRequest.requestId !== event.issuance.requestId)
    ) {
      return reduceVoterError(state, "issuance_conflict");
    }
    const existingScopedIssuance = next.blindIssuances?.[issuanceScopeKey] ?? null;
    if (existingScopedIssuance) {
      const sameIssuance = existingScopedIssuance.issuanceId === event.issuance.issuanceId
        && existingScopedIssuance.blindSignature === event.issuance.blindSignature;
      if (!sameIssuance) {
        return reduceVoterError(state, "issuance_conflict");
      }
    }
    if (next.blindIssuance && sameBallotScope(next.blindIssuance.ballotScope, event.issuance.ballotScope)) {
      const sameIssuance = next.blindIssuance.issuanceId === event.issuance.issuanceId
        && next.blindIssuance.blindSignature === event.issuance.blindSignature;
      if (!sameIssuance) {
        return reduceVoterError(state, "issuance_conflict");
      }
    }
    next.blindIssuance = next.blindIssuance ?? event.issuance;
    next.blindIssuances = {
      ...(next.blindIssuances ?? {}),
      [issuanceScopeKey]: event.issuance,
    };
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
    const questionKey = ballotSubmissionQuestionKey(event.submission);
    const existingQuestionDecision = questionKey ? next.submissionDecisions?.[questionKey] : null;
    if ((!questionKey && next.submissionAccepted === true) || existingQuestionDecision?.accepted === true) {
      return reduceVoterError(state, "already_submitted");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceVoterError(state, "schema_invalid");
    }
    next.submission = event.submission;
    if (questionKey) {
      next.submissions = {
        ...(next.submissions ?? {}),
        [questionKey]: event.submission,
      };
    }
    next.responseNpub = event.submission.responseNpub ?? event.submission.invitedNpub;
    next.lastUpdatedAt = event.submission.submittedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_ACCEPTED") {
    const questionEntry = Object.entries(next.submissions ?? {})
      .find(([, submission]) => submission.submissionId === event.submissionId) ?? null;
    if (next.submission?.submissionId !== event.submissionId && !questionEntry) {
      return reduceVoterError(state, "schema_invalid");
    }
    if (questionEntry) {
      next.submissionDecisions = {
        ...(next.submissionDecisions ?? {}),
        [questionEntry[0]]: {
          submissionId: event.submissionId,
          accepted: true,
          decidedAt: event.decidedAt,
          reason: null,
        },
      };
    } else {
      next.submissionAccepted = true;
      next.submissionAcceptedAt = event.decidedAt;
    }
    next.lastUpdatedAt = event.decidedAt;
    return { state: next, ok: true };
  }

  const questionEntry = Object.entries(next.submissions ?? {})
    .find(([, submission]) => submission.submissionId === event.submissionId) ?? null;
  if (next.submission?.submissionId !== event.submissionId && !questionEntry) {
    return reduceVoterError(state, "schema_invalid");
  }
  if (questionEntry) {
    next.submissionDecisions = {
      ...(next.submissionDecisions ?? {}),
      [questionEntry[0]]: {
        submissionId: event.submissionId,
        accepted: false,
        decidedAt: event.decidedAt,
        reason: event.reason,
      },
    };
  } else {
    next.submissionAccepted = false;
    next.submissionAcceptedAt = event.decidedAt;
  }
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
      const same = sameBlindBallotRequest(existingRequest, event.request);
      if (!same) {
        return reduceCoordinatorError(state, "issuance_conflict");
      }
      next.pendingBlindRequests[event.request.requestId] = {
        ...existingRequest,
        lastSentAt: event.request.lastSentAt ?? existingRequest.lastSentAt ?? null,
      };
      next.lastUpdatedAt = event.request.lastSentAt ?? event.request.createdAt;
      return { state: next, ok: true };
    }
    const existingIssuance = findIssuanceByNpubAndScope(
      next.issuedBlindResponses,
      event.request.invitedNpub,
      event.request.ballotScope,
    );
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
    if (
      request.tokenCommitment !== event.issuance.tokenCommitment
      || request.blindSigningKeyId !== event.issuance.blindSigningKeyId
    ) {
      return reduceCoordinatorError(state, "issuance_conflict");
    }
    const existing = next.issuedBlindResponses[event.issuance.requestId];
    if (existing) {
      const same = existing.issuanceId === event.issuance.issuanceId
        && existing.blindSignature === event.issuance.blindSignature;
      return same
        ? { state, ok: true }
        : reduceCoordinatorError(state, "issuance_conflict");
    }
    const existingForVoter = findIssuanceByNpubAndScope(
      next.issuedBlindResponses,
      event.issuance.invitedNpub,
      event.issuance.ballotScope,
    );
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
    const issuance = findIssuanceByTokenCommitment(next.issuedBlindResponses, event.submission.tokenCommitment);
    if (!issuance) {
      return reduceCoordinatorError(state, "issuance_missing");
    }
    if (issuance.blindSigningKeyId !== event.submission.blindSigningKeyId) {
      return reduceCoordinatorError(state, "invalid_credential");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceCoordinatorError(state, "schema_invalid");
    }
    for (const proof of submissionCredentialBundle(event.submission)) {
      const issuance = findIssuanceByTokenCommitment(next.issuedBlindResponses, proof.tokenCommitment);
      if (!issuance) {
        return reduceCoordinatorError(state, "issuance_missing");
      }
      if (
        issuance.blindSigningKeyId !== proof.blindSigningKeyId
        || !sameBallotScope(issuance.ballotScope, proof.ballotScope)
      ) {
        return reduceCoordinatorError(state, "invalid_credential");
      }
    }
    next.receivedSubmissions[event.submission.submissionId] = event.submission;
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
  const issuedForSubmission = findIssuanceByTokenCommitment(next.issuedBlindResponses, submission.tokenCommitment);
  const entry = issuedForSubmission ? next.whitelist[issuedForSubmission.invitedNpub] : null;

  if (event.type === "BALLOT_ACCEPTED") {
    const existingAcceptance = next.acceptanceResults[submission.submissionId];
    if (existingAcceptance?.accepted === true) {
      return { state, ok: true };
    }
    for (const proof of submissionCredentialBundle(submission)) {
      const acceptedSubmissionId = next.acceptedNullifiers[proof.nullifier];
      if (acceptedSubmissionId && acceptedSubmissionId !== submission.submissionId) {
        return reduceCoordinatorError(state, "duplicate_nullifier");
      }
    }
    const acceptedForToken = Object.entries(next.acceptanceResults).find(([submissionId, acceptedResult]) => {
      if (!acceptedResult.accepted || submissionId === submission.submissionId) {
        return false;
      }
      const existingSubmission = next.receivedSubmissions[submissionId];
      if (!existingSubmission) {
        return false;
      }
      const existingProofs = submissionCredentialBundle(existingSubmission);
      return submissionCredentialBundle(submission).some((proof) => existingProofs.some((existingProof) => (
        existingProof.tokenCommitment === proof.tokenCommitment
        && sameBallotScope(existingProof.ballotScope, proof.ballotScope)
      )));
    });
    if (acceptedForToken) {
      return reduceCoordinatorError(state, "already_voted");
    }
    for (const proof of submissionCredentialBundle(submission)) {
      next.acceptedNullifiers[proof.nullifier] = submission.submissionId;
    }
    next.acceptanceResults[submission.submissionId] = result;
    if (entry) {
      entry.submissionId = submission.submissionId;
      entry.claimState = "vote_accepted";
    }
    next.lastUpdatedAt = result.decidedAt;
    return { state: next, ok: true };
  }

  next.acceptanceResults[submission.submissionId] = result;
  if (entry) {
    entry.claimState = "vote_rejected";
  }
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
      for (const proof of submissionCredentialBundle(submission)) {
        merged.acceptedNullifiers[proof.nullifier] = submissionId;
      }
    }
  }

  for (const request of Object.values(merged.pendingBlindRequests)) {
    const entry = merged.whitelist[request.invitedNpub];
    if (entry) {
      entry.claimState = maxClaimState(entry.claimState, "blind_request_received");
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
    bearerInviteCodes: `${prefix}:bearerInviteCodes`,
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
  if (!input.submission.tokenCommitment.trim() || !input.submission.blindSigningKeyId.trim()) {
    return false;
  }
  if (!validateResponsesSchema(input.submission.payload.responses)) {
    return false;
  }
  const answered = new Set(input.submission.payload.responses.map((entry) => entry.questionId));
  if (!input.requiredQuestionIds.every((questionId) => answered.has(questionId))) {
    return false;
  }
  if (Array.isArray(input.submission.credentialBundle) && input.submission.credentialBundle.length > 0) {
    const proofQuestionIds = new Set(
      input.submission.credentialBundle
        .map((proof) => ballotCredentialProofQuestionId(proof))
        .filter(Boolean),
    );
    if (
      proofQuestionIds.size > 0
      && (
        [...answered].some((questionId) => !proofQuestionIds.has(questionId))
        || [...proofQuestionIds].some((questionId) => !answered.has(questionId))
      )
    ) {
      return false;
    }
    if (!input.requiredQuestionIds.every((questionId) => proofQuestionIds.has(questionId))) {
      return false;
    }
    const seenNullifiers = new Set<string>();
    for (const proof of input.submission.credentialBundle) {
      if (
        !proof.tokenCommitment.trim()
        || !proof.blindSigningKeyId.trim()
        || !proof.credential.trim()
        || !proof.nullifier.trim()
        || seenNullifiers.has(proof.nullifier)
      ) {
        return false;
      }
      seenNullifiers.add(proof.nullifier);
    }
  }
  return true;
}

export function countAcceptedUniqueVoters(state: CoordinatorElectionState) {
  return Object.values(state.acceptanceResults)
    .filter((entry) => entry.accepted)
    .length;
}
