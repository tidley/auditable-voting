import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
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
  type BallotRejectReason,
  type BallotSubmission,
  type BlindBallotIssuance,
  type BlindBallotRequest,
  type CoordinatorElectionState,
  type ElectionInviteMessage,
  type ElectionSummary,
  type Npub,
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
  fetchOptionABlindIssuanceDms,
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDms,
  fetchOptionABlindRequestDmsWithNsec,
  publishOptionABallotSubmissionAckDm,
  publishOptionABallotAcceptanceDm,
  publishOptionABallotSubmissionDm,
  publishOptionABlindIssuanceAckDm,
  publishOptionABlindIssuanceDm,
  publishOptionABlindRequestAckDm,
  publishOptionABlindRequestDm,
  subscribeOptionABallotAcceptanceDms,
  subscribeOptionABallotSubmissionAckDms,
  subscribeOptionABallotSubmissionDms,
  subscribeOptionABlindIssuanceAckDms,
  subscribeOptionABlindIssuanceDms,
  subscribeOptionABlindRequestAckDms,
  subscribeOptionABlindRequestDms,
  type BallotSubmissionAck,
  type BlindRequestAck,
  type BlindIssuanceAck,
  type OptionABlindRequestFetchDiagnostics,
} from "./questionnaireOptionABlindDm";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
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

const OPTION_A_COORDINATOR_DM_LOOKBACK_SECONDS = 24 * 60 * 60;
const OPTION_A_COORDINATOR_SIGNER_DM_LIMIT = 60;
const OPTION_A_COORDINATOR_NSEC_DM_LIMIT = 120;
const OPTION_A_ISSUANCE_DM_RETRY_MS = 2 * 60 * 1000;
const OPTION_A_BLIND_REQUEST_RETRY_MS = 10 * 1000;
const OPTION_A_BLIND_REQUEST_ACK_RETRY_MS = 10 * 60 * 1000;
const OPTION_A_BLIND_REQUEST_ACK_RESEND_AFTER_MS = 20 * 60 * 1000;
const OPTION_A_SUBMISSION_REPUBLISH_RETRY_MS = 60 * 1000;
const OPTION_A_SUBMISSION_ACK_RETRY_MS = 2 * 60 * 1000;
const OPTION_A_SELF_COPY_RECOVERY_LOOKBACK_SECONDS = Math.round(36 * 60 * 60);
const OPTION_A_VOTER_DM_LOOKBACK_SECONDS = Math.round(36 * 60 * 60);
const OPTION_A_VOTER_REFRESH_DM_LIMIT = 120;

export type OptionARuntimeErrorCode =
  | "not_logged_in"
  | "election_missing"
  | "invite_missing"
  | "invite_mismatch"
  | "not_whitelisted"
  | "coordinator_missing"
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

function optionAFlowLog(role: "voter" | "coordinator", stage: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[OptionA][${role}] ${stage}${payload}`);
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

async function deriveDeterministicResponseSecretKey(input: {
  electionId: string;
  answers: QuestionnaireAnswer[];
  tokenSecret: string;
  blindSignature: string;
}) {
  const sortedAnswers = [...input.answers].sort((left, right) => left.questionId.localeCompare(right.questionId));
  const seedMaterial = stableStringify({
    electionId: input.electionId,
    answers: sortedAnswers,
    tokenSecret: input.tokenSecret,
    blindSignature: input.blindSignature,
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
    pendingBlindRequests: {},
    issuedBlindResponses: {},
    receivedSubmissions: {},
    acceptedNullifiers: {},
    acceptanceResults: {},
    lastUpdatedAt: nowIso(),
  };
}

function findIssuedBlindResponse(
  state: CoordinatorElectionState,
  request: BlindBallotRequest,
): BlindBallotIssuance | null {
  return state.issuedBlindResponses[request.requestId]
    ?? Object.values(state.issuedBlindResponses).find((issuance) => issuance.invitedNpub === request.invitedNpub)
    ?? null;
}

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

export class QuestionnaireOptionAVoterRuntime {
  private state: VoterElectionLocalState | null = null;
  private requestBlindBallotInflight: Promise<VoterElectionLocalState> | null = null;
  private submitVoteInflight: Promise<VoterElectionLocalState> | null = null;
  private refreshFetchInFlight = false;
  private submissionRepublishAttemptAtBySubmissionId = new Map<string, number>();
  private blindIssuanceAckInflightByRequestId = new Map<string, Promise<void>>();
  private stopBlindRequestAckSubscription: (() => void) | null = null;
  private stopBlindIssuanceSubscription: (() => void) | null = null;
  private stopSubmissionAckSubscription: (() => void) | null = null;
  private stopAcceptanceSubscription: (() => void) | null = null;

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
    return readElectionPrivateRelayPrefs(this.electionId);
  }

  private rememberPrivateRelaySuccesses(result: { relayResults?: Array<{ relay: string; success: boolean }> } | null | undefined) {
    const relays = extractSuccessfulRelays(result);
    if (relays.length > 0) {
      recordElectionPrivateRelaySuccesses(this.electionId, relays);
    }
  }

  private startVoterDmSubscriptions() {
    if (!this.state?.loginVerified) {
      this.stopVoterDmSubscriptions();
      return;
    }
    const shouldSubscribeBlindIssuance = Boolean(
      this.state.blindRequestSent && !this.state.credentialReady,
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

    if (!shouldSubscribeBlindIssuance && this.stopBlindRequestAckSubscription) {
      this.stopBlindRequestAckSubscription();
      this.stopBlindRequestAckSubscription = null;
    }
    if (shouldSubscribeBlindIssuance && !this.stopBlindRequestAckSubscription) {
      this.stopBlindRequestAckSubscription = subscribeOptionABlindRequestAckDms({
        signer: this.signer,
        electionId: this.electionId,
        relays,
        since: issuanceSince,
        onAck: (ack) => {
          storeBlindRequestAckRecord({
            requestId: ack.requestId,
            electionId: ack.electionId,
            invitedNpub: ack.invitedNpub,
            ackedAt: ack.ackedAt,
          });
        },
      });
    }

    if (!shouldSubscribeBlindIssuance && this.stopBlindIssuanceSubscription) {
      this.stopBlindIssuanceSubscription();
      this.stopBlindIssuanceSubscription = null;
    }
    if (shouldSubscribeBlindIssuance && !this.stopBlindIssuanceSubscription) {
      this.stopBlindIssuanceSubscription = subscribeOptionABlindIssuanceDms({
        signer: this.signer,
        electionId: this.electionId,
        relays,
        since: issuanceSince,
        onIssuance: (issuance) => {
          storeBlindIssuance(issuance);
          if (issuance.definition) {
            storeCachedQuestionnaireDefinition(issuance.definition);
          }
          void this.ensureBlindIssuanceAck(issuance).catch(() => undefined);
        },
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
          storeAcceptance(acceptance);
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
        const result = await publishOptionABlindIssuanceAckDm({
          signer: this.signer,
          recipientNpub: this.state?.coordinatorNpub ?? issuance.invitedNpub,
          ack,
          fallbackNsec: this.fallbackNsec,
          relays: this.getPreferredDmRelays(),
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

    const restored = restoreVoterElectionLocalState({
      persisted: loggedIn.state,
      canonicalIssuance: loggedIn.state.blindRequest ? readBlindIssuance(loggedIn.state.blindRequest.requestId) : null,
      canonicalAcceptance: loggedIn.state.submission ? readAcceptance(loggedIn.state.submission.submissionId) : null,
    });

    this.state = restored;
    saveVoterState({ voterNpub: signerNpub, state: restored });
    this.startVoterDmSubscriptions();
    if (restored.blindIssuance) {
      void this.ensureBlindIssuanceAck(restored.blindIssuance).catch(() => undefined);
    }
    return await this.recoverSubmittedBallotFromSelfDm().catch(() => restored);
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

    const summary = loadElectionSummary(this.electionId);
    const existingState = loadVoterState({
      voterNpub: invitedNpub,
      electionId: this.electionId,
      coordinatorNpub: input.coordinatorNpub ?? invite?.coordinatorNpub ?? summary?.coordinatorNpub,
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
      coordinatorNpub: input.coordinatorNpub ?? invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? "",
      now: nowIso(),
    });
    const resolvedCoordinatorNpub = input.coordinatorNpub ?? invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? "";
    const voterState = resolvedCoordinatorNpub && loadedVoterState.coordinatorNpub !== resolvedCoordinatorNpub
      ? { ...loadedVoterState, coordinatorNpub: resolvedCoordinatorNpub, lastUpdatedAt: nowIso() }
      : loadedVoterState;

    let next = voterState;
    if (invite) {
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

    const restored = restoreVoterElectionLocalState({
      persisted: loggedIn.state,
      canonicalIssuance: loggedIn.state.blindRequest ? readBlindIssuance(loggedIn.state.blindRequest.requestId) : null,
      canonicalAcceptance: loggedIn.state.submission ? readAcceptance(loggedIn.state.submission.submissionId) : null,
    });

    this.state = restored;
    saveVoterState({ voterNpub: invitedNpub, state: restored });
    this.startVoterDmSubscriptions();
    if (restored.blindIssuance) {
      void this.ensureBlindIssuanceAck(restored.blindIssuance).catch(() => undefined);
    }
    return restored;
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
    }
  }

  async requestBlindBallot(options?: { forceResend?: boolean; minRetryMs?: number }) {
    if (this.requestBlindBallotInflight) {
      optionAFlowLog("voter", "blind_request_inflight_reused", { electionId: this.electionId });
      return this.requestBlindBallotInflight;
    }
    this.requestBlindBallotInflight = this.requestBlindBallotInternal(options);
    try {
      return await this.requestBlindBallotInflight;
    } finally {
      this.requestBlindBallotInflight = null;
    }
  }

  private async requestBlindBallotInternal(options?: { forceResend?: boolean; minRetryMs?: number }) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    optionAFlowLog("voter", "blind_request_started", {
      electionId: this.state.electionId,
      alreadyHasRequest: Boolean(this.state.blindRequest),
      alreadyHasIssuance: Boolean(this.state.blindIssuance),
    });
    if (this.state.blindIssuance) {
      void this.ensureBlindIssuanceAck(this.state.blindIssuance).catch(() => undefined);
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      return this.state;
    }

    let next = this.state;
    let request = next.blindRequest;
    if (!request) {
      const blindSigningPublicKey = next.inviteMessage?.blindSigningPublicKey
        ?? loadElectionSummary(next.electionId)?.blindSigningPublicKey
        ?? null;
      if (!blindSigningPublicKey) {
        throw new OptionARuntimeError("issuance_failed", "Coordinator blind-signing key is not available yet.");
      }
      const tokenSecret = makeTokenSecret();
      const tokenCommitment = await sha256Hex(tokenSecret);
      const message = buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId: next.electionId,
        tokenSecretCommitment: tokenCommitment,
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
        tokenCommitment,
        blindSigningKeyId: blindSigningPublicKey.keyId,
        clientNonce: makeId("nonce"),
        createdAt: nowIso(),
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

    this.state = next;
    const minRetryMs = Math.max(0, options?.minRetryMs ?? OPTION_A_BLIND_REQUEST_RETRY_MS);
    const lastSentMs = this.state.blindRequestSentAt ? Date.parse(this.state.blindRequestSentAt) : Number.NaN;
    if (
      !options?.forceResend
      && request
      && this.state.blindRequestSent
      && !this.state.blindIssuance
      && Number.isFinite(lastSentMs)
      && Date.now() - lastSentMs < minRetryMs
    ) {
      optionAFlowLog("voter", "blind_request_resend_skipped_cooldown", {
        electionId: this.state.electionId,
        requestId: request.requestId,
        minRetryMs,
      });
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      return this.state;
    }
    const requestAck = request ? readBlindRequestAckRecord(request.requestId) : null;
    if (
      !options?.forceResend
      && request
      && this.state.blindRequestSent
      && !this.state.blindIssuance
      && hasRecentAck(requestAck?.ackedAt, OPTION_A_BLIND_REQUEST_ACK_RETRY_MS)
    ) {
      optionAFlowLog("voter", "blind_request_resend_skipped_acknowledged", {
        electionId: this.state.electionId,
        requestId: request.requestId,
        ackedAt: requestAck?.ackedAt ?? null,
        minRetryMs: OPTION_A_BLIND_REQUEST_ACK_RETRY_MS,
      });
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
      return this.state;
    }
    if (
      !options?.forceResend
      && request
      && this.state.blindRequestSent
      && !this.state.blindIssuance
      && requestAck
      && Number.isFinite(lastSentMs)
      && Date.now() - lastSentMs < OPTION_A_BLIND_REQUEST_ACK_RESEND_AFTER_MS
    ) {
      optionAFlowLog("voter", "blind_request_resend_skipped_ack_backoff", {
        electionId: this.state.electionId,
        requestId: request.requestId,
        ackedAt: requestAck.ackedAt,
        minRetryMs: OPTION_A_BLIND_REQUEST_ACK_RESEND_AFTER_MS,
      });
      saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
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
    if (!this.state.coordinatorNpub?.trim()) {
      throw new OptionARuntimeError(
        "invite_missing",
        "Coordinator details are missing. Refresh status or reopen the invite.",
      );
    }
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
    optionAFlowLog("voter", "blind_request_sent", {
      electionId: this.state.electionId,
      requestId: request.requestId,
    });
    return this.state;
  }

  async publishBlindRequestDm(request = this.state?.blindRequest ?? null) {
    if (!this.state || !request || !this.state.coordinatorNpub) {
      return null;
    }
    optionAFlowLog("voter", "blind_request_publish_attempt", {
      electionId: this.state.electionId,
      requestId: request.requestId,
      coordinatorNpub: this.state.coordinatorNpub,
    });
    try {
      const result = await publishOptionABlindRequestDm({
        signer: this.signer,
        recipientNpub: this.state.coordinatorNpub,
        request,
        fallbackNsec: this.fallbackNsec,
        relays: this.getPreferredDmRelays(),
      });
      this.rememberPrivateRelaySuccesses(result);
      return result;
    } catch {
      return null;
    }
  }

  refreshIssuanceAndAcceptance() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }

    const electionId = this.state.electionId;
    const lookbackSince = Math.max(0, Math.floor(Date.now() / 1000) - OPTION_A_VOTER_DM_LOOKBACK_SECONDS);
    const needsIssuanceFetch = Boolean(this.state.blindRequestSent && !this.state.credentialReady);
    const needsAcceptanceFetch = Boolean(this.state.submission && this.state.submissionAccepted === null);
    const requestSince = lookbackSince;
    const acceptanceSince = lookbackSince;
    if (!this.refreshFetchInFlight) {
      const fetchTasks: Array<Promise<void>> = [];
      if (needsIssuanceFetch) {
        const requestAckFetch = this.fallbackNsec?.trim()
          ? fetchOptionABlindRequestAckDmsWithNsec({
            nsec: this.fallbackNsec,
            electionId,
            limit: 100,
          })
          : fetchOptionABlindRequestAckDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            since: requestSince,
          });
        const blindIssuanceFetch = this.fallbackNsec?.trim()
          ? fetchOptionABlindIssuanceDmsWithNsec({
            nsec: this.fallbackNsec,
            electionId,
            limit: 100,
          })
          : fetchOptionABlindIssuanceDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            since: requestSince,
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
              storeBlindIssuance(issuance);
              if (issuance.definition) {
                storeCachedQuestionnaireDefinition(issuance.definition);
              }
            }
          }).catch(() => null).then(() => undefined),
        );
      }
      if (needsAcceptanceFetch) {
        const acceptanceReadNsec = this.state.responseNsec?.trim() || this.fallbackNsec?.trim() || "";
        const submissionAckFetch = acceptanceReadNsec
          ? fetchOptionABallotSubmissionAckDmsWithNsec({
            nsec: acceptanceReadNsec,
            electionId,
            limit: 100,
          })
          : fetchOptionABallotSubmissionAckDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            since: acceptanceSince,
          });
        const acceptanceFetch = acceptanceReadNsec
          ? fetchOptionABallotAcceptanceDmsWithNsec({
            nsec: acceptanceReadNsec,
            electionId,
            limit: 100,
          })
          : fetchOptionABallotAcceptanceDms({
            signer: this.signer,
            electionId,
            relays: this.getPreferredDmRelays(),
            limit: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            maxDecryptAttempts: OPTION_A_VOTER_REFRESH_DM_LIMIT,
            since: acceptanceSince,
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
              storeAcceptance(acceptance);
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

    let next = this.state;
    if (next.blindRequest) {
      const issuance = readBlindIssuance(next.blindRequest.requestId);
      if (issuance) {
        if (issuance.definition) {
          storeCachedQuestionnaireDefinition(issuance.definition);
        }
        const received = reduceVoterEvent(next, {
          type: "BLIND_ISSUANCE_RECEIVED",
          issuance,
        });
        if (received.ok) {
          next = received.state;
          void this.ensureBlindIssuanceAck(issuance).catch(() => undefined);
        }
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
    this.state = next;
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    return this.state;
  }

  async submitVote(requiredQuestionIds: string[]) {
    if (this.submitVoteInflight) {
      optionAFlowLog("voter", "submit_vote_inflight_reused", { electionId: this.electionId });
      return this.submitVoteInflight;
    }
    this.submitVoteInflight = this.submitVoteInternal(requiredQuestionIds);
    try {
      return await this.submitVoteInflight;
    } finally {
      this.submitVoteInflight = null;
    }
  }

  private async submitVoteInternal(requiredQuestionIds: string[]) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    optionAFlowLog("voter", "submit_vote_started", {
      electionId: this.state.electionId,
      hasExistingSubmission: Boolean(this.state.submission),
    });
    const issuance = this.state.blindIssuance;
    const tokenSecret = this.state.blindTokenSecret;
    if (!issuance || !tokenSecret) {
      throw new OptionARuntimeError("issuance_failed", "No issued credential is available.");
    }
    if (issuance.tokenCommitment !== tokenSecret.tokenCommitment) {
      throw new OptionARuntimeError("issuance_failed", "Issued credential does not match this browser's token secret.");
    }

    if (this.state.submission && this.state.responseNsec && this.state.responseNpub) {
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
      optionAFlowLog("voter", "submit_vote_republish_existing_submission", {
        electionId: this.state.electionId,
        submissionId,
        responseNpub: this.state.responseNpub,
      });
      const republished = await this.publishBallotSubmissionDm(this.state.submission, { fallbackNsec: this.state.responseNsec });
      if (!republished || republished.successes <= 0) {
        throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the ballot submission DM.");
      }
      await this.publishBallotSubmissionSelfCopyDm(this.state.submission, { fallbackNsec: this.state.responseNsec });
      return this.state;
    }

    const message = buildQuestionnaireBlindTokenSignedMessage({
      questionnaireId: this.state.electionId,
      tokenSecretCommitment: tokenSecret.tokenCommitment,
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
    const responseSecretKey = await deriveDeterministicResponseSecretKey({
      electionId: this.state.electionId,
      answers: this.state.draftResponses,
      tokenSecret: tokenSecret.tokenSecret,
      blindSignature: issuance.blindSignature,
    });
    const responseNsec = nip19.nsecEncode(responseSecretKey);
    const responseNpub = nip19.npubEncode(getPublicKey(responseSecretKey));
    optionAFlowLog("voter", "submit_vote_responder_marker_derived", {
      electionId: this.state.electionId,
      responseNpub,
      responseCount: this.state.draftResponses.length,
    });

    const submission: BallotSubmission = {
      type: "ballot_submission",
      schemaVersion: 1,
      electionId: this.state.electionId,
      submissionId: makeId("submission"),
      invitedNpub: responseNpub,
      responseNpub,
      tokenCommitment: tokenSecret.tokenCommitment,
      blindSigningKeyId: issuance.blindSigningKeyId,
      nullifier: deriveQuestionnaireTokenNullifier({
        questionnaireId: this.state.electionId,
        tokenSecret: tokenSecret.tokenSecret,
      }),
      payload: {
        electionId: this.state.electionId,
        responses: this.state.draftResponses,
      },
      submittedAt: nowIso(),
      credential,
    };

    const valid = validateBallotSubmission({
      submission,
      electionId: this.state.electionId,
      electionState: "open",
      requiredQuestionIds,
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
    enqueueSubmission(submission);
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    const published = await this.publishBallotSubmissionDm(submission, { fallbackNsec: responseNsec });
    optionAFlowLog("voter", "submit_vote_dm_publish_result", {
      electionId: this.state.electionId,
      submissionId: submission.submissionId,
      successes: published?.successes ?? 0,
      failures: published?.failures ?? 0,
    });
    if (!published || published.successes <= 0) {
      throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the ballot submission DM.");
    }
    await this.publishBallotSubmissionSelfCopyDm(submission, { fallbackNsec: responseNsec });
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
  private pendingAuthorizationsByNpub: Record<string, BlindBallotRequest[]> = {};
  private issuanceDmRepublishRequests = new Map<string, string>();
  private stopBlindRequestSubscription: (() => void) | null = null;
  private stopSubmissionSubscription: (() => void) | null = null;
  private stopBlindIssuanceAckSubscription: (() => void) | null = null;
  private liveBlindRequestProcessInFlight: Promise<void> | null = null;
  private liveSubmissionProcessInFlight: Promise<void> | null = null;

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

  getPendingAuthorizations() {
    return Object.entries(this.pendingAuthorizationsByNpub)
      .map(([invitedNpub, requests]) => ({
        invitedNpub,
        latestRequest: [...requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
        requestCount: requests.length,
      }))
      .filter((entry) => entry.latestRequest !== null);
  }

  dispose() {
    this.stopCoordinatorDmSubscriptions();
  }

  private stopCoordinatorDmSubscriptions() {
    this.stopBlindRequestSubscription?.();
    this.stopBlindRequestSubscription = null;
    this.stopSubmissionSubscription?.();
    this.stopSubmissionSubscription = null;
    this.stopBlindIssuanceAckSubscription?.();
    this.stopBlindIssuanceAckSubscription = null;
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
    this.stopSubmissionSubscription = subscribeOptionABallotSubmissionDms({
      signer: this.signer,
      electionId: this.electionId,
      relays,
      onSubmission: (submission) => {
        enqueueSubmission(submission);
        void this.triggerSubmissionProcessingFromLive().catch(() => undefined);
      },
    });
    this.stopBlindIssuanceAckSubscription = subscribeOptionABlindIssuanceAckDms({
      signer: this.signer,
      electionId: this.electionId,
      relays,
      onAck: (ack) => {
        this.recordBlindIssuanceAck(ack);
      },
    });
  }

  private getDmReadSince() {
    const nowSec = Math.round(Date.now() / 1000);
    // Gift-wrap events use randomized created_at values, so anchoring to recently opened rounds
    // can exclude valid fresh events. Use only a fixed lookback floor.
    return Math.max(0, nowSec - OPTION_A_COORDINATOR_DM_LOOKBACK_SECONDS);
  }

  private getPreferredDmRelays() {
    return readElectionPrivateRelayPrefs(this.electionId);
  }

  private rememberPrivateRelaySuccesses(result: { relayResults?: Array<{ relay: string; success: boolean }> } | null | undefined) {
    const relays = extractSuccessfulRelays(result);
    if (relays.length > 0) {
      recordElectionPrivateRelaySuccesses(this.electionId, relays);
    }
  }

  private async publishBlindRequestAckDm(request: BlindBallotRequest) {
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
    optionAFlowLog("coordinator", "blind_issuance_ack_received", {
      electionId: ack.electionId,
      requestId: ack.requestId,
      issuanceId: ack.issuanceId,
      invitedNpub: ack.invitedNpub,
    });
  }

  private hasProofIssuanceConsumed(issuance: BlindBallotIssuance) {
    if (!this.state) {
      return false;
    }
    return Object.values(this.state.receivedSubmissions).some((submission) => {
      if (submission.electionId !== issuance.electionId) {
        return false;
      }
      return submission.tokenCommitment === issuance.tokenCommitment
        || submission.invitedNpub === issuance.invitedNpub
        || submission.responseNpub === issuance.invitedNpub;
    });
  }

  async loginWithSigner(summary?: Partial<ElectionSummary>) {
    this.coordinatorNpub = toNpub(await this.signer.getPublicKey());
    const state = this.ensureCoordinatorState(summary);
    await this.ensureBlindSigningKey();
    this.startCoordinatorDmSubscriptions();
    return this.state ?? state;
  }

  bootstrapCoordinatorNpub(input: {
    coordinatorNpub: string;
    summary?: Partial<ElectionSummary>;
    startDmSubscriptions?: boolean;
  }) {
    const nextCoordinatorNpub = toNpub(input.coordinatorNpub);
    const coordinatorChanged = this.coordinatorNpub !== nextCoordinatorNpub;
    this.coordinatorNpub = nextCoordinatorNpub;
    const state = this.ensureCoordinatorState(input.summary);
    if (input.startDmSubscriptions ?? true) {
      const subscriptionsMissing = !this.stopBlindRequestSubscription || !this.stopSubmissionSubscription;
      if (coordinatorChanged || subscriptionsMissing) {
        this.startCoordinatorDmSubscriptions();
      }
    }
    return state;
  }

  async ensureBlindSigningPublicKey() {
    const privateKey = await this.ensureBlindSigningKey();
    return toQuestionnaireBlindPublicKey(privateKey);
  }

  private ensureCoordinatorState(summary?: Partial<ElectionSummary>) {
    if (!this.coordinatorNpub) {
      throw new OptionARuntimeError("coordinator_missing", "Coordinator npub is missing.");
    }
    const existing = loadCoordinatorState({ coordinatorNpub: this.coordinatorNpub, electionId: this.electionId });
    if (existing) {
      this.state = restoreCoordinatorElectionState({ persisted: existing });
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
    };
    upsertElectionSummary(nextSummary);
    const created = emptyCoordinatorState(nextSummary);
    this.state = created;
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: created });
    return created;
  }

  private async ensureBlindSigningKey(): Promise<QuestionnaireBlindPrivateKey> {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    if (this.state.blindSigningPrivateKey) {
      const existingPrivateKey = this.state.blindSigningPrivateKey;
      if (!this.state.election.blindSigningPublicKey) {
        this.state = {
          ...this.state,
          election: {
            ...this.state.election,
            blindSigningPublicKey: toQuestionnaireBlindPublicKey(existingPrivateKey),
          },
        };
        upsertElectionSummary(this.state.election);
        saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
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
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return privateKey;
  }

  addWhitelistNpub(invitedNpub: string) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    const entry: WhitelistEntry = {
      electionId: this.electionId,
      invitedNpub,
      addedAt: nowIso(),
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
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return this.state;
  }

  async authorizeRequester(invitedNpub: string) {
    optionAFlowLog("coordinator", "authorize_requester", { electionId: this.electionId, invitedNpub });
    this.addWhitelistNpub(invitedNpub);
    const pendingForVoter = [...(this.pendingAuthorizationsByNpub[invitedNpub] ?? [])];
    for (const request of pendingForVoter) {
      enqueueBlindRequest(request);
    }
    delete this.pendingAuthorizationsByNpub[invitedNpub];
    await this.processPendingBlindRequests();
    const delivered = await this.publishPendingBlindIssuancesToDm({
      requestIds: pendingForVoter.map((request) => request.requestId),
      minRetryMs: 0,
    });
    optionAFlowLog("coordinator", "authorize_requester_processed", {
      electionId: this.electionId,
      invitedNpub,
      pendingRequestCount: pendingForVoter.length,
      deliveredIssuances: delivered,
    });
    return this.state;
  }

  async sendInvite(invitedNpub: string, meta: { title: string; description: string; voteUrl: string }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    optionAFlowLog("coordinator", "invite_send_started", {
      electionId: this.electionId,
      invitedNpub,
    });
    if (!this.state.whitelist[invitedNpub]) {
      throw new OptionARuntimeError("not_whitelisted", "Invite target is not whitelisted.");
    }
    const blindSigningPrivateKey = await this.ensureBlindSigningKey();
    const invite: ElectionInviteMessage = {
      type: "election_invite",
      schemaVersion: 1,
      electionId: this.electionId,
      title: meta.title,
      description: meta.description,
      voteUrl: meta.voteUrl,
      invitedNpub,
      coordinatorNpub: this.coordinatorNpub,
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(blindSigningPrivateKey),
      definition: readCachedQuestionnaireDefinition(this.electionId),
      expiresAt: null,
    };
    const sent = reduceCoordinatorEvent(this.state, {
      type: "INVITE_SENT",
      electionId: this.electionId,
      invitedNpub,
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
        invitedNpub,
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
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return {
      invite,
      dmDelivered,
      dmFailureReason,
    };
  }

  async syncBlindRequestsFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
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
          diagnosticsSink: (next) => {
            diagnostics = next;
          },
        });
      for (const request of requests) {
        enqueueBlindRequest(request);
      }
      if (diagnostics) {
        optionAFlowLog("coordinator", "blind_requests_sync_diagnostics", {
          electionId: this.electionId,
          ...diagnostics,
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
  }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }

    const forcedRequestIds = new Set([
      ...this.issuanceDmRepublishRequests.keys(),
      ...(options?.requestIds ?? []),
    ]);
    const minRetryMs = options?.minRetryMs ?? OPTION_A_ISSUANCE_DM_RETRY_MS;
    const issued = Object.values(this.state.issuedBlindResponses)
      .map((issuance) => this.enrichIssuanceWithDefinition(issuance))
      .filter((issuance) => {
        if (options?.forceAll || forcedRequestIds.has(issuance.requestId)) {
          return true;
        }
        // A valid submission for this issuance is proof the voter already received their credential.
        if (this.hasProofIssuanceConsumed(issuance)) {
          return false;
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
        return !Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs >= minRetryMs;
      });
    let delivered = 0;
    for (const issuance of issued) {
      const attemptedAt = nowIso();
      let eventId: string | null = null;
      let success = false;
      try {
        const result = await publishOptionABlindIssuanceDm({
          signer: this.signer,
          recipientNpub: issuance.invitedNpub,
          issuance,
          fallbackNsec: this.fallbackNsec,
          relays: this.getPreferredDmRelays(),
        });
        eventId = result.eventId;
        success = result.successes > 0;
        if (success) {
          delivered += 1;
          this.rememberPrivateRelaySuccesses(result);
        }
        optionAFlowLog("coordinator", "blind_issuance_dm_publish_result", {
          electionId: this.electionId,
          requestId: issuance.requestId,
          successes: result.successes,
          failures: result.failures,
        });
      } catch {
        // Keep best-effort to avoid blocking queue processing.
      } finally {
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
    return delivered;
  }

  private enrichIssuanceWithDefinition(issuance: BlindBallotIssuance): BlindBallotIssuance {
    if (issuance.definition) {
      return issuance;
    }
    const definition = readCachedQuestionnaireDefinition(this.electionId);
    return definition ? { ...issuance, definition } : issuance;
  }

  async syncBlindIssuanceAcksFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    try {
      const since = this.getDmReadSince();
      const acks = this.fallbackNsec?.trim()
        ? await fetchOptionABlindIssuanceAckDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
        })
        : await fetchOptionABlindIssuanceAckDms({
          signer: this.signer,
          electionId: this.electionId,
          relays: this.getPreferredDmRelays(),
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
          maxDecryptAttempts: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
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

  async syncSubmissionsFromDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
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

  async publishPendingAcceptanceResultsToDm(options?: { forceAll?: boolean }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
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
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    const blindSigningPrivateKey = await this.ensureBlindSigningKey();
    const queue = listBlindRequests(this.electionId);
    optionAFlowLog("coordinator", "process_blind_requests_started", {
      electionId: this.electionId,
      queued: queue.length,
    });
    let next = this.state;
    for (const request of queue) {
      const claimed = reduceCoordinatorEvent(next, {
        type: "LOGIN_VERIFIED",
        electionId: this.electionId,
        invitedNpub: request.invitedNpub,
      });
      if (claimed.ok) {
        next = claimed.state;
      }
      const received = reduceCoordinatorEvent(next, {
        type: "BLIND_REQUEST_RECEIVED",
        request,
      });
      if (!received.ok) {
        const existingIssuance = findIssuedBlindResponse(next, request);
        if (received.error === "already_issued" && existingIssuance) {
          const enriched = this.enrichIssuanceWithDefinition(existingIssuance);
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
      await this.publishBlindRequestAckDm(request);
      const existingIssuance = findIssuedBlindResponse(next, request);
      if (existingIssuance) {
        const enriched = this.enrichIssuanceWithDefinition(existingIssuance);
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
        tokenCommitment: request.tokenCommitment,
        blindSigningKeyId: blindSigningPrivateKey.keyId,
        blindSignature: await signBlindedQuestionnaireToken({
          privateKey: blindSigningPrivateKey,
          blindedMessage: request.blindedMessage,
        }),
        definition: readCachedQuestionnaireDefinition(this.electionId),
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
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return this.state;
  }

  async processPendingSubmissions(requiredQuestionIds: string[]) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    const queue = listSubmissions(this.electionId);
    optionAFlowLog("coordinator", "process_submissions_started", {
      electionId: this.electionId,
      queued: queue.length,
    });
    let next = this.state;

    for (const submission of queue) {
      const existingDecision = next.acceptanceResults[submission.submissionId];
      if (existingDecision) {
        await this.publishBallotSubmissionAckDm(submission);
        dequeueSubmission(submission.submissionId);
        continue;
      }
      const received = reduceCoordinatorEvent(next, {
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
        dequeueSubmission(submission.submissionId);
        continue;
      }

      next = received.state;
      await this.publishBallotSubmissionAckDm(submission);
      const valid = validateBallotSubmission({
        submission,
        electionId: this.electionId,
        electionState: next.election.state,
        requiredQuestionIds,
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
        dequeueSubmission(submission.submissionId);
        continue;
      }
      const issuance = Object.values(next.issuedBlindResponses)
        .find((entry) => entry.tokenCommitment === submission.tokenCommitment) ?? null;
      const publicKey = next.election.blindSigningPublicKey ?? (
        next.blindSigningPrivateKey ? toQuestionnaireBlindPublicKey(next.blindSigningPrivateKey) : null
      );
      const credentialValid = issuance && publicKey && issuance.blindSigningKeyId === submission.blindSigningKeyId
        ? await verifyQuestionnaireBlindSignature({
          publicKey,
          message: buildQuestionnaireBlindTokenSignedMessage({
            questionnaireId: this.electionId,
            tokenSecretCommitment: submission.tokenCommitment,
          }),
          signature: submission.credential,
        })
        : false;
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
      }
      dequeueSubmission(submission.submissionId);
    }

    this.state = next;
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return this.state;
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
    });
    await runtime.syncBlindRequestsFromDm();
    await runtime.processPendingBlindRequests();
    await runtime.syncBlindIssuanceAcksFromDm();
    await runtime.publishPendingBlindIssuancesToDm({
      forceAll: input.forceRepublishIssuances,
    });
    await runtime.syncSubmissionsFromDm();
    await runtime.processPendingSubmissions(input.requiredQuestionIdsByElectionId?.[electionId] ?? []);
    await runtime.publishPendingAcceptanceResultsToDm();
    processedElectionIds.push(electionId);
  }

  return {
    processedElectionIds,
    processedElections: processedElectionIds.length,
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
