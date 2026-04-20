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
  enqueueBlindRequest,
  enqueueSubmission,
  listBlindRequests,
  loadElectionRegistry,
  listSubmissions,
  loadCoordinatorState,
  loadElectionSummary,
  loadVoterState,
  publishInviteToMailbox,
  readAcceptance,
  readBlindIssuanceDeliveryRecord,
  readBlindIssuance,
  recordBlindIssuanceDeliveryAttempt,
  readInviteFromMailbox,
  saveCoordinatorState,
  saveVoterState,
  storeAcceptance,
  storeBlindIssuance,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import {
  fetchOptionABallotAcceptanceDms,
  fetchOptionABallotAcceptanceDmsWithNsec,
  fetchOptionABallotSubmissionDms,
  fetchOptionABallotSubmissionDmsWithNsec,
  fetchOptionABlindIssuanceDms,
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDms,
  fetchOptionABlindRequestDmsWithNsec,
  publishOptionABallotAcceptanceDm,
  publishOptionABallotSubmissionDm,
  publishOptionABlindIssuanceDm,
  publishOptionABlindRequestDm,
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
    return restored;
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
    return restored;
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

  async requestBlindBallot() {
    if (this.requestBlindBallotInflight) {
      optionAFlowLog("voter", "blind_request_inflight_reused", { electionId: this.electionId });
      return this.requestBlindBallotInflight;
    }
    this.requestBlindBallotInflight = this.requestBlindBallotInternal();
    try {
      return await this.requestBlindBallotInflight;
    } finally {
      this.requestBlindBallotInflight = null;
    }
  }

  private async requestBlindBallotInternal() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    optionAFlowLog("voter", "blind_request_started", {
      electionId: this.state.electionId,
      alreadyHasRequest: Boolean(this.state.blindRequest),
      alreadyHasIssuance: Boolean(this.state.blindIssuance),
    });
    if (this.state.blindIssuance) {
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
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
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
      });
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
    const toSince = (value?: string | null) => {
      if (!value) {
        return undefined;
      }
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed / 1000) - 300) : undefined;
    };
    const requestSince = toSince(this.state.blindRequestSentAt);
    const acceptanceSince = toSince(this.state.submission?.submittedAt) ?? requestSince;
    void (this.fallbackNsec?.trim()
      ? fetchOptionABlindIssuanceDmsWithNsec({
        nsec: this.fallbackNsec,
        electionId,
        limit: 100,
      })
      : fetchOptionABlindIssuanceDms({
        signer: this.signer,
        electionId,
        limit: 30,
        maxDecryptAttempts: 30,
        since: requestSince,
      })).then((issuanceMessages) => {
      for (const issuance of issuanceMessages) {
        storeBlindIssuance(issuance);
        if (issuance.definition) {
          storeCachedQuestionnaireDefinition(issuance.definition);
        }
      }
    }).catch(() => null);
    const acceptanceReadNsec = this.state.responseNsec?.trim() || this.fallbackNsec?.trim() || "";
    void (acceptanceReadNsec
      ? fetchOptionABallotAcceptanceDmsWithNsec({
        nsec: acceptanceReadNsec,
        electionId,
        limit: 100,
      })
      : fetchOptionABallotAcceptanceDms({
        signer: this.signer,
        electionId,
        limit: 30,
        maxDecryptAttempts: 30,
        since: acceptanceSince,
      })).then((acceptanceMessages) => {
      for (const acceptance of acceptanceMessages) {
        storeAcceptance(acceptance);
      }
    }).catch(() => null);

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
      optionAFlowLog("voter", "submit_vote_republish_existing_submission", {
        electionId: this.state.electionId,
        submissionId: this.state.submission.submissionId,
        responseNpub: this.state.responseNpub,
      });
      const republished = await this.publishBallotSubmissionDm(this.state.submission, { fallbackNsec: this.state.responseNsec });
      if (!republished || republished.successes <= 0) {
        throw new OptionARuntimeError("dm_delivery_failed", "No relay accepted the ballot submission DM.");
      }
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
      return await publishOptionABallotSubmissionDm({
        signer: this.signer,
        recipientNpub: this.state.coordinatorNpub,
        submission,
        fallbackNsec: options?.fallbackNsec ?? this.state.responseNsec ?? this.fallbackNsec,
      });
    } catch {
      return null;
    }
  }
}

export class QuestionnaireOptionACoordinatorRuntime {
  private state: CoordinatorElectionState | null = null;
  private coordinatorNpub: string | null = null;
  private pendingAuthorizationsByNpub: Record<string, BlindBallotRequest[]> = {};
  private issuanceDmRepublishRequests = new Map<string, string>();

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

  private getDmReadSince() {
    const openedAt = this.state?.election.openedAt;
    const parsed = openedAt ? Date.parse(openedAt) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed / 1000) - 600);
    }
    return Math.max(0, Math.round(Date.now() / 1000) - OPTION_A_COORDINATOR_DM_LOOKBACK_SECONDS);
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
    this.issuanceDmRepublishRequests.set(issuance.requestId, requestSentAt);
  }

  private hasVoterReachedSubmission(issuance: BlindBallotIssuance) {
    const claimState = this.state?.whitelist[issuance.invitedNpub]?.claimState;
    return claimState === "vote_received"
      || claimState === "vote_accepted"
      || claimState === "vote_rejected";
  }

  async loginWithSigner(summary?: Partial<ElectionSummary>) {
    this.coordinatorNpub = toNpub(await this.signer.getPublicKey());
    const state = this.ensureCoordinatorState(summary);
    await this.ensureBlindSigningKey();
    return this.state ?? state;
  }

  bootstrapCoordinatorNpub(input: {
    coordinatorNpub: string;
    summary?: Partial<ElectionSummary>;
  }) {
    this.coordinatorNpub = toNpub(input.coordinatorNpub);
    return this.ensureCoordinatorState(input.summary);
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
      title: summary?.title ?? "Option A election",
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
    delete this.pendingAuthorizationsByNpub[invitedNpub];
    return this.processPendingBlindRequests();
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
      const requests = this.fallbackNsec?.trim()
        ? await fetchOptionABlindRequestDmsWithNsec({
          nsec: this.fallbackNsec,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_NSEC_DM_LIMIT,
          since,
        })
        : await fetchOptionABlindRequestDms({
          signer: this.signer,
          electionId: this.electionId,
          limit: OPTION_A_COORDINATOR_SIGNER_DM_LIMIT,
          since,
        });
      for (const request of requests) {
        enqueueBlindRequest(request);
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
        const delivery = readBlindIssuanceDeliveryRecord(issuance.requestId);
        if (!delivery?.lastAttemptAt) {
          return true;
        }
        if (delivery.lastSuccessAt && this.hasVoterReachedSubmission(issuance)) {
          return false;
        }
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
        });
        eventId = result.eventId;
        success = result.successes > 0;
        if (success) {
          delivered += 1;
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

  async publishPendingAcceptanceResultsToDm() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }

    let delivered = 0;
    for (const acceptance of Object.values(this.state.acceptanceResults)) {
      const submission = this.state.receivedSubmissions[acceptance.submissionId];
      if (!submission) {
        continue;
      }
      try {
        const result = await publishOptionABallotAcceptanceDm({
          signer: this.signer,
          recipientNpub: submission.responseNpub ?? submission.invitedNpub,
          acceptance,
          fallbackNsec: this.fallbackNsec,
        });
        if (result.successes > 0) {
          delivered += 1;
        }
        optionAFlowLog("coordinator", "acceptance_dm_publish_result", {
          electionId: this.electionId,
          submissionId: acceptance.submissionId,
          successes: result.successes,
          failures: result.failures,
        });
      } catch {
        // Keep best-effort to avoid blocking response processing.
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
          this.maybeQueueIssuanceRepublish(enriched, request);
          next = {
            ...next,
            issuedBlindResponses: {
              ...next.issuedBlindResponses,
              [enriched.requestId]: enriched,
            },
          };
          storeBlindIssuance(enriched);
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
        continue;
      }

      next = received.state;
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
    runtime.bootstrapCoordinatorNpub({ coordinatorNpub, summary });
    await runtime.syncBlindRequestsFromDm();
    await runtime.processPendingBlindRequests();
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
}
