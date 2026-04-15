import { nip19 } from "nostr-tools";
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
import {
  enqueueBlindRequest,
  enqueueSubmission,
  listBlindRequests,
  listSubmissions,
  loadCoordinatorState,
  loadElectionSummary,
  loadVoterState,
  publishInviteToMailbox,
  readAcceptance,
  readBlindIssuance,
  readInviteFromMailbox,
  saveCoordinatorState,
  saveVoterState,
  storeAcceptance,
  storeBlindIssuance,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import type { SignerService } from "./services/signerService";

export type OptionARuntimeErrorCode =
  | "not_logged_in"
  | "election_missing"
  | "invite_missing"
  | "invite_mismatch"
  | "not_whitelisted"
  | "coordinator_missing"
  | "issuance_failed"
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

  constructor(
    private readonly signer: SignerService,
    private readonly electionId: string,
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
    const invite = inviteFromUrl ?? readInviteFromMailbox({ invitedNpub: signerNpub, electionId: this.electionId });
    if (invite && invite.invitedNpub !== signerNpub) {
      throw new OptionARuntimeError("invite_mismatch", "This invite is for a different Nostr account.");
    }

    const summary = loadElectionSummary(this.electionId);
    const voterState = loadVoterState({
      voterNpub: signerNpub,
      electionId: this.electionId,
      coordinatorNpub: invite?.coordinatorNpub ?? summary?.coordinatorNpub,
    }) ?? createEmptyVoterElectionLocalState({
      electionId: this.electionId,
      invitedNpub: signerNpub,
      coordinatorNpub: invite?.coordinatorNpub ?? summary?.coordinatorNpub ?? "",
      now: nowIso(),
    });

    let next = voterState;
    if (invite) {
      const loaded = reduceVoterEvent(next, { type: "INVITE_LOADED", invite });
      if (!loaded.ok) {
        throw new OptionARuntimeError("invite_mismatch", "Invite could not be loaded.");
      }
      next = loaded.state;
    }

    const coordinator = next.coordinatorNpub
      ? loadCoordinatorState({ coordinatorNpub: next.coordinatorNpub, electionId: this.electionId })
      : null;
    const whitelisted = Boolean(coordinator?.whitelist[signerNpub]);
    if (coordinator && !whitelisted) {
      throw new OptionARuntimeError("not_whitelisted", "You are not whitelisted for this election.");
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

  requestBlindBallot() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const request: BlindBallotRequest = {
      type: "blind_ballot_request",
      schemaVersion: 1,
      electionId: this.state.electionId,
      requestId: makeId("request"),
      invitedNpub: this.state.invitedNpub,
      blindedMessage: makeId("blinded"),
      clientNonce: makeId("nonce"),
      createdAt: nowIso(),
    };
    const created = reduceVoterEvent(this.state, { type: "BLIND_REQUEST_CREATED", request });
    if (!created.ok) {
      throw new OptionARuntimeError("issuance_failed", "Could not create blind request.");
    }
    const sent = reduceVoterEvent(created.state, {
      type: "BLIND_REQUEST_SENT",
      electionId: this.state.electionId,
      requestId: request.requestId,
      sentAt: nowIso(),
    });
    if (!sent.ok) {
      throw new OptionARuntimeError("issuance_failed", "Could not send blind request.");
    }
    this.state = sent.state;
    enqueueBlindRequest(request);
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    return this.state;
  }

  refreshIssuanceAndAcceptance() {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    let next = this.state;
    if (next.blindRequest) {
      const issuance = readBlindIssuance(next.blindRequest.requestId);
      if (issuance) {
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

  submitVote(requiredQuestionIds: string[]) {
    if (!this.state) {
      throw new OptionARuntimeError("not_logged_in", "Login is required.");
    }
    const credential = this.state.blindIssuance?.blindSignature;
    if (!credential) {
      throw new OptionARuntimeError("issuance_failed", "No issued credential is available.");
    }

    const submission: BallotSubmission = {
      type: "ballot_submission",
      schemaVersion: 1,
      electionId: this.state.electionId,
      submissionId: makeId("submission"),
      invitedNpub: this.state.invitedNpub,
      credential,
      nullifier: `nullifier_${credential.slice(0, 16)}_${this.state.electionId}`,
      payload: {
        electionId: this.state.electionId,
        responses: this.state.draftResponses,
      },
      submittedAt: nowIso(),
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
    this.state = created.state;
    enqueueSubmission(submission);
    saveVoterState({ voterNpub: this.state.invitedNpub, state: this.state });
    return this.state;
  }
}

export class QuestionnaireOptionACoordinatorRuntime {
  private state: CoordinatorElectionState | null = null;
  private coordinatorNpub: string | null = null;

  constructor(
    private readonly signer: SignerService,
    private readonly electionId: string,
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

  async loginWithSigner(summary?: Partial<ElectionSummary>) {
    this.coordinatorNpub = toNpub(await this.signer.getPublicKey());
    return this.ensureCoordinatorState(summary);
  }

  bootstrapCoordinatorNpub(input: {
    coordinatorNpub: string;
    summary?: Partial<ElectionSummary>;
  }) {
    this.coordinatorNpub = toNpub(input.coordinatorNpub);
    return this.ensureCoordinatorState(input.summary);
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
    };
    upsertElectionSummary(nextSummary);
    const created = emptyCoordinatorState(nextSummary);
    this.state = created;
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: created });
    return created;
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

  sendInvite(invitedNpub: string, meta: { title: string; description: string; voteUrl: string }) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    if (!this.state.whitelist[invitedNpub]) {
      throw new OptionARuntimeError("not_whitelisted", "Invite target is not whitelisted.");
    }
    const invite: ElectionInviteMessage = {
      type: "election_invite",
      schemaVersion: 1,
      electionId: this.electionId,
      title: meta.title,
      description: meta.description,
      voteUrl: meta.voteUrl,
      invitedNpub,
      coordinatorNpub: this.coordinatorNpub,
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
    publishInviteToMailbox(invite);
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return invite;
  }

  processPendingBlindRequests() {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    const queue = listBlindRequests(this.electionId);
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
        continue;
      }
      next = received.state;
      const issuance: BlindBallotIssuance = {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: this.electionId,
        requestId: request.requestId,
        issuanceId: makeId("issuance"),
        invitedNpub: request.invitedNpub,
        blindSignature: `sig_${request.blindedMessage.slice(0, 16)}_${request.clientNonce.slice(0, 8)}`,
        issuedAt: nowIso(),
      };
      const issued = reduceCoordinatorEvent(next, {
        type: "BLIND_SIGNATURE_ISSUED",
        issuance,
      });
      if (!issued.ok) {
        continue;
      }
      next = issued.state;
      storeBlindIssuance(issuance);
    }
    this.state = next;
    saveCoordinatorState({ coordinatorNpub: this.coordinatorNpub, state: this.state });
    return this.state;
  }

  processPendingSubmissions(requiredQuestionIds: string[]) {
    if (!this.state || !this.coordinatorNpub) {
      throw new OptionARuntimeError("not_logged_in", "Coordinator login is required.");
    }
    const queue = listSubmissions(this.electionId);
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
