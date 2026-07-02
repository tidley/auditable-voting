import {
  questionBallotScopeKey,
  type QuestionnaireCredentialsPerVoter,
  questionnaireUsesPerQuestionCredentials,
  type QuestionnaireDefinition,
  type QuestionnaireDefinitionReference,
} from "./questionnaireProtocol";
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
  credentialIndex?: number | null;
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
  definitionCreatedAt?: number;
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
  dmRelays?: string[];
  expiresAt?: IsoTime | null;
}

export interface WhitelistEntry {
  electionId: ElectionId;
  invitedNpub: Npub;
  addedAt: IsoTime;
  credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
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
  credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
  definitionReference?: QuestionnaireDefinitionReference | null;
  /**
   * Legacy invites embedded enough round data for offline bootstrap. New invites carry
   * only definitionReference and resolve the definition from public questionnaire events.
   */
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
  blindSigningKeyId: string;
  blindSignature: string;
  definitionHash?: Hex | null;
  definitionEventId?: EventId | null;
  ballotScope?: BallotScope | null;
  /** Legacy issuances embedded the definition directly. New issuances carry a definition hash/reference. */
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
    pendingBlindRequests: sanitiseBlindBallotRequestRecord(state.pendingBlindRequests),
    issuedBlindResponses: sanitiseBlindBallotIssuanceRecord(state.issuedBlindResponses),
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
    blindRequest: state.blindRequest ? sanitiseBlindBallotRequest(state.blindRequest) : null,
    blindIssuance: state.blindIssuance ? sanitiseBlindBallotIssuance(state.blindIssuance) : null,
    blindRequests: sanitiseBlindBallotRequestRecordPreservingKeys(state.blindRequests ?? {}),
    blindIssuances: sanitiseBlindBallotIssuanceRecordPreservingKeys(state.blindIssuances ?? {}),
    blindTokenSecrets: { ...(state.blindTokenSecrets ?? {}) },
    submissions: { ...(state.submissions ?? {}) },
    submissionDecisions: { ...(state.submissionDecisions ?? {}) },
    draftResponses: [...state.draftResponses],
  };
}

function maxClaimState(left: WhitelistClaimState, right: WhitelistClaimState): WhitelistClaimState {
  return CLAIM_STATE_ORDER[left] >= CLAIM_STATE_ORDER[right] ? left : right;
}

function sanitiseBallotScope(scope: BallotScope | null | undefined): BallotScope | null {
  if (!scope || typeof scope !== "object") {
    return null;
  }
  const next: BallotScope = {};
  if (typeof scope.questionId === "string") {
    next.questionId = scope.questionId;
  } else if (scope.questionId === null) {
    next.questionId = null;
  }
  if (typeof scope.slotId === "string") {
    next.slotId = scope.slotId;
  } else if (scope.slotId === null) {
    next.slotId = null;
  }
  if (typeof scope.slotIndex === "number" && Number.isFinite(scope.slotIndex)) {
    next.slotIndex = Math.max(1, Math.floor(scope.slotIndex));
  } else if (scope.slotIndex === null) {
    next.slotIndex = null;
  }
  if (typeof scope.version === "number" && Number.isFinite(scope.version)) {
    next.version = Math.max(1, Math.floor(scope.version));
  } else if (scope.version === null) {
    next.version = null;
  }
  if (typeof scope.credentialIndex === "number" && Number.isFinite(scope.credentialIndex)) {
    const credentialIndex = Math.max(1, Math.floor(scope.credentialIndex));
    if (credentialIndex > 1) {
      next.credentialIndex = credentialIndex;
    }
  } else if (scope.credentialIndex === null) {
    next.credentialIndex = null;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function sanitiseBlindBallotRequest(request: BlindBallotRequest): BlindBallotRequest {
  const next: BlindBallotRequest = {
    type: "blind_ballot_request",
    schemaVersion: 1,
    electionId: request.electionId,
    requestId: request.requestId,
    invitedNpub: request.invitedNpub,
    blindedMessage: request.blindedMessage,
    blindSigningKeyId: request.blindSigningKeyId,
    clientNonce: request.clientNonce,
    createdAt: request.createdAt,
  };
  if (request.inviteCodeHash !== undefined) {
    next.inviteCodeHash = request.inviteCodeHash ?? null;
  }
  if (request.ballotScope !== undefined) {
    next.ballotScope = sanitiseBallotScope(request.ballotScope);
  }
  if (request.lastSentAt !== undefined) {
    next.lastSentAt = request.lastSentAt ?? null;
  }
  return next;
}

export function sanitiseBlindBallotIssuance(issuance: BlindBallotIssuance): BlindBallotIssuance {
  const next: BlindBallotIssuance = {
    type: "blind_ballot_response",
    schemaVersion: 1,
    electionId: issuance.electionId,
    requestId: issuance.requestId,
    issuanceId: issuance.issuanceId,
    invitedNpub: issuance.invitedNpub,
    blindSigningKeyId: issuance.blindSigningKeyId,
    blindSignature: issuance.blindSignature,
    issuedAt: issuance.issuedAt,
  };
  if (issuance.definitionHash !== undefined) {
    next.definitionHash = issuance.definitionHash ?? null;
  }
  if (issuance.definitionEventId !== undefined) {
    next.definitionEventId = issuance.definitionEventId ?? null;
  }
  if (issuance.ballotScope !== undefined) {
    next.ballotScope = sanitiseBallotScope(issuance.ballotScope);
  }
  if (issuance.definition !== undefined) {
    next.definition = issuance.definition ?? null;
  }
  return next;
}

function sanitiseBlindBallotRequestRecord(
  requests: Record<RequestId, BlindBallotRequest>,
): Record<RequestId, BlindBallotRequest> {
  const next: Record<RequestId, BlindBallotRequest> = {};
  for (const request of Object.values(requests ?? {})) {
    const sanitised = sanitiseBlindBallotRequest(request);
    next[sanitised.requestId] = sanitised;
  }
  return next;
}

function sanitiseBlindBallotRequestRecordPreservingKeys(
  requests: Record<string, BlindBallotRequest>,
): Record<string, BlindBallotRequest> {
  const next: Record<string, BlindBallotRequest> = {};
  for (const [key, request] of Object.entries(requests ?? {})) {
    next[key] = sanitiseBlindBallotRequest(request);
  }
  return next;
}

function sanitiseBlindBallotIssuanceRecord(
  issuances: Record<RequestId, BlindBallotIssuance>,
): Record<RequestId, BlindBallotIssuance> {
  const next: Record<RequestId, BlindBallotIssuance> = {};
  for (const issuance of Object.values(issuances ?? {})) {
    const sanitised = sanitiseBlindBallotIssuance(issuance);
    next[sanitised.requestId] = sanitised;
  }
  return next;
}

function sanitiseBlindBallotIssuanceRecordPreservingKeys(
  issuances: Record<string, BlindBallotIssuance>,
): Record<string, BlindBallotIssuance> {
  const next: Record<string, BlindBallotIssuance> = {};
  for (const [key, issuance] of Object.entries(issuances ?? {})) {
    next[key] = sanitiseBlindBallotIssuance(issuance);
  }
  return next;
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
  const credentialIndex = Number.isFinite(scope?.credentialIndex) ? Math.max(1, Math.floor(scope?.credentialIndex as number)) : 1;
  const credentialSuffix = credentialIndex > 1 ? `:c${credentialIndex}` : "";
  if (!questionId && !slotId && !version && !slotIndex && credentialIndex <= 1) {
    return "__questionnaire__";
  }
  if (slotIndex > 0) {
    return `slot:${slotIndex}:v${version || 1}${credentialSuffix}`;
  }
  return `${questionId || slotId}:${slotId}:${slotIndex}:v${version || 1}${credentialSuffix}`;
}

function sameBallotScope(left: BallotScope | null | undefined, right: BallotScope | null | undefined) {
  return ballotScopeKey(left) === ballotScopeKey(right);
}

function ballotScopeBaseKey(scope: BallotScope | null | undefined) {
  return ballotScopeKey(scope ? { ...scope, credentialIndex: null } : scope);
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

function findPendingBlindRequestByNpubAndScope(
  pendingBlindRequests: Record<RequestId, BlindBallotRequest>,
  invitedNpub: Npub,
  scope: BallotScope | null | undefined,
): BlindBallotRequest | null {
  for (const request of Object.values(pendingBlindRequests)) {
    if (request.invitedNpub === invitedNpub && sameBallotScope(request.ballotScope, scope)) {
      return request;
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
    && left.blindSigningKeyId === right.blindSigningKeyId
    && left.clientNonce === right.clientNonce
    && left.createdAt === right.createdAt
    && (left.inviteCodeHash ?? null) === (right.inviteCodeHash ?? null)
    && sameBallotScope(left.ballotScope, right.ballotScope);
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

function ballotSubmissionQuestionKeys(submission: BallotSubmission): string[] {
  const scopedProofs = submissionCredentialBundle(submission).filter((proof) => proof.ballotScope);
  if (scopedProofs.length > 0) {
    return [...new Set([
      ...submission.payload.responses
        .map((entry) => entry.questionId.trim())
        .filter(Boolean),
      ...scopedProofs.map((proof) => ballotScopeKey(proof.ballotScope)),
    ])];
  }
  if (!Array.isArray(submission.credentialBundle) || submission.credentialBundle.length === 0) {
    return [];
  }
  return [...new Set(
    submission.payload.responses
      .map((entry) => entry.questionId.trim())
      .filter(Boolean),
  )];
}

function ballotSubmissionDuplicateKeys(submission: BallotSubmission): string[] {
  const scopedProofs = submissionCredentialBundle(submission).filter((proof) => proof.ballotScope);
  if (scopedProofs.length > 0) {
    return [...new Set(scopedProofs.map((proof) => ballotScopeKey(proof.ballotScope)))];
  }
  return ballotSubmissionQuestionKeys(submission);
}

function answeredQuestionsMatchCredentialScopes(
  definition: QuestionnaireDefinition | null | undefined,
  submission: BallotSubmission,
) {
  if (!definition || !questionnaireUsesPerQuestionCredentials(definition)) {
    return true;
  }
  const proofScopeKeys = new Set(
    submissionCredentialBundle(submission).map((proof) => ballotScopeBaseKey(proof.ballotScope)),
  );
  for (const answer of submission.payload.responses) {
    const questionIndex = definition.questions.findIndex((question) => question.questionId === answer.questionId);
    if (questionIndex < 0) {
      return false;
    }
    if (!proofScopeKeys.has(questionBallotScopeKey(definition.questions[questionIndex], questionIndex))) {
      return false;
    }
  }
  return true;
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
    const request = sanitiseBlindBallotRequest(event.request);
    if (request.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    if (!next.loginVerified) {
      return reduceVoterError(state, "login_not_verified");
    }
    const scopeKey = ballotScopeKey(request.ballotScope);
    if (
      next.blindIssuances?.[scopeKey]
      || (next.blindIssuance && sameBallotScope(next.blindIssuance.ballotScope, request.ballotScope))
    ) {
      return reduceVoterError(state, "issuance_conflict");
    }
    const existingScopedRequest = next.blindRequests?.[scopeKey] ?? null;
    if (existingScopedRequest) {
      const sameRequest = sameBlindBallotRequest(existingScopedRequest, request);
      if (sameRequest && existingScopedRequest.lastSentAt !== request.lastSentAt) {
        const updatedRequest = {
          ...existingScopedRequest,
          lastSentAt: request.lastSentAt ?? existingScopedRequest.lastSentAt ?? null,
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
      const sameRequest = sameBlindBallotRequest(next.blindRequest, request);
      return sameRequest
        ? { state: next, ok: true }
        : reduceVoterError(state, "issuance_conflict");
    }
    next.blindRequest = next.blindRequest ?? request;
    next.blindRequests = {
      ...(next.blindRequests ?? {}),
      [scopeKey]: request,
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
    const issuance = sanitiseBlindBallotIssuance(event.issuance);
    if (issuance.electionId !== next.electionId) {
      return reduceVoterError(state, "election_id_mismatch");
    }
    const issuanceScopeKey = ballotScopeKey(issuance.ballotScope);
    const scopedRequest = next.blindRequests?.[issuanceScopeKey] ?? null;
    if (
      (!next.blindRequest || next.blindRequest.requestId !== issuance.requestId)
      && (!scopedRequest || scopedRequest.requestId !== issuance.requestId)
    ) {
      return reduceVoterError(state, "issuance_conflict");
    }
    const existingScopedIssuance = next.blindIssuances?.[issuanceScopeKey] ?? null;
    if (existingScopedIssuance) {
      const sameIssuance = existingScopedIssuance.issuanceId === issuance.issuanceId
        && existingScopedIssuance.blindSignature === issuance.blindSignature;
      if (!sameIssuance) {
        return reduceVoterError(state, "issuance_conflict");
      }
    }
    if (next.blindIssuance && sameBallotScope(next.blindIssuance.ballotScope, issuance.ballotScope)) {
      const sameIssuance = next.blindIssuance.issuanceId === issuance.issuanceId
        && next.blindIssuance.blindSignature === issuance.blindSignature;
      if (!sameIssuance) {
        return reduceVoterError(state, "issuance_conflict");
      }
    }
    next.blindIssuance = next.blindIssuance ?? issuance;
    next.blindIssuances = {
      ...(next.blindIssuances ?? {}),
      [issuanceScopeKey]: issuance,
    };
    next.credentialReady = true;
    next.lastUpdatedAt = issuance.issuedAt;
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
    const questionKeys = ballotSubmissionQuestionKeys(event.submission);
    const duplicateKeys = ballotSubmissionDuplicateKeys(event.submission);
    const existingAcceptedQuestionDecision = duplicateKeys.some((questionKey) => (
      next.submissionDecisions?.[questionKey]?.accepted === true
    ));
    if ((duplicateKeys.length === 0 && next.submissionAccepted === true) || existingAcceptedQuestionDecision) {
      return reduceVoterError(state, "already_submitted");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceVoterError(state, "schema_invalid");
    }
    next.submission = event.submission;
    if (questionKeys.length > 0) {
      next.submissions = {
        ...(next.submissions ?? {}),
        ...Object.fromEntries(questionKeys.map((questionKey) => [questionKey, event.submission])),
      };
    }
    next.responseNpub = event.submission.responseNpub ?? event.submission.invitedNpub;
    next.lastUpdatedAt = event.submission.submittedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_ACCEPTED") {
    const questionEntries = Object.entries(next.submissions ?? {})
      .filter(([, submission]) => submission.submissionId === event.submissionId);
    if (next.submission?.submissionId !== event.submissionId && questionEntries.length === 0) {
      return reduceVoterError(state, "schema_invalid");
    }
    if (questionEntries.length > 0) {
      next.submissionDecisions = {
        ...(next.submissionDecisions ?? {}),
        ...Object.fromEntries(questionEntries.map(([questionId]) => [questionId, {
          submissionId: event.submissionId,
          accepted: true,
          decidedAt: event.decidedAt,
          reason: null,
        }])),
      };
    } else {
      next.submissionAccepted = true;
      next.submissionAcceptedAt = event.decidedAt;
    }
    next.lastUpdatedAt = event.decidedAt;
    return { state: next, ok: true };
  }

  const questionEntries = Object.entries(next.submissions ?? {})
    .filter(([, submission]) => submission.submissionId === event.submissionId);
  if (next.submission?.submissionId !== event.submissionId && questionEntries.length === 0) {
    return reduceVoterError(state, "schema_invalid");
  }
  if (questionEntries.length > 0) {
    next.submissionDecisions = {
      ...(next.submissionDecisions ?? {}),
      ...Object.fromEntries(questionEntries.map(([questionId]) => [questionId, {
        submissionId: event.submissionId,
        accepted: false,
        decidedAt: event.decidedAt,
        reason: event.reason,
      }])),
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
    const request = sanitiseBlindBallotRequest(event.request);
    if (request.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    if (next.election.state === "closed" || next.election.state === "counted") {
      return reduceCoordinatorError(state, "election_not_open");
    }
    const entry = next.whitelist[request.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    if (CLAIM_STATE_ORDER[entry.claimState] < CLAIM_STATE_ORDER.claimed) {
      return reduceCoordinatorError(state, "state_transition_rejected");
    }
    const existingRequest = next.pendingBlindRequests[request.requestId];
    if (existingRequest) {
      const same = sameBlindBallotRequest(existingRequest, request);
      if (!same) {
        return reduceCoordinatorError(state, "issuance_conflict");
      }
      next.pendingBlindRequests[request.requestId] = {
        ...existingRequest,
        lastSentAt: request.lastSentAt ?? existingRequest.lastSentAt ?? null,
      };
      next.lastUpdatedAt = request.lastSentAt ?? request.createdAt;
      return { state: next, ok: true };
    }
    const existingScopedRequest = findPendingBlindRequestByNpubAndScope(
      next.pendingBlindRequests,
      request.invitedNpub,
      request.ballotScope,
    );
    if (existingScopedRequest) {
      return sameBlindBallotRequest(existingScopedRequest, request)
        ? { state: next, ok: true }
        : reduceCoordinatorError(state, "already_issued");
    }
    const existingIssuance = findIssuanceByNpubAndScope(
      next.issuedBlindResponses,
      request.invitedNpub,
      request.ballotScope,
    );
    if (existingIssuance) {
      return reduceCoordinatorError(state, "already_issued");
    }
    next.pendingBlindRequests[request.requestId] = request;
    entry.claimState = maxClaimState(entry.claimState, "blind_request_received");
    next.lastUpdatedAt = request.createdAt;
    return { state: next, ok: true };
  }

  if (event.type === "BLIND_SIGNATURE_ISSUED") {
    const issuance = sanitiseBlindBallotIssuance(event.issuance);
    if (issuance.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    const entry = next.whitelist[issuance.invitedNpub];
    if (!entry) {
      return reduceCoordinatorError(state, "not_whitelisted");
    }
    const request = next.pendingBlindRequests[issuance.requestId];
    if (!request) {
      return reduceCoordinatorError(state, "request_missing");
    }
    if (request.blindSigningKeyId !== issuance.blindSigningKeyId) {
      return reduceCoordinatorError(state, "issuance_conflict");
    }
    const existing = next.issuedBlindResponses[issuance.requestId];
    if (existing) {
      const same = existing.issuanceId === issuance.issuanceId
        && existing.blindSignature === issuance.blindSignature;
      return same
        ? { state: next, ok: true }
        : reduceCoordinatorError(state, "issuance_conflict");
    }
    const existingForVoter = findIssuanceByNpubAndScope(
      next.issuedBlindResponses,
      issuance.invitedNpub,
      issuance.ballotScope,
    );
    if (existingForVoter) {
      return reduceCoordinatorError(state, "already_issued");
    }
    next.issuedBlindResponses[issuance.requestId] = issuance;
    entry.issuanceId = issuance.issuanceId;
    entry.claimState = maxClaimState(entry.claimState, "blind_signature_issued");
    next.lastUpdatedAt = issuance.issuedAt;
    return { state: next, ok: true };
  }

  if (event.type === "BALLOT_SUBMISSION_RECEIVED") {
    if (event.submission.electionId !== next.election.electionId) {
      return reduceCoordinatorError(state, "election_id_mismatch");
    }
    if (next.election.state !== "open") {
      return reduceCoordinatorError(state, "election_not_open");
    }
    const expectedKeyId = next.election.blindSigningPublicKey?.keyId?.trim() ?? "";
    if (expectedKeyId && event.submission.blindSigningKeyId !== expectedKeyId) {
      return reduceCoordinatorError(state, "invalid_credential");
    }
    if (!validateResponsesSchema(event.submission.payload.responses)) {
      return reduceCoordinatorError(state, "schema_invalid");
    }
    for (const proof of submissionCredentialBundle(event.submission)) {
      if (expectedKeyId && proof.blindSigningKeyId !== expectedKeyId) {
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
    next.lastUpdatedAt = result.decidedAt;
    return { state: next, ok: true };
  }

  next.acceptanceResults[submission.submissionId] = result;
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
    ...sanitiseBlindBallotRequestRecord(input.canonicalRequests ?? {}),
  };
  merged.issuedBlindResponses = {
    ...merged.issuedBlindResponses,
    ...sanitiseBlindBallotIssuanceRecord(input.canonicalIssuances ?? {}),
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
  }

  return merged;
}

export function restoreVoterElectionLocalState(input: {
  persisted: VoterElectionLocalState;
  canonicalIssuance?: BlindBallotIssuance | null;
  canonicalAcceptance?: BallotAcceptanceResult | null;
}): VoterElectionLocalState {
  const next = cloneVoterState(input.persisted);
  const issuance = input.canonicalIssuance
    ? sanitiseBlindBallotIssuance(input.canonicalIssuance)
    : next.blindIssuance ?? null;
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
  definition?: QuestionnaireDefinition | null;
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
    if (!answeredQuestionsMatchCredentialScopes(input.definition, input.submission)) {
      return false;
    }
  }
  return true;
}

export function countAcceptedUniqueVoters(state: CoordinatorElectionState) {
  return Object.values(state.acceptanceResults)
    .filter((entry) => entry.accepted)
    .length;
}
