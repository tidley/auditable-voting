import { describe, expect, it } from "vitest";
import {
  buildCoordinatorStorageKeys,
  buildVoterStorageKeys,
  countAcceptedUniqueVoters,
  createEmptyVoterElectionLocalState,
  deriveCoordinatorUiFlags,
  deriveVoterUiFlags,
  reduceCoordinatorEvent,
  reduceVoterEvent,
  restoreCoordinatorElectionState,
  restoreVoterElectionLocalState,
  validateBallotSubmission,
  validateBlindBallotRequest,
  validateLoginProof,
  type BallotSubmission,
  type BlindBallotIssuance,
  type BlindBallotRequest,
  type CoordinatorElectionState,
  type ElectionInviteMessage,
  type SignedLoginProof,
  type WhitelistEntry,
} from "./questionnaireOptionA";

const electionId = "election-1";
const coordinatorNpub = "npub1coordinator";
const voterNpub = "npub1voter";
const nowIso = "2026-04-15T00:00:00.000Z";

function makeWhitelistEntry(npub = voterNpub): WhitelistEntry {
  return {
    electionId,
    invitedNpub: npub,
    addedAt: nowIso,
    claimState: "whitelisted",
  };
}

function makeCoordinatorState(): CoordinatorElectionState {
  return {
    election: {
      electionId,
      title: "Course feedback",
      description: "Term feedback",
      state: "open",
      coordinatorNpub,
    },
    whitelist: {},
    pendingBlindRequests: {},
    issuedBlindResponses: {},
    receivedSubmissions: {},
    acceptedNullifiers: {},
    acceptanceResults: {},
    lastUpdatedAt: nowIso,
  };
}

function makeInvite(): ElectionInviteMessage {
  return {
    type: "election_invite",
    schemaVersion: 1,
    electionId,
    title: "Course feedback",
    description: "Term feedback",
    voteUrl: "https://example.org/vote",
    invitedNpub: voterNpub,
    coordinatorNpub,
    expiresAt: "2026-05-01T00:00:00.000Z",
  };
}

function makeBlindRequest(requestId = "request-1"): BlindBallotRequest {
  return {
    type: "blind_ballot_request",
    schemaVersion: 1,
    electionId,
    requestId,
    invitedNpub: voterNpub,
    blindedMessage: "blinded-msg",
    clientNonce: "nonce-1",
    createdAt: nowIso,
  };
}

function makeIssuance(requestId = "request-1", issuanceId = "issuance-1"): BlindBallotIssuance {
  return {
    type: "blind_ballot_response",
    schemaVersion: 1,
    electionId,
    requestId,
    issuanceId,
    invitedNpub: voterNpub,
    blindSignature: "blind-signature",
    issuedAt: nowIso,
  };
}

function makeSubmission(input: { submissionId?: string; nullifier?: string; invitedNpub?: string } = {}): BallotSubmission {
  return {
    type: "ballot_submission",
    schemaVersion: 1,
    electionId,
    submissionId: input.submissionId ?? "submission-1",
    invitedNpub: input.invitedNpub ?? voterNpub,
    credential: "credential-1",
    nullifier: input.nullifier ?? "nullifier-1",
    payload: {
      electionId,
      responses: [
        { questionId: "q1", type: "yes_no", answer: "yes" },
      ],
    },
    submittedAt: nowIso,
  };
}

describe("questionnaireOptionA", () => {
  it("validates login proof for whitelisted voter and rejects non-whitelisted coordinator transition and expired challenge", () => {
    const proof: SignedLoginProof = {
      type: "signed_login_proof",
      schemaVersion: 1,
      electionId,
      npub: voterNpub,
      challenge: {
        type: "login_challenge",
        schemaVersion: 1,
        domain: "example.org",
        electionId,
        npub: voterNpub,
        nonce: "nonce-1",
        issuedAt: "2026-04-15T00:00:00.000Z",
        expiresAt: "2026-04-15T00:10:00.000Z",
      },
      signature: "sig",
    };

    const valid = validateLoginProof({
      proof,
      expectedDomain: "example.org",
      expectedElectionId: electionId,
      nonceAlreadyUsed: false,
      nowIso: "2026-04-15T00:01:00.000Z",
      verifySignature: () => true,
    });
    expect(valid).toBe(true);

    const expired = validateLoginProof({
      proof: { ...proof, challenge: { ...proof.challenge, expiresAt: "2026-04-15T00:00:00.000Z" } },
      expectedDomain: "example.org",
      expectedElectionId: electionId,
      nonceAlreadyUsed: false,
      nowIso: "2026-04-15T00:01:00.000Z",
      verifySignature: () => true,
    });
    expect(expired).toBe(false);

    const state = makeCoordinatorState();
    const loginUnknown = reduceCoordinatorEvent(state, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: "npub1unknown",
    });
    expect(loginUnknown.ok).toBe(false);
    expect(loginUnknown.error).toBe("not_whitelisted");
  });

  it("handles blind request creation, send, resume, duplicate rejection and replay idempotence", () => {
    const voterInit = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub,
      now: nowIso,
    });
    const loadedInvite = reduceVoterEvent(voterInit, { type: "INVITE_LOADED", invite: makeInvite() });
    const loggedIn = reduceVoterEvent(loadedInvite.state, {
      type: "LOGIN_VERIFIED",
      electionId,
      npub: voterNpub,
      verifiedAt: nowIso,
    });
    const request = makeBlindRequest("request-1");
    const created = reduceVoterEvent(loggedIn.state, {
      type: "BLIND_REQUEST_CREATED",
      request,
    });
    expect(created.ok).toBe(true);

    const sent = reduceVoterEvent(created.state, {
      type: "BLIND_REQUEST_SENT",
      electionId,
      requestId: request.requestId,
      sentAt: nowIso,
    });
    expect(sent.ok).toBe(true);

    const resumed = restoreVoterElectionLocalState({ persisted: sent.state });
    expect(resumed.blindRequest?.requestId).toBe("request-1");
    expect(resumed.blindRequestSent).toBe(true);

    let coordinator = makeCoordinatorState();
    coordinator = reduceCoordinatorEvent(coordinator, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    const firstRequest = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_REQUEST_RECEIVED",
      request,
    });
    expect(firstRequest.ok).toBe(true);

    coordinator = reduceCoordinatorEvent(firstRequest.state, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-1", "issuance-1"),
    }).state;

    const secondIndependent = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-2"),
    });
    expect(secondIndependent.ok).toBe(false);
    expect(secondIndependent.error).toBe("already_issued");

    const replay = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-1", "issuance-1"),
    });
    expect(replay.ok).toBe(true);
  });

  it("enforces issuance invariants and voter-side mismatch protection with resume", () => {
    const voterInit = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub,
      now: nowIso,
    });
    const readyForIssuance = reduceVoterEvent(
      reduceVoterEvent(voterInit, {
        type: "LOGIN_VERIFIED",
        electionId,
        npub: voterNpub,
      }).state,
      { type: "BLIND_REQUEST_CREATED", request: makeBlindRequest("request-1") },
    );
    const firstIssuance = reduceVoterEvent(readyForIssuance.state, {
      type: "BLIND_ISSUANCE_RECEIVED",
      issuance: makeIssuance("request-1", "issuance-1"),
    });
    expect(firstIssuance.ok).toBe(true);

    const mismatched = reduceVoterEvent(firstIssuance.state, {
      type: "BLIND_ISSUANCE_RECEIVED",
      issuance: makeIssuance("request-2", "issuance-2"),
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.error).toBe("issuance_conflict");

    const resumed = restoreVoterElectionLocalState({
      persisted: firstIssuance.state,
      canonicalIssuance: makeIssuance("request-1", "issuance-1"),
    });
    expect(resumed.credentialReady).toBe(true);

    let coordinator = makeCoordinatorState();
    coordinator = reduceCoordinatorEvent(coordinator, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-1"),
    }).state;
    const issue1 = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-1", "issuance-1"),
    });
    const issue2 = reduceCoordinatorEvent(issue1.state, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-2", "issuance-2"),
    });
    expect(issue1.ok).toBe(true);
    expect(issue2.ok).toBe(false);
    expect(issue2.error).toBe("request_missing");
  });

  it("accepts valid submission, rejects duplicate nullifier and already-voted submissions, and enforces required answers", () => {
    const validSubmission = validateBallotSubmission({
      submission: makeSubmission(),
      electionId,
      electionState: "open",
      requiredQuestionIds: ["q1"],
    });
    expect(validSubmission).toBe(true);

    const missingRequired = validateBallotSubmission({
      submission: {
        ...makeSubmission(),
        payload: { electionId, responses: [] },
      },
      electionId,
      electionState: "open",
      requiredQuestionIds: ["q1"],
    });
    expect(missingRequired).toBe(false);

    let coordinator = makeCoordinatorState();
    coordinator = reduceCoordinatorEvent(coordinator, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-1"),
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-1", "issuance-1"),
    }).state;

    const submission1 = makeSubmission({ submissionId: "submission-1", nullifier: "nullifier-1" });
    const recv1 = reduceCoordinatorEvent(coordinator, {
      type: "BALLOT_SUBMISSION_RECEIVED",
      submission: submission1,
    });
    expect(recv1.ok).toBe(true);
    const accept1 = reduceCoordinatorEvent(recv1.state, {
      type: "BALLOT_ACCEPTED",
      result: {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId,
        submissionId: "submission-1",
        accepted: true,
        decidedAt: nowIso,
      },
    });
    expect(accept1.ok).toBe(true);

    const submission2 = makeSubmission({ submissionId: "submission-2", nullifier: "nullifier-1" });
    const recv2 = reduceCoordinatorEvent(accept1.state, {
      type: "BALLOT_SUBMISSION_RECEIVED",
      submission: submission2,
    });
    expect(recv2.ok).toBe(true);
    const acceptDuplicateNullifier = reduceCoordinatorEvent(recv2.state, {
      type: "BALLOT_ACCEPTED",
      result: {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId,
        submissionId: "submission-2",
        accepted: true,
        decidedAt: nowIso,
      },
    });
    expect(acceptDuplicateNullifier.ok).toBe(false);
    expect(acceptDuplicateNullifier.error).toBe("duplicate_nullifier");

    const submission3 = makeSubmission({ submissionId: "submission-3", nullifier: "nullifier-2" });
    const recv3 = reduceCoordinatorEvent(accept1.state, {
      type: "BALLOT_SUBMISSION_RECEIVED",
      submission: submission3,
    });
    const acceptAlreadyVoted = reduceCoordinatorEvent(recv3.state, {
      type: "BALLOT_ACCEPTED",
      result: {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId,
        submissionId: "submission-3",
        accepted: true,
        decidedAt: nowIso,
      },
    });
    expect(acceptAlreadyVoted.ok).toBe(false);
    expect(acceptAlreadyVoted.error).toBe("already_voted");
  });

  it("restores voter and coordinator state with canonical truth and preserves accounting", () => {
    let coordinator = makeCoordinatorState();
    coordinator = reduceCoordinatorEvent(coordinator, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry(voterNpub) }).state;
    coordinator = reduceCoordinatorEvent(coordinator, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry("npub1voter2") }).state;
    coordinator = reduceCoordinatorEvent(coordinator, { type: "LOGIN_VERIFIED", electionId, invitedNpub: voterNpub }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-1"),
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BLIND_SIGNATURE_ISSUED",
      issuance: makeIssuance("request-1", "issuance-1"),
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BALLOT_SUBMISSION_RECEIVED",
      submission: makeSubmission({ submissionId: "submission-1", nullifier: "nullifier-1" }),
    }).state;
    coordinator = reduceCoordinatorEvent(coordinator, {
      type: "BALLOT_ACCEPTED",
      result: {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId,
        submissionId: "submission-1",
        accepted: true,
        decidedAt: nowIso,
      },
    }).state;

    const restoredCoordinator = restoreCoordinatorElectionState({
      persisted: coordinator,
      canonicalIssuances: { "request-1": makeIssuance("request-1", "issuance-1") },
    });
    expect(restoredCoordinator.whitelist[voterNpub]?.claimState).toBe("vote_accepted");
    expect(countAcceptedUniqueVoters(restoredCoordinator)).toBe(1);

    const duplicateReplay = restoreCoordinatorElectionState({
      persisted: restoredCoordinator,
      canonicalAcceptance: {
        "submission-1": {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId,
          submissionId: "submission-1",
          accepted: true,
          decidedAt: nowIso,
        },
      },
    });
    expect(countAcceptedUniqueVoters(duplicateReplay)).toBe(1);

    const voterBase = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub,
      now: nowIso,
    });
    const withSubmission = reduceVoterEvent(
      reduceVoterEvent(
        reduceVoterEvent(
          reduceVoterEvent(voterBase, { type: "LOGIN_VERIFIED", electionId, npub: voterNpub }).state,
          { type: "BLIND_REQUEST_CREATED", request: makeBlindRequest("request-1") },
        ).state,
        { type: "BLIND_ISSUANCE_RECEIVED", issuance: makeIssuance("request-1", "issuance-1") },
      ).state,
      { type: "BALLOT_SUBMISSION_CREATED", submission: makeSubmission({ submissionId: "submission-1" }) },
    );
    const restoredVoter = restoreVoterElectionLocalState({
      persisted: withSubmission.state,
      canonicalIssuance: makeIssuance("request-1", "issuance-1"),
      canonicalAcceptance: {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId,
        submissionId: "submission-1",
        accepted: true,
        decidedAt: nowIso,
      },
    });
    expect(restoredVoter.credentialReady).toBe(true);
    expect(restoredVoter.submissionAccepted).toBe(true);
  });

  it("allows blind request intake before publish and blocks when closed", () => {
    const request = makeBlindRequest("request-prepublish");

    const coordinatorDraft = makeCoordinatorState();
    coordinatorDraft.election.state = "draft";
    const whitelistedDraft = reduceCoordinatorEvent(coordinatorDraft, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    const claimedDraft = reduceCoordinatorEvent(whitelistedDraft, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    const draftReceived = reduceCoordinatorEvent(claimedDraft, {
      type: "BLIND_REQUEST_RECEIVED",
      request,
    });
    expect(draftReceived.ok).toBe(true);

    const coordinatorPublished = makeCoordinatorState();
    coordinatorPublished.election.state = "published";
    const whitelistedPublished = reduceCoordinatorEvent(coordinatorPublished, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    const claimedPublished = reduceCoordinatorEvent(whitelistedPublished, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    const publishedReceived = reduceCoordinatorEvent(claimedPublished, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-published"),
    });
    expect(publishedReceived.ok).toBe(true);

    const coordinatorClosed = makeCoordinatorState();
    coordinatorClosed.election.state = "closed";
    const whitelistedClosed = reduceCoordinatorEvent(coordinatorClosed, { type: "WHITELIST_ADDED", entry: makeWhitelistEntry() }).state;
    const claimedClosed = reduceCoordinatorEvent(whitelistedClosed, {
      type: "LOGIN_VERIFIED",
      electionId,
      invitedNpub: voterNpub,
    }).state;
    const closedReceived = reduceCoordinatorEvent(claimedClosed, {
      type: "BLIND_REQUEST_RECEIVED",
      request: makeBlindRequest("request-closed"),
    });
    expect(closedReceived.ok).toBe(false);
    expect(closedReceived.error).toBe("election_not_open");
  });

  it("derives UI flags, storage keys and blind request validation from strict rules", () => {
    const voterState = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub,
      now: nowIso,
    });
    const voterFlags = deriveVoterUiFlags(voterState);
    expect(voterFlags.canLogin).toBe(true);
    expect(voterFlags.canSubmitVote).toBe(false);

    const coordinatorFlags = deriveCoordinatorUiFlags(makeCoordinatorState());
    expect(coordinatorFlags.canIssueBlindResponses).toBe(true);

    const storageKeys = buildVoterStorageKeys({ npub: voterNpub, electionId });
    expect(storageKeys.invite).toBe(`app:auditable-voting:voter:${voterNpub}:${electionId}:invite`);
    const coordinatorKeys = buildCoordinatorStorageKeys({ npub: coordinatorNpub, electionId });
    expect(coordinatorKeys.whitelist).toBe(`app:auditable-voting:coordinator:${coordinatorNpub}:${electionId}:whitelist`);

    const validBlindRequest = validateBlindBallotRequest({
      request: makeBlindRequest("request-1"),
      electionState: "open",
      isWhitelisted: true,
      loginVerified: true,
      requestSeen: false,
    });
    const invalidBlindRequest = validateBlindBallotRequest({
      request: { ...makeBlindRequest("request-2"), blindedMessage: " " },
      electionState: "open",
      isWhitelisted: true,
      loginVerified: true,
      requestSeen: false,
    });
    expect(validBlindRequest).toBe(true);
    expect(invalidBlindRequest).toBe(false);
  });
});
