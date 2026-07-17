import { generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";
import {
  countAcceptedUniqueVoters,
  createEmptyVoterElectionLocalState,
  deriveCoordinatorUiFlags,
  deriveVoterUiFlags,
  reduceCoordinatorEvent,
  reduceVoterEvent,
  restoreCoordinatorElectionState,
  restoreVoterElectionLocalState,
  validateBallotSubmission,
  type BallotAcceptanceResult,
  type BallotCredentialProof,
  type BallotRejectReason,
  type BallotScope,
  type BallotSubmission,
  type BearerInviteCodeEntry,
  type BlindBallotIssuance,
  type BlindBallotRequest,
  type CoordinatorElectionState,
  type ElectionInviteMessage,
  type ElectionSummary,
  type ElectionState,
  type Npub,
  type QuestionnaireBlindPublicKey,
  type QuestionnaireAnswer,
  type VoterElectionLocalState,
  type WhitelistEntry,
} from "./questionnaireOptionA";
import type { QuestionnaireBlindPrivateKey } from "./questionnaireBlindSignature";
import {
  dequeueBlindRequest,
  dequeueSubmission,
  enqueueBlindRequest,
  enqueueSubmission,
  listBlindRequests,
  loadElectionRegistry,
  listSubmissions,
  loadCoordinatorState,
  loadElectionSummary,
  loadVoterState,
  publishInviteToMailbox,
  readBallotSubmissionAckRecord,
  readBlindRequestAckRecord,
  readElectionPrivateRelayPrefs,
  readAcceptance,
  readBallotAcceptanceDeliveryRecord,
  readBallotSubmissionAckDeliveryRecord,
  readBlindIssuanceAckRecord,
  readBlindIssuanceDeliveryRecord,
  readBlindRequestAckDeliveryRecord,
  readBlindIssuance,
  recordBallotAcceptanceDeliveryAttempt,
  recordBallotSubmissionAckDeliveryAttempt,
  recordBlindRequestAckDeliveryAttempt,
  recordBlindIssuanceDeliveryAttempt,
  readInviteFromMailbox,
  recordElectionPrivateRelaySuccesses,
  saveCoordinatorState,
  saveVoterState,
  storeBallotSubmissionAckRecord,
  storeAcceptance,
  storeBlindRequestAckRecord,
  storeBlindIssuanceAckRecord,
  storeBlindIssuance,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import {
  fetchOptionABallotSubmissionAckDms,
  fetchOptionABallotSubmissionAckDmsWithNsec,
  fetchOptionABlindIssuanceAckDms,
  fetchOptionABlindIssuanceAckDmsWithNsec,
  fetchOptionABlindRequestAckDms,
  fetchOptionABlindRequestAckDmsWithNsec,
  fetchOptionABallotAcceptanceDms,
  fetchOptionABallotAcceptanceDmsWithNsec,
  fetchOptionABallotSubmissionDms,
  fetchOptionABallotSubmissionDmsWithNsec,
  confirmOptionADmEventCopies,
  fetchOptionACoordinatorStateDms,
  fetchOptionACoordinatorStateDmsWithNsec,
  fetchOptionAVoterStateDms,
  fetchOptionAVoterStateDmsWithNsec,
  fetchOptionABlindIssuanceDms,
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDms,
  fetchOptionABlindRequestDmsWithNsec,
  fetchOptionAParticipantStatusDms,
  fetchOptionAParticipantStatusDmsWithNsec,
  publishOptionABallotSubmissionAckDm,
  publishOptionABallotAcceptanceDm,
  publishOptionABallotSubmissionDm,
  publishOptionACoordinatorStateDm,
  publishOptionAVoterStateDm,
  publishOptionABlindIssuanceAckDm,
  publishOptionABlindIssuanceBundleDm,
  publishOptionABlindIssuanceDm,
  publishOptionABlindRequestAckDm,
  publishOptionABlindRequestBundleDm,
  publishOptionABlindRequestDm,
  publishOptionAParticipantStatusDm,
  subscribeOptionABallotAcceptanceDms,
  subscribeOptionABallotSubmissionAckDms,
  subscribeOptionABallotSubmissionDms,
  subscribeOptionABlindIssuanceAckDms,
  subscribeOptionABlindIssuanceDms,
  subscribeOptionABlindIssuanceDmsWithNsec,
  subscribeOptionABlindRequestAckDms,
  subscribeOptionABlindRequestAckDmsWithNsec,
  subscribeOptionABlindRequestDms,
  subscribeOptionAParticipantStatusDms,
  type BallotSubmissionAck,
  type BlindRequestAck,
  type BlindIssuanceAck,
  type OptionACoordinatorStateSnapshot,
  type OptionAParticipantStatus,
  type OptionAVoterStateSnapshot,
  type OptionABlindRequestFetchDiagnostics,
} from "./questionnaireOptionABlindDm";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import {
  buildQuestionnaireDefinitionReference,
  questionnaireDefinitionEventHash,
  questionnaireDefinitionHash,
} from "./questionnaireDefinitionReference";
import { fetchOptionAInviteDms, publishOptionAInviteDm } from "./questionnaireOptionAInviteDm";
import type { SignerService } from "./services/signerService";
import {
  blindQuestionnaireToken,
  finalizeQuestionnaireBlindSignature,
  generateQuestionnaireBlindKeyPair,
  signBlindedQuestionnaireToken,
  toQuestionnaireBlindPublicKey,
  verifyQuestionnaireBlindSignature,
} from "./questionnaireBlindSignature";
import {
  buildQuestionnaireBlindTokenSignedMessage,
  deriveQuestionnaireTokenNullifier,
} from "./questionnaireBlindToken";
import { isDelegatedWorkerCapabilityEnabled, loadStoredWorkerDelegation } from "./questionnaireWorkerDelegation";
import {
  publishQuestionnaireBlindResponsePublic,
  publishQuestionnaireProvisionalResponsePublic,
  publishQuestionnaireSubmissionDecisionPublic,
} from "./questionnaireResponsePublish";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireDefinitions,
  fetchLatestQuestionnaireDefinitionByCoordinator,
  fetchQuestionnaireSubmissionDecisions,
} from "./questionnaireTransport";
import {
  allowedScopesForRequiredScope,
  normaliseQuestionnaireAllowedScopes,
  normaliseQuestionnaireBallotGroup,
  normaliseQuestionnaireCredentialsPerVoter,
  questionBallotCredentialScope,
  questionnaireCredentialsPerVoter,
  questionnaireUsesPerQuestionCredentials,
  type QuestionnaireCredentialsPerVoter,
  type QuestionnaireDefinition,
  type QuestionnaireResponseAnswer,
  type QuestionnaireSubmissionDecision,
} from "./questionnaireProtocol";
import type { QuestionnaireSubmissionDecisionReason } from "./questionnaireProtocol";
import { mergeQuestionnaireRelayHints } from "./questionnaireRelays";
import { DEFAULT_NOSTR_DM_RELAYS as SIMPLE_DM_RELAYS } from "./nostrRelayConfig";
import { QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1, type QuestionnaireFlowMode } from "./questionnaireProtocolConstants";
import {
  buildIssueBlindTokensWorkerRouting,
  mergeBlindRequestRoutingRelays,
  selectIssueBlindTokensWorkerRouting,
} from "./questionnaireWorkerRouting";
import {
  hashQuestionnaireInviteCode,
  isQuestionnaireInviteCodeHash,
  normaliseQuestionnaireInviteCode,
} from "./questionnaireInviteCode";

const OPTION_A_COORDINATOR_DM_LOOKBACK_SECONDS = 24 * 60 * 60;
const OPTION_A_COORDINATOR_SIGNER_DM_LIMIT = 320;
const OPTION_A_COORDINATOR_NSEC_DM_LIMIT = 320;
const OPTION_A_COORDINATOR_DM_PAGE_LIMIT = 40;
const OPTION_A_COORDINATOR_DM_MAX_PAGES = 8;
const OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS = 6_000;
const OPTION_A_ISSUANCE_DM_RETRY_MS = 8 * 1000;
const OPTION_A_ISSUANCE_DM_FAILED_RETRY_MS = 5 * 1000;
const OPTION_A_BLIND_REQUEST_RETRY_MS = 15 * 1000;
const OPTION_A_SUBMISSION_REPUBLISH_RETRY_MS = 3 * 60 * 1000;
const OPTION_A_SUBMISSION_ACK_RETRY_MS = 2 * 60 * 1000;
const OPTION_A_SELF_COPY_RECOVERY_LOOKBACK_SECONDS = Math.round(7 * 24 * 60 * 60);
const OPTION_A_STATE_SELF_COPY_PUBLISH_MIN_INTERVAL_MS = 15 * 1000;
const OPTION_A_VOTER_DM_LOOKBACK_SECONDS = Math.round(7 * 24 * 60 * 60);
const OPTION_A_ADAPTIVE_VOTER_DM_LIMIT = 240;
const OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT = 40;
const OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES = 6;
const OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS = 6_000;
const OPTION_A_PUBLIC_DECISION_REFRESH_LIMIT = 300;
const OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES = 2;

export type OptionARuntimeErrorCode =
  | "not_logged_in"
  | "election_missing"
  | "invite_missing"
  | "invite_mismatch"
  | "not_whitelisted"
  | "coordinator_missing"
  | "definition_not_ready"
  | "issuance_failed"
  | "dm_delivery_failed"
  | "invalid_submission";

export class OptionARuntimeError extends Error {
  constructor(public readonly code: OptionARuntimeErrorCode, message: string) {
    super(message);
    this.name = "OptionARuntimeError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toNpub(pubkey: string): string {
  if (pubkey.startsWith("npub1")) {
    return pubkey;
  }
  return nip19.npubEncode(pubkey);
}

function toHexPubkey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return trimmed;
}

function withIssueBlindTokensWorkerRouting(summary: ElectionSummary, routing = summary.issueBlindTokensWorker ?? null): ElectionSummary {
  return {
    ...summary,
    issueBlindTokensWorker: routing,
  };
}

function getPreferredQuestionnaireRelays(electionId: string) {
  return mergeQuestionnaireRelayHints(
    loadElectionSummary(electionId)?.questionnaireRelays,
    readCachedQuestionnaireDefinition(electionId)?.questionnaireRelays,
    readElectionPrivateRelayPrefs(electionId),
  );
}

function getPreferredQuestionnaireDmRelays(electionId: string) {
  return mergeQuestionnaireRelayHints(
    readElectionPrivateRelayPrefs(electionId),
    SIMPLE_DM_RELAYS,
  );
}

function cacheQuestionnaireDefinitionForRuntime(definition: QuestionnaireDefinition) {
  const storedDefinition = storeCachedQuestionnaireDefinition(definition) ?? definition;
  const electionId = storedDefinition.questionnaireId.trim();
  if (!electionId) {
    return;
  }
  const summary = loadElectionSummary(electionId);
  const coordinatorNpub = storedDefinition.coordinatorPubkey.trim();
  if (!summary && !coordinatorNpub) {
    return;
  }
  const closed = Number.isFinite(storedDefinition.closeAt) && storedDefinition.closeAt <= Math.floor(Date.now() / 1000);
  upsertElectionSummary({
    electionId,
    title: storedDefinition.title || summary?.title || "Questionnaire",
    description: storedDefinition.description ?? summary?.description ?? "",
    state: summary?.state ?? (closed ? "closed" : "open"),
    openedAt: Number.isFinite(storedDefinition.openAt) ? new Date(storedDefinition.openAt * 1000).toISOString() : summary?.openedAt ?? null,
    closedAt: Number.isFinite(storedDefinition.closeAt) ? new Date(storedDefinition.closeAt * 1000).toISOString() : summary?.closedAt ?? null,
    coordinatorNpub: summary?.coordinatorNpub || coordinatorNpub,
    blindSigningPublicKey: storedDefinition.blindSigningPublicKey ?? summary?.blindSigningPublicKey ?? null,
    definitionCreatedAt: Number.isFinite(storedDefinition.createdAt) ? storedDefinition.createdAt : summary?.definitionCreatedAt,
    questionnaireRelays: storedDefinition.questionnaireRelays,
    issueBlindTokensWorker: summary?.issueBlindTokensWorker ?? null,
    protocolVersion: storedDefinition.protocolVersion ?? summary?.protocolVersion,
    flowMode: storedDefinition.flowMode ?? summary?.flowMode,
    responseMode: storedDefinition.responseMode ?? summary?.responseMode,
  });
}

function decodeNsecSecretKey(nsec: string | null | undefined) {
  const trimmed = nsec?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      return null;
    }
    return decoded.data as Uint8Array;
  } catch {
    return null;
  }
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function makeTokenSecret() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(bytes);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function optionADebugLoggingEnabled() {
  const globalDebug = (globalThis as typeof globalThis & { __AUDITABLE_VOTING_DEBUG_OPTION_A?: unknown })
    .__AUDITABLE_VOTING_DEBUG_OPTION_A;
  if (globalDebug === true) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("debug_option_a") === "1"
      || window.localStorage.getItem("auditable-voting:debug:option-a") === "1";
  } catch {
    return false;
  }
}

function optionAFlowLog(role: "voter" | "coordinator", stage: string, details?: Record<string, unknown>) {
  if (!optionADebugLoggingEnabled()) {
    return;
  }
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.debug(`[OptionA][${role}] ${stage}${payload}`);
}

function extractSuccessfulRelays(result: { relayResults?: Array<{ relay: string; success: boolean }> } | null | undefined) {
  return (result?.relayResults ?? [])
    .filter((entry) => entry.success)
    .map((entry) => entry.relay);
}

function hasRecentAck(ackedAt: string | null | undefined, retryWindowMs: number) {
  if (!ackedAt) {
    return false;
  }
  const ackedAtMs = Date.parse(ackedAt);
  return Number.isFinite(ackedAtMs) && Date.now() - ackedAtMs < retryWindowMs;
}

function shouldThrottleBlindRequestPublish(params: {
  request: BlindBallotRequest;
  requestSent: boolean;
  blindIssuanceExists: boolean;
  forceResend: boolean;
  minRetryMs: number;
  requestAckAt: string | null | undefined;
}) {
  if (params.forceResend) {
    return false;
  }
  if (!params.requestSent || params.blindIssuanceExists) {
    return false;
  }
  const lastSentMs = params.request.lastSentAt ? Date.parse(params.request.lastSentAt) : Number.NaN;
  if (Number.isFinite(lastSentMs) && Date.now() - lastSentMs < params.minRetryMs) {
    return true;
  }
  if (hasRecentAck(params.requestAckAt, params.minRetryMs)) {
    return true;
  }
  return false;
}

const voterBlindRequestInflightByKey = new Map<string, Promise<VoterElectionLocalState>>();

function voterBlindRequestInflightKey(state: VoterElectionLocalState | null | undefined) {
  const electionId = state?.electionId?.trim() ?? "";
  const invitedNpub = state?.invitedNpub?.trim() ?? "";
  return electionId && invitedNpub ? `${electionId}:${invitedNpub}` : "";
}

function hasCompatibleBlindRequestKey(
  request: BlindBallotRequest | null | undefined,
  blindSigningPublicKey: QuestionnaireBlindPublicKey | null,
) {
  const expectedKeyId = blindSigningPublicKey?.keyId?.trim() ?? "";
  return Boolean(request) && (!expectedKeyId || request?.blindSigningKeyId === expectedKeyId);
}

function hasCompatibleBlindIssuanceKey(
  issuance: BlindBallotIssuance | null | undefined,
  blindSigningPublicKey: QuestionnaireBlindPublicKey | null,
) {
  const expectedKeyId = blindSigningPublicKey?.keyId?.trim() ?? "";
  return Boolean(issuance) && (!expectedKeyId || issuance?.blindSigningKeyId === expectedKeyId);
}

function hasCompatibleBlindTokenSecretKey(
  secret: VoterElectionLocalState["blindTokenSecret"] | null | undefined,
  blindSigningPublicKey: QuestionnaireBlindPublicKey | null,
) {
  const expectedKeyId = blindSigningPublicKey?.keyId?.trim() ?? "";
  return Boolean(secret) && (!expectedKeyId || secret?.blindSigningPublicKey.keyId === expectedKeyId);
}

type ResponseSecretMaterial = {
  tokenSecret: string;
  tokenCommitment: string;
  ballotScope: BallotScope | null;
};

async function deriveDeterministicResponseSecretKey(input: {
  electionId: string;
  secrets: ResponseSecretMaterial[];
}) {
  const sortedSecrets = [...input.secrets]
    .map((secret) => ({
      tokenSecret: secret.tokenSecret,
      tokenCommitment: secret.tokenCommitment,
      ballotScope: secret.ballotScope ?? null,
      scopeKey: ballotScopeKey(secret.ballotScope),
    }))
    .sort((left, right) => `${left.scopeKey}:${left.tokenCommitment}`.localeCompare(`${right.scopeKey}:${right.tokenCommitment}`));
  const seedMaterial = stableStringify({
    domain: "auditable-voting/questionnaire-response-identity/v2",
    electionId: input.electionId,
    secrets: sortedSecrets,
  });

  for (let nonce = 0; nonce < 32; nonce += 1) {
    const candidate = await sha256Bytes(`${seedMaterial}::${nonce}`);
    try {
      getPublicKey(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return generateSecretKey();
}

function emptyCoordinatorState(summary: ElectionSummary): CoordinatorElectionState {
  return {
    election: summary,
    whitelist: {},
    bearerInviteCodes: {},
    pendingBlindRequests: {},
    issuedBlindResponses: {},
    receivedSubmissions: {},
    acceptedNullifiers: {},
    acceptanceResults: {},
    lastUpdatedAt: nowIso(),
  };
}

function mergeElectionSummaryIntoCoordinatorElection(
  existing: ElectionSummary,
  summary?: Partial<ElectionSummary>,
): ElectionSummary {
  const summaryState = summary?.state;
  const shouldApplySummaryState = Boolean(summaryState) && (
    existing.state === "draft"
    || existing.state === "published"
    || existing.state === "open"
    || summaryState === "closed"
    || summaryState === "counted"
  );
  return {
    ...existing,
    title: summary?.title ?? existing.title,
    description: summary?.description ?? existing.description,
    state: shouldApplySummaryState ? summaryState as ElectionSummary["state"] : existing.state,
    openedAt: summary?.openedAt ?? existing.openedAt,
    closedAt: summary?.closedAt ?? existing.closedAt,
    protocolVersion: summary?.protocolVersion ?? existing.protocolVersion,
    flowMode: summary?.flowMode ?? existing.flowMode,
    responseMode: summary?.responseMode ?? existing.responseMode,
    blindSigningPublicKey: summary?.blindSigningPublicKey ?? existing.blindSigningPublicKey,
    definitionCreatedAt: summary?.definitionCreatedAt ?? existing.definitionCreatedAt,
    questionnaireRelays: summary?.questionnaireRelays ?? existing.questionnaireRelays,
    issueBlindTokensWorker: summary?.issueBlindTokensWorker ?? existing.issueBlindTokensWorker ?? null,
  };
}

function buildLocalPublishedElectionSummary(
  electionId: string,
  existing?: ElectionSummary,
): Partial<ElectionSummary> | null {
  const summary = loadElectionSummary(electionId);
  const definition = readCachedQuestionnaireDefinition(electionId);
  if (!summary && !definition) {
    return null;
  }
  return {
    title: summary?.title ?? definition?.title ?? existing?.title,
    description: summary?.description ?? definition?.description ?? existing?.description,
    state: summary?.state ?? (definition ? "open" : existing?.state),
    openedAt: summary?.openedAt ?? (definition?.openAt ? new Date(definition.openAt * 1000).toISOString() : existing?.openedAt),
    closedAt: summary?.closedAt ?? (definition?.closeAt ? new Date(definition.closeAt * 1000).toISOString() : existing?.closedAt),
    coordinatorNpub: summary?.coordinatorNpub ?? definition?.coordinatorPubkey ?? existing?.coordinatorNpub,
    blindSigningPublicKey: summary?.blindSigningPublicKey ?? definition?.blindSigningPublicKey ?? existing?.blindSigningPublicKey,
    definitionCreatedAt: summary?.definitionCreatedAt ?? definition?.createdAt ?? existing?.definitionCreatedAt,
    questionnaireRelays: summary?.questionnaireRelays ?? definition?.questionnaireRelays ?? existing?.questionnaireRelays,
    issueBlindTokensWorker: summary?.issueBlindTokensWorker ?? existing?.issueBlindTokensWorker ?? null,
    protocolVersion: summary?.protocolVersion ?? definition?.protocolVersion ?? existing?.protocolVersion,
    flowMode: summary?.flowMode ?? definition?.flowMode ?? existing?.flowMode,
    responseMode: summary?.responseMode ?? definition?.responseMode ?? existing?.responseMode,
  };
}

function findIssuedBlindResponse(
  state: CoordinatorElectionState,
  request: BlindBallotRequest,
): BlindBallotIssuance | null {
  return state.issuedBlindResponses[request.requestId]
    ?? Object.values(state.issuedBlindResponses).find((issuance) => (
      issuance.invitedNpub === request.invitedNpub
      && ballotScopeKey(issuance.ballotScope) === ballotScopeKey(request.ballotScope)
    ))
    ?? null;
}

function ballotScopeKey(scope: BallotScope | null | undefined) {
  const questionId = scope?.questionId?.trim() ?? "";
  const slotId = scope?.slotId?.trim() ?? "";
  const ballotGroup = normaliseQuestionnaireBallotGroup(scope?.ballotGroup);
  const allowedScopes = normaliseQuestionnaireAllowedScopes(scope?.allowedScopes, ballotGroup)
    .filter((entry) => entry !== "0");
  const slotIndex = Number.isFinite(scope?.slotIndex) ? Math.max(1, Math.floor(scope?.slotIndex as number)) : 0;
  const version = Number.isFinite(scope?.version) ? Math.max(1, Math.floor(scope?.version as number)) : 1;
  const credentialIndex = Number.isFinite(scope?.credentialIndex) ? Math.max(1, Math.floor(scope?.credentialIndex as number)) : 1;
  const credentialSuffix = credentialIndex > 1 ? `:c${credentialIndex}` : "";
  const scopePrefix = allowedScopes.length > 0 ? `scopes:${allowedScopes.join("+")}:` : "";
  if (!questionId && !slotId && !slotIndex && version === 1 && credentialIndex <= 1 && allowedScopes.length === 0) {
    return "__questionnaire__";
  }
  if (!questionId && !slotId && !slotIndex && version === 1 && allowedScopes.length > 0) {
    return `${scopePrefix}questionnaire${credentialSuffix}`;
  }
  if (slotIndex > 0) {
    return `${scopePrefix}slot:${slotIndex}:v${version}${credentialSuffix}`;
  }
  return `${scopePrefix}${questionId || slotId}:${slotId}:${slotIndex}:v${version}${credentialSuffix}`;
}

function sameBallotScope(left: BallotScope | null | undefined, right: BallotScope | null | undefined) {
  return ballotScopeKey(left) === ballotScopeKey(right);
}

function withCredentialIndex(scope: BallotScope | null, credentialIndex: number): BallotScope | null {
  const index = Math.max(1, Math.floor(credentialIndex));
  if (index <= 1) {
    return scope;
  }
  return {
    ...(scope ?? {}),
    credentialIndex: index,
  };
}

function ballotScopeCredentialIndex(scope: BallotScope | null | undefined) {
  return Number.isFinite(scope?.credentialIndex)
    ? Math.max(1, Math.floor(scope?.credentialIndex as number))
    : 1;
}

function voterCredentialsPerVoter(input: {
  invite?: Pick<ElectionInviteMessage, "credentialsPerVoter"> | null;
  privateInviteCredentialsPerVoter?: QuestionnaireCredentialsPerVoter | null;
  definition?: Pick<QuestionnaireDefinition, "credentialsPerVoter"> | null;
}): QuestionnaireCredentialsPerVoter {
  return input.invite?.credentialsPerVoter === 2
    || input.privateInviteCredentialsPerVoter === 2
    ? 2
    : questionnaireCredentialsPerVoter(input.definition);
}

function voterUsesScopedBlindCredentials(input: {
  invite?: Pick<ElectionInviteMessage, "credentialsPerVoter" | "ballotGroup"> | null;
  privateInviteCredentialsPerVoter?: QuestionnaireCredentialsPerVoter | null;
  privateInviteBallotGroup?: string | null;
  definition?: Pick<QuestionnaireDefinition, "ballotCredentialMode" | "credentialsPerVoter"> | null;
}) {
  return questionnaireUsesPerQuestionCredentials(input.definition)
    || voterCredentialsPerVoter(input) > 1
    || Boolean(voterBallotGroup(input));
}

function voterBallotGroup(input: {
  invite?: Pick<ElectionInviteMessage, "ballotGroup"> | null;
  privateInviteBallotGroup?: string | null;
}) {
  return normaliseQuestionnaireBallotGroup(input.invite?.ballotGroup)
    ?? normaliseQuestionnaireBallotGroup(input.privateInviteBallotGroup);
}

function ballotGroupScope(ballotGroup?: string | null): BallotScope | null {
  const normalised = normaliseQuestionnaireBallotGroup(ballotGroup);
  if (!normalised) {
    return null;
  }
  return { allowedScopes: allowedScopesForRequiredScope(normalised) };
}

function voterShouldWaitForDefinitionBeforeBlindRequest(input: {
  state: VoterElectionLocalState;
  summary: ElectionSummary | null;
  cachedDefinition: QuestionnaireDefinition | null;
}) {
  if (input.cachedDefinition || input.state.inviteMessage?.definition) {
    return false;
  }
  if (
    input.state.inviteMessage?.definitionReference
    && voterUsesScopedBlindCredentials({
      invite: input.state.inviteMessage,
      privateInviteCredentialsPerVoter: input.state.privateInviteCredentialsPerVoter,
      privateInviteBallotGroup: input.state.privateInviteBallotGroup,
      definition: input.cachedDefinition,
    })
  ) {
    return true;
  }
  if (input.summary?.protocolVersion === 2) {
    return true;
  }
  if (input.state.inviteMessage?.blindSigningPublicKey || input.summary?.blindSigningPublicKey) {
    return false;
  }
  return false;
}

function buildQuestionnaireCredentialScopes(
  definition: QuestionnaireDefinition | null | undefined,
  credentialsPerVoter = questionnaireCredentialsPerVoter(definition),
  ballotGroup?: string | null,
): Array<BallotScope | null> {
  const credentialCount = normaliseQuestionnaireCredentialsPerVoter(credentialsPerVoter);
  if (!definition || !questionnaireUsesPerQuestionCredentials(definition)) {
    const scope = ballotGroupScope(ballotGroup);
    return Array.from({ length: credentialCount }, (_, index) => withCredentialIndex(scope, index + 1));
  }
  const scopes: BallotScope[] = [];
  const seen = new Set<string>();
  for (let credentialIndex = 1; credentialIndex <= credentialCount; credentialIndex += 1) {
    definition.questions.forEach((question, index) => {
      const scope = questionBallotCredentialScope(question, index, credentialIndex);
      const key = ballotScopeKey(scope);
      if (!seen.has(key)) {
        seen.add(key);
        if (scope) {
          scopes.push(scope);
        }
      }
    });
  }
  return scopes;
}

function reconcileVoterCredentialReadyForDefinition(
  state: VoterElectionLocalState,
  definition: QuestionnaireDefinition | null | undefined,
): VoterElectionLocalState {
  if (!voterUsesScopedBlindCredentials({
    invite: state.inviteMessage ?? null,
    privateInviteCredentialsPerVoter: state.privateInviteCredentialsPerVoter,
    privateInviteBallotGroup: state.privateInviteBallotGroup,
    definition,
  })) {
    const credentialReady = Boolean(state.blindIssuance && state.blindTokenSecret);
    return state.credentialReady === credentialReady ? state : { ...state, credentialReady };
  }
  const scopes = buildQuestionnaireCredentialScopes(
    definition,
    voterCredentialsPerVoter({
      invite: state.inviteMessage ?? null,
      privateInviteCredentialsPerVoter: state.privateInviteCredentialsPerVoter,
      definition,
    }),
    voterBallotGroup({
      invite: state.inviteMessage ?? null,
      privateInviteBallotGroup: state.privateInviteBallotGroup,
    }),
  );
  const credentialReady = scopes.every((scope) => {
    const scopeKey = ballotScopeKey(scope);
    return Boolean(state.blindIssuances?.[scopeKey] && state.blindTokenSecrets?.[scopeKey]);
  });
  return state.credentialReady === credentialReady ? state : { ...state, credentialReady };
}

function voterHasTokenSecretForIssuance(state: VoterElectionLocalState, issuance: BlindBallotIssuance) {
  return Boolean(
    state.blindTokenSecrets?.[ballotScopeKey(issuance.ballotScope)]
    ?? (state.blindRequest?.requestId === issuance.requestId
      ? state.blindTokenSecret
      : null),
  );
}

function scopeForQuestion(
  definition: QuestionnaireDefinition | null | undefined,
  questionId: string,
  credentialIndex = 1,
  ballotGroup?: string | null,
): BallotScope | null {
  if (!definition || !questionnaireUsesPerQuestionCredentials(definition)) {
    return withCredentialIndex(ballotGroupScope(ballotGroup), credentialIndex);
  }
  const index = definition.questions.findIndex((question) => question.questionId === questionId);
  const question = index >= 0 ? definition.questions[index] : null;
  if (!question) {
    return null;
  }
  const targetKey = ballotScopeKey(questionBallotCredentialScope(question, index));
  const canonicalIndex = definition.questions.findIndex((candidate, candidateIndex) => {
    return ballotScopeKey(questionBallotCredentialScope(candidate, candidateIndex)) === targetKey;
  });
  const canonicalQuestion = canonicalIndex >= 0 ? definition.questions[canonicalIndex] : question;
  return questionBallotCredentialScope(canonicalQuestion, canonicalIndex >= 0 ? canonicalIndex : index, credentialIndex);
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

function scopedRequiredQuestionIdsForSubmission(submission: BallotSubmission, requiredQuestionIds: string[]) {
  const proofs = Array.isArray(submission.credentialBundle) && submission.credentialBundle.length > 0
    ? submission.credentialBundle
    : [];
  if (proofs.length === 0) {
    return requiredQuestionIds;
  }
  const coveredQuestionIds = new Set<string>();
  for (const answer of submission.payload.responses) {
    if (answer.questionId.trim()) {
      coveredQuestionIds.add(answer.questionId.trim());
    }
  }
  for (const proof of proofs) {
    const questionId = ballotCredentialProofQuestionId(proof);
    if (questionId) {
      coveredQuestionIds.add(questionId);
    }
  }
  if (coveredQuestionIds.size === 0) {
    return requiredQuestionIds;
  }
  return requiredQuestionIds.filter((questionId) => coveredQuestionIds.has(questionId));
}

type SubmitVoteOptions = {
  questionId?: string;
  questionIds?: string[];
  credentialIndex?: number;
};

function inferRejectReason(error?: string): BallotRejectReason {
  if (error === "duplicate_nullifier") {
    return "duplicate_nullifier";
  }
  if (error === "already_voted") {
    return "already_voted";
  }
  if (error === "issuance_missing") {
    return "issuance_missing";
  }
  if (error === "election_not_open") {
    return "election_closed";
  }
  if (error === "not_whitelisted") {
    return "not_whitelisted";
  }
  return "schema_invalid";
}

function toSubmissionDecisionReason(input: {
  accepted: boolean;
  rejectReason?: BallotRejectReason;
}): QuestionnaireSubmissionDecisionReason {
  if (input.accepted) {
    return "accepted";
  }
  if (input.rejectReason === "duplicate_nullifier" || input.rejectReason === "already_voted") {
    return "duplicate_nullifier";
  }
  if (input.rejectReason === "invalid_credential" || input.rejectReason === "issuance_missing") {
    return "invalid_token_proof";
  }
  if (input.rejectReason === "election_closed") {
    return "questionnaire_closed";
  }
  return "invalid_payload_shape";
}

function fromSubmissionDecisionReason(reason: QuestionnaireSubmissionDecisionReason): BallotRejectReason | undefined {
  if (reason === "accepted") {
    return undefined;
  }
  if (reason === "duplicate_nullifier") {
    return "duplicate_nullifier";
  }
  if (reason === "invalid_token_proof") {
    return "invalid_credential";
  }
  if (reason === "questionnaire_closed") {
    return "election_closed";
  }
  return "schema_invalid";
}

function publicDecisionToAcceptance(decision: QuestionnaireSubmissionDecision): BallotAcceptanceResult {
  return {
    type: "ballot_acceptance_result",
    schemaVersion: 1,
    electionId: decision.questionnaireId,
    submissionId: decision.submissionId,
    accepted: decision.accepted,
    reason: fromSubmissionDecisionReason(decision.reason),
    decidedAt: new Date(decision.decidedAt * 1000).toISOString(),
  };
}

function toQuestionnaireResponseAnswers(
  responses: QuestionnaireAnswer[],
  options?: { coordinatorNpub?: string; responseSecretKey?: Uint8Array | null },
): QuestionnaireResponseAnswer[] {
  return responses.map((answer) => {
    if (answer.type === "yes_no") {
      return {
        questionId: answer.questionId,
        answerType: "yes_no",
        value: answer.answer === "yes",
      };
    }
    if (answer.type === "multiple_choice") {
      return {
        questionId: answer.questionId,
        answerType: "multiple_choice",
        selectedOptionIds: [...answer.answer],
      };
    }
    if (answer.type === "rank") {
      return {
        questionId: answer.questionId,
        answerType: "rank",
        rankedOptionIds: [...answer.answer],
      };
    }
    let text = answer.answer;
    if (answer.encryptForCoordinator) {
      const coordinatorNpub = options?.coordinatorNpub?.trim() ?? "";
      const responseSecretKey = options?.responseSecretKey ?? null;
      if (!coordinatorNpub || !responseSecretKey) {
        throw new OptionARuntimeError("invalid_submission", "Organiser encryption key is unavailable for free-text encryption.");
      }
      const coordinatorHex = toHexPubkey(coordinatorNpub);
      const conversationKey = nip44.v2.utils.getConversationKey(responseSecretKey, coordinatorHex);
      const ciphertext = nip44.v2.encrypt(answer.answer, conversationKey);
      text = `enc:nip44v2:${ciphertext}`;
    }
    return {
      questionId: answer.questionId,
      answerType: "free_text",
      text,
    };
  });
}

function fromQuestionnaireResponseAnswers(answers: QuestionnaireResponseAnswer[]): QuestionnaireAnswer[] {
  return answers.map((answer) => {
    if (answer.answerType === "yes_no") {
      return {
        questionId: answer.questionId,
        type: "yes_no",
        answer: answer.value ? "yes" : "no",
      };
    }
    if (answer.answerType === "multiple_choice") {
      return {
        questionId: answer.questionId,
        type: "multiple_choice",
        answer: [...answer.selectedOptionIds],
      };
    }
    if (answer.answerType === "rank") {
      return {
        questionId: answer.questionId,
        type: "rank",
        answer: [...answer.rankedOptionIds],
      };
    }
    return {
      questionId: answer.questionId,
      type: "text",
      answer: answer.text,
    };
  });
}

function shouldUsePublicSubmissionFlow(input: {
  summaryFlowMode?: QuestionnaireFlowMode | null;
  cachedDefinitionFlowMode?: QuestionnaireFlowMode | null;
}) {
  return input.cachedDefinitionFlowMode === QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1
    || input.summaryFlowMode === QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1;
}

function timestampMs(value: string | null | undefined) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function canReplaySubmissionAfterClose(input: {
  submission: BallotSubmission;
  election: ElectionSummary;
}) {
  if (input.election.state !== "closed" && input.election.state !== "counted") {
    return false;
  }
  const submittedAt = timestampMs(input.submission.submittedAt);
  const closedAt = timestampMs(input.election.closedAt);
  return submittedAt !== null && closedAt !== null && submittedAt <= closedAt;
}

function electionStateForSubmissionValidation(input: {
  submission: BallotSubmission;
  election: ElectionSummary;
}): ElectionState {
  return input.election.state === "open" || canReplaySubmissionAfterClose(input)
    ? "open"
    : input.election.state;
}

function stateForSubmissionIntake(input: {
  state: CoordinatorElectionState;
  submission: BallotSubmission;
}) {
  if (input.state.election.state === "open" || !canReplaySubmissionAfterClose({
    submission: input.submission,
    election: input.state.election,
  })) {
    return {
      state: input.state,
      replayingAfterClose: false,
    };
  }
  return {
    state: {
      ...input.state,
      election: {
        ...input.state.election,
        state: "open" as const,
      },
    },
    replayingAfterClose: true,
  };
}

export class QuestionnaireOptionAVoterRuntime {
  private state: VoterElectionLocalState | null = null;
  private stateListeners = new Set<() => void>();
  private requestBlindBallotInflight: Promise<VoterElectionLocalState> | null = null;
  private submitVoteInflight: Promise<VoterElectionLocalState> | null = null;
  private lastSelfStateSnapshotHash: string | null = null;
  private lastSelfStateSnapshotPublishedAt = 0;
  private refreshFetchInFlight = false;
  private submissionRepublishAttemptAtBySubmissionId = new Map<string, number>();
  private blindIssuanceAckInflightByRequestId = new Map<string, Promise<void>>();
  private stopBlindRequestAckSubscription: (() => void) | null = null;
  private stopBlindIssuanceSubscription: (() => void) | null = null;
  private stopSubmissionAckSubscription: (() => void) | null = null;
  private stopAcceptanceSubscription: (() => void) | null = null;
  private bearerInviteCode: string | null = null;
  private privateInviteCredentialsPerVoter: QuestionnaireCredentialsPerVoter | null = null;
  private privateInviteBallotGroup: string | null = null;

  constructor(
    private readonly signer: SignerService,
    private readonly electionId: string,
    private readonly fallbackNsec?: string,
  ) {}

  getSnapshot() {
    return this.state;
  }

  subscribeStateChanges(listener: () => void) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private notifyStateChanged() {
    for (const listener of this.stateListeners) {
      listener();
    }
  }

  setBearerInviteCode(code: string | null | undefined, options?: {
    credentialsPerVoter?: QuestionnaireCredentialsPerVoter | null;
    ballotGroup?: string | null;
  }) {
    this.bearerInviteCode = normaliseQuestionnaireInviteCode(code) || null;
    if (options?.credentialsPerVoter !== undefined) {
      this.privateInviteCredentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(options.credentialsPerVoter);
    }
    if (options?.ballotGroup !== undefined) {
      this.privateInviteBallotGroup = normaliseQuestionnaireBallotGroup(options.ballotGroup);
    }
    if ((options?.credentialsPerVoter === undefined && options?.ballotGroup === undefined) || !this.state) {
      return;
    }
    this.state = {
      ...this.state,
      ...(options?.credentialsPerVoter !== undefined
        ? { privateInviteCredentialsPerVoter: normaliseQuestionnaireCredentialsPerVoter(options.credentialsPerVoter) }
        : {}),
      ...(options?.ballotGroup !== undefined
        ? { privateInviteBallotGroup: normaliseQuestionnaireBallotGroup(options.ballotGroup) }
        : {}),
      lastUpdatedAt: nowIso(),
    };
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
  }

  getFlags() {
    if (!this.state) {
      return {
        canLogin: true,
        canRequestBallot: false,
        canSubmitVote: false,
        alreadySubmitted: false,
        resumeAvailable: false,
      };
    }
    return deriveVoterUiFlags(this.state);
  }

  dispose() {
    this.stopVoterDmSubscriptions();
    this.stateListeners.clear();
  }

  private stopVoterDmSubscriptions() {
    this.stopBlindRequestAckSubscription?.();
    this.stopBlindRequestAckSubscription = null;
    this.stopBlindIssuanceSubscription?.();
    this.stopBlindIssuanceSubscription = null;
    this.stopSubmissionAckSubscription?.();
    this.stopSubmissionAckSubscription = null;
    this.stopAcceptanceSubscription?.();
    this.stopAcceptanceSubscription = null;
  }

  private getPreferredDmRelays() {
    return getPreferredQuestionnaireDmRelays(this.electionId);
  }

  private resolveVoterBlindSigningPublicKey(input: {
    inviteMessage?: ElectionInviteMessage | null;
    summary: ElectionSummary | null;
    cachedDefinition: QuestionnaireDefinition | null;
  }) {
    const timestampedCandidates = [
      {
        publicKey: input.summary?.blindSigningPublicKey ?? null,
        createdAt: input.summary?.definitionCreatedAt,
      },
      {
        publicKey: input.cachedDefinition?.blindSigningPublicKey ?? null,
        createdAt: input.cachedDefinition?.createdAt,
      },
      // Legacy direct-invite definitions are tolerated for old links, but fresh
      // public/cached definitions above are the source of truth for new flows.
      {
        publicKey: input.inviteMessage?.definition?.blindSigningPublicKey ?? null,
        createdAt: input.inviteMessage?.definition?.createdAt,
      },
    ]
      .filter((candidate): candidate is { publicKey: QuestionnaireBlindPublicKey; createdAt: number } =>
        Boolean(candidate.publicKey) && Number.isFinite(candidate.createdAt),
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    if (timestampedCandidates[0]) {
      return timestampedCandidates[0].publicKey;
    }
    return (
      input.summary?.blindSigningPublicKey
      ?? input.cachedDefinition?.blindSigningPublicKey
      ?? input.inviteMessage?.definition?.blindSigningPublicKey
      ?? input.inviteMessage?.blindSigningPublicKey
      ?? null
    );
  }

  private async refreshVoterPublicQuestionnaireMetadata(input: {
    state: VoterElectionLocalState;
    summary: ElectionSummary | null;
    cachedDefinition: QuestionnaireDefinition | null;
  }) {
    const relays = mergeQuestionnaireRelayHints(
      input.cachedDefinition?.questionnaireRelays,
      input.state.inviteMessage?.definitionReference?.relays,
      input.state.inviteMessage?.definition?.questionnaireRelays,
      input.summary?.questionnaireRelays,
    );
    try {
      const entries = await fetchQuestionnaireDefinitions({
        questionnaireId: input.state.electionId,
        limit: 20,
        relays: relays.length > 0 ? relays : undefined,
      });
      const latest = [...entries]
        .filter((entry) => entry.definition.questionnaireId === input.state.electionId)
        .filter((entry) => {
          const expectedHash = input.state.inviteMessage?.definitionReference?.definitionHash?.trim() ?? "";
          return !expectedHash || questionnaireDefinitionEventHash(entry.event.content) === expectedHash;
        })
        .sort((left, right) => Number(right.event.created_at ?? right.definition.createdAt ?? 0) - Number(left.event.created_at ?? left.definition.createdAt ?? 0))[0]?.definition ?? null;
      if (latest) {
        cacheQuestionnaireDefinitionForRuntime(latest);
      }
    } catch {
      // A fresh public definition is preferred, but cached metadata is still usable offline.
    }
    return {
      summary: loadElectionSummary(input.state.electionId),
      cachedDefinition: readCachedQuestionnaireDefinition(input.state.electionId),
    };
  }

  private reconcileVoterBlindSigningKeyState(input: {
    state: VoterElectionLocalState;
    blindSigningPublicKey: QuestionnaireBlindPublicKey | null;
  }): VoterElectionLocalState {
    const { state } = input;
    const expectedKeyId = input.blindSigningPublicKey?.keyId.trim() || "";
    if (!expectedKeyId) {
      return state;
    }

    const hasMismatch = Boolean(
      (state.blindRequest && state.blindRequest.blindSigningKeyId !== expectedKeyId)
      || (state.blindIssuance && state.blindIssuance.blindSigningKeyId !== expectedKeyId)
      || (state.blindTokenSecret && state.blindTokenSecret.blindSigningPublicKey.keyId !== expectedKeyId)
      || Object.values(state.blindRequests ?? {}).some((request) => request.blindSigningKeyId !== expectedKeyId)
      || Object.values(state.blindIssuances ?? {}).some((issuance) => issuance.blindSigningKeyId !== expectedKeyId)
      || Object.values(state.blindTokenSecrets ?? {}).some((entry) => entry.blindSigningPublicKey.keyId !== expectedKeyId)
    );
    if (!hasMismatch) {
      return state;
    }

    for (const requestId of Object.values(state.blindRequests ?? {}).map((request) => request.requestId)) {
      dequeueBlindRequest(requestId);
    }

    optionAFlowLog("voter", "blind_signing_key_mismatch_reset", {
      electionId: state.electionId,
      invitedNpub: state.invitedNpub,
      expectedBlindSigningKeyId: expectedKeyId,
      previousRequestId: state.blindRequest?.requestId ?? null,
      previousIssuanceId: state.blindIssuance?.issuanceId ?? null,
    });

    return {
      ...state,
      blindRequest: null,
      blindRequests: {},
      blindRequestSent: false,
      blindRequestSentAt: null,
      blindIssuance: null,
      blindIssuances: {},
      blindTokenSecret: null,
      blindTokenSecrets: {},
      credentialReady: false,
      lastUpdatedAt: nowIso(),
    };
  }

  private mergePersistedVoterCredentialState(input: {
    state: VoterElectionLocalState;
    blindSigningPublicKey: QuestionnaireBlindPublicKey | null;
  }): VoterElectionLocalState {
    const persisted = loadVoterState({
      voterNpub: input.state.invitedNpub,
      electionId: input.state.electionId,
      coordinatorNpub: input.state.coordinatorNpub,
    });
    if (!persisted) {
      return input.state;
    }
    const persistedForKey = this.reconcileVoterBlindSigningKeyState({
      state: persisted,
      blindSigningPublicKey: input.blindSigningPublicKey,
    });
    const blindRequests = { ...(input.state.blindRequests ?? {}) };
    for (const [scopeKey, request] of Object.entries(persistedForKey.blindRequests ?? {})) {
      if (!blindRequests[scopeKey] && hasCompatibleBlindRequestKey(request, input.blindSigningPublicKey)) {
        blindRequests[scopeKey] = request;
      }
    }
    const blindIssuances = { ...(input.state.blindIssuances ?? {}) };
    for (const [scopeKey, issuance] of Object.entries(persistedForKey.blindIssuances ?? {})) {
      if (!blindIssuances[scopeKey] && hasCompatibleBlindIssuanceKey(issuance, input.blindSigningPublicKey)) {
        blindIssuances[scopeKey] = issuance;
      }
    }
    const blindTokenSecrets = { ...(input.state.blindTokenSecrets ?? {}) };
    for (const [scopeKey, tokenSecret] of Object.entries(persistedForKey.blindTokenSecrets ?? {})) {
      if (!blindTokenSecrets[scopeKey] && hasCompatibleBlindTokenSecretKey(tokenSecret, input.blindSigningPublicKey)) {
        blindTokenSecrets[scopeKey] = tokenSecret;
      }
    }

    const persistedBlindRequest = hasCompatibleBlindRequestKey(persistedForKey.blindRequest, input.blindSigningPublicKey)
      ? persistedForKey.blindRequest ?? null
      : null;
    const persistedBlindIssuance = hasCompatibleBlindIssuanceKey(persistedForKey.blindIssuance, input.blindSigningPublicKey)
      ? persistedForKey.blindIssuance ?? null
      : null;
    const persistedBlindTokenSecret = hasCompatibleBlindTokenSecretKey(persistedForKey.blindTokenSecret, input.blindSigningPublicKey)
      ? persistedForKey.blindTokenSecret ?? null
      : null;

    return {
      ...input.state,
      privateInviteCredentialsPerVoter: input.state.privateInviteCredentialsPerVoter ?? persistedForKey.privateInviteCredentialsPerVoter ?? null,
      privateInviteBallotGroup: input.state.privateInviteBallotGroup ?? persistedForKey.privateInviteBallotGroup ?? null,
      blindRequest: input.state.blindRequest ?? persistedBlindRequest,
      blindRequests,
      blindRequestSent: input.state.blindRequestSent || persistedForKey.blindRequestSent,
      blindRequestSentAt: input.state.blindRequestSentAt ?? persistedForKey.blindRequestSentAt ?? null,
      blindIssuance: input.state.blindIssuance ?? persistedBlindIssuance,
      blindIssuances,
      blindTokenSecret: input.state.blindTokenSecret ?? persistedBlindTokenSecret,
      blindTokenSecrets,
      credentialReady: input.state.credentialReady
        || persistedForKey.credentialReady
        || Object.keys(blindIssuances).length > 0,
    };
  }

  private rememberIssueBlindTokensWorkerRouting(routing = this.state?.inviteMessage?.issueBlindTokensWorker ?? null) {
    const summary = loadElectionSummary(this.electionId);
    if (summary) {
      upsertElectionSummary(withIssueBlindTokensWorkerRouting(summary, routing));
    }
    if (this.state?.inviteMessage) {
      this.state = {
        ...this.state,
        inviteMessage: {
          ...this.state.inviteMessage,
          issueBlindTokensWorker: routing,
        },
        lastUpdatedAt: nowIso(),
      };
    }
  }

  private async resolveIssueBlindTokensWorkerRouting() {
    const hinted = selectIssueBlindTokensWorkerRouting({
      invite: this.state?.inviteMessage ?? null,
      summary: loadElectionSummary(this.electionId),
    });
    try {
      const delegation = await fetchQuestionnaireActiveWorkerDelegationForCapability({
        questionnaireId: this.electionId,
        capability: "issue_blind_tokens",
        relays: getPreferredQuestionnaireRelays(this.electionId),
        coordinatorNpub: this.state?.coordinatorNpub ?? loadElectionSummary(this.electionId)?.coordinatorNpub ?? null,
      });
      if (delegation?.workerNpub?.trim()) {
        const resolved = buildIssueBlindTokensWorkerRouting({
          delegationId: delegation.delegationId,
          workerNpub: delegation.workerNpub,
          controlRelays: delegation.controlRelays,
          dmRelays: delegation.dmRelays ?? getPreferredQuestionnaireDmRelays(this.electionId),
          expiresAt: delegation.expiresAt,
        });
        this.rememberIssueBlindTokensWorkerRouting(resolved);
        return resolved;
      }
    } catch {
      // Fall back to cached invite/summary routing.
    }
    return hinted;
  }

  private rememberPrivateRelaySuccesses(result: { relayResults?: Array<{ relay: string; success: boolean }> } | null | undefined) {
    const relays = extractSuccessfulRelays(result);
    if (relays.length > 0) {
      recordElectionPrivateRelaySuccesses(this.electionId, relays);
    }
  }

  private buildVoterSelfStateSnapshot(state: VoterElectionLocalState): OptionAVoterStateSnapshot {
    return {
      type: "voter_state_snapshot",
      schemaVersion: 1,
      electionId: state.electionId,
      invitedNpub: state.invitedNpub,
      coordinatorNpub: state.coordinatorNpub,
      loginVerified: state.loginVerified,
      loginVerifiedAt: state.loginVerifiedAt ?? null,
      blindRequest: state.blindRequest ?? null,
      blindRequests: state.blindRequests ?? {},
      blindRequestSent: state.blindRequestSent,
      blindRequestSentAt: state.blindRequestSentAt ?? null,
      blindIssuance: state.blindIssuance ?? null,
      blindIssuances: state.blindIssuances ?? {},
      blindTokenSecret: state.blindTokenSecret ?? null,
      blindTokenSecrets: state.blindTokenSecrets ?? {},
      credentialReady: state.credentialReady,
      responseNpub: state.responseNpub ?? null,
      draftResponses: state.draftResponses,
      submission: state.submission ?? null,
      submissions: state.submissions ?? {},
      submissionAccepted: state.submissionAccepted ?? null,
      submissionAcceptedAt: state.submissionAcceptedAt ?? null,
      submissionDecisions: state.submissionDecisions ?? {},
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  private async publishVoterStateSelfDm(options?: { force?: boolean; reason?: string }) {
    if (!this.state?.loginVerified || !this.state.invitedNpub) {
      return;
    }
    const now = Date.now();
    if (!options?.force && now - this.lastSelfStateSnapshotPublishedAt < OPTION_A_STATE_SELF_COPY_PUBLISH_MIN_INTERVAL_MS) {
      return;
    }
    const snapshot = this.buildVoterSelfStateSnapshot(this.state);
    const fingerprint = await sha256Hex(JSON.stringify(snapshot));
    if (!options?.force && this.lastSelfStateSnapshotHash === fingerprint) {
      return;
    }
    try {
      const result = await publishOptionAVoterStateDm({
        signer: this.signer,
        recipientNpub: this.state.invitedNpub,
        snapshot,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      const relayCandidates = result.relayResults.map((entry) => entry.relay);
      const copyCheck = await confirmOptionADmEventCopies({
        eventId: result.eventId ?? "",
        relays: relayCandidates,
        minCopies: OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES,
      });
      if (copyCheck.confirmedCopies >= OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES) {
        this.lastSelfStateSnapshotHash = fingerprint;
        this.lastSelfStateSnapshotPublishedAt = now;
        optionAFlowLog("voter", "state_self_copy_publish_result", {
          electionId: this.state.electionId,
          invitedNpub: this.state.invitedNpub,
          reason: options?.reason ?? "unspecified",
          successes: result.successes,
          failures: result.failures,
          confirmedCopies: copyCheck.confirmedCopies,
          confirmedRelays: copyCheck.confirmedRelays,
        });
      } else {
        optionAFlowLog("voter", "state_self_copy_publish_insufficient_copies", {
          electionId: this.state.electionId,
          invitedNpub: this.state.invitedNpub,
          reason: options?.reason ?? "unspecified",
          eventId: result.eventId,
          successes: result.successes,
          failures: result.failures,
          confirmedCopies: copyCheck.confirmedCopies,
          checkedRelays: copyCheck.checkedRelays,
          requiredCopies: OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES,
        });
      }
    } catch (error) {
      optionAFlowLog("voter", "state_self_copy_publish_failed", {
        electionId: this.state.electionId,
        invitedNpub: this.state.invitedNpub,
        reason: options?.reason ?? "unspecified",
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async publishParticipantStatus(
    state: OptionAParticipantStatus["state"],
    ids?: Pick<OptionAParticipantStatus, "requestId" | "issuanceId">,
  ) {
    if (!this.state?.coordinatorNpub?.trim() || !this.state.invitedNpub?.trim()) {
      return;
    }
    const status: OptionAParticipantStatus = {
      type: "participant_status",
      schemaVersion: 1,
      electionId: this.state.electionId,
      invitedNpub: this.state.invitedNpub,
      source: "voter",
      state,
      observedAt: nowIso(),
      ...ids,
    };
    try {
      const result = await publishOptionAParticipantStatusDm({
        signer: this.signer,
        recipientNpub: this.state.coordinatorNpub,
        status,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
    } catch (error) {
      optionAFlowLog("voter", "participant_status_publish_failed", {
        electionId: status.electionId,
        state: status.state,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private applyRecoveredVoterStateSnapshot(snapshot: OptionAVoterStateSnapshot) {
    if (!this.state) {
      return false;
    }
    if (snapshot.electionId !== this.state.electionId || snapshot.invitedNpub !== this.state.invitedNpub) {
      return false;
    }
    const currentUpdatedAtMs = Date.parse(this.state.lastUpdatedAt);
    const snapshotUpdatedAtMs = Date.parse(snapshot.lastUpdatedAt);
    const snapshotLooksNewer = Number.isFinite(snapshotUpdatedAtMs) && (
      !Number.isFinite(currentUpdatedAtMs) || snapshotUpdatedAtMs >= currentUpdatedAtMs
    );
    const fillsMissingProgress = (
      (!this.state.blindRequestSent && snapshot.blindRequestSent)
      || (!this.state.credentialReady && snapshot.credentialReady)
      || (!this.state.submission && Boolean(snapshot.submission))
      || (Object.keys(this.state.submissions ?? {}).length === 0 && Object.keys(snapshot.submissions ?? {}).length > 0)
      || (this.state.submissionAccepted == null && snapshot.submissionAccepted != null)
    );
    if (!snapshotLooksNewer && !fillsMissingProgress) {
      return false;
    }

    let next: VoterElectionLocalState = {
      ...this.state,
      coordinatorNpub: this.state.coordinatorNpub || snapshot.coordinatorNpub,
      loginVerified: this.state.loginVerified || snapshot.loginVerified,
      loginVerifiedAt: this.state.loginVerifiedAt ?? snapshot.loginVerifiedAt ?? null,
      blindRequest: this.state.blindRequest ?? snapshot.blindRequest ?? null,
      blindRequests: {
        ...(snapshot.blindRequests ?? {}),
        ...(this.state.blindRequests ?? {}),
      },
      blindRequestSent: this.state.blindRequestSent || snapshot.blindRequestSent,
      blindRequestSentAt: this.state.blindRequestSentAt ?? snapshot.blindRequestSentAt ?? null,
      blindIssuance: this.state.blindIssuance ?? snapshot.blindIssuance ?? null,
      blindIssuances: {
        ...(snapshot.blindIssuances ?? {}),
        ...(this.state.blindIssuances ?? {}),
      },
      blindTokenSecret: this.state.blindTokenSecret ?? snapshot.blindTokenSecret ?? null,
      blindTokenSecrets: {
        ...(snapshot.blindTokenSecrets ?? {}),
        ...(this.state.blindTokenSecrets ?? {}),
      },
      credentialReady: false,
      responseNpub: this.state.responseNpub ?? snapshot.responseNpub ?? null,
      draftResponses: this.state.draftResponses.length > 0
        ? this.state.draftResponses
        : (snapshot.draftResponses ?? []),
      submission: this.state.submission ?? snapshot.submission ?? null,
      submissions: {
        ...(snapshot.submissions ?? {}),
        ...(this.state.submissions ?? {}),
      },
      submissionAccepted: this.state.submissionAccepted ?? snapshot.submissionAccepted ?? null,
      submissionAcceptedAt: this.state.submissionAcceptedAt ?? snapshot.submissionAcceptedAt ?? null,
      submissionDecisions: {
        ...(snapshot.submissionDecisions ?? {}),
        ...(this.state.submissionDecisions ?? {}),
      },
      lastUpdatedAt: snapshotLooksNewer ? snapshot.lastUpdatedAt : this.state.lastUpdatedAt,
    };
    next = reconcileVoterCredentialReadyForDefinition(next, readCachedQuestionnaireDefinition(next.electionId));
    if (next.blindIssuance && voterHasTokenSecretForIssuance(next, next.blindIssuance)) {
      storeBlindIssuance(next.blindIssuance);
      if (next.blindIssuance.definition) {
        cacheQuestionnaireDefinitionForRuntime(next.blindIssuance.definition);
      }
      void this.ensureBlindIssuanceAck(next.blindIssuance).catch(() => undefined);
    }
    for (const issuance of Object.values(next.blindIssuances ?? {})) {
      if (!voterHasTokenSecretForIssuance(next, issuance)) {
        continue;
      }
      storeBlindIssuance(issuance);
      if (issuance.definition) {
        cacheQuestionnaireDefinitionForRuntime(issuance.definition);
      }
      void this.ensureBlindIssuanceAck(issuance).catch(() => undefined);
    }
    if (next.submission) {
      enqueueSubmission(next.submission);
    }
    for (const submission of Object.values(next.submissions ?? {})) {
      enqueueSubmission(submission);
    }
    this.state = next;
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    optionAFlowLog("voter", "state_self_copy_recovered", {
      electionId: this.state.electionId,
      invitedNpub: this.state.invitedNpub,
      blindRequestSent: this.state.blindRequestSent,
      credentialReady: this.state.credentialReady,
      hasSubmission: Boolean(this.state.submission),
      submissionAccepted: this.state.submissionAccepted,
    });
    this.startVoterDmSubscriptions();
    this.notifyStateChanged();
    return true;
  }

  async recoverVoterStateFromSelfDm() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const voterNsec = this.fallbackNsec?.trim() ?? "";
    const since = Math.floor(Date.now() / 1000) - OPTION_A_SELF_COPY_RECOVERY_LOOKBACK_SECONDS;
    const snapshots = voterNsec
      ? await fetchOptionAVoterStateDmsWithNsec({
        nsec: voterNsec,
        electionId: this.state.electionId,
        limit: 100,
        since,
      })
      : await fetchOptionAVoterStateDms({
        signer: this.signer,
        electionId: this.state.electionId,
        limit: 40,
        maxDecryptAttempts: 40,
        since,
      });
    const latest = snapshots
      .filter((snapshot) => snapshot.electionId === this.state?.electionId && snapshot.invitedNpub === this.state?.invitedNpub)
      .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))[0] ?? null;
    if (latest) {
      this.applyRecoveredVoterStateSnapshot(latest);
    }
    return this.state;
  }

  restartVoterDmSubscriptions() {
    this.stopVoterDmSubscriptions();
    this.startVoterDmSubscriptions();
  }

  private hasPendingBlindRequestForCredential() {
    if (!this.state?.blindRequest && !this.state?.blindRequests) {
      return false;
    }
    if (this.state.blindRequest && !this.state.blindIssuance) {
      return true;
    }
    return Object.entries(this.state.blindRequests ?? {}).some(([scopeKey, request]) => (
      Boolean(request) && !this.state?.blindIssuances?.[scopeKey]
    ));
  }

  private applyBlindIssuanceToState(issuance: BlindBallotIssuance, reason: string) {
    if (!this.state) {
      return false;
    }
    const wasCredentialReady = this.state.credentialReady;
    const received = reduceVoterEvent(this.state, {
      type: "BLIND_ISSUANCE_RECEIVED",
      issuance,
    });
    if (!received.ok) {
      return false;
    }
    if (!voterHasTokenSecretForIssuance(received.state, issuance)) {
      return false;
    }
    storeBlindIssuance(issuance);
    if (issuance.definition) {
      cacheQuestionnaireDefinitionForRuntime(issuance.definition);
    }
    const definition = issuance.definition ?? readCachedQuestionnaireDefinition(issuance.electionId);
    const nextState = reconcileVoterCredentialReadyForDefinition(received.state, definition);
    this.state = nextState;
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    this.startVoterDmSubscriptions();
    void this.publishVoterStateSelfDm({ reason });
    void this.ensureBlindIssuanceAck(issuance).catch(() => undefined);
    if (!wasCredentialReady && nextState.credentialReady) {
      void this.publishParticipantStatus("ballot_received", {
        requestId: issuance.requestId,
        issuanceId: issuance.issuanceId,
      });
    }
    this.notifyStateChanged();
    return true;
  }

  private applyAcceptanceToState(acceptance: BallotAcceptanceResult, reason: string) {
    storeAcceptance(acceptance);
    if (!this.state?.submission || this.state.submission.submissionId !== acceptance.submissionId) {
      return false;
    }
    const next = acceptance.accepted
      ? reduceVoterEvent(this.state, {
        type: "BALLOT_SUBMISSION_ACCEPTED",
        submissionId: this.state.submission.submissionId,
        decidedAt: acceptance.decidedAt,
      })
      : reduceVoterEvent(this.state, {
        type: "BALLOT_SUBMISSION_REJECTED",
        submissionId: this.state.submission.submissionId,
        reason: acceptance.reason ?? "rejected",
        decidedAt: acceptance.decidedAt,
      });
    if (!next.ok) {
      return false;
    }
    this.state = next.state;
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    this.startVoterDmSubscriptions();
    void this.publishVoterStateSelfDm({ reason });
    this.notifyStateChanged();
    return true;
  }

  private startVoterDmSubscriptions() {
    if (!this.state?.loginVerified) {
      this.stopVoterDmSubscriptions();
      return;
    }
    const shouldSubscribeBlindIssuance = Boolean(
      !this.state.credentialReady && (this.state.blindRequestSent || this.hasPendingBlindRequestForCredential()),
    );
    const shouldSubscribeAcceptance = Boolean(
      this.state.submission && this.state.submissionAccepted === null,
    );
    const relays = this.getPreferredDmRelays();
    // Gift-wrap events use intentionally randomized created_at values, so narrow "since"
    // windows can hide newly sent DMs. Always subscribe over a fixed lookback window.
    const lookbackSince = Math.max(0, Math.floor(Date.now() / 1000) - OPTION_A_VOTER_DM_LOOKBACK_SECONDS);
    const issuanceSince = lookbackSince;
    const acceptanceSince = lookbackSince;
    const voterNsec = this.fallbackNsec?.trim() ?? "";

    if (!shouldSubscribeBlindIssuance && this.stopBlindRequestAckSubscription) {
      this.stopBlindRequestAckSubscription();
      this.stopBlindRequestAckSubscription = null;
    }
    if (shouldSubscribeBlindIssuance && !this.stopBlindRequestAckSubscription) {
      const onAck = (ack: BlindRequestAck) => {
        storeBlindRequestAckRecord({
          requestId: ack.requestId,
          electionId: ack.electionId,
          invitedNpub: ack.invitedNpub,
          ackedAt: ack.ackedAt,
        });
      };
      this.stopBlindRequestAckSubscription = voterNsec
        ? subscribeOptionABlindRequestAckDmsWithNsec({
          nsec: voterNsec,
          electionId: this.electionId,
          relays,
          onAck,
        })
        : subscribeOptionABlindRequestAckDms({
          signer: this.signer,
          electionId: this.electionId,
          relays,
          since: issuanceSince,
          onAck,
        });
    }

    if (!shouldSubscribeBlindIssuance && this.stopBlindIssuanceSubscription) {
      this.stopBlindIssuanceSubscription();
      this.stopBlindIssuanceSubscription = null;
    }
    if (shouldSubscribeBlindIssuance && !this.stopBlindIssuanceSubscription) {
      const onIssuance = (issuance: BlindBallotIssuance) => {
        this.applyBlindIssuanceToState(issuance, "blind_issuance_received");
      };
      this.stopBlindIssuanceSubscription = voterNsec
        ? subscribeOptionABlindIssuanceDmsWithNsec({
          nsec: voterNsec,
          electionId: this.electionId,
          relays,
          onIssuance,
        })
        : subscribeOptionABlindIssuanceDms({
          signer: this.signer,
          electionId: this.electionId,
          relays,
          since: issuanceSince,
          onIssuance,
        });
    }

    if (!shouldSubscribeAcceptance && this.stopSubmissionAckSubscription) {
      this.stopSubmissionAckSubscription();
      this.stopSubmissionAckSubscription = null;
    }
    if (shouldSubscribeAcceptance && !this.stopSubmissionAckSubscription) {
      this.stopSubmissionAckSubscription = subscribeOptionABallotSubmissionAckDms({
        signer: this.signer,
        electionId: this.electionId,
        relays,
        since: acceptanceSince,
        onAck: (ack) => {
          storeBallotSubmissionAckRecord({
            submissionId: ack.submissionId,
            electionId: ack.electionId,
            responseNpub: ack.responseNpub,
            ackedAt: ack.ackedAt,
          });
        },
      });
    }

    if (!shouldSubscribeAcceptance && this.stopAcceptanceSubscription) {
      this.stopAcceptanceSubscription();
      this.stopAcceptanceSubscription = null;
    }
    if (shouldSubscribeAcceptance && !this.stopAcceptanceSubscription) {
      this.stopAcceptanceSubscription = subscribeOptionABallotAcceptanceDms({
        signer: this.signer,
        electionId: this.electionId,
        relays,
        since: acceptanceSince,
        onAcceptance: (acceptance) => {
          this.applyAcceptanceToState(acceptance, "acceptance_received");
        },
      });
    }
  }

  private isBlindIssuanceAcked(issuance: BlindBallotIssuance) {
    const ack = readBlindIssuanceAckRecord(issuance.requestId);
    return Boolean(ack && ack.issuanceId === issuance.issuanceId);
  }

  private async ensureBlindIssuanceAck(issuance: BlindBallotIssuance) {
    if (!this.state?.coordinatorNpub?.trim()) {
      return;
    }
    if (this.isBlindIssuanceAcked(issuance)) {
      return;
    }
    const inflight = this.blindIssuanceAckInflightByRequestId.get(issuance.requestId);
    if (inflight) {
      await inflight;
      return;
    }
    const ackTask = (async () => {
      const ack: BlindIssuanceAck = {
        type: "blind_ballot_issuance_ack",
        schemaVersion: 1,
        electionId: issuance.electionId,
        requestId: issuance.requestId,
        issuanceId: issuance.issuanceId,
        invitedNpub: this.state?.invitedNpub ?? issuance.invitedNpub,
        ackedAt: nowIso(),
      };
      try {
        const routing = await this.resolveIssueBlindTokensWorkerRouting();
        const recipientNpub = routing?.workerNpub?.trim() || this.state?.coordinatorNpub || issuance.invitedNpub;
        const result = await publishOptionABlindIssuanceAckDm({
          signer: this.signer,
          recipientNpub,
          ack,
          fallbackNsec: this.fallbackNsec,
          relays: mergeBlindRequestRoutingRelays(this.getPreferredDmRelays(), routing),
        });
        optionAFlowLog("voter", "blind_issuance_ack_publish_result", {
          electionId: ack.electionId,
          requestId: ack.requestId,
          issuanceId: ack.issuanceId,
          successes: result.successes,
          failures: result.failures,
        });
        if (result.successes > 0) {
          this.rememberPrivateRelaySuccesses(result);
          storeBlindIssuanceAckRecord(ack);
        }
      } catch (error) {
        optionAFlowLog("voter", "blind_issuance_ack_publish_failed", {
          electionId: ack.electionId,
          requestId: ack.requestId,
          issuanceId: ack.issuanceId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    })();
    this.blindIssuanceAckInflightByRequestId.set(issuance.requestId, ackTask);
    try {
      await ackTask;
    } finally {
      this.blindIssuanceAckInflightByRequestId.delete(issuance.requestId);
    }
  }

  async loginWithSigner(inviteFromUrl: ElectionInviteMessage | null) {
    const signerNpub = toNpub(await this.signer.getPublicKey());
    const inviteFromDm = inviteFromUrl
      ? null
      : (await fetchOptionAInviteDms({
        signer: this.signer,
        electionId: this.electionId,
        limit: 40,
      }))[0] ?? null;
    if (inviteFromDm) {
      publishInviteToMailbox(inviteFromDm);
    }
    const invite = inviteFromUrl ?? inviteFromDm ?? readInviteFromMailbox({ invitedNpub: signerNpub, electionId: this.electionId });
    if (invite && invite.invitedNpub !== signerNpub) {
      throw new OptionARuntimeError("invite_mismatch", "This invite is for a different Nostr account.");
    }

    const summary = loadElectionSummary(this.electionId);
    const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
    if (invite?.issueBlindTokensWorker && summary) {
      upsertElectionSummary(withIssueBlindTokensWorkerRouting(summary, invite.issueBlindTokensWorker));
    }
    const loadedVoterState = loadVoterState({
      voterNpub: signerNpub,
      electionId: this.electionId,
      coordinatorNpub: invite?.coordinatorNpub ?? summary?.coordinatorNpub,
    }) ?? createEmptyVoterElectionLocalState({
      electionId: this.electionId,
      invitedNpub: signerNpub,
      coordinatorNpub: invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? "",
      now: nowIso(),
    });
    const voterState = invite && loadedVoterState.coordinatorNpub !== invite.coordinatorNpub
      ? { ...loadedVoterState, coordinatorNpub: invite.coordinatorNpub, lastUpdatedAt: nowIso() }
      : loadedVoterState;

    let next = voterState;
    if (invite) {
      if (invite.definition) {
        cacheQuestionnaireDefinitionForRuntime(invite.definition);
      }
      const loaded = reduceVoterEvent(next, { type: "INVITE_LOADED", invite });
      if (!loaded.ok) {
        throw new OptionARuntimeError("invite_mismatch", "Invite could not be loaded.");
      }
      next = loaded.state;
    }

    const loggedIn = reduceVoterEvent(next, {
      type: "LOGIN_VERIFIED",
      electionId: this.electionId,
      npub: signerNpub,
      verifiedAt: nowIso(),
    });
    if (!loggedIn.ok) {
      throw new OptionARuntimeError("invite_mismatch", "Login verification failed.");
    }
    const loggedInState = this.privateInviteCredentialsPerVoter || this.privateInviteBallotGroup
      ? {
        ...loggedIn.state,
        ...(this.privateInviteCredentialsPerVoter ? { privateInviteCredentialsPerVoter: this.privateInviteCredentialsPerVoter } : {}),
        privateInviteBallotGroup: this.privateInviteBallotGroup,
      }
      : loggedIn.state;

    const restored = restoreVoterElectionLocalState({
      persisted: loggedInState,
      canonicalIssuance: loggedInState.blindRequest ? readBlindIssuance(loggedInState.blindRequest.requestId) : null,
      canonicalAcceptance: loggedInState.submission ? readAcceptance(loggedInState.submission.submissionId) : null,
    });
    const refreshedMetadata = await this.refreshVoterPublicQuestionnaireMetadata({
      state: restored,
      summary: loadElectionSummary(this.electionId),
      cachedDefinition: readCachedQuestionnaireDefinition(this.electionId) ?? cachedDefinition,
    });
    const blindSigningPublicKey = this.resolveVoterBlindSigningPublicKey({
      inviteMessage: restored.inviteMessage,
      summary: refreshedMetadata.summary,
      cachedDefinition: refreshedMetadata.cachedDefinition,
    });
    const reconciled = this.reconcileVoterBlindSigningKeyState({
      state: restored,
      blindSigningPublicKey,
    });
    const readyState = reconcileVoterCredentialReadyForDefinition(
      reconciled,
      refreshedMetadata.cachedDefinition ?? readCachedQuestionnaireDefinition(this.electionId) ?? cachedDefinition,
    );

    this.state = readyState;
    saveVoterState({ voterNpub: signerNpub, state: readyState });
    this.startVoterDmSubscriptions();
    if (readyState.blindIssuance && voterHasTokenSecretForIssuance(readyState, readyState.blindIssuance)) {
      void this.ensureBlindIssuanceAck(readyState.blindIssuance).catch(() => undefined);
    }
    await this.recoverVoterStateFromSelfDm().catch(() => readyState);
    await this.recoverSubmittedBallotFromSelfDm().catch(() => readyState);
    void this.publishVoterStateSelfDm({ reason: "login_with_signer" });
    void this.publishParticipantStatus("voter_live");
    return this.state ?? readyState;
  }

  bootstrapWithLocalIdentity(input: {
    invitedNpub: string;
    coordinatorNpub?: string;
    invite?: ElectionInviteMessage | null;
    allowInviteRecipientMismatch?: boolean;
    allowInviteMissing?: boolean;
  }) {
    const invitedNpub = toNpub((input.invitedNpub ?? "").trim());
    if (!invitedNpub) {
      throw new OptionARuntimeError("invite_missing", "Could not resolve invited voter identity.");
    }
    const rawInvite = input.invite
      ?? readInviteFromMailbox({ invitedNpub, electionId: this.electionId });
    if (rawInvite && rawInvite.invitedNpub !== invitedNpub && !input.allowInviteRecipientMismatch) {
      throw new OptionARuntimeError("invite_mismatch", "This invite is for a different voter identity.");
    }
    const invite = rawInvite && rawInvite.invitedNpub !== invitedNpub
      ? { ...rawInvite, invitedNpub }
      : rawInvite;

    const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
    const summary = loadElectionSummary(this.electionId);
    const definitionCoordinatorNpub = cachedDefinition?.coordinatorPubkey?.trim() ?? "";
    if (invite?.issueBlindTokensWorker && summary) {
      upsertElectionSummary(withIssueBlindTokensWorkerRouting(summary, invite.issueBlindTokensWorker));
    }
    const existingState = loadVoterState({
      voterNpub: invitedNpub,
      electionId: this.electionId,
      coordinatorNpub: input.coordinatorNpub ?? invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? definitionCoordinatorNpub,
    });
    if (!existingState && !invite && !input.allowInviteMissing) {
      throw new OptionARuntimeError(
        "invite_missing",
        "No invite found for this voter and questionnaire.",
      );
    }
    const loadedVoterState = existingState ?? createEmptyVoterElectionLocalState({
      electionId: this.electionId,
      invitedNpub,
      coordinatorNpub: input.coordinatorNpub ?? invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? definitionCoordinatorNpub,
      now: nowIso(),
    });
    const resolvedCoordinatorNpub = input.coordinatorNpub
      ?? invite?.coordinatorNpub
      ?? summary?.coordinatorNpub
      ?? definitionCoordinatorNpub
      ?? "";
    const voterState = resolvedCoordinatorNpub && loadedVoterState.coordinatorNpub !== resolvedCoordinatorNpub
      ? { ...loadedVoterState, coordinatorNpub: resolvedCoordinatorNpub, lastUpdatedAt: nowIso() }
      : loadedVoterState;

    let next = voterState;
    if (invite) {
      if (invite.definition) {
        cacheQuestionnaireDefinitionForRuntime(invite.definition);
      }
      const loaded = reduceVoterEvent(next, { type: "INVITE_LOADED", invite });
      if (!loaded.ok) {
        throw new OptionARuntimeError("invite_mismatch", "Invite could not be loaded.");
      }
      next = loaded.state;
    }

    const loggedIn = reduceVoterEvent(next, {
      type: "LOGIN_VERIFIED",
      electionId: this.electionId,
      npub: invitedNpub,
      verifiedAt: nowIso(),
    });
    if (!loggedIn.ok) {
      throw new OptionARuntimeError("invite_mismatch", "Login verification failed.");
    }
    const loggedInState = this.privateInviteCredentialsPerVoter || this.privateInviteBallotGroup
      ? {
        ...loggedIn.state,
        ...(this.privateInviteCredentialsPerVoter ? { privateInviteCredentialsPerVoter: this.privateInviteCredentialsPerVoter } : {}),
        privateInviteBallotGroup: this.privateInviteBallotGroup,
      }
      : loggedIn.state;

    const restored = restoreVoterElectionLocalState({
      persisted: loggedInState,
      canonicalIssuance: loggedInState.blindRequest ? readBlindIssuance(loggedInState.blindRequest.requestId) : null,
      canonicalAcceptance: loggedInState.submission ? readAcceptance(loggedInState.submission.submissionId) : null,
    });
    const localMetadata = {
      summary: loadElectionSummary(this.electionId),
      cachedDefinition: readCachedQuestionnaireDefinition(this.electionId) ?? cachedDefinition,
    };
    void this.refreshVoterPublicQuestionnaireMetadata({
      state: restored,
      ...localMetadata,
    }).catch(() => null);
    const blindSigningPublicKey = this.resolveVoterBlindSigningPublicKey({
      inviteMessage: restored.inviteMessage,
      summary: localMetadata.summary,
      cachedDefinition: localMetadata.cachedDefinition,
    });
    const reconciled = this.reconcileVoterBlindSigningKeyState({
      state: restored,
      blindSigningPublicKey,
    });
    const readyState = reconcileVoterCredentialReadyForDefinition(
      reconciled,
      localMetadata.cachedDefinition,
    );

    this.state = readyState;
    saveVoterState({ voterNpub: invitedNpub, state: readyState });
    this.startVoterDmSubscriptions();
    if (readyState.blindIssuance && voterHasTokenSecretForIssuance(readyState, readyState.blindIssuance)) {
      void this.ensureBlindIssuanceAck(readyState.blindIssuance).catch(() => undefined);
    }
    void this.recoverVoterStateFromSelfDm().catch(() => readyState);
    void this.publishVoterStateSelfDm({ reason: "bootstrap_local_identity" });
    void this.publishParticipantStatus("voter_live");
    return readyState;
  }

  private applyRecoveredSubmission(submission: BallotSubmission) {
    if (!this.state || submission.electionId !== this.state.electionId) {
      return false;
    }
    if (this.state.submission && this.state.submission.submissionId !== submission.submissionId) {
      return false;
    }
    const responseNpub = submission.responseNpub ?? submission.invitedNpub;
    this.state = {
      ...this.state,
      credentialReady: true,
      responseNpub,
      draftResponses: submission.payload.responses,
      submission,
      lastUpdatedAt: submission.submittedAt,
    };
    enqueueSubmission(submission);
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "submission_self_copy_recovered" });
    optionAFlowLog("voter", "submission_self_copy_recovered", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      responseNpub,
    });
    return true;
  }

  async recoverSubmittedBallotFromSelfDm() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    if (this.state.submission) {
      return this.state;
    }
    const voterNsec = this.fallbackNsec?.trim() ?? "";
    const since = Math.floor(Date.now() / 1000) - OPTION_A_SELF_COPY_RECOVERY_LOOKBACK_SECONDS;
    const submissions = voterNsec
      ? await fetchOptionABallotSubmissionDmsWithNsec({
        nsec: voterNsec,
        electionId: this.state.electionId,
        limit: 80,
        since,
      })
      : await fetchOptionABallotSubmissionDms({
        signer: this.signer,
        electionId: this.state.electionId,
        limit: 30,
        maxDecryptAttempts: 30,
        since,
      });
    const recovered = submissions
      .filter((submission) => submission.electionId === this.state?.electionId)
      .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0] ?? null;
    if (recovered) {
      this.applyRecoveredSubmission(recovered);
    }
    return this.state;
  }

  updateDraftResponses(responses: QuestionnaireAnswer[]) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const updated = reduceVoterEvent(this.state, {
      type: "DRAFT_RESPONSES_UPDATED",
      electionId: this.state.electionId,
      responses,
    });
    if (updated.ok) {
      this.state = updated.state;
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      void this.publishVoterStateSelfDm({ reason: "draft_responses_updated" });
    }
  }

  async publishProvisionalResponses(questionIds: string[], options?: { credentialIndex?: number }) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const targetQuestionIds = [...new Set(questionIds.map((questionId) => questionId.trim()).filter(Boolean))];
    if (targetQuestionIds.length === 0) {
      return null;
    }
    const targetQuestionIdSet = new Set(targetQuestionIds);
    const responses = this.state.draftResponses.filter((answer) => targetQuestionIdSet.has(answer.questionId));
    if (responses.length === 0) {
      return null;
    }
    const credentialIndex = Math.max(1, Math.floor(options?.credentialIndex ?? 1));
    const definition = readCachedQuestionnaireDefinition(this.state.electionId);
    let responseSecretKey: Uint8Array;
    try {
      responseSecretKey = await deriveDeterministicResponseSecretKey({
        electionId: this.state.electionId,
        secrets: this.responseSecretMaterialsForSubmission(definition, responses, { credentialIndex }),
      });
    } catch (error) {
      if (error instanceof OptionARuntimeError && error.code === "issuance_failed") {
        return null;
      }
      throw error;
    }
    const responseNsec = nip19.nsecEncode(responseSecretKey);
    const responseIdHash = await sha256Hex(stableStringify({
      electionId: this.state.electionId,
      questionIds: targetQuestionIds,
      credentialIndex,
      authorPubkey: nip19.npubEncode(getPublicKey(responseSecretKey)),
    }));
    const published = await publishQuestionnaireProvisionalResponsePublic({
      responseNsec,
      questionnaireId: this.state.electionId,
      questionnaireDefinitionEventId: null,
      responseId: `provisional_${responseIdHash.slice(0, 20)}`,
      submittedAt: Math.floor(Date.now() / 1000),
      questionIds: targetQuestionIds,
      credentialIndex,
      answers: toQuestionnaireResponseAnswers(responses, {
        coordinatorNpub: this.state.coordinatorNpub,
        responseSecretKey,
      }),
      relays: this.getPreferredDmRelays(),
    });
    optionAFlowLog("voter", "provisional_response_public_publish_result", {
      electionId: this.state.electionId,
      questionIds: targetQuestionIds,
      credentialIndex,
      successes: published?.successes ?? 0,
      failures: published?.failures ?? 0,
    });
    return published;
  }

  async requestBlindBallot(options?: { forceResend?: boolean; minRetryMs?: number }) {
    if (this.requestBlindBallotInflight) {
      optionAFlowLog("voter", "blind_request_inflight_reused", { electionId: this.electionId });
      return this.requestBlindBallotInflight;
    }
    const sharedInflightKey = voterBlindRequestInflightKey(this.state);
    const sharedInflight = sharedInflightKey ? voterBlindRequestInflightByKey.get(sharedInflightKey) : null;
    if (sharedInflight) {
      optionAFlowLog("voter", "blind_request_shared_inflight_reused", {
        electionId: this.state?.electionId ?? this.electionId,
        invitedNpub: this.state?.invitedNpub ?? null,
      });
      const result = await sharedInflight;
      const latest = this.state
        ? loadVoterState({
          voterNpub: this.state.invitedNpub,
          electionId: this.state.electionId,
          coordinatorNpub: this.state.coordinatorNpub,
        })
        : null;
      this.state = latest ?? result;
      this.startVoterDmSubscriptions();
      this.notifyStateChanged();
      return this.state;
    }
    const inflight = this.requestBlindBallotInternal(options);
    this.requestBlindBallotInflight = inflight;
    if (sharedInflightKey) {
      voterBlindRequestInflightByKey.set(sharedInflightKey, inflight);
    }
    try {
      return await this.requestBlindBallotInflight;
    } finally {
      if (sharedInflightKey && voterBlindRequestInflightByKey.get(sharedInflightKey) === inflight) {
        voterBlindRequestInflightByKey.delete(sharedInflightKey);
      }
      this.requestBlindBallotInflight = null;
    }
  }

  private async requestBlindBallotInternal(options?: { forceResend?: boolean; minRetryMs?: number }) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    let next = this.state;
    let summary = loadElectionSummary(next.electionId);
    let cachedDefinition = readCachedQuestionnaireDefinition(next.electionId);
    optionAFlowLog("voter", "blind_request_started", {
      electionId: next.electionId,
      alreadyHasRequest: Boolean(next.blindRequest),
      alreadyHasIssuance: Boolean(next.blindIssuance),
    });
    ({ summary, cachedDefinition } = await this.refreshVoterPublicQuestionnaireMetadata({
      state: next,
      summary,
      cachedDefinition,
    }));
    if (voterShouldWaitForDefinitionBeforeBlindRequest({ state: next, summary, cachedDefinition })) {
      throw new OptionARuntimeError(
        "definition_not_ready",
        "Questionnaire details are still loading. Try requesting the ballot again in a moment.",
      );
    }
    const blindSigningPublicKey = this.resolveVoterBlindSigningPublicKey({
      inviteMessage: next.inviteMessage ?? null,
      summary,
      cachedDefinition,
    });
    next = this.reconcileVoterBlindSigningKeyState({
      state: next,
      blindSigningPublicKey,
    });
    next = this.mergePersistedVoterCredentialState({
      state: next,
      blindSigningPublicKey,
    });
    this.state = next;
    const usesScopedBlindCredentials = voterUsesScopedBlindCredentials({
      invite: this.state.inviteMessage ?? null,
      privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
      definition: cachedDefinition,
    });
    if (
      this.state.blindIssuance
      && this.state.blindTokenSecret
      && !usesScopedBlindCredentials
    ) {
      void this.ensureBlindIssuanceAck(this.state.blindIssuance).catch(() => undefined);
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_already_issued" });
      return this.state;
    }
    if (usesScopedBlindCredentials) {
      const scopes = buildQuestionnaireCredentialScopes(
        cachedDefinition,
        voterCredentialsPerVoter({
          invite: this.state.inviteMessage ?? null,
          privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
          definition: cachedDefinition,
        }),
        voterBallotGroup({
          invite: this.state.inviteMessage ?? null,
          privateInviteBallotGroup: this.state.privateInviteBallotGroup,
        }),
      );
      const allIssued = scopes.every((scope) => {
        const scopeKey = ballotScopeKey(scope);
        return Boolean(this.state?.blindIssuances?.[scopeKey] && this.state.blindTokenSecrets?.[scopeKey]);
      });
      if (allIssued) {
        this.state = { ...this.state, credentialReady: true };
        saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
        void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_bundle_already_issued" });
        return this.state;
      }
    }

    let request = next.blindRequest;
    if (request && !next.blindTokenSecret && !usesScopedBlindCredentials) {
      request = null;
      next = {
        ...next,
        blindRequest: null,
        blindIssuance: null,
        credentialReady: false,
      };
      this.state = next;
    }
    const inviteCodeHash = this.bearerInviteCode
      ? await hashQuestionnaireInviteCode(this.bearerInviteCode)
      : "";
    if (usesScopedBlindCredentials && cachedDefinition) {
      return this.requestBlindBallotBundleInternal({
        cachedDefinition,
        summary,
        inviteCodeHash,
        forceResend: options?.forceResend,
        minRetryMs: options?.minRetryMs,
      });
    }
    if (!request) {
      const blindSigningPublicKey = this.resolveVoterBlindSigningPublicKey({
        inviteMessage: next.inviteMessage ?? null,
        summary,
        cachedDefinition,
      });
      if (!blindSigningPublicKey) {
        throw new OptionARuntimeError("issuance_failed", "Organiser blind-signing key is not available yet.");
      }
      const tokenSecret = makeTokenSecret();
      const tokenCommitment = await sha256Hex(tokenSecret);
      const ballotScope = ballotGroupScope(voterBallotGroup({
        invite: next.inviteMessage ?? null,
        privateInviteBallotGroup: next.privateInviteBallotGroup,
      }));
      const message = buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId: next.electionId,
        tokenSecretCommitment: tokenCommitment,
        ballotScope,
      });
      const blinded = await blindQuestionnaireToken({
        publicKey: blindSigningPublicKey,
        message,
      });
      request = {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: next.electionId,
        requestId: makeId("request"),
        invitedNpub: next.invitedNpub,
        blindedMessage: blinded.blindedMessage,
        blindSigningKeyId: blindSigningPublicKey.keyId,
        clientNonce: makeId("nonce"),
        createdAt: nowIso(),
        inviteCodeHash: inviteCodeHash || null,
        ballotScope,
      };
      const created = reduceVoterEvent(next, { type: "BLIND_REQUEST_CREATED", request });
      if (!created.ok) {
        throw new OptionARuntimeError("issuance_failed", "Could not create blind request.");
      }
      optionAFlowLog("voter", "blind_request_created", {
        electionId: next.electionId,
        requestId: request.requestId,
      });
      next = created.state;
      next = {
        ...next,
        blindTokenSecret: {
          tokenSecret,
          tokenCommitment,
          blindingFactor: blinded.blindingFactor,
          blindSigningPublicKey,
        },
      };
    }
    if (request && inviteCodeHash && !request.inviteCodeHash) {
      request = {
        ...request,
        inviteCodeHash,
      };
      next = {
        ...next,
        blindRequest: request,
      };
    }

    this.state = next;
    if (!this.state.coordinatorNpub?.trim()) {
      const summaryCoordinatorNpub = summary?.coordinatorNpub?.trim()
        || cachedDefinition?.coordinatorPubkey?.trim()
        || "";
      if (summaryCoordinatorNpub) {
        this.state = {
          ...this.state,
          coordinatorNpub: summaryCoordinatorNpub,
          lastUpdatedAt: nowIso(),
        };
      }
    }
    const minRetryMs = Math.max(0, options?.minRetryMs ?? OPTION_A_BLIND_REQUEST_RETRY_MS);
    const lastSentMs = this.state.blindRequestSentAt ? Date.parse(this.state.blindRequestSentAt) : Number.NaN;
    const requestAck = request ? readBlindRequestAckRecord(request.requestId) : null;
    if (
      request
      && shouldThrottleBlindRequestPublish({
        request,
        requestSent: this.state.blindRequestSent,
        blindIssuanceExists: Boolean(this.state.blindIssuance),
        forceResend: Boolean(options?.forceResend),
        minRetryMs,
        requestAckAt: requestAck?.ackedAt,
      })
    ) {
      const lastSentAt = request.lastSentAt;
      const hasFreshAck = hasRecentAck(requestAck?.ackedAt, minRetryMs);
      optionAFlowLog("voter", "blind_request_resend_skipped_cooldown", {
        electionId: this.state.electionId,
        requestId: request.requestId,
        minRetryMs,
        reason: hasFreshAck ? "acked_recently" : Number.isFinite(lastSentMs) ? "sent_recently" : "first_send",
        requestLastSentAt: lastSentAt,
        requestAckAt: requestAck?.ackedAt ?? null,
      });
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_skip_cooldown" });
      return this.state;
    }
    if (
      request
      && this.state.blindRequestSent
      && !this.state.blindIssuance
      && !options?.forceResend
    ) {
      optionAFlowLog("voter", "blind_request_pending_issuance_retry_due", {
        electionId: this.state.electionId,
        requestId: request.requestId,
        minRetryMs,
      });
    }
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_pre_publish" });
    if (!this.state.coordinatorNpub?.trim()) {
      throw new OptionARuntimeError(
        "invite_missing",
        "Organiser details are missing. Refresh status or reopen the invite.",
      );
    }
    this.startVoterDmSubscriptions();
    const sentAt = nowIso();
    request = {
      ...request,
      lastSentAt: sentAt,
    };
    const published = await this.publishBlindRequestDm(request);
    optionAFlowLog("voter", "blind_request_dm_publish_result", {
      electionId: this.state.electionId,
      requestId: request.requestId,
      successes: published?.successes ?? 0,
      failures: published?.failures ?? 0,
    });
    if (!published || published.successes <= 0) {
      throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the blind ballot request DM.");
    }
    const sent = reduceVoterEvent(this.state, {
      type: "BLIND_REQUEST_SENT",
      electionId: this.state.electionId,
      requestId: request.requestId,
      sentAt,
    });
    if (!sent.ok) {
      throw new OptionARuntimeError("issuance_failed", "Could not send blind request.");
    }
    next = sent.state;
    this.state = next;
    this.startVoterDmSubscriptions();
    enqueueBlindRequest(request);
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_sent", force: true });
    optionAFlowLog("voter", "blind_request_sent", {
      electionId: this.state.electionId,
      requestId: request.requestId,
    });
    return this.state;
  }

  private async requestBlindBallotBundleInternal(input: {
    cachedDefinition: QuestionnaireDefinition;
    summary: ElectionSummary | null;
    inviteCodeHash: string;
    forceResend?: boolean;
    minRetryMs?: number;
  }) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const blindSigningPublicKey = this.resolveVoterBlindSigningPublicKey({
      inviteMessage: this.state.inviteMessage ?? null,
      summary: input.summary,
      cachedDefinition: input.cachedDefinition,
    });
    if (!blindSigningPublicKey) {
      throw new OptionARuntimeError("issuance_failed", "Organiser blind-signing key is not available yet.");
    }

    const scopes = buildQuestionnaireCredentialScopes(
      input.cachedDefinition,
      voterCredentialsPerVoter({
        invite: this.state.inviteMessage ?? null,
        privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
        definition: input.cachedDefinition,
      }),
      voterBallotGroup({
        invite: this.state.inviteMessage ?? null,
        privateInviteBallotGroup: this.state.privateInviteBallotGroup,
      }),
    );
    let next: VoterElectionLocalState = {
      ...this.state,
      blindRequests: { ...(this.state.blindRequests ?? {}) },
      blindIssuances: { ...(this.state.blindIssuances ?? {}) },
      blindTokenSecrets: { ...(this.state.blindTokenSecrets ?? {}) },
    };
    const minRetryMs = Math.max(0, input.minRetryMs ?? OPTION_A_BLIND_REQUEST_RETRY_MS);
    const requestsToPublish: BlindBallotRequest[] = [];

    for (const scope of scopes) {
      const scopeKey = ballotScopeKey(scope);
      const existingIssuance = next.blindIssuances?.[scopeKey] ?? null;
      const existingTokenSecret = next.blindTokenSecrets?.[scopeKey] ?? null;
      if (existingIssuance && existingTokenSecret) {
        void this.ensureBlindIssuanceAck(existingIssuance).catch(() => undefined);
        continue;
      }
      if (existingIssuance && !existingTokenSecret) {
        const blindIssuances = { ...(next.blindIssuances ?? {}) };
        delete blindIssuances[scopeKey];
        next = {
          ...next,
          blindIssuance: next.blindIssuance?.issuanceId === existingIssuance.issuanceId ? null : next.blindIssuance,
          blindIssuances,
          credentialReady: false,
        };
      }
      let request = next.blindRequests?.[scopeKey] ?? null;
      let tokenSecretEntry = next.blindTokenSecrets?.[scopeKey] ?? null;
      if (!request || !tokenSecretEntry) {
        const tokenSecret = makeTokenSecret();
        const tokenCommitment = await sha256Hex(tokenSecret);
        const message = buildQuestionnaireBlindTokenSignedMessage({
          questionnaireId: next.electionId,
          tokenSecretCommitment: tokenCommitment,
          ballotScope: scope,
        });
        const blinded = await blindQuestionnaireToken({
          publicKey: blindSigningPublicKey,
          message,
        });
        request = {
          type: "blind_ballot_request",
          schemaVersion: 1,
          electionId: next.electionId,
          requestId: makeId("request"),
          invitedNpub: next.invitedNpub,
          blindedMessage: blinded.blindedMessage,
          blindSigningKeyId: blindSigningPublicKey.keyId,
          clientNonce: makeId("nonce"),
          createdAt: nowIso(),
          inviteCodeHash: input.inviteCodeHash || null,
          ballotScope: scope,
        };
        tokenSecretEntry = {
          tokenSecret,
          tokenCommitment,
          blindingFactor: blinded.blindingFactor,
          blindSigningPublicKey,
          ballotScope: scope,
        };
      } else if (input.inviteCodeHash && !request.inviteCodeHash) {
        request = {
          ...request,
          inviteCodeHash: input.inviteCodeHash,
        };
      }

      const requestAck = readBlindRequestAckRecord(request.requestId);
      const hasFreshAck = hasRecentAck(requestAck?.ackedAt, minRetryMs);
      const shouldPublish = input.forceResend
        || !request.lastSentAt
        || !shouldThrottleBlindRequestPublish({
          request,
          requestSent: Boolean(next.blindRequestSent),
          blindIssuanceExists: false,
          forceResend: Boolean(input.forceResend),
          minRetryMs,
          requestAckAt: requestAck?.ackedAt,
        });
      if (!shouldPublish && hasFreshAck) {
        optionAFlowLog("voter", "blind_request_bundle_publish_skipped_ack_recently", {
          electionId: this.state.electionId,
          requestId: request.requestId,
          requestAckAt: requestAck?.ackedAt ?? null,
          minRetryMs,
          scope: scopeKey,
        });
      }
      next.blindRequests = {
        ...(next.blindRequests ?? {}),
        [scopeKey]: request,
      };
      next.blindTokenSecrets = {
        ...(next.blindTokenSecrets ?? {}),
        [scopeKey]: tokenSecretEntry,
      };
      next.blindRequest = next.blindRequest ?? request;
      next.blindTokenSecret = next.blindTokenSecret ?? tokenSecretEntry;
      if (shouldPublish) {
        requestsToPublish.push(request);
      }
    }

    if (!next.coordinatorNpub?.trim()) {
      const summaryCoordinatorNpub = input.summary?.coordinatorNpub?.trim()
        || input.cachedDefinition.coordinatorPubkey?.trim()
        || "";
      if (summaryCoordinatorNpub) {
        next = {
          ...next,
          coordinatorNpub: summaryCoordinatorNpub,
          lastUpdatedAt: nowIso(),
        };
      }
    }
    if (!next.coordinatorNpub?.trim()) {
      throw new OptionARuntimeError(
        "invite_missing",
        "Organiser details are missing. Refresh status or reopen the invite.",
      );
    }

    this.state = next;
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_bundle_pre_publish" });
    this.startVoterDmSubscriptions();

    if (requestsToPublish.length > 0) {
      const sentAt = nowIso();
      const scopedRequests = requestsToPublish.map((request) => ({
        ...request,
        lastSentAt: sentAt,
      }));
      const published = await this.publishBlindRequestBundleDm(scopedRequests);
      if (!published || published.successes <= 0) {
        throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the blind ballot request DM.");
      }
      let nextRequests = { ...(this.state.blindRequests ?? {}) };
      for (const scopedRequest of scopedRequests) {
        const scopeKey = ballotScopeKey(scopedRequest.ballotScope);
        nextRequests = {
          ...nextRequests,
          [scopeKey]: scopedRequest,
        };
        enqueueBlindRequest(scopedRequest);
      }
      this.state = {
        ...this.state,
        blindRequest: this.state.blindRequest ?? scopedRequests[0] ?? null,
        blindRequests: nextRequests,
        blindRequestSent: true,
        blindRequestSentAt: sentAt,
        lastUpdatedAt: sentAt,
      };
    }

    const allIssued = scopes.every((scope) => Boolean(this.state?.blindIssuances?.[ballotScopeKey(scope)]));
    this.state = {
      ...this.state,
      credentialReady: allIssued,
    };
    this.startVoterDmSubscriptions();
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "request_blind_ballot_bundle_sent", force: true });
    optionAFlowLog("voter", "blind_request_bundle_sent", {
      electionId: this.state.electionId,
      requested: requestsToPublish.length,
      scopes: scopes.length,
      allIssued,
    });
    return this.state;
  }

  async publishBlindRequestDm(request = this.state?.blindRequest ?? null) {
    if (!this.state || !request || !this.state.coordinatorNpub) {
      return null;
    }
    const routing = await this.resolveIssueBlindTokensWorkerRouting();
    const coordinatorNpub = this.state.coordinatorNpub.trim();
    const workerNpub = routing?.workerNpub?.trim() || "";
    const recipientNpub = workerNpub || coordinatorNpub;
    const relays = mergeBlindRequestRoutingRelays(this.getPreferredDmRelays(), routing);
    optionAFlowLog("voter", "blind_request_publish_attempt", {
      electionId: this.state.electionId,
      requestId: request.requestId,
      coordinatorNpub,
      workerNpub: workerNpub || null,
      recipientNpub,
      recipientCount: 1,
      delegationId: routing?.delegationId ?? null,
      recipientRole: workerNpub ? "proxy" : "organiser",
    });
    try {
      const result = await publishOptionABlindRequestDm({
        signer: this.signer,
        recipientNpub,
        request,
        fallbackNsec: this.fallbackNsec,
        relays: workerNpub ? relays : this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      return result;
    } catch {
      return null;
    }
  }

  async publishBlindRequestBundleDm(requests: BlindBallotRequest[]) {
    if (!this.state || requests.length === 0 || !this.state.coordinatorNpub) {
      return null;
    }
    if (requests.length === 1) {
      return this.publishBlindRequestDm(requests[0]);
    }
    const routing = await this.resolveIssueBlindTokensWorkerRouting();
    const coordinatorNpub = this.state.coordinatorNpub.trim();
    const workerNpub = routing?.workerNpub?.trim() || "";
    const recipientNpub = workerNpub || coordinatorNpub;
    const relays = mergeBlindRequestRoutingRelays(this.getPreferredDmRelays(), routing);
    optionAFlowLog("voter", "blind_request_bundle_publish_attempt", {
      electionId: this.state.electionId,
      requestCount: requests.length,
      coordinatorNpub,
      workerNpub: workerNpub || null,
      recipientCount: 1,
      delegationId: routing?.delegationId ?? null,
    });
    try {
      const result = await publishOptionABlindRequestBundleDm({
        signer: this.signer,
        recipientNpub,
        requests,
        fallbackNsec: this.fallbackNsec,
        relays: workerNpub ? relays : this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      return result;
    } catch {
      return null;
    }
  }

  refreshIssuanceAndAcceptance(options?: { restartSubscriptions?: boolean }) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }

    if (options?.restartSubscriptions) {
      this.restartVoterDmSubscriptions();
    }

    const electionId = this.state.electionId;
    const activeDefinition = readCachedQuestionnaireDefinition(electionId);
    const lookbackSince = Math.max(0, Math.floor(Date.now() / 1000) - OPTION_A_VOTER_DM_LOOKBACK_SECONDS);
    const needsIssuanceFetch = Boolean(this.state.blindRequestSent && !this.state.credentialReady);
    const needsAcceptanceFetch = Boolean(this.state.submission && this.state.submissionAccepted === null);
    const requestSince = lookbackSince;
    const acceptanceSince = lookbackSince;
    if (!this.refreshFetchInFlight) {
      const fetchTasks: Array<Promise<void>> = [];
      if (needsIssuanceFetch) {
        const activeRequestId = voterUsesScopedBlindCredentials({
          invite: this.state.inviteMessage ?? null,
          privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
          privateInviteBallotGroup: this.state.privateInviteBallotGroup,
          definition: activeDefinition,
        })
          ? ""
          : this.state.blindRequest?.requestId ?? "";
        const requestAckFetch = this.fallbackNsec?.trim()
          ? fetchOptionABlindRequestAckDmsWithNsec({
            nsec: this.fallbackNsec,
            electionId,
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            targetRequestId: activeRequestId,
          })
          : fetchOptionABlindRequestAckDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            since: requestSince,
            targetRequestId: activeRequestId,
          });
        const blindIssuanceFetch = this.fallbackNsec?.trim()
          ? fetchOptionABlindIssuanceDmsWithNsec({
            nsec: this.fallbackNsec,
            electionId,
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            targetRequestId: activeRequestId,
          })
          : fetchOptionABlindIssuanceDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            since: requestSince,
            targetRequestId: activeRequestId,
          });
        fetchTasks.push(
          requestAckFetch.then((ackMessages) => {
            for (const ack of ackMessages) {
              storeBlindRequestAckRecord({
                requestId: ack.requestId,
                electionId: ack.electionId,
                invitedNpub: ack.invitedNpub,
                ackedAt: ack.ackedAt,
              });
            }
          }).catch(() => null).then(() => undefined),
        );
        fetchTasks.push(
          blindIssuanceFetch.then((issuanceMessages) => {
            for (const issuance of issuanceMessages) {
              this.applyBlindIssuanceToState(issuance, "blind_issuance_backfill");
            }
          }).catch(() => null).then(() => undefined),
        );
      }
      if (needsAcceptanceFetch) {
        const acceptanceReadNsec = this.state.responseNsec?.trim() || this.fallbackNsec?.trim() || "";
        const submissionId = this.state.submission?.submissionId ?? "";
        const publicDecisionRelays = readCachedQuestionnaireDefinition(electionId)?.questionnaireRelays
          ?? loadElectionSummary(electionId)?.questionnaireRelays
          ?? this.getPreferredDmRelays();
        const publicDecisionFetch = submissionId
          ? fetchQuestionnaireSubmissionDecisions({
            questionnaireId: electionId,
            relays: publicDecisionRelays,
            limit: OPTION_A_PUBLIC_DECISION_REFRESH_LIMIT,
            readRelayLimit: 3,
            preferKindOnly: true,
            maxPages: 12,
            timeBudgetMs: 5_000,
          })
          : Promise.resolve([]);
        const submissionAckFetch = acceptanceReadNsec
          ? fetchOptionABallotSubmissionAckDmsWithNsec({
            nsec: acceptanceReadNsec,
            electionId,
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            targetSubmissionId: submissionId,
          })
          : fetchOptionABallotSubmissionAckDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            since: acceptanceSince,
            targetSubmissionId: submissionId,
          });
        const acceptanceFetch = acceptanceReadNsec
          ? fetchOptionABallotAcceptanceDmsWithNsec({
            nsec: acceptanceReadNsec,
            electionId,
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            targetSubmissionId: submissionId,
          })
          : fetchOptionABallotAcceptanceDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_ADAPTIVE_VOTER_DM_LIMIT,
            pageLimit: OPTION_A_ADAPTIVE_VOTER_DM_PAGE_LIMIT,
            maxPages: OPTION_A_ADAPTIVE_VOTER_DM_MAX_PAGES,
            timeBudgetMs: OPTION_A_ADAPTIVE_VOTER_DM_TIME_BUDGET_MS,
            since: acceptanceSince,
            targetSubmissionId: submissionId,
          });
        fetchTasks.push(
          submissionAckFetch.then((ackMessages) => {
            for (const ack of ackMessages) {
              storeBallotSubmissionAckRecord({
                submissionId: ack.submissionId,
                electionId: ack.electionId,
                responseNpub: ack.responseNpub,
                ackedAt: ack.ackedAt,
              });
            }
          }).catch(() => null).then(() => undefined),
        );
        fetchTasks.push(
          acceptanceFetch.then((acceptanceMessages) => {
            for (const acceptance of acceptanceMessages) {
              this.applyAcceptanceToState(acceptance, "acceptance_backfill");
            }
          }).catch(() => null).then(() => undefined),
        );
        fetchTasks.push(
          publicDecisionFetch.then((decisionEntries) => {
            const latestDecision = decisionEntries
              .filter((entry) => entry.decision.submissionId === submissionId)
              .sort((left, right) => Number(right.event.created_at ?? right.decision.decidedAt ?? 0) - Number(left.event.created_at ?? left.decision.decidedAt ?? 0))[0]
              ?.decision ?? null;
            if (latestDecision) {
              this.applyAcceptanceToState(publicDecisionToAcceptance(latestDecision), "public_decision_backfill");
            }
          }).catch(() => null).then(() => undefined),
        );
      }
      if (fetchTasks.length > 0) {
        this.refreshFetchInFlight = true;
        void Promise.all(fetchTasks).finally(() => {
          this.refreshFetchInFlight = false;
        });
      }
    }

    const previousState = this.state;
    let next = previousState;
    const requestsToCheck = Object.values(next.blindRequests ?? {});
    if (requestsToCheck.length === 0 && next.blindRequest) {
      requestsToCheck.push(next.blindRequest);
    }
    for (const request of requestsToCheck) {
      const issuance = readBlindIssuance(request.requestId);
      if (issuance) {
        if (issuance.definition) {
          cacheQuestionnaireDefinitionForRuntime(issuance.definition);
        }
        const received = reduceVoterEvent(next, {
          type: "BLIND_ISSUANCE_RECEIVED",
          issuance,
        });
        if (received.ok && voterHasTokenSecretForIssuance(received.state, issuance)) {
          next = received.state;
          void this.ensureBlindIssuanceAck(issuance).catch(() => undefined);
        }
      }
    }
    next = reconcileVoterCredentialReadyForDefinition(next, activeDefinition);
    if (!previousState.credentialReady && next.credentialReady) {
      const terminalIssuance = Object.values(next.blindIssuances ?? {}).at(-1) ?? next.blindIssuance;
      if (terminalIssuance) {
        void this.publishParticipantStatus("ballot_received", {
          requestId: terminalIssuance.requestId,
          issuanceId: terminalIssuance.issuanceId,
        });
      }
    }
    if (next.submission) {
      const acceptance = readAcceptance(next.submission.submissionId);
      if (acceptance?.accepted) {
        const accepted = reduceVoterEvent(next, {
          type: "BALLOT_SUBMISSION_ACCEPTED",
          submissionId: next.submission.submissionId,
          decidedAt: acceptance.decidedAt,
        });
        if (accepted.ok) {
          next = accepted.state;
        }
      } else if (acceptance && !acceptance.accepted) {
        const rejected = reduceVoterEvent(next, {
          type: "BALLOT_SUBMISSION_REJECTED",
          submissionId: next.submission.submissionId,
          reason: acceptance.reason ?? "rejected",
          decidedAt: acceptance.decidedAt,
        });
        if (rejected.ok) {
          next = rejected.state;
        }
      }
    }
    for (const submission of Object.values(next.submissions ?? {})) {
      const acceptance = readAcceptance(submission.submissionId);
      if (acceptance?.accepted) {
        const accepted = reduceVoterEvent(next, {
          type: "BALLOT_SUBMISSION_ACCEPTED",
          submissionId: submission.submissionId,
          decidedAt: acceptance.decidedAt,
        });
        if (accepted.ok) {
          next = accepted.state;
        }
      } else if (acceptance && !acceptance.accepted) {
        const rejected = reduceVoterEvent(next, {
          type: "BALLOT_SUBMISSION_REJECTED",
          submissionId: submission.submissionId,
          reason: acceptance.reason ?? "rejected",
          decidedAt: acceptance.decidedAt,
        });
        if (rejected.ok) {
          next = rejected.state;
        }
      }
    }
    if (next !== previousState) {
      this.state = next;
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      void this.publishVoterStateSelfDm({ reason: "refresh_issuance_acceptance" });
    }
    return this.state;
  }

  async submitVote(requiredQuestionIds: string[], options?: SubmitVoteOptions) {
    if (this.submitVoteInflight) {
      optionAFlowLog("voter", "submit_vote_inflight_reused", { electionId: this.electionId });
      return this.submitVoteInflight;
    }
    this.submitVoteInflight = this.submitVoteInternal(requiredQuestionIds, options);
    try {
      return await this.submitVoteInflight;
    } finally {
      this.submitVoteInflight = null;
    }
  }

  private async buildSubmissionCredentialBundle(
    definition: QuestionnaireDefinition | null,
    responses = this.state?.draftResponses ?? [],
    options?: { credentialIndex?: number },
  ): Promise<BallotCredentialProof[]> {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const usesPerQuestionCredentials = questionnaireUsesPerQuestionCredentials(definition);
    const usesScopedBlindCredentials = voterUsesScopedBlindCredentials({
      invite: this.state.inviteMessage ?? null,
      privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
      definition,
    });
    const activeBallotGroup = voterBallotGroup({
      invite: this.state.inviteMessage ?? null,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
    });
    if (!usesPerQuestionCredentials) {
      const credentialIndex = Math.max(1, Math.floor(options?.credentialIndex ?? 1));
      const scope = usesScopedBlindCredentials ? withCredentialIndex(ballotGroupScope(activeBallotGroup), credentialIndex) : null;
      const scopeKey = ballotScopeKey(scope);
      const issuance = usesScopedBlindCredentials
        ? this.state.blindIssuances?.[scopeKey] ?? (credentialIndex === 1 ? this.state.blindIssuance : null)
        : this.state.blindIssuance;
      const tokenSecret = usesScopedBlindCredentials
        ? this.state.blindTokenSecrets?.[scopeKey] ?? (credentialIndex === 1 ? this.state.blindTokenSecret : null)
        : this.state.blindTokenSecret;
      if (!issuance || !tokenSecret) {
        throw new OptionARuntimeError("issuance_failed", "No issued credential is available.");
      }
      const ballotScope = tokenSecret.ballotScope ?? issuance.ballotScope ?? scope;
      const message = buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId: this.state.electionId,
        tokenSecretCommitment: tokenSecret.tokenCommitment,
        ballotScope,
      });
      const credential = await finalizeQuestionnaireBlindSignature({
        publicKey: tokenSecret.blindSigningPublicKey,
        message,
        blindSignature: issuance.blindSignature,
        blindingFactor: tokenSecret.blindingFactor,
      });
      const localCredentialValid = await verifyQuestionnaireBlindSignature({
        publicKey: tokenSecret.blindSigningPublicKey,
        message,
        signature: credential,
      });
      if (!localCredentialValid) {
        throw new OptionARuntimeError("issuance_failed", "Issued blind signature could not be verified.");
      }
      return [{
        tokenCommitment: tokenSecret.tokenCommitment,
        blindSigningKeyId: issuance.blindSigningKeyId,
        credential,
        nullifier: deriveQuestionnaireTokenNullifier({
          questionnaireId: this.electionId,
          tokenSecret: tokenSecret.tokenSecret,
          ballotScope,
        }),
        ballotScope,
      }];
    }

    const proofs: BallotCredentialProof[] = [];
    const proofByScopeKey = new Set<string>();
    const credentialIndex = Math.max(1, Math.floor(options?.credentialIndex ?? 1));
    for (const answer of responses) {
      const scope = scopeForQuestion(definition, answer.questionId, credentialIndex, activeBallotGroup);
      const scopeKey = ballotScopeKey(scope);
      if (proofByScopeKey.has(scopeKey)) {
        continue;
      }
      const issuance = this.state.blindIssuances?.[scopeKey] ?? null;
      const tokenSecret = this.state.blindTokenSecrets?.[scopeKey] ?? null;
      if (!issuance || !tokenSecret) {
        throw new OptionARuntimeError("issuance_failed", `No issued credential is available for ${answer.questionId}.`);
      }
      const message = buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId: this.state.electionId,
        tokenSecretCommitment: tokenSecret.tokenCommitment,
        ballotScope: scope,
      });
      const credential = await finalizeQuestionnaireBlindSignature({
        publicKey: tokenSecret.blindSigningPublicKey,
        message,
        blindSignature: issuance.blindSignature,
        blindingFactor: tokenSecret.blindingFactor,
      });
      const localCredentialValid = await verifyQuestionnaireBlindSignature({
        publicKey: tokenSecret.blindSigningPublicKey,
        message,
        signature: credential,
      });
      if (!localCredentialValid) {
        throw new OptionARuntimeError("issuance_failed", `Issued blind signature for ${answer.questionId} could not be verified.`);
      }
      proofByScopeKey.add(scopeKey);
      proofs.push({
        questionId: scope?.questionId ?? answer.questionId,
        tokenCommitment: tokenSecret.tokenCommitment,
        blindSigningKeyId: issuance.blindSigningKeyId,
        credential,
        nullifier: deriveQuestionnaireTokenNullifier({
          questionnaireId: this.electionId,
          tokenSecret: tokenSecret.tokenSecret,
          ballotScope: scope,
        }),
        ballotScope: scope,
      });
    }
    return proofs;
  }

  private responseSecretMaterialsForSubmission(
    definition: QuestionnaireDefinition | null,
    responses = this.state?.draftResponses ?? [],
    options?: { credentialIndex?: number },
  ): ResponseSecretMaterial[] {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const usesPerQuestionCredentials = questionnaireUsesPerQuestionCredentials(definition);
    const usesScopedBlindCredentials = voterUsesScopedBlindCredentials({
      invite: this.state.inviteMessage ?? null,
      privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
      definition,
    });
    const activeBallotGroup = voterBallotGroup({
      invite: this.state.inviteMessage ?? null,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
    });
    if (!usesPerQuestionCredentials) {
      const credentialIndex = Math.max(1, Math.floor(options?.credentialIndex ?? 1));
      const scope = usesScopedBlindCredentials ? withCredentialIndex(ballotGroupScope(activeBallotGroup), credentialIndex) : null;
      const scopeKey = ballotScopeKey(scope);
      const tokenSecret = usesScopedBlindCredentials
        ? this.state.blindTokenSecrets?.[scopeKey] ?? (credentialIndex === 1 ? this.state.blindTokenSecret : null)
        : this.state.blindTokenSecret;
      if (!tokenSecret) {
        throw new OptionARuntimeError("issuance_failed", "No issued credential is available.");
      }
      return [{
        tokenSecret: tokenSecret.tokenSecret,
        tokenCommitment: tokenSecret.tokenCommitment,
        ballotScope: tokenSecret.ballotScope ?? this.state.blindIssuance?.ballotScope ?? scope,
      }];
    }

    const secrets: ResponseSecretMaterial[] = [];
    const seen = new Set<string>();
    const credentialIndex = Math.max(1, Math.floor(options?.credentialIndex ?? 1));
    for (const answer of responses) {
      const scope = scopeForQuestion(definition, answer.questionId, credentialIndex, activeBallotGroup);
      const scopeKey = ballotScopeKey(scope);
      if (seen.has(scopeKey)) {
        continue;
      }
      const tokenSecret = this.state.blindTokenSecrets?.[scopeKey] ?? null;
      if (!tokenSecret) {
        throw new OptionARuntimeError("issuance_failed", `No issued credential is available for ${answer.questionId}.`);
      }
      seen.add(scopeKey);
      secrets.push({
        tokenSecret: tokenSecret.tokenSecret,
        tokenCommitment: tokenSecret.tokenCommitment,
        ballotScope: tokenSecret.ballotScope ?? scope,
      });
    }
    return secrets;
  }

  private async submitVoteInternal(requiredQuestionIds: string[], options?: SubmitVoteOptions) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    optionAFlowLog("voter", "submit_vote_started", {
      electionId: this.state.electionId,
      hasExistingSubmission: Boolean(this.state.submission),
    });
    const definition = readCachedQuestionnaireDefinition(this.state.electionId);
    const targetQuestionIds = [...new Set([
      ...(options?.questionId ? [options.questionId] : []),
      ...(options?.questionIds ?? []),
    ]
      .map((questionId) => questionId.trim())
      .filter(Boolean))];
    const targetQuestionIdSet = new Set(targetQuestionIds);
    const submissionResponses = targetQuestionIdSet.size > 0
      ? this.state.draftResponses.filter((answer) => targetQuestionIdSet.has(answer.questionId))
      : this.state.draftResponses;
    const credentialIndex = options?.credentialIndex ?? 1;
    const activeBallotGroup = voterBallotGroup({
      invite: this.state.inviteMessage ?? null,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
    });
    const targetSubmissionKeys = definition && targetQuestionIds.length > 0
      ? [...new Set(targetQuestionIds.map((questionId) => ballotScopeKey(scopeForQuestion(definition, questionId, credentialIndex, activeBallotGroup))))]
      : targetQuestionIds;
    const existingQuestionSubmissions = targetQuestionIds
      .map((questionId) => {
        const scopedKey = definition ? ballotScopeKey(scopeForQuestion(definition, questionId, credentialIndex, activeBallotGroup)) : questionId;
        return this.state?.submissions?.[scopedKey]
          ?? (credentialIndex === 1 ? this.state?.submissions?.[questionId] ?? null : null);
      })
      .filter(Boolean);

    if (targetSubmissionKeys.length > 0 && existingQuestionSubmissions.length >= targetSubmissionKeys.length) {
      optionAFlowLog("voter", "submit_vote_question_already_submitted", {
        electionId: this.state.electionId,
        questionId: targetSubmissionKeys.join(","),
        submissionId: existingQuestionSubmissions[0]?.submissionId ?? "",
      });
      return this.state;
    }

    if (targetQuestionIds.length === 0 && this.state.submission && this.state.responseNsec && this.state.responseNpub) {
      if (this.state.submissionAccepted === true || this.state.submissionAccepted === false) {
        optionAFlowLog("voter", "submit_vote_republish_skipped_decided", {
          electionId: this.state.electionId,
          submissionId: this.state.submission.submissionId,
          submissionAccepted: this.state.submissionAccepted,
        });
        this.refreshIssuanceAndAcceptance();
        return this.state;
      }
      const submissionId = this.state.submission.submissionId;
      const submissionAck = readBallotSubmissionAckRecord(submissionId);
      if (hasRecentAck(submissionAck?.ackedAt, OPTION_A_SUBMISSION_ACK_RETRY_MS)) {
        optionAFlowLog("voter", "submit_vote_republish_skipped_acknowledged", {
          electionId: this.state.electionId,
          submissionId,
          ackedAt: submissionAck?.ackedAt ?? null,
          minRetryMs: OPTION_A_SUBMISSION_ACK_RETRY_MS,
        });
        this.refreshIssuanceAndAcceptance();
        return this.state;
      }
      const nowMs = Date.now();
      const lastAttemptMs = this.submissionRepublishAttemptAtBySubmissionId.get(submissionId) ?? 0;
      if (nowMs - lastAttemptMs < OPTION_A_SUBMISSION_REPUBLISH_RETRY_MS) {
        optionAFlowLog("voter", "submit_vote_republish_skipped_cooldown", {
          electionId: this.state.electionId,
          submissionId,
          minRetryMs: OPTION_A_SUBMISSION_REPUBLISH_RETRY_MS,
        });
        this.refreshIssuanceAndAcceptance();
        return this.state;
      }
      this.submissionRepublishAttemptAtBySubmissionId.set(submissionId, nowMs);
      optionAFlowLog("voter", "submit_vote_republish_existing_public_submission", {
        electionId: this.state.electionId,
        submissionId,
        responseNpub: this.state.responseNpub,
      });
      const existingCredentialBundle = submissionCredentialBundle(this.state.submission);
      const includeExistingCredentialBundle = Array.isArray(this.state.submission.credentialBundle)
        && this.state.submission.credentialBundle.length > 0;
      const republished = await publishQuestionnaireBlindResponsePublic({
        responseNsec: this.state.responseNsec,
        questionnaireId: this.state.electionId,
        responseId: this.state.submission.submissionId,
        submittedAt: Number.isFinite(Date.parse(this.state.submission.submittedAt))
          ? Math.floor(Date.parse(this.state.submission.submittedAt) / 1000)
          : Math.floor(Date.now() / 1000),
        tokenNullifier: this.state.submission.nullifier,
        tokenNullifiers: includeExistingCredentialBundle ? existingCredentialBundle.map((proof) => ({
          questionId: proof.questionId ?? proof.ballotScope?.questionId ?? null,
          tokenNullifier: proof.nullifier,
          ballotScope: proof.ballotScope ?? null,
        })) : undefined,
        tokenProof: {
          tokenCommitment: this.state.submission.tokenCommitment,
          questionnaireId: this.electionId,
          signature: this.state.submission.credential,
          ballotScope: existingCredentialBundle[0]?.ballotScope ?? null,
        },
        tokenProofs: includeExistingCredentialBundle ? existingCredentialBundle.map((proof) => ({
          tokenCommitment: proof.tokenCommitment,
          questionnaireId: submission.electionId,
          signature: proof.credential,
          questionId: proof.questionId ?? proof.ballotScope?.questionId ?? null,
          ballotScope: proof.ballotScope ?? null,
        })) : undefined,
        answers: toQuestionnaireResponseAnswers(this.state.submission.payload.responses, {
          coordinatorNpub: this.state.coordinatorNpub,
          responseSecretKey: decodeNsecSecretKey(this.state.responseNsec),
        }),
        relays: this.getPreferredDmRelays(),
      });
      if (!republished || republished.successes <= 0) {
        throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the public ballot submission.");
      }
      await this.publishBallotSubmissionSelfCopyDm(this.state.submission, { fallbackNsec: this.state.responseNsec });
      void this.publishVoterStateSelfDm({ reason: "submit_vote_republish_existing", force: true });
      return this.state;
    }

    const credentialBundle = await this.buildSubmissionCredentialBundle(definition, submissionResponses, {
      credentialIndex: options?.credentialIndex,
    });
    const primaryCredential = credentialBundle[0];
    if (!primaryCredential) {
      throw new OptionARuntimeError("invalid_submission", "No answers are ready to submit.");
    }
    const includeCredentialBundle = voterUsesScopedBlindCredentials({
      invite: this.state.inviteMessage ?? null,
      privateInviteCredentialsPerVoter: this.state.privateInviteCredentialsPerVoter,
      privateInviteBallotGroup: this.state.privateInviteBallotGroup,
      definition,
    });
    const responseSecretKey = await deriveDeterministicResponseSecretKey({
      electionId: this.state.electionId,
      secrets: this.responseSecretMaterialsForSubmission(definition, submissionResponses, {
        credentialIndex: options?.credentialIndex,
      }),
    });
    const responseNsec = nip19.nsecEncode(responseSecretKey);
    const responseNpub = nip19.npubEncode(getPublicKey(responseSecretKey));
    optionAFlowLog("voter", "submit_vote_responder_marker_derived", {
      electionId: this.state.electionId,
      responseNpub,
      responseCount: submissionResponses.length,
    });

    const submission: BallotSubmission = {
      type: "ballot_submission",
      schemaVersion: 1,
      electionId: this.state.electionId,
      submissionId: makeId("submission"),
      invitedNpub: responseNpub,
      responseNpub,
      tokenCommitment: primaryCredential.tokenCommitment,
      blindSigningKeyId: primaryCredential.blindSigningKeyId,
      nullifier: primaryCredential.nullifier,
      ...(includeCredentialBundle ? { credentialBundle } : {}),
      payload: {
        electionId: this.state.electionId,
        responses: submissionResponses,
      },
      submittedAt: nowIso(),
      credential: primaryCredential.credential,
    };

    const valid = validateBallotSubmission({
      submission,
      electionId: this.state.electionId,
      electionState: "open",
      requiredQuestionIds,
      definition,
    });
    if (!valid) {
      throw new OptionARuntimeError("invalid_submission", "Submission is invalid or incomplete.");
    }

    const created = reduceVoterEvent(this.state, {
      type: "BALLOT_SUBMISSION_CREATED",
      submission,
    });
    if (!created.ok) {
      throw new OptionARuntimeError("invalid_submission", "Could not create submission.");
    }
    this.state = {
      ...created.state,
      responseNsec,
      responseNpub,
    };
    this.startVoterDmSubscriptions();
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    void this.publishVoterStateSelfDm({ reason: "submit_vote_created", force: true });
    const published = await publishQuestionnaireBlindResponsePublic({
      responseNsec,
      questionnaireId: this.state.electionId,
      responseId: submission.submissionId,
      submittedAt: Number.isFinite(Date.parse(submission.submittedAt))
        ? Math.floor(Date.parse(submission.submittedAt) / 1000)
        : Math.floor(Date.now() / 1000),
      tokenNullifier: submission.nullifier,
      tokenNullifiers: includeCredentialBundle ? credentialBundle.map((proof) => ({
        questionId: proof.questionId ?? proof.ballotScope?.questionId ?? null,
        tokenNullifier: proof.nullifier,
        ballotScope: proof.ballotScope ?? null,
      })) : undefined,
      tokenProof: {
        tokenCommitment: submission.tokenCommitment,
        questionnaireId: this.state.electionId,
        signature: submission.credential,
        ballotScope: primaryCredential.ballotScope ?? null,
      },
        tokenProofs: includeCredentialBundle ? credentialBundle.map((proof) => ({
          tokenCommitment: proof.tokenCommitment,
          questionnaireId: submission.electionId,
        signature: proof.credential,
        questionId: proof.questionId ?? proof.ballotScope?.questionId ?? null,
        ballotScope: proof.ballotScope ?? null,
      })) : undefined,
      answers: toQuestionnaireResponseAnswers(submission.payload.responses, {
        coordinatorNpub: this.state.coordinatorNpub,
        responseSecretKey,
      }),
      relays: this.getPreferredDmRelays(),
    });
    optionAFlowLog("voter", "submit_vote_public_publish_result", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      successes: published?.successes ?? 0,
      failures: published?.failures ?? 0,
    });
    if (!published || published.successes <= 0) {
      throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the public ballot submission.");
    }
    await this.publishBallotSubmissionSelfCopyDm(submission, { fallbackNsec: responseNsec });
    void this.publishVoterStateSelfDm({ reason: "submit_vote_completed", force: true });
    optionAFlowLog("voter", "submit_vote_completed", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      responseNpub,
    });
    return this.state;
  }

  async publishBallotSubmissionDm(
    submission = this.state?.submission ?? null,
    options?: { fallbackNsec?: string },
  ) {
    if (!this.state || !submission || !this.state.coordinatorNpub) {
      return null;
    }
    optionAFlowLog("voter", "submission_publish_attempt", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      coordinatorNpub: this.state.coordinatorNpub,
    });
    try {
      const result = await publishOptionABallotSubmissionDm({
        signer: this.signer,
        recipientNpub: this.state.coordinatorNpub,
        submission,
        fallbackNsec: options?.fallbackNsec ?? this.state.responseNsec ?? this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      return result;
    } catch {
      return null;
    }
  }

  private async publishBallotSubmissionSelfCopyDm(
    submission = this.state?.submission ?? null,
    options?: { fallbackNsec?: string },
  ) {
    if (!this.state || !submission || !this.state.invitedNpub) {
      return null;
    }
    optionAFlowLog("voter", "submission_self_copy_publish_attempt", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      recipientNpub: this.state.invitedNpub,
    });
    try {
      const result = await publishOptionABallotSubmissionDm({
        signer: this.signer,
        recipientNpub: this.state.invitedNpub,
        submission,
        fallbackNsec: options?.fallbackNsec ?? this.state.responseNsec ?? this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      optionAFlowLog("voter", "submission_self_copy_publish_result", {
        electionId: this.state.electionId,
        submissionId: submission.submissionId,
        successes: result.successes,
        failures: result.failures,
      });
      return result;
    } catch (error) {
      optionAFlowLog("voter", "submission_self_copy_publish_failed", {
        electionId: this.state.electionId,
        submissionId: submission.submissionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }
}

export class QuestionnaireOptionACoordinatorRuntime {
  private state: CoordinatorElectionState | null = null;
  private coordinatorNpub: string | null = null;
  private lastSelfStateSnapshotHash: string | null = null;
  private lastSelfStateSnapshotPublishedAt = 0;
  private lastBlindRequestSyncDiagnostics: OptionABlindRequestFetchDiagnostics | null = null;
  private pendingAuthorizationsByNpub: Record<string, BlindBallotRequest[]> = {};
  private pendingParticipantStatusesByNpub: Record<string, OptionAParticipantStatus[]> = {};
  private issuanceDmRepublishRequests = new Map<string, string>();
  private stopBlindRequestSubscription: (() => void) | null = null;
  private stopSubmissionSubscription: (() => void) | null = null;
  private stopBlindIssuanceAckSubscription: (() => void) | null = null;
  private stopParticipantStatusSubscription: (() => void) | null = null;
  private liveBlindRequestProcessInFlight: Promise<void> | null = null;
  private liveSubmissionProcessInFlight: Promise<void> | null = null;
  private processBlindRequestsInFlight: Promise<CoordinatorElectionState> | null = null;
  private processSubmissionsInFlight: Promise<CoordinatorElectionState> | null = null;
  private publishBlindIssuancesInFlight: Promise<number> | null = null;
  private publishAcceptanceResultsInFlight: Promise<number> | null = null;
  private pendingBlindIssuancePublishOptions: {
    forceAll?: boolean;
    requestIds?: string[];
    minRetryMs?: number;
  } | null = null;
  private pendingAcceptancePublishForceAll = false;

  constructor(
    private readonly signer: SignerService,
    private readonly electionId: string,
    private readonly fallbackNsec?: string,
  ) {}

  getSnapshot() {
    return this.state;
  }

  getFlags() {
    if (!this.state) {
      return {
        canSendInvites: false,
        canIssueBlindResponses: false,
        canAcceptVotes: false,
        canPublishResults: false,
      };
    }
    return deriveCoordinatorUiFlags(this.state);
  }

  getAcceptedUniqueCount() {
    return this.state ? countAcceptedUniqueVoters(this.state) : 0;
  }

  getLastBlindRequestSyncDiagnostics() {
    return this.lastBlindRequestSyncDiagnostics;
  }

  getPendingAuthorizations() {
    const invitedNpubs = new Set([
      ...Object.keys(this.pendingAuthorizationsByNpub),
      ...Object.keys(this.pendingParticipantStatusesByNpub),
    ]);
    return [...invitedNpubs]
      .map((invitedNpub) => {
        const requests = this.pendingAuthorizationsByNpub[invitedNpub] ?? [];
        const statuses = this.pendingParticipantStatusesByNpub[invitedNpub] ?? [];
        const requestIds = new Set([
          ...requests.map((request) => request.requestId),
          ...statuses.map((status) => status.requestId).filter((requestId): requestId is string => Boolean(requestId)),
        ]);
        return {
        invitedNpub,
        latestRequest: [...requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
          latestStatus: [...statuses].sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0] ?? null,
          requestCount: Math.max(1, requestIds.size),
        };
      });
  }

  dispose() {
    this.stopCoordinatorDmSubscriptions();
  }

  private isDelegatedIssueBlindTokensEnabled() {
    if (!isDelegatedWorkerCapabilityEnabled({
      electionId: this.electionId,
      capability: "issue_blind_tokens",
    })) {
      return false;
    }
    const routing = selectIssueBlindTokensWorkerRouting({
      summary: loadElectionSummary(this.electionId),
    });
    if (!routing?.workerNpub?.trim()) {
      return false;
    }
    const stored = loadStoredWorkerDelegation(this.electionId);
    if (!stored?.activeDelegation || stored.mode !== "delegated_worker") {
      return false;
    }
    if (routing.delegationId && routing.delegationId !== stored.activeDelegation.delegationId) {
      return false;
    }
    return true;
  }

  private stopCoordinatorDmSubscriptions() {
    this.stopBlindRequestSubscription?.();
    this.stopBlindRequestSubscription = null;
    this.stopSubmissionSubscription?.();
    this.stopSubmissionSubscription = null;
    this.stopBlindIssuanceAckSubscription?.();
    this.stopBlindIssuanceAckSubscription = null;
    this.stopParticipantStatusSubscription?.();
    this.stopParticipantStatusSubscription = null;
  }

  private triggerBlindRequestProcessingFromLive() {
    if (this.liveBlindRequestProcessInFlight) {
      return this.liveBlindRequestProcessInFlight;
    }
    this.liveBlindRequestProcessInFlight = (async () => {
      await this.processPendingBlindRequests();
      await this.publishPendingBlindIssuancesToDm();
    })().finally(() => {
      this.liveBlindRequestProcessInFlight = null;
    });
    return this.liveBlindRequestProcessInFlight;
  }

  private triggerSubmissionProcessingFromLive() {
    if (this.liveSubmissionProcessInFlight) {
      return this.liveSubmissionProcessInFlight;
    }
    this.liveSubmissionProcessInFlight = (async () => {
      await this.processPendingSubmissions([]);
      await this.publishPendingAcceptanceResultsToDm();
    })().finally(() => {
      this.liveSubmissionProcessInFlight = null;
    });
    return this.liveSubmissionProcessInFlight;
  }

  private startCoordinatorDmSubscriptions() {
    this.stopCoordinatorDmSubscriptions();
    if (!this.coordinatorNpub) {
      return;
    }
    const publicSubmissionFlow = shouldUsePublicSubmissionFlow({
      summaryFlowMode: this.state?.election.flowMode ?? null,
      cachedDefinitionFlowMode: readCachedQuestionnaireDefinition(this.electionId)?.flowMode ?? null,
    });
    const relays = this.getPreferredDmRelays();
    this.stopBlindRequestSubscription = subscribeOptionABlindRequestDms({
      signer: this.signer,
      electionId: this.electionId,
      relays,
      onRequest: (request) => {
        enqueueBlindRequest(request);
        void this.triggerBlindRequestProcessingFromLive().catch(() => undefined);
      },
    });
    if (!publicSubmissionFlow) {
      this.stopSubmissionSubscription = subscribeOptionABallotSubmissionDms({
        signer: this.signer,
        electionId: this.electionId,
        relays,
        onSubmission: (submission) => {
          enqueueSubmission(submission);
          void this.triggerSubmissionProcessingFromLive().catch(() => undefined);
        },
      });
    }
    this.stopBlindIssuanceAckSubscription = subscribeOptionABlindIssuanceAckDms({
      signer: this.signer,
      electionId: this.electionId,
      relays,
      onAck: (ack) => {
        this.recordBlindIssuanceAck(ack);
      },
    });
    this.stopParticipantStatusSubscription = subscribeOptionAParticipantStatusDms({
      signer: this.signer,
      electionId: this.electionId,
      workerNpub: this.activeIssuerWorkerNpub() || undefined,
      relays,
      onStatus: (status) => {
        this.applyParticipantStatus(status);
      },
    });
  }

  private activeIssuerWorkerNpub() {
    const stored = loadStoredWorkerDelegation(this.electionId)?.activeDelegation?.workerNpub?.trim() ?? "";
    return stored || selectIssueBlindTokensWorkerRouting({ summary: loadElectionSummary(this.electionId) })?.workerNpub?.trim() || "";
  }

  private applyParticipantStatus(status: OptionAParticipantStatus) {
    if (!this.state || status.electionId !== this.electionId) {
      return false;
    }
    const existing = this.state.whitelist[status.invitedNpub];
    if (!existing) {
      if (status.source !== "issuer_proxy" || status.state !== "ballot_requested") {
        return false;
      }
      const pending = this.pendingParticipantStatusesByNpub[status.invitedNpub] ?? [];
      const alreadySeen = pending.some((entry) => (
        entry.requestId === status.requestId && entry.state === status.state
      ));
      if (!alreadySeen) {
        this.pendingParticipantStatusesByNpub[status.invitedNpub] = [...pending, status];
      }
      this.state = {
        ...this.state,
        lastUpdatedAt: Date.parse(status.observedAt) >= Date.parse(this.state.lastUpdatedAt)
          ? status.observedAt
          : this.state.lastUpdatedAt,
      };
      this.persistCoordinatorState("participant_status_ballot_requested");
      return true;
    }
    const entry: WhitelistEntry = existing;
    const claimOrder = [
      "whitelisted",
      "invited",
      "claimed",
      "blind_request_received",
      "blind_signature_issued",
      "vote_received",
      "vote_accepted",
      "vote_rejected",
    ];
    const targetClaimState = status.state === "ballot_requested"
      ? "blind_request_received"
      : status.state === "ballot_issued" || status.state === "ballot_received"
        ? "blind_signature_issued"
        : "claimed";
    const nextClaimState = claimOrder.indexOf(targetClaimState) > claimOrder.indexOf(entry.claimState)
      ? targetClaimState as WhitelistEntry["claimState"]
      : entry.claimState;
    const nextEntry: WhitelistEntry = {
      ...entry,
      claimState: nextClaimState,
      ...(status.state === "voter_live" ? { voterLastSeenAt: status.observedAt } : {}),
      ...(status.state === "ballot_requested" ? { ballotRequestedAt: status.observedAt } : {}),
      ...(status.state === "ballot_issued" ? { ballotIssuedAt: status.observedAt } : {}),
      ...(status.state === "ballot_received" ? { ballotReceivedAt: status.observedAt } : {}),
      ...(status.issuanceId ? { issuanceId: status.issuanceId } : {}),
    };
    this.state = {
      ...this.state,
      whitelist: {
        ...this.state.whitelist,
        [status.invitedNpub]: nextEntry,
      },
      lastUpdatedAt: Date.parse(status.observedAt) >= Date.parse(this.state.lastUpdatedAt)
        ? status.observedAt
        : this.state.lastUpdatedAt,
    };
    this.persistCoordinatorState(`participant_status_${status.state}`);
    return true;
  }

  private getDmReadSince() {
    const nowSec = Math.round(Date.now() / 1000);
    // Gift-wrap events use randomized created_at values, so anchoring to recently opened rounds
    // can exclude valid fresh events. Use only a fixed lookback floor.
    return Math.max(0, nowSec - OPTION_A_COORDINATOR_DM_LOOKBACK_SECONDS);
  }

  private getPreferredDmRelays() {
    return getPreferredQuestionnaireRelays(this.electionId);
  }

  private rememberPrivateRelaySuccesses(result: { relayResults?: Array<{ relay: string; success: boolean }> } | null | undefined) {
    const relays = extractSuccessfulRelays(result);
    if (relays.length > 0) {
      recordElectionPrivateRelaySuccesses(this.electionId, relays);
    }
  }

  private buildCoordinatorSelfStateSnapshot(state: CoordinatorElectionState): OptionACoordinatorStateSnapshot {
    const { blindSigningPrivateKey: _ignored, ...stateWithoutPrivateKey } = state;
    const pendingAuthorizationsByNpub = Object.fromEntries(
      Object.entries(this.pendingAuthorizationsByNpub).map(([npub, requests]) => [npub, [...requests]]),
    );
    const pendingParticipantStatusesByNpub = Object.fromEntries(
      Object.entries(this.pendingParticipantStatusesByNpub).map(([npub, statuses]) => [npub, [...statuses]]),
    );
    return {
      type: "coordinator_state_snapshot",
      schemaVersion: 1,
      electionId: state.election.electionId,
      coordinatorNpub: state.election.coordinatorNpub,
      state: stateWithoutPrivateKey,
      pendingAuthorizationsByNpub,
      pendingParticipantStatusesByNpub,
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  private async publishCoordinatorStateSelfDm(options?: { force?: boolean; reason?: string }) {
    if (!this.state || !this.coordinatorNpub) {
      return;
    }
    const now = Date.now();
    if (!options?.force && now - this.lastSelfStateSnapshotPublishedAt < OPTION_A_STATE_SELF_COPY_PUBLISH_MIN_INTERVAL_MS) {
      return;
    }
    const snapshot = this.buildCoordinatorSelfStateSnapshot(this.state);
    const fingerprint = await sha256Hex(JSON.stringify(snapshot));
    if (!options?.force && this.lastSelfStateSnapshotHash === fingerprint) {
      return;
    }
    try {
      const result = await publishOptionACoordinatorStateDm({
        signer: this.signer,
        recipientNpub: this.coordinatorNpub,
        snapshot,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      const relayCandidates = result.relayResults.map((entry) => entry.relay);
      const copyCheck = await confirmOptionADmEventCopies({
        eventId: result.eventId ?? "",
        relays: relayCandidates,
        minCopies: OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES,
      });
      if (copyCheck.confirmedCopies >= OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES) {
        this.lastSelfStateSnapshotHash = fingerprint;
        this.lastSelfStateSnapshotPublishedAt = now;
        optionAFlowLog("coordinator", "state_self_copy_publish_result", {
          electionId: this.state.election.electionId,
          coordinatorNpub: this.coordinatorNpub,
          reason: options?.reason ?? "unspecified",
          successes: result.successes,
          failures: result.failures,
          confirmedCopies: copyCheck.confirmedCopies,
          confirmedRelays: copyCheck.confirmedRelays,
        });
      } else {
        optionAFlowLog("coordinator", "state_self_copy_publish_insufficient_copies", {
          electionId: this.state.election.electionId,
          coordinatorNpub: this.coordinatorNpub,
          reason: options?.reason ?? "unspecified",
          eventId: result.eventId,
          successes: result.successes,
          failures: result.failures,
          confirmedCopies: copyCheck.confirmedCopies,
          checkedRelays: copyCheck.checkedRelays,
          requiredCopies: OPTION_A_STATE_SELF_COPY_MIN_RELAY_COPIES,
        });
      }
    } catch (error) {
      optionAFlowLog("coordinator", "state_self_copy_publish_failed", {
        electionId: this.state.election.electionId,
        coordinatorNpub: this.coordinatorNpub,
        reason: options?.reason ?? "unspecified",
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private persistCoordinatorState(reason: string, options?: { force?: boolean }) {
    if (!this.state || !this.coordinatorNpub) {
      return;
    }
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    void this.publishCoordinatorStateSelfDm({
      reason,
      force: options?.force,
    });
  }

  private applyRecoveredCoordinatorStateSnapshot(snapshot: OptionACoordinatorStateSnapshot) {
    if (!this.state || !this.coordinatorNpub) {
      return false;
    }
    if (snapshot.electionId !== this.state.election.electionId || snapshot.coordinatorNpub !== this.coordinatorNpub) {
      return false;
    }
    const currentUpdatedAtMs = Date.parse(this.state.lastUpdatedAt);
    const snapshotUpdatedAtMs = Date.parse(snapshot.lastUpdatedAt);
    const snapshotLooksNewer = Number.isFinite(snapshotUpdatedAtMs) && (
      !Number.isFinite(currentUpdatedAtMs) || snapshotUpdatedAtMs >= currentUpdatedAtMs
    );
    const fillsMissingProgress = (
      Object.keys(snapshot.state.issuedBlindResponses).length > Object.keys(this.state.issuedBlindResponses).length
      || Object.keys(snapshot.state.receivedSubmissions).length > Object.keys(this.state.receivedSubmissions).length
      || Object.keys(snapshot.state.acceptanceResults).length > Object.keys(this.state.acceptanceResults).length
      || Object.keys(snapshot.state.bearerInviteCodes ?? {}).length > Object.keys(this.state.bearerInviteCodes ?? {}).length
      || Object.keys(snapshot.pendingAuthorizationsByNpub ?? {}).length > Object.keys(this.pendingAuthorizationsByNpub).length
      || Object.keys(snapshot.pendingParticipantStatusesByNpub ?? {}).length > Object.keys(this.pendingParticipantStatusesByNpub).length
    );
    if (!snapshotLooksNewer && !fillsMissingProgress) {
      return false;
    }

    const merged = restoreCoordinatorElectionState({
      persisted: {
        ...this.state,
        election: {
          ...this.state.election,
          ...snapshot.state.election,
        },
        whitelist: {
          ...this.state.whitelist,
          ...snapshot.state.whitelist,
        },
        bearerInviteCodes: {
          ...(this.state.bearerInviteCodes ?? {}),
          ...(snapshot.state.bearerInviteCodes ?? {}),
        },
        pendingBlindRequests: {
          ...this.state.pendingBlindRequests,
          ...snapshot.state.pendingBlindRequests,
        },
        issuedBlindResponses: {
          ...this.state.issuedBlindResponses,
          ...snapshot.state.issuedBlindResponses,
        },
        receivedSubmissions: {
          ...this.state.receivedSubmissions,
          ...snapshot.state.receivedSubmissions,
        },
        acceptedNullifiers: {
          ...this.state.acceptedNullifiers,
          ...snapshot.state.acceptedNullifiers,
        },
        acceptanceResults: {
          ...this.state.acceptanceResults,
          ...snapshot.state.acceptanceResults,
        },
        blindSigningPrivateKey: this.state.blindSigningPrivateKey ?? null,
        lastUpdatedAt: snapshotLooksNewer ? snapshot.lastUpdatedAt : this.state.lastUpdatedAt,
      },
    });
    this.pendingAuthorizationsByNpub = {
      ...this.pendingAuthorizationsByNpub,
      ...(snapshot.pendingAuthorizationsByNpub ?? {}),
    };
    this.pendingParticipantStatusesByNpub = {
      ...this.pendingParticipantStatusesByNpub,
      ...(snapshot.pendingParticipantStatusesByNpub ?? {}),
    };
    this.state = merged;
    upsertElectionSummary(this.state.election);
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    optionAFlowLog("coordinator", "state_self_copy_recovered", {
      electionId: this.state.election.electionId,
      coordinatorNpub: this.coordinatorNpub,
      issuedBlindResponses: Object.keys(this.state.issuedBlindResponses).length,
      receivedSubmissions: Object.keys(this.state.receivedSubmissions).length,
      acceptanceResults: Object.keys(this.state.acceptanceResults).length,
      pendingAuthorizations: Object.keys(this.pendingAuthorizationsByNpub).length,
    });
    return true;
  }

  async recoverCoordinatorStateFromSelfDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const coordinatorNsec = this.fallbackNsec?.trim() ?? "";
    const since = Math.floor(Date.now() / 1000) - OPTION_A_SELF_COPY_RECOVERY_LOOKBACK_SECONDS;
    const snapshots = coordinatorNsec
      ? await fetchOptionACoordinatorStateDmsWithNsec({
        nsec: coordinatorNsec,
        electionId: this.state.election.electionId,
        limit: 120,
        since,
      })
      : await fetchOptionACoordinatorStateDms({
        signer: this.signer,
        electionId: this.state.election.electionId,
        limit: 60,
        maxDecryptAttempts: 60,
        since,
      });
    const latest = snapshots
      .filter((snapshot) => snapshot.electionId === this.state?.election.electionId && snapshot.coordinatorNpub === this.coordinatorNpub)
      .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))[0] ?? null;
    if (latest) {
      this.applyRecoveredCoordinatorStateSnapshot(latest);
    }
    return this.state;
  }

  private async publishBlindRequestAckDm(request: BlindBallotRequest) {
    if (this.shouldSkipBlindRequestAck(request)) {
      optionAFlowLog("coordinator", "blind_request_ack_publish_skipped_downstream_proof", {
        electionId: request.electionId,
        requestId: request.requestId,
        invitedNpub: request.invitedNpub,
      });
      return;
    }
    const delivery = readBlindRequestAckDeliveryRecord(request.requestId);
    if (delivery?.lastSuccessAt) {
      return;
    }
    const ack: BlindRequestAck = {
      type: "blind_ballot_request_ack",
      schemaVersion: 1,
      electionId: request.electionId,
      requestId: request.requestId,
      invitedNpub: request.invitedNpub,
      ackedAt: nowIso(),
    };
    const attemptedAt = nowIso();
    try {
      const result = await publishOptionABlindRequestAckDm({
        signer: this.signer,
        recipientNpub: request.invitedNpub,
        ack,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      optionAFlowLog("coordinator", "blind_request_ack_publish_result", {
        electionId: ack.electionId,
        requestId: ack.requestId,
        successes: result.successes,
        failures: result.failures,
      });
      recordBlindRequestAckDeliveryAttempt({
        requestId: ack.requestId,
        electionId: ack.electionId,
        invitedNpub: ack.invitedNpub,
        attemptedAt,
        delivered: result.successes > 0,
      });
      if (result.successes > 0) {
        this.rememberPrivateRelaySuccesses(result);
      }
    } catch (error) {
      optionAFlowLog("coordinator", "blind_request_ack_publish_failed", {
        electionId: ack.electionId,
        requestId: ack.requestId,
        error: error instanceof Error ? error.message : "unknown",
      });
      recordBlindRequestAckDeliveryAttempt({
        requestId: ack.requestId,
        electionId: ack.electionId,
        invitedNpub: ack.invitedNpub,
        attemptedAt,
        delivered: false,
      });
    }
  }

  private async publishBallotSubmissionAckDm(submission: BallotSubmission) {
    const responseNpub = submission.responseNpub ?? submission.invitedNpub;
    const delivery = readBallotSubmissionAckDeliveryRecord(submission.submissionId);
    if (delivery?.lastSuccessAt) {
      return;
    }
    const ack: BallotSubmissionAck = {
      type: "ballot_submission_ack",
      schemaVersion: 1,
      electionId: submission.electionId,
      submissionId: submission.submissionId,
      responseNpub,
      ackedAt: nowIso(),
    };
    const attemptedAt = nowIso();
    try {
      const result = await publishOptionABallotSubmissionAckDm({
        signer: this.signer,
        recipientNpub: responseNpub,
        ack,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      optionAFlowLog("coordinator", "submission_ack_publish_result", {
        electionId: ack.electionId,
        submissionId: ack.submissionId,
        responseNpub,
        successes: result.successes,
        failures: result.failures,
      });
      recordBallotSubmissionAckDeliveryAttempt({
        submissionId: ack.submissionId,
        electionId: ack.electionId,
        responseNpub,
        attemptedAt,
        delivered: result.successes > 0,
      });
      if (result.successes > 0) {
        this.rememberPrivateRelaySuccesses(result);
      }
    } catch (error) {
      optionAFlowLog("coordinator", "submission_ack_publish_failed", {
        electionId: ack.electionId,
        submissionId: ack.submissionId,
        responseNpub,
        error: error instanceof Error ? error.message : "unknown",
      });
      recordBallotSubmissionAckDeliveryAttempt({
        submissionId: ack.submissionId,
        electionId: ack.electionId,
        responseNpub,
        attemptedAt,
        delivered: false,
      });
    }
  }

  private maybeQueueIssuanceRepublish(issuance: BlindBallotIssuance, request: BlindBallotRequest) {
    const requestSentAt = request.lastSentAt ?? request.createdAt;
    const requestSentMs = Date.parse(requestSentAt);
    const issuedMs = Date.parse(issuance.issuedAt);
    if (!Number.isFinite(requestSentMs) || !Number.isFinite(issuedMs) || requestSentMs <= issuedMs) {
      return;
    }
    const delivery = readBlindIssuanceDeliveryRecord(issuance.requestId);
    if (delivery?.requestLastSentAt === requestSentAt) {
      return;
    }
    if (this.isBlindIssuanceAcked(issuance)) {
      return;
    }
    this.issuanceDmRepublishRequests.set(issuance.requestId, requestSentAt);
  }

  private isBlindIssuanceAcked(issuance: BlindBallotIssuance) {
    const ack = readBlindIssuanceAckRecord(issuance.requestId);
    return Boolean(ack && ack.issuanceId === issuance.issuanceId);
  }

  private recordBlindIssuanceAck(ack: BlindIssuanceAck) {
    storeBlindIssuanceAckRecord({
      requestId: ack.requestId,
      electionId: ack.electionId,
      invitedNpub: ack.invitedNpub,
      issuanceId: ack.issuanceId,
      ackedAt: ack.ackedAt,
    });
    this.issuanceDmRepublishRequests.delete(ack.requestId);
    const request = this.state?.pendingBlindRequests[ack.requestId] ?? null;
    const whitelistEntry = this.state?.whitelist[ack.invitedNpub] ?? null;
    const confirmsKnownRequest = Boolean(
      this.state
      && request
      && whitelistEntry
      && ack.electionId === this.electionId
      && request.electionId === ack.electionId
      && request.invitedNpub === ack.invitedNpub,
    );
    if (this.state && request && whitelistEntry && confirmsKnownRequest) {
      const alreadyPastIssuance = ["vote_received", "vote_accepted", "vote_rejected"].includes(whitelistEntry.claimState);
      this.state = {
        ...this.state,
        whitelist: {
          ...this.state.whitelist,
          [ack.invitedNpub]: {
            ...whitelistEntry,
            claimState: alreadyPastIssuance ? whitelistEntry.claimState : "blind_signature_issued",
            issuanceId: ack.issuanceId,
          },
        },
        lastUpdatedAt: ack.ackedAt,
      };
      this.persistCoordinatorState("blind_issuance_ack_received");
    }
    optionAFlowLog("coordinator", "blind_issuance_ack_received", {
      electionId: ack.electionId,
      requestId: ack.requestId,
      issuanceId: ack.issuanceId,
      invitedNpub: ack.invitedNpub,
    });
  }

  private shouldSkipBlindRequestAck(request: BlindBallotRequest) {
    const issuance = this.state?.issuedBlindResponses[request.requestId] ?? readBlindIssuance(request.requestId);
    if (!issuance) {
      return false;
    }
    if (this.isBlindIssuanceAcked(issuance)) {
      return true;
    }
    return false;
  }

  async loginWithSigner(summary?: Partial<ElectionSummary>) {
    this.coordinatorNpub = toNpub(await this.signer.getPublicKey());
    const state = this.ensureCoordinatorState(summary);
    await this.recoverCoordinatorStateFromSelfDm().catch(() => this.state ?? state);
    await this.ensureBlindSigningKey();
    this.startCoordinatorDmSubscriptions();
    void this.publishCoordinatorStateSelfDm({ reason: "login_with_signer" });
    return this.state ?? state;
  }

  bootstrapCoordinatorNpub(input: {
    coordinatorNpub: string;
    summary?: Partial<ElectionSummary>;
    startDmSubscriptions?: boolean;
    recoverSelfState?: boolean;
    publishSelfState?: boolean;
  }) {
    const nextCoordinatorNpub = toNpub(input.coordinatorNpub);
    const coordinatorChanged = this.coordinatorNpub !== nextCoordinatorNpub;
    this.coordinatorNpub = nextCoordinatorNpub;
    const state = this.ensureCoordinatorState(input.summary);
    if (input.startDmSubscriptions ?? true) {
      const publicSubmissionFlow = shouldUsePublicSubmissionFlow({
        summaryFlowMode: state.election.flowMode ?? null,
        cachedDefinitionFlowMode: readCachedQuestionnaireDefinition(this.electionId)?.flowMode ?? null,
      });
      const subscriptionsMissing = publicSubmissionFlow
        ? !this.stopBlindRequestSubscription
        : !this.stopBlindRequestSubscription || !this.stopSubmissionSubscription;
      if (coordinatorChanged || subscriptionsMissing) {
        this.startCoordinatorDmSubscriptions();
      }
    }
    if (input.recoverSelfState ?? true) {
      void this.recoverCoordinatorStateFromSelfDm().catch(() => this.state ?? state);
    }
    if (input.publishSelfState ?? true) {
      void this.publishCoordinatorStateSelfDm({ reason: "bootstrap_local_identity" });
    }
    return state;
  }

  async ensureBlindSigningPublicKey() {
    const privateKey = await this.ensureBlindSigningKey();
    return toQuestionnaireBlindPublicKey(privateKey);
  }

  private ensureCoordinatorState(summary?: Partial<ElectionSummary>) {
    if (!this.coordinatorNpub) {
      throw new OptionARuntimeError("coordinator_missing", "Organiser npub is missing.");
    }
    const existing = loadCoordinatorState({ coordinatorNpub: this.coordinatorNpub, electionId: this.electionId });
    if (existing) {
      this.state = restoreCoordinatorElectionState({
        persisted: {
          ...existing,
          election: mergeElectionSummaryIntoCoordinatorElection(existing.election, summary),
        },
      });
      upsertElectionSummary(this.state.election);
      return this.state;
    }

    const nextSummary: ElectionSummary = {
      electionId: this.electionId,
      title: summary?.title ?? "Questionnaire",
      description: summary?.description ?? "",
      state: summary?.state ?? "open",
      openedAt: summary?.openedAt ?? nowIso(),
      closedAt: summary?.closedAt ?? null,
      coordinatorNpub: this.coordinatorNpub,
      blindSigningPublicKey: summary?.blindSigningPublicKey ?? null,
      questionnaireRelays: summary?.questionnaireRelays,
      issueBlindTokensWorker: summary?.issueBlindTokensWorker ?? null,
      protocolVersion: summary?.protocolVersion,
      flowMode: summary?.flowMode,
      responseMode: summary?.responseMode,
    };
    upsertElectionSummary(nextSummary);
    const created = emptyCoordinatorState(nextSummary);
    this.state = created;
    this.persistCoordinatorState("coordinator_state_created", { force: true });
    return created;
  }

  private refreshElectionSummaryFromLocalPublication() {
    if (!this.state) {
      return null;
    }
    const localSummary = buildLocalPublishedElectionSummary(this.electionId, this.state.election);
    if (!localSummary) {
      return this.state;
    }
    const mergedElection = mergeElectionSummaryIntoCoordinatorElection(this.state.election, localSummary);
    if (JSON.stringify(mergedElection) === JSON.stringify(this.state.election)) {
      return this.state;
    }
    this.state = {
      ...this.state,
      election: mergedElection,
      lastUpdatedAt: nowIso(),
    };
    upsertElectionSummary(mergedElection);
    this.persistCoordinatorState("refresh_local_published_election_summary", { force: true });
    return this.state;
  }

  private async ensureBlindSigningKey(): Promise<QuestionnaireBlindPrivateKey> {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    if (this.state.blindSigningPrivateKey) {
      const existingPrivateKey = this.state.blindSigningPrivateKey;
      const existingPublicKey = toQuestionnaireBlindPublicKey(existingPrivateKey);
      if (this.state.election.blindSigningPublicKey?.keyId !== existingPublicKey.keyId) {
        this.state = {
          ...this.state,
          election: {
            ...this.state.election,
            blindSigningPublicKey: existingPublicKey,
          },
        };
        upsertElectionSummary(this.state.election);
        this.persistCoordinatorState("blind_signing_public_key_backfilled");
      }
      return existingPrivateKey;
    }
    const privateKey = await generateQuestionnaireBlindKeyPair();
    this.state = {
      ...this.state,
      blindSigningPrivateKey: privateKey,
      election: {
        ...this.state.election,
        blindSigningPublicKey: toQuestionnaireBlindPublicKey(privateKey),
      },
    };
    upsertElectionSummary(this.state.election);
    this.persistCoordinatorState("blind_signing_key_generated", { force: true });
    return privateKey;
  }

  addWhitelistNpub(invitedNpub: string, options?: {
    credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
    ballotGroup?: string | null;
  }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalizedInvitedNpub = toNpub(invitedNpub);
    if (!normalizedInvitedNpub) {
      throw new OptionARuntimeError("invalid_submission", "Invite target npub is invalid.");
    }
    const credentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(options?.credentialsPerVoter);
    const ballotGroup = normaliseQuestionnaireBallotGroup(options?.ballotGroup);
    const existing = this.state.whitelist[normalizedInvitedNpub];
    if (existing) {
      const credentialsChanged = options?.credentialsPerVoter !== undefined && (existing.credentialsPerVoter ?? 1) !== credentialsPerVoter;
      const groupChanged = options?.ballotGroup !== undefined && (existing.ballotGroup ?? null) !== ballotGroup;
      if (credentialsChanged || groupChanged) {
        this.state = {
          ...this.state,
          whitelist: {
            ...this.state.whitelist,
            [normalizedInvitedNpub]: {
              ...existing,
              ...(credentialsChanged ? { credentialsPerVoter } : {}),
              ...(options?.ballotGroup !== undefined ? { ballotGroup } : {}),
            },
          },
          lastUpdatedAt: nowIso(),
        };
        this.persistCoordinatorState("whitelist_settings_updated", { force: true });
      }
      return this.state;
    }
    const entry: WhitelistEntry = {
      electionId: this.electionId,
      invitedNpub: normalizedInvitedNpub,
      addedAt: nowIso(),
      credentialsPerVoter,
      ballotGroup,
      claimState: "whitelisted",
    };
    const reduced = reduceCoordinatorEvent(this.state, {
      type: "WHITELIST_ADDED",
      entry,
    });
    if (!reduced.ok) {
      throw new OptionARuntimeError("invalid_submission", "Could not add whitelist entry.");
    }
    this.state = reduced.state;
    this.persistCoordinatorState("whitelist_added", { force: true });
    return this.state;
  }

  setWhitelistCredentialsPerVoter(invitedNpub: string, credentialsPerVoter: QuestionnaireCredentialsPerVoter) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalizedInvitedNpub = toNpub(invitedNpub);
    const existing = normalizedInvitedNpub ? this.state.whitelist[normalizedInvitedNpub] : null;
    if (!normalizedInvitedNpub || !existing) {
      return this.state;
    }
    const nextCredentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(credentialsPerVoter);
    if ((existing.credentialsPerVoter ?? 1) === nextCredentialsPerVoter) {
      return this.state;
    }
    this.state = {
      ...this.state,
      whitelist: {
        ...this.state.whitelist,
        [normalizedInvitedNpub]: {
          ...existing,
          credentialsPerVoter: nextCredentialsPerVoter,
        },
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("whitelist_credentials_updated", { force: true });
    return this.state;
  }

  setWhitelistBallotGroup(invitedNpub: string, ballotGroup: string | null) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalizedInvitedNpub = toNpub(invitedNpub);
    const existing = normalizedInvitedNpub ? this.state.whitelist[normalizedInvitedNpub] : null;
    if (!normalizedInvitedNpub || !existing) {
      return this.state;
    }
    const nextBallotGroup = normaliseQuestionnaireBallotGroup(ballotGroup);
    if ((existing.ballotGroup ?? null) === nextBallotGroup) {
      return this.state;
    }
    this.state = {
      ...this.state,
      whitelist: {
        ...this.state.whitelist,
        [normalizedInvitedNpub]: {
          ...existing,
          ballotGroup: nextBallotGroup,
        },
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("whitelist_ballot_group_updated", { force: true });
    return this.state;
  }

  addWhitelistNpubs(invitedNpubs: string[], options?: {
    credentialsByNpub?: Record<string, QuestionnaireCredentialsPerVoter>;
    ballotGroupsByNpub?: Record<string, string | null | undefined>;
  }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const uniqueNpubs = [...new Set(
      invitedNpubs
        .map((entry) => toNpub(entry))
        .filter((entry): entry is string => Boolean(entry)),
    )];
    if (uniqueNpubs.length === 0) {
      return {
        state: this.state,
        addedCount: 0,
        changed: false,
      };
    }

    let nextState = this.state;
    let addedCount = 0;
    let changed = false;
    const addedAt = nowIso();
    for (const normalizedInvitedNpub of uniqueNpubs) {
      if (nextState.whitelist[normalizedInvitedNpub]) {
        const existing = nextState.whitelist[normalizedInvitedNpub];
        const explicitCredentials = options?.credentialsByNpub && Object.prototype.hasOwnProperty.call(options.credentialsByNpub, normalizedInvitedNpub)
          ? normaliseQuestionnaireCredentialsPerVoter(options.credentialsByNpub[normalizedInvitedNpub])
          : null;
        const hasExplicitBallotGroup = Boolean(options?.ballotGroupsByNpub && Object.prototype.hasOwnProperty.call(options.ballotGroupsByNpub, normalizedInvitedNpub));
        const explicitBallotGroup = hasExplicitBallotGroup
          ? normaliseQuestionnaireBallotGroup(options?.ballotGroupsByNpub?.[normalizedInvitedNpub])
          : existing.ballotGroup ?? null;
        if (
          (explicitCredentials && (existing.credentialsPerVoter ?? 1) !== explicitCredentials)
          || (hasExplicitBallotGroup && (existing.ballotGroup ?? null) !== explicitBallotGroup)
        ) {
          nextState = {
            ...nextState,
            whitelist: {
              ...nextState.whitelist,
              [normalizedInvitedNpub]: {
                ...existing,
                ...(explicitCredentials ? { credentialsPerVoter: explicitCredentials } : {}),
                ...(hasExplicitBallotGroup ? { ballotGroup: explicitBallotGroup } : {}),
              },
            },
            lastUpdatedAt: nowIso(),
          };
          changed = true;
        }
        continue;
      }
      const credentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(options?.credentialsByNpub?.[normalizedInvitedNpub]);
      const ballotGroup = normaliseQuestionnaireBallotGroup(options?.ballotGroupsByNpub?.[normalizedInvitedNpub]);
      const entry: WhitelistEntry = {
        electionId: this.electionId,
        invitedNpub: normalizedInvitedNpub,
        addedAt,
        credentialsPerVoter,
        ballotGroup,
        claimState: "whitelisted",
      };
      const reduced = reduceCoordinatorEvent(nextState, {
        type: "WHITELIST_ADDED",
        entry,
      });
      if (!reduced.ok) {
        continue;
      }
      nextState = reduced.state;
      addedCount += 1;
      changed = true;
    }
    if (changed) {
      this.state = nextState;
      this.persistCoordinatorState("whitelist_added_batch", { force: true });
    }
    return {
      state: this.state,
      addedCount,
      changed,
    };
  }

  addBearerInviteCode(codeHash: string, options?: {
    credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
    ballotGroup?: string | null;
  }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    if (!isQuestionnaireInviteCodeHash(normalisedHash)) {
      throw new OptionARuntimeError("invalid_submission", "Private invite code is invalid.");
    }
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (existing?.state === "redeemed") {
      return existing;
    }
    const entry: BearerInviteCodeEntry = {
      electionId: this.electionId,
      codeHash: normalisedHash,
      createdAt: existing?.createdAt ?? nowIso(),
      state: existing?.state === "revoked" ? "revoked" : "available",
      credentialsPerVoter: normaliseQuestionnaireCredentialsPerVoter(options?.credentialsPerVoter ?? existing?.credentialsPerVoter),
      ballotGroup: options?.ballotGroup !== undefined
        ? normaliseQuestionnaireBallotGroup(options.ballotGroup)
        : existing?.ballotGroup ?? null,
      note: existing?.note ?? null,
      autoRequestBallot: existing?.autoRequestBallot !== false,
      markedUsedAt: existing?.markedUsedAt ?? null,
      redeemedAt: existing?.redeemedAt ?? null,
      redeemedNpub: existing?.redeemedNpub ?? null,
      revokedAt: existing?.revokedAt ?? null,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: entry,
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("bearer_invite_code_added", { force: true });
    return entry;
  }

  revokeBearerInviteCode(codeHash: string) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing || existing.state !== "available") {
      return existing;
    }
    const revoked: BearerInviteCodeEntry = {
      ...existing,
      state: "revoked",
      revokedAt: nowIso(),
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: revoked,
      },
      lastUpdatedAt: revoked.revokedAt ?? nowIso(),
    };
    this.persistCoordinatorState("bearer_invite_code_revoked", { force: true });
    return revoked;
  }

  toggleBearerInviteCodeAvailability(codeHash: string) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing || existing.state === "redeemed") {
      return existing;
    }
    const now = nowIso();
    const next: BearerInviteCodeEntry = {
      ...existing,
      state: existing.state === "available" ? "revoked" : "available",
      revokedAt: existing.state === "available" ? now : null,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: next,
      },
      lastUpdatedAt: now,
    };
    this.persistCoordinatorState("bearer_invite_code_availability_toggled", { force: true });
    return next;
  }

  updateBearerInviteCodeNote(codeHash: string, note: string) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing) {
      return null;
    }
    const trimmedNote = note.trim();
    const next: BearerInviteCodeEntry = {
      ...existing,
      note: trimmedNote || null,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: next,
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("bearer_invite_code_note_updated");
    return next;
  }

  setBearerInviteCodeMarkedUsed(codeHash: string, markedUsed: boolean) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing) {
      return null;
    }
    const updatedAt = nowIso();
    const nextState = existing.state === "redeemed"
      ? existing.state
      : markedUsed
        ? "revoked"
        : "available";
    const next: BearerInviteCodeEntry = {
      ...existing,
      state: nextState,
      markedUsedAt: markedUsed ? existing.markedUsedAt ?? updatedAt : null,
      revokedAt: nextState === "revoked"
        ? existing.revokedAt ?? updatedAt
        : nextState === "available"
          ? null
          : existing.revokedAt ?? null,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: next,
      },
      lastUpdatedAt: updatedAt,
    };
    this.persistCoordinatorState("bearer_invite_code_marked_used");
    return next;
  }

  setBearerInviteCodeAutoRequestBallot(codeHash: string, autoRequestBallot: boolean) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing) {
      return null;
    }
    const next: BearerInviteCodeEntry = {
      ...existing,
      autoRequestBallot,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: next,
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("bearer_invite_code_auto_request_updated");
    return next;
  }

  setBearerInviteCodeBallotGroup(codeHash: string, ballotGroup: string | null) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalisedHash = (codeHash ?? "").trim().toLowerCase();
    const existing = this.state.bearerInviteCodes?.[normalisedHash] ?? null;
    if (!existing) {
      return null;
    }
    const nextBallotGroup = normaliseQuestionnaireBallotGroup(ballotGroup);
    if ((existing.ballotGroup ?? null) === nextBallotGroup) {
      return existing;
    }
    const next: BearerInviteCodeEntry = {
      ...existing,
      ballotGroup: nextBallotGroup,
    };
    this.state = {
      ...this.state,
      bearerInviteCodes: {
        ...(this.state.bearerInviteCodes ?? {}),
        [normalisedHash]: next,
      },
      lastUpdatedAt: nowIso(),
    };
    this.persistCoordinatorState("bearer_invite_code_ballot_group_updated", { force: true });
    return next;
  }

  private redeemBearerInviteCodeForRequest(
    state: CoordinatorElectionState,
    request: BlindBallotRequest,
  ): CoordinatorElectionState {
    const codeHash = (request.inviteCodeHash ?? "").trim().toLowerCase();
    if (!isQuestionnaireInviteCodeHash(codeHash)) {
      return state;
    }
    const codes = state.bearerInviteCodes ?? {};
    const codeEntry = codes[codeHash] ?? null;
    if (!codeEntry || codeEntry.electionId !== this.electionId || codeEntry.state === "revoked") {
      return state;
    }
    const redeemedNpub = codeEntry.redeemedNpub?.trim() ?? "";
    if (codeEntry.state === "redeemed" && redeemedNpub && redeemedNpub !== request.invitedNpub) {
      return state;
    }

    const redeemedAt = codeEntry.redeemedAt ?? nowIso();
    const credentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(codeEntry.credentialsPerVoter);
    const ballotGroup = normaliseQuestionnaireBallotGroup(codeEntry.ballotGroup);
    const existingWhitelistEntry = state.whitelist[request.invitedNpub] ?? null;
    const whitelistEntry: WhitelistEntry = existingWhitelistEntry
      ? {
        ...existingWhitelistEntry,
        credentialsPerVoter: existingWhitelistEntry.credentialsPerVoter === 2 || credentialsPerVoter === 2 ? 2 : 1,
        ballotGroup: existingWhitelistEntry.ballotGroup ?? ballotGroup,
        inviteCodeHash: existingWhitelistEntry.inviteCodeHash ?? codeHash,
        inviteCodeRedeemedAt: existingWhitelistEntry.inviteCodeRedeemedAt ?? redeemedAt,
      }
      : {
        electionId: this.electionId,
        invitedNpub: request.invitedNpub,
        addedAt: redeemedAt,
        credentialsPerVoter,
        ballotGroup,
        inviteCodeHash: codeHash,
        inviteCodeRedeemedAt: redeemedAt,
        claimState: "whitelisted",
      };

    const redeemedCodeEntry: BearerInviteCodeEntry = {
      ...codeEntry,
      state: "redeemed",
      redeemedAt,
      redeemedNpub: request.invitedNpub,
    };

    return {
      ...state,
      whitelist: {
        ...state.whitelist,
        [request.invitedNpub]: whitelistEntry,
      },
      bearerInviteCodes: {
        ...codes,
        [codeHash]: redeemedCodeEntry,
      },
      lastUpdatedAt: redeemedAt,
    };
  }

  private getBearerInviteCodeRequestBlockReason(
    state: CoordinatorElectionState,
    request: BlindBallotRequest,
  ): "redeemed" | "revoked" | null {
    const codeHash = (request.inviteCodeHash ?? "").trim().toLowerCase();
    if (!isQuestionnaireInviteCodeHash(codeHash)) {
      return null;
    }
    const codeEntry = state.bearerInviteCodes?.[codeHash] ?? null;
    if (!codeEntry || codeEntry.electionId !== this.electionId) {
      return null;
    }
    if (codeEntry.state === "revoked") {
      return "revoked";
    }
    const redeemedNpub = codeEntry.redeemedNpub?.trim() ?? "";
    if (codeEntry.state === "redeemed" && redeemedNpub && redeemedNpub !== request.invitedNpub) {
      return "redeemed";
    }
    return null;
  }

  private configuredBallotGroupForRequest(
    state: CoordinatorElectionState,
    request: BlindBallotRequest,
  ): string | null | undefined {
    const codeHash = (request.inviteCodeHash ?? "").trim().toLowerCase();
    if (isQuestionnaireInviteCodeHash(codeHash)) {
      const codeEntry = state.bearerInviteCodes?.[codeHash];
      if (codeEntry?.electionId === this.electionId) {
        return normaliseQuestionnaireBallotGroup(codeEntry.ballotGroup);
      }
    }
    const whitelistEntry = state.whitelist[request.invitedNpub];
    return whitelistEntry ? normaliseQuestionnaireBallotGroup(whitelistEntry.ballotGroup) : undefined;
  }

  async authorizeRequester(invitedNpub: string, options?: {
    credentialsPerVoter?: QuestionnaireCredentialsPerVoter;
    ballotGroup?: string | null;
  }) {
    const normalizedInvitedNpub = toNpub(invitedNpub);
    optionAFlowLog("coordinator", "authorize_requester", { electionId: this.electionId, invitedNpub: normalizedInvitedNpub || invitedNpub });
    this.addWhitelistNpub(normalizedInvitedNpub || invitedNpub, options?.credentialsPerVoter !== undefined || options?.ballotGroup !== undefined
      ? { credentialsPerVoter: options.credentialsPerVoter, ballotGroup: options.ballotGroup }
      : undefined);
    const pendingForVoter = [...(this.pendingAuthorizationsByNpub[normalizedInvitedNpub || invitedNpub] ?? [])];
    for (const request of pendingForVoter) {
      enqueueBlindRequest(request);
    }
    delete this.pendingAuthorizationsByNpub[normalizedInvitedNpub || invitedNpub];
    delete this.pendingParticipantStatusesByNpub[normalizedInvitedNpub || invitedNpub];
    await this.processPendingBlindRequests();
    const delivered = await this.publishPendingBlindIssuancesToDm({
      requestIds: pendingForVoter.map((request) => request.requestId),
      minRetryMs: 0,
    });
    optionAFlowLog("coordinator", "authorize_requester_processed", {
      electionId: this.electionId,
      invitedNpub: normalizedInvitedNpub || invitedNpub,
      pendingRequestCount: pendingForVoter.length,
      deliveredIssuances: delivered,
    });
    return this.state;
  }

  async sendInvite(invitedNpub: string, meta: { title: string; description: string; voteUrl: string }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const normalizedInvitedNpub = toNpub(invitedNpub);
    if (!normalizedInvitedNpub) {
      throw new OptionARuntimeError("invalid_submission", "Invite target npub is invalid.");
    }
    optionAFlowLog("coordinator", "invite_send_started", {
      electionId: this.electionId,
      invitedNpub: normalizedInvitedNpub,
    });
    if (!this.state.whitelist[normalizedInvitedNpub]) {
      throw new OptionARuntimeError("not_whitelisted", "Invite target is not whitelisted.");
    }
    const credentialsPerVoter = normaliseQuestionnaireCredentialsPerVoter(this.state.whitelist[normalizedInvitedNpub]?.credentialsPerVoter);
    const ballotGroup = normaliseQuestionnaireBallotGroup(this.state.whitelist[normalizedInvitedNpub]?.ballotGroup);
    const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
    const publishedDefinitionEntry = await fetchLatestQuestionnaireDefinitionByCoordinator({
      questionnaireId: this.electionId,
      coordinatorNpub: this.coordinatorNpub,
      relays: getPreferredQuestionnaireRelays(this.electionId),
    }).catch(() => null);
    const referenceDefinition = publishedDefinitionEntry?.definition ?? cachedDefinition;
    const definitionReference = referenceDefinition
      ? buildQuestionnaireDefinitionReference({
        definition: referenceDefinition,
        definitionEventId: publishedDefinitionEntry?.event.id ?? null,
        definitionHash: publishedDefinitionEntry?.definitionHash ?? null,
        relays: getPreferredQuestionnaireRelays(this.electionId),
      })
      : {
        questionnaireId: this.electionId,
        coordinatorNpub: this.coordinatorNpub,
        relays: getPreferredQuestionnaireRelays(this.electionId),
      };
    let issueBlindTokensWorker = selectIssueBlindTokensWorkerRouting({
      summary: loadElectionSummary(this.electionId) ?? this.state.election,
    });
    try {
      const delegation = await fetchQuestionnaireActiveWorkerDelegationForCapability({
        questionnaireId: this.electionId,
        capability: "issue_blind_tokens",
        relays: getPreferredQuestionnaireRelays(this.electionId),
        coordinatorNpub: this.coordinatorNpub,
      });
      if (delegation?.workerNpub?.trim()) {
        issueBlindTokensWorker = buildIssueBlindTokensWorkerRouting({
          delegationId: delegation.delegationId,
          workerNpub: delegation.workerNpub,
          controlRelays: delegation.controlRelays,
          dmRelays: delegation.dmRelays ?? getPreferredQuestionnaireDmRelays(this.electionId),
          expiresAt: delegation.expiresAt,
        });
        this.state.election = withIssueBlindTokensWorkerRouting(this.state.election, issueBlindTokensWorker);
        upsertElectionSummary(this.state.election);
      }
    } catch {
      // Keep cached worker routing hint when fresh public lookup fails.
    }
    const invite: ElectionInviteMessage = {
      type: "election_invite",
      schemaVersion: 1,
      electionId: this.electionId,
      title: meta.title,
      description: meta.description,
      voteUrl: meta.voteUrl,
      invitedNpub: normalizedInvitedNpub,
      coordinatorNpub: this.coordinatorNpub,
      ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}),
      ...(ballotGroup ? { ballotGroup } : {}),
      definitionReference,
      issueBlindTokensWorker,
      expiresAt: null,
    };
    const sent = reduceCoordinatorEvent(this.state, {
      type: "INVITE_SENT",
      electionId: this.electionId,
      invitedNpub: normalizedInvitedNpub,
      inviteEventId: makeId("invite"),
      sentAt: nowIso(),
    });
    if (!sent.ok) {
      throw new OptionARuntimeError("invalid_submission", "Could not mark invite as sent.");
    }
    this.state = sent.state;
    let dmDelivered = false;
    let dmFailureReason: string | null = null;
    try {
      const publishResult = await publishOptionAInviteDm({
        signer: this.signer,
        invite,
        fallbackNsec: this.fallbackNsec,
      });
      dmDelivered = publishResult.successes > 0;
      optionAFlowLog("coordinator", "invite_dm_publish_result", {
        electionId: this.electionId,
        invitedNpub: normalizedInvitedNpub,
        successes: publishResult.successes,
        failures: publishResult.failures,
      });
      if (!dmDelivered) {
        dmFailureReason = "No relay accepted the invite DM publish.";
      }
    } catch (error) {
      dmFailureReason = error instanceof Error ? error.message : "Invite DM publish failed.";
    }
    publishInviteToMailbox(invite);
    this.persistCoordinatorState("invite_sent", { force: true });
    return {
      invite,
      dmDelivered,
      dmFailureReason,
    };
  }

  async syncBlindRequestsFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    try {
      const since = this.getDmReadSince();
      let diagnostics: OptionABlindRequestFetchDiagnostics | null = null;
      const requests = this.fallbackNsec?.trim()
        ? await fetchOptionABlindRequestDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
          since,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
          diagnosticsSink: (next) => {
            diagnostics = next;
          },
        })
        : await fetchOptionABlindRequestDms({
          signer: this.signer,
          electionId: this.electionId,
          relays: this.getPreferredDmRelays(),
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
          diagnosticsSink: (next) => {
            diagnostics = next;
          },
        });
      for (const request of requests) {
        if (this.shouldSkipBlindRequestAck(request)) {
          dequeueBlindRequest(request.requestId);
          continue;
        }
        enqueueBlindRequest(request);
      }
      const syncDiagnostics = diagnostics as OptionABlindRequestFetchDiagnostics | null;
      if (syncDiagnostics) {
        this.lastBlindRequestSyncDiagnostics = syncDiagnostics;
        optionAFlowLog("coordinator", "blind_requests_sync_diagnostics", {
          electionId: this.electionId,
          ...syncDiagnostics,
        });
      }
      optionAFlowLog("coordinator", "blind_requests_synced", {
        electionId: this.electionId,
        count: requests.length,
      });
      return requests.length;
    } catch {
      return 0;
    }
  }

  async publishPendingBlindIssuancesToDm(options?: {
    forceAll?: boolean;
    requestIds?: string[];
    minRetryMs?: number;
  }): Promise<number> {
    if (this.publishBlindIssuancesInFlight) {
      const pending = this.pendingBlindIssuancePublishOptions ?? {};
      const requestIds = new Set([...(pending.requestIds ?? []), ...(options?.requestIds ?? [])]);
      this.pendingBlindIssuancePublishOptions = {
        forceAll: Boolean(pending.forceAll || options?.forceAll),
        requestIds: [...requestIds],
        minRetryMs: Math.min(
          pending.minRetryMs ?? Number.POSITIVE_INFINITY,
          options?.minRetryMs ?? Number.POSITIVE_INFINITY,
        ),
      };
      if (!Number.isFinite(this.pendingBlindIssuancePublishOptions.minRetryMs ?? Number.NaN)) {
        delete this.pendingBlindIssuancePublishOptions.minRetryMs;
      }
      return this.publishBlindIssuancesInFlight;
    }
    this.publishBlindIssuancesInFlight = this.publishPendingBlindIssuancesToDmInternal(options).finally(() => {
      this.publishBlindIssuancesInFlight = null;
    });
    const delivered = await this.publishBlindIssuancesInFlight;
    const pendingOptions = this.pendingBlindIssuancePublishOptions;
    this.pendingBlindIssuancePublishOptions = null;
    if (pendingOptions) {
      const nextDelivered = await this.publishPendingBlindIssuancesToDm(pendingOptions);
      return delivered + nextDelivered;
    }
    return delivered;
  }

  private async publishPendingBlindIssuancesToDmInternal(options?: {
    forceAll?: boolean;
    requestIds?: string[];
    minRetryMs?: number;
  }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    if (this.isDelegatedIssueBlindTokensEnabled()) {
      optionAFlowLog("coordinator", "blind_issuance_publish_skipped_delegated_worker", {
        electionId: this.electionId,
      });
      return 0;
    }

    const forcedRequestIds = new Set([
      ...this.issuanceDmRepublishRequests.keys(),
      ...(options?.requestIds ?? []),
    ]);
    const minRetryMs = options?.minRetryMs ?? OPTION_A_ISSUANCE_DM_RETRY_MS;
    const issued = Object.values(this.state.issuedBlindResponses)
      .map((issuance) => this.enrichIssuanceWithDefinitionReference(issuance))
      .filter((issuance) => {
        if (options?.forceAll || forcedRequestIds.has(issuance.requestId)) {
          return true;
        }
        if (this.isBlindIssuanceAcked(issuance)) {
          return false;
        }
        const delivery = readBlindIssuanceDeliveryRecord(issuance.requestId);
        if (!delivery?.lastAttemptAt) {
          return true;
        }
        // Keep bounded retries until we receive an explicit issuance ACK (or see a valid submission).
        // A single relay-accepted publish is not a guaranteed recipient delivery on public relays.
        const lastAttemptMs = Date.parse(delivery.lastAttemptAt);
        const retryMs = delivery.lastSuccessAt
          ? minRetryMs
          : Math.min(minRetryMs, OPTION_A_ISSUANCE_DM_FAILED_RETRY_MS);
        return !Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs >= retryMs;
      });
    let delivered = 0;
    const issuancesByRecipient = new Map<string, BlindBallotIssuance[]>();
    for (const issuance of issued) {
      const entries = issuancesByRecipient.get(issuance.invitedNpub) ?? [];
      entries.push(issuance);
      issuancesByRecipient.set(issuance.invitedNpub, entries);
    }
    for (const recipientIssuances of issuancesByRecipient.values()) {
      const attemptedAt = nowIso();
      let eventId: string | null = null;
      let success = false;
      try {
        const result = recipientIssuances.length > 1
          ? await publishOptionABlindIssuanceBundleDm({
            signer: this.signer,
            recipientNpub: recipientIssuances[0].invitedNpub,
            issuances: recipientIssuances,
            definitionHash: recipientIssuances.find((issuance) => issuance.definitionHash)?.definitionHash ?? null,
            definitionEventId: recipientIssuances.find((issuance) => issuance.definitionEventId)?.definitionEventId ?? null,
            fallbackNsec: this.fallbackNsec,
            relays: this.getPreferredDmRelays(),
          })
          : await publishOptionABlindIssuanceDm({
            signer: this.signer,
            recipientNpub: recipientIssuances[0].invitedNpub,
            issuance: recipientIssuances[0],
            fallbackNsec: this.fallbackNsec,
            relays: this.getPreferredDmRelays(),
          });
        eventId = result.eventId;
        success = result.successes > 0;
        if (success) {
          delivered += recipientIssuances.length;
          this.rememberPrivateRelaySuccesses(result);
        }
        optionAFlowLog("coordinator", "blind_issuance_dm_publish_result", {
          electionId: this.electionId,
          requestIds: recipientIssuances.map((issuance) => issuance.requestId),
          successes: result.successes,
          failures: result.failures,
        });
      } catch {
        // Keep best-effort to avoid blocking queue processing.
      } finally {
        for (const issuance of recipientIssuances) {
          recordBlindIssuanceDeliveryAttempt({
            issuance,
            attemptedAt,
            delivered: success,
            eventId,
            requestLastSentAt: this.issuanceDmRepublishRequests.get(issuance.requestId) ?? null,
          });
          this.issuanceDmRepublishRequests.delete(issuance.requestId);
        }
      }
    }
    return delivered;
  }

  private enrichIssuanceWithDefinitionReference(issuance: BlindBallotIssuance): BlindBallotIssuance {
    if (issuance.definitionHash && !issuance.definition) {
      return issuance;
    }
    const definition = readCachedQuestionnaireDefinition(this.electionId);
    if (!definition) {
      return issuance;
    }
    return {
      ...issuance,
      definition: undefined,
      definitionHash: issuance.definitionHash ?? questionnaireDefinitionHash(definition),
      definitionEventId: issuance.definitionEventId ?? null,
    };
  }

  async syncBlindIssuanceAcksFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    try {
      const since = this.getDmReadSince();
      const acks = this.fallbackNsec?.trim()
        ? await fetchOptionABlindIssuanceAckDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
        })
        : await fetchOptionABlindIssuanceAckDms({
          signer: this.signer,
          electionId: this.electionId,
          relays: this.getPreferredDmRelays(),
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
          maxDecryptAttempts: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
        });
      for (const ack of acks) {
        this.recordBlindIssuanceAck(ack);
      }
      optionAFlowLog("coordinator", "blind_issuance_acks_synced", {
        electionId: this.electionId,
        count: acks.length,
      });
      return acks.length;
    } catch {
      return 0;
    }
  }

  async syncParticipantStatusesFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    try {
      const since = this.getDmReadSince();
      const publicDelegation = await fetchQuestionnaireActiveWorkerDelegationForCapability({
        questionnaireId: this.electionId,
        capability: "issue_blind_tokens",
        coordinatorNpub: this.coordinatorNpub,
        readRelayLimit: 6,
      }).catch(() => null);
      const workerNpub = publicDelegation?.workerNpub?.trim() || this.activeIssuerWorkerNpub() || undefined;
      const relays = mergeQuestionnaireRelayHints(
        this.getPreferredDmRelays(),
        publicDelegation?.dmRelays,
      );
      const statuses = this.fallbackNsec?.trim()
        ? await fetchOptionAParticipantStatusDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          workerNpub,
          relays,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
          since,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
        })
        : await fetchOptionAParticipantStatusDms({
          signer: this.signer,
          electionId: this.electionId,
          workerNpub,
          relays,
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
          maxDecryptAttempts: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          pageLimit: OPTION_A_COORDINATOR_DM_PAGE_LIMIT,
          maxPages: OPTION_A_COORDINATOR_DM_MAX_PAGES,
          timeBudgetMs: OPTION_A_COORDINATOR_DM_TIME_BUDGET_MS,
        });
      statuses
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
        .forEach((status) => this.applyParticipantStatus(status));
      return statuses.length;
    } catch {
      return 0;
    }
  }

  async syncSubmissionsFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    if (isDelegatedWorkerCapabilityEnabled({
      electionId: this.electionId,
      capability: "verify_public_submissions",
    }) || isDelegatedWorkerCapabilityEnabled({
      electionId: this.electionId,
      capability: "publish_submission_decisions",
    })) {
      optionAFlowLog("coordinator", "submissions_sync_skipped_delegated_worker", {
        electionId: this.electionId,
      });
      return 0;
    }
    const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
    const publicSubmissionFlow = shouldUsePublicSubmissionFlow({
      summaryFlowMode: this.state.election.flowMode ?? null,
      cachedDefinitionFlowMode: cachedDefinition?.flowMode ?? null,
    });
    if (publicSubmissionFlow) {
      optionAFlowLog("coordinator", "submissions_sync_skipped_public_submission_flow", {
        electionId: this.electionId,
      });
      return 0;
    }

    try {
      const since = this.getDmReadSince();
      const submissions = this.fallbackNsec?.trim()
        ? await fetchOptionABallotSubmissionDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
          since,
        })
        : await fetchOptionABallotSubmissionDms({
          signer: this.signer,
          electionId: this.electionId,
          relays: this.getPreferredDmRelays(),
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
        });
      for (const submission of submissions) {
        enqueueSubmission(submission);
      }
      optionAFlowLog("coordinator", "submissions_synced", {
        electionId: this.electionId,
        count: submissions.length,
      });
      return submissions.length;
    } catch {
      return 0;
    }
  }

  async publishPendingAcceptanceResultsToDm(options?: { forceAll?: boolean }): Promise<number> {
    if (this.publishAcceptanceResultsInFlight) {
      this.pendingAcceptancePublishForceAll = this.pendingAcceptancePublishForceAll || Boolean(options?.forceAll);
      return this.publishAcceptanceResultsInFlight;
    }
    this.publishAcceptanceResultsInFlight = this.publishPendingAcceptanceResultsToDmInternal(options).finally(() => {
      this.publishAcceptanceResultsInFlight = null;
    });
    const delivered = await this.publishAcceptanceResultsInFlight;
    if (this.pendingAcceptancePublishForceAll) {
      this.pendingAcceptancePublishForceAll = false;
      const nextDelivered = await this.publishPendingAcceptanceResultsToDm({ forceAll: true });
      return delivered + nextDelivered;
    }
    return delivered;
  }

  private async publishPendingAcceptanceResultsToDmInternal(options?: { forceAll?: boolean }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    const publicSubmissionFlow = shouldUsePublicSubmissionFlow({
      summaryFlowMode: this.state.election.flowMode ?? null,
      cachedDefinitionFlowMode: readCachedQuestionnaireDefinition(this.electionId)?.flowMode ?? null,
    });
    if (publicSubmissionFlow && !options?.forceAll) {
      optionAFlowLog("coordinator", "acceptance_dm_publish_skipped_public_decisions", {
        electionId: this.electionId,
      });
      return 0;
    }

    let delivered = 0;
    for (const acceptance of Object.values(this.state.acceptanceResults)) {
      const submission = this.state.receivedSubmissions[acceptance.submissionId];
      if (!submission) {
        continue;
      }
      const responseNpub = submission.responseNpub ?? submission.invitedNpub;
      const deliveryState = readBallotAcceptanceDeliveryRecord(acceptance.submissionId);
      if (!options?.forceAll && deliveryState?.lastSuccessAt) {
        continue;
      }
      const attemptedAt = nowIso();
      let deliveredNow = false;
      try {
        const result = await publishOptionABallotAcceptanceDm({
          signer: this.signer,
          recipientNpub: responseNpub,
          acceptance,
          fallbackNsec: this.fallbackNsec,
          relays: this.getPreferredDmRelays(),
        });
        if (result.successes > 0) {
          deliveredNow = true;
          delivered += 1;
          this.rememberPrivateRelaySuccesses(result);
        }
        optionAFlowLog("coordinator", "acceptance_dm_publish_result", {
          electionId: this.electionId,
          submissionId: acceptance.submissionId,
          successes: result.successes,
          failures: result.failures,
        });
      } catch {
        // Keep best-effort to avoid blocking response processing.
      } finally {
        recordBallotAcceptanceDeliveryAttempt({
          submissionId: acceptance.submissionId,
          electionId: this.electionId,
          responseNpub,
          attemptedAt,
          delivered: deliveredNow,
        });
      }
    }
    return delivered;
  }

  async processPendingBlindRequests() {
    if (this.processBlindRequestsInFlight) {
      return this.processBlindRequestsInFlight;
    }
    this.processBlindRequestsInFlight = this.processPendingBlindRequestsInternal().finally(() => {
      this.processBlindRequestsInFlight = null;
    });
    return this.processBlindRequestsInFlight;
  }

  private async processPendingBlindRequestsInternal() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    this.refreshElectionSummaryFromLocalPublication();
    const delegatedIssuance = this.isDelegatedIssueBlindTokensEnabled();
    if (delegatedIssuance) {
      optionAFlowLog("coordinator", "process_blind_requests_delegated_worker_observe_only", {
        electionId: this.electionId,
      });
    }
    const queue = listBlindRequests(this.electionId);
    if (queue.length === 0) {
      optionAFlowLog("coordinator", "process_blind_requests_skipped_empty_queue", {
        electionId: this.electionId,
      });
      return this.state;
    }
    const blindSigningPrivateKey = delegatedIssuance ? null : await this.ensureBlindSigningKey();
    const pendingAuthorizationsBefore = JSON.stringify(this.pendingAuthorizationsByNpub);
    const originalState = this.state;
    optionAFlowLog("coordinator", "process_blind_requests_started", {
      electionId: this.electionId,
      queued: queue.length,
    });
    let next = this.state;
    for (const request of queue) {
      const privateInviteBlockReason = this.getBearerInviteCodeRequestBlockReason(next, request);
      if (privateInviteBlockReason) {
        optionAFlowLog("coordinator", "blind_request_rejected_private_invite_unavailable", {
          electionId: this.electionId,
          requestId: request.requestId,
          invitedNpub: request.invitedNpub,
          reason: privateInviteBlockReason,
        });
        dequeueBlindRequest(request.requestId);
        continue;
      }
      const configuredBallotGroup = this.configuredBallotGroupForRequest(next, request);
      if (configuredBallotGroup !== undefined) {
        const expectedScopes = allowedScopesForRequiredScope(configuredBallotGroup);
        const requestedScopes = normaliseQuestionnaireAllowedScopes(
          request.ballotScope?.allowedScopes,
          request.ballotScope?.ballotGroup,
        );
        if (JSON.stringify(expectedScopes) !== JSON.stringify(requestedScopes)) {
          optionAFlowLog("coordinator", "blind_request_rejected_voter_group_mismatch", {
            electionId: this.electionId,
            requestId: request.requestId,
            invitedNpub: request.invitedNpub,
            expectedScopes,
            requestedScopes,
          });
          dequeueBlindRequest(request.requestId);
          continue;
        }
      }
      next = this.redeemBearerInviteCodeForRequest(next, request);
      const claimed = reduceCoordinatorEvent(next, {
        type: "LOGIN_VERIFIED",
        electionId: this.electionId,
        invitedNpub: request.invitedNpub,
      });
      if (claimed.ok) {
        next = claimed.state;
      }
      const whitelistEntry = next.whitelist[request.invitedNpub] ?? null;
      if (
        whitelistEntry
        && ballotScopeCredentialIndex(request.ballotScope) > normaliseQuestionnaireCredentialsPerVoter(whitelistEntry.credentialsPerVoter)
      ) {
        optionAFlowLog("coordinator", "blind_request_rejected_proxy_not_enabled", {
          electionId: this.electionId,
          requestId: request.requestId,
          invitedNpub: request.invitedNpub,
          scope: ballotScopeKey(request.ballotScope),
        });
        dequeueBlindRequest(request.requestId);
        continue;
      }
      const received = reduceCoordinatorEvent(next, {
        type: "BLIND_REQUEST_RECEIVED",
        request,
      });
      if (!received.ok) {
        if (delegatedIssuance) {
          if (received.error === "not_whitelisted") {
            const existing = this.pendingAuthorizationsByNpub[request.invitedNpub] ?? [];
            const alreadySeen = existing.some((entry) => entry.requestId === request.requestId);
            this.pendingAuthorizationsByNpub[request.invitedNpub] = alreadySeen
              ? existing
              : [...existing, request];
          }
          continue;
        }
        const existingIssuance = findIssuedBlindResponse(next, request);
        if (received.error === "already_issued" && existingIssuance) {
          const enriched = this.enrichIssuanceWithDefinitionReference(existingIssuance);
          await this.publishBlindRequestAckDm(request);
          this.maybeQueueIssuanceRepublish(enriched, request);
          next = {
            ...next,
            issuedBlindResponses: {
              ...next.issuedBlindResponses,
              [enriched.requestId]: enriched,
            },
          };
          storeBlindIssuance(enriched);
          dequeueBlindRequest(request.requestId);
        }
        if (received.error === "not_whitelisted") {
          const existing = this.pendingAuthorizationsByNpub[request.invitedNpub] ?? [];
          const alreadySeen = existing.some((entry) => entry.requestId === request.requestId);
          this.pendingAuthorizationsByNpub[request.invitedNpub] = alreadySeen
            ? existing
            : [...existing, request];
        }
        continue;
      }
      next = received.state;
      if (delegatedIssuance) {
        continue;
      }
      if (!blindSigningPrivateKey) {
        continue;
      }
      await this.publishBlindRequestAckDm(request);
      const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
      const definitionHash = cachedDefinition ? questionnaireDefinitionHash(cachedDefinition) : null;
      const existingIssuance = findIssuedBlindResponse(next, request);
      if (existingIssuance) {
        const enriched = this.enrichIssuanceWithDefinitionReference(existingIssuance);
        this.maybeQueueIssuanceRepublish(enriched, request);
        next = {
          ...next,
          issuedBlindResponses: {
            ...next.issuedBlindResponses,
            [enriched.requestId]: enriched,
          },
        };
        storeBlindIssuance(enriched);
        dequeueBlindRequest(request.requestId);
        continue;
      }
      const issuance: BlindBallotIssuance = {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: this.electionId,
        requestId: request.requestId,
        issuanceId: makeId("issuance"),
        invitedNpub: request.invitedNpub,
        blindSigningKeyId: blindSigningPrivateKey.keyId,
        blindSignature: await signBlindedQuestionnaireToken({
          privateKey: blindSigningPrivateKey,
          blindedMessage: request.blindedMessage,
        }),
        ballotScope: request.ballotScope ?? null,
        definitionHash,
        definitionEventId: null,
        issuedAt: nowIso(),
      };
      const issued = reduceCoordinatorEvent(next, {
        type: "BLIND_SIGNATURE_ISSUED",
        issuance,
      });
      if (!issued.ok) {
        continue;
      }
      optionAFlowLog("coordinator", "blind_signature_issued", {
        electionId: this.electionId,
        requestId: request.requestId,
        issuanceId: issuance.issuanceId,
      });
      next = issued.state;
      storeBlindIssuance(issuance);
      dequeueBlindRequest(request.requestId);
    }
    this.state = next;
    const stateChanged = next !== originalState;
    const pendingAuthorizationsChanged = pendingAuthorizationsBefore !== JSON.stringify(this.pendingAuthorizationsByNpub);
    if (stateChanged || pendingAuthorizationsChanged) {
      this.persistCoordinatorState("process_pending_blind_requests");
    }
    return this.state;
  }

  async processPendingSubmissions(requiredQuestionIds: string[]) {
    if (this.processSubmissionsInFlight) {
      return this.processSubmissionsInFlight;
    }
    this.processSubmissionsInFlight = this.processPendingSubmissionsInternal(requiredQuestionIds).finally(() => {
      this.processSubmissionsInFlight = null;
    });
    return this.processSubmissionsInFlight;
  }

  private async processPendingSubmissionsInternal(requiredQuestionIds: string[]) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Organiser login is required.");
    }
    this.refreshElectionSummaryFromLocalPublication();
    if (isDelegatedWorkerCapabilityEnabled({
      electionId: this.electionId,
      capability: "verify_public_submissions",
    }) || isDelegatedWorkerCapabilityEnabled({
      electionId: this.electionId,
      capability: "publish_submission_decisions",
    })) {
      optionAFlowLog("coordinator", "process_submissions_delegated_worker_enabled", {
        electionId: this.electionId,
      });
      return this.state;
    }
    const originalState = this.state;
    let next = this.state;
    const cachedDefinition = readCachedQuestionnaireDefinition(this.electionId);
    const publicSubmissionFlow = shouldUsePublicSubmissionFlow({
      summaryFlowMode: this.state.election.flowMode ?? null,
      cachedDefinitionFlowMode: cachedDefinition?.flowMode ?? null,
    });
    const queue = publicSubmissionFlow ? [] : listSubmissions(this.electionId);
    const queuedSubmissionIds = new Set(queue.map((entry) => entry.submissionId));
    const publicResponses = await fetchQuestionnaireBlindResponses({
      questionnaireId: this.electionId,
      limit: 400,
      relays: this.getPreferredDmRelays(),
    }).catch(() => []);
    for (const entry of publicResponses) {
      const existingSubmission = next.receivedSubmissions[entry.response.responseId];
      if (existingSubmission) {
        continue;
      }
      if (next.acceptanceResults[entry.response.responseId]) {
        continue;
      }
      if (queuedSubmissionIds.has(entry.response.responseId)) {
        continue;
      }
      if (!Array.isArray(entry.response.answers) || entry.response.answers.length === 0) {
        continue;
      }
      const hasBundledCredentials = Boolean(entry.response.tokenProofs?.length || entry.response.tokenNullifiers?.length);
      const responseProofs = entry.response.tokenProofs?.length ? entry.response.tokenProofs : [entry.response.tokenProof];
      const responseNullifiers = entry.response.tokenNullifiers?.length
        ? entry.response.tokenNullifiers
        : [{ tokenNullifier: entry.response.tokenNullifier, ballotScope: entry.response.tokenProof.ballotScope ?? null }];
      const publicKey = next.election.blindSigningPublicKey ?? cachedDefinition?.blindSigningPublicKey ?? null;
      const credentialBundle = responseProofs.map((proof, proofIndex): BallotCredentialProof => ({
        questionId: proof.questionId ?? proof.ballotScope?.questionId ?? responseNullifiers[proofIndex]?.questionId ?? null,
        tokenCommitment: proof.tokenCommitment,
        blindSigningKeyId: publicKey?.keyId ?? "",
        credential: proof.signature,
        nullifier: responseNullifiers[proofIndex]?.tokenNullifier ?? entry.response.tokenNullifier,
        ballotScope: proof.ballotScope ?? responseNullifiers[proofIndex]?.ballotScope ?? null,
      }));
      if (!publicKey) {
        optionAFlowLog("coordinator", "public_submission_skipped_missing_public_key", {
          electionId: this.electionId,
          submissionId: entry.response.responseId,
        });
        continue;
      }
      const blindSigningKeyId = publicKey.keyId;
      const syntheticSubmission: BallotSubmission = {
        type: "ballot_submission",
        schemaVersion: 1,
        electionId: this.electionId,
        submissionId: entry.response.responseId,
        invitedNpub: entry.response.authorPubkey,
        responseNpub: entry.response.authorPubkey,
        tokenCommitment: credentialBundle[0]?.tokenCommitment ?? entry.response.tokenProof.tokenCommitment,
        blindSigningKeyId,
        credential: credentialBundle[0]?.credential ?? entry.response.tokenProof.signature,
        nullifier: credentialBundle[0]?.nullifier ?? entry.response.tokenNullifier,
        ...(hasBundledCredentials ? { credentialBundle } : {}),
        payload: {
          electionId: this.electionId,
          responses: fromQuestionnaireResponseAnswers(entry.response.answers),
        },
        submittedAt: new Date((entry.response.submittedAt ?? entry.event.created_at) * 1000).toISOString(),
      };
      enqueueSubmission(syntheticSubmission);
      queue.push(syntheticSubmission);
      queuedSubmissionIds.add(syntheticSubmission.submissionId);
    }
    optionAFlowLog("coordinator", "process_submissions_started", {
      electionId: this.electionId,
      queued: queue.length,
    });
    for (const submission of queue) {
      const existingDecision = next.acceptanceResults[submission.submissionId];
      if (existingDecision) {
        await this.publishBallotSubmissionAckDm(submission);
        dequeueSubmission(submission.submissionId);
        continue;
      }
      if (next.election.state !== "open" && next.election.state !== "closed" && next.election.state !== "counted") {
        optionAFlowLog("coordinator", "submission_deferred_until_questionnaire_open", {
          electionId: this.electionId,
          submissionId: submission.submissionId,
          state: next.election.state,
        });
        continue;
      }
      const intake = stateForSubmissionIntake({
        state: next,
        submission,
      });
      const received = reduceCoordinatorEvent(intake.state, {
        type: "BALLOT_SUBMISSION_RECEIVED",
        submission,
      });
      if (!received.ok) {
        const rejected: BallotAcceptanceResult = {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId: this.electionId,
          submissionId: submission.submissionId,
          accepted: false,
          reason: inferRejectReason(received.error),
          decidedAt: nowIso(),
        };
        storeAcceptance(rejected);
        await this.publishSubmissionDecisionPublic(submission, rejected);
        dequeueSubmission(submission.submissionId);
        continue;
      }

      next = intake.replayingAfterClose
        ? {
          ...received.state,
          election: next.election,
        }
        : received.state;
      await this.publishBallotSubmissionAckDm(submission);
      const validationElectionState = electionStateForSubmissionValidation({
        submission,
        election: next.election,
      });
      const valid = validateBallotSubmission({
        submission,
        electionId: this.electionId,
        electionState: validationElectionState,
        requiredQuestionIds: scopedRequiredQuestionIdsForSubmission(submission, requiredQuestionIds),
        definition: cachedDefinition,
      });
      if (!valid) {
        const rejected: BallotAcceptanceResult = {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId: this.electionId,
          submissionId: submission.submissionId,
          accepted: false,
          reason: "schema_invalid",
          decidedAt: nowIso(),
        };
        storeAcceptance(rejected);
        await this.publishSubmissionDecisionPublic(submission, rejected);
        dequeueSubmission(submission.submissionId);
        continue;
      }
      const publicKey = next.election.blindSigningPublicKey ?? (
        next.blindSigningPrivateKey ? toQuestionnaireBlindPublicKey(next.blindSigningPrivateKey) : null
      );
      const proofs = submissionCredentialBundle(submission);
      const credentialValid = Boolean(publicKey) && (await Promise.all(proofs.map(async (proof) => {
        return Boolean(
          publicKey
          && proof.blindSigningKeyId === publicKey.keyId
          && await verifyQuestionnaireBlindSignature({
            publicKey,
            message: buildQuestionnaireBlindTokenSignedMessage({
              questionnaireId: this.electionId,
              tokenSecretCommitment: proof.tokenCommitment,
              ballotScope: proof.ballotScope ?? null,
            }),
            signature: proof.credential,
          }),
        );
      }))).every(Boolean);
      if (!credentialValid) {
        const rejected: BallotAcceptanceResult = {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId: this.electionId,
          submissionId: submission.submissionId,
          accepted: false,
          reason: "invalid_credential",
          decidedAt: nowIso(),
        };
        storeAcceptance(rejected);
        await this.publishSubmissionDecisionPublic(submission, rejected);
        dequeueSubmission(submission.submissionId);
        continue;
      }

      const accepted: BallotAcceptanceResult = {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId: this.electionId,
        submissionId: submission.submissionId,
        accepted: true,
        decidedAt: nowIso(),
      };

      const reducedAccepted = reduceCoordinatorEvent(next, {
        type: "BALLOT_ACCEPTED",
        result: accepted,
      });
      if (reducedAccepted.ok) {
        next = reducedAccepted.state;
        storeAcceptance(accepted);
        await this.publishSubmissionDecisionPublic(submission, accepted);
        optionAFlowLog("coordinator", "submission_accepted", {
          electionId: this.electionId,
          submissionId: submission.submissionId,
        });
      } else {
        const rejected: BallotAcceptanceResult = {
          ...accepted,
          accepted: false,
          reason: inferRejectReason(reducedAccepted.error),
        };
        storeAcceptance(rejected);
        await this.publishSubmissionDecisionPublic(submission, rejected);
      }
      dequeueSubmission(submission.submissionId);
    }

    this.state = next;
    if (next !== originalState) {
      this.persistCoordinatorState("process_pending_submissions");
    }
    return this.state;
  }

  private async publishSubmissionDecisionPublic(
    submission: BallotSubmission,
    result: BallotAcceptanceResult,
  ) {
    if (!this.coordinatorNpub) {
      return null;
    }
    const coordinatorNsec = this.fallbackNsec ?? null;
    if (!coordinatorNsec) {
      optionAFlowLog("coordinator", "submission_decision_publish_skipped_no_nsec", {
        electionId: this.electionId,
        submissionId: submission.submissionId,
        accepted: result.accepted,
      });
      return null;
    }
    try {
      const published = await publishQuestionnaireSubmissionDecisionPublic({
        coordinatorNsec,
        questionnaireId: this.electionId,
        submissionId: submission.submissionId,
        tokenNullifier: submission.nullifier,
        accepted: result.accepted,
        reason: toSubmissionDecisionReason({
          accepted: result.accepted,
          rejectReason: result.reason,
        }),
        coordinatorNpub: this.coordinatorNpub,
        decidedAt: Number.isFinite(Date.parse(result.decidedAt))
          ? Math.floor(Date.parse(result.decidedAt) / 1000)
          : Math.floor(Date.now() / 1000),
        relays: this.getPreferredDmRelays(),
      });
      optionAFlowLog("coordinator", "submission_decision_public_publish_result", {
        electionId: this.electionId,
        submissionId: submission.submissionId,
        accepted: result.accepted,
        successes: published?.successes ?? 0,
        failures: published?.failures ?? 0,
      });
      return published;
    } catch (error) {
      optionAFlowLog("coordinator", "submission_decision_public_publish_failed", {
        electionId: this.electionId,
        submissionId: submission.submissionId,
        accepted: result.accepted,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export async function processOptionAQueuesForCoordinator(input: {
  coordinatorNpub: string;
  signer: SignerService;
  preferredElectionId?: string;
  onlyPreferredElectionId?: boolean;
  requiredQuestionIdsByElectionId?: Record<string, string[]>;
}) {
  const coordinatorNpub = toNpub(input.coordinatorNpub);
  const registry = loadElectionRegistry();
  const preferredElectionId = input.preferredElectionId?.trim() ?? "";
  const orderedElectionIds = input.onlyPreferredElectionId && preferredElectionId
    ? [preferredElectionId]
    : [
      preferredElectionId,
      ...registry,
    ]
      .filter((value) => value.length > 0)
      .filter((value, index, values) => values.indexOf(value) === index);

  const processedElectionIds: string[] = [];
  for (const electionId of orderedElectionIds) {
    const summary = loadElectionSummary(electionId);
    if (!summary || summary.coordinatorNpub !== coordinatorNpub) {
      continue;
    }
    const runtime = new QuestionnaireOptionACoordinatorRuntime(input.signer, electionId);
    runtime.bootstrapCoordinatorNpub({
      coordinatorNpub,
      summary,
      startDmSubscriptions: false,
      recoverSelfState: false,
      publishSelfState: false,
    });
    await runtime.processPendingBlindRequests();
    await runtime.processPendingSubmissions(input.requiredQuestionIdsByElectionId?.[electionId] ?? []);
    processedElectionIds.push(electionId);
  }

  return {
    processedElectionIds,
    processedElections: processedElectionIds.length,
  };
}

export async function processOptionAQueuesForCoordinatorLive(input: {
  coordinatorNpub: string;
  signer: SignerService;
  fallbackNsec?: string;
  preferredElectionId?: string;
  onlyPreferredElectionId?: boolean;
  requiredQuestionIdsByElectionId?: Record<string, string[]>;
  forceRepublishIssuances?: boolean;
}) {
  const singleFlightKey = `${toNpub(input.coordinatorNpub)}:${input.preferredElectionId?.trim() ?? ""}:${input.onlyPreferredElectionId ? "preferred" : "all"}`;
  if (liveCoordinatorQueueInFlight.has(singleFlightKey)) {
    return liveCoordinatorQueueInFlight.get(singleFlightKey)!;
  }
  const runner = (async () => {
  const coordinatorNpub = toNpub(input.coordinatorNpub);
  const registry = loadElectionRegistry();
  const preferredElectionId = input.preferredElectionId?.trim() ?? "";
  const orderedElectionIds = input.onlyPreferredElectionId && preferredElectionId
    ? [preferredElectionId]
    : [
      preferredElectionId,
      ...registry,
    ]
      .filter((value) => value.length > 0)
      .filter((value, index, values) => values.indexOf(value) === index);

  const processedElectionIds: string[] = [];
  let blindRequestsSynced = 0;
  let submissionsSynced = 0;
  let blindIssuancesDelivered = 0;
  let acceptanceResultsDelivered = 0;
  const blindRequestDiagnosticsByElectionId: Record<string, OptionABlindRequestFetchDiagnostics | null> = {};
  for (const electionId of orderedElectionIds) {
    const summary = loadElectionSummary(electionId);
    if (!summary || summary.coordinatorNpub !== coordinatorNpub) {
      continue;
    }
    const runtime = new QuestionnaireOptionACoordinatorRuntime(
      input.signer,
      electionId,
      input.fallbackNsec,
    );
    runtime.bootstrapCoordinatorNpub({
      coordinatorNpub,
      summary,
      startDmSubscriptions: false,
      recoverSelfState: false,
      publishSelfState: false,
    });
    await runtime.syncParticipantStatusesFromDm();
    blindRequestsSynced += await runtime.syncBlindRequestsFromDm();
    blindRequestDiagnosticsByElectionId[electionId] = runtime.getLastBlindRequestSyncDiagnostics();
    await runtime.processPendingBlindRequests();
    await runtime.syncBlindIssuanceAcksFromDm();
    blindIssuancesDelivered += await runtime.publishPendingBlindIssuancesToDm({
      forceAll: input.forceRepublishIssuances,
    });
    submissionsSynced += await runtime.syncSubmissionsFromDm();
    await runtime.processPendingSubmissions(input.requiredQuestionIdsByElectionId?.[electionId] ?? []);
    acceptanceResultsDelivered += await runtime.publishPendingAcceptanceResultsToDm();
    processedElectionIds.push(electionId);
  }

  return {
    processedElectionIds,
    processedElections: processedElectionIds.length,
    blindRequestsSynced,
    submissionsSynced,
    blindIssuancesDelivered,
    acceptanceResultsDelivered,
    blindRequestDiagnosticsByElectionId,
  };
  })();
  liveCoordinatorQueueInFlight.set(singleFlightKey, runner);
  try {
    return await runner;
  } finally {
    liveCoordinatorQueueInFlight.delete(singleFlightKey);
  }
}

const liveCoordinatorQueueInFlight = new Map<string, Promise<{
  processedElectionIds: string[];
  processedElections: number;
}>>();
