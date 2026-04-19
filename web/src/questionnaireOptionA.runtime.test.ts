// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processOptionAQueuesForCoordinator,
  QuestionnaireOptionACoordinatorRuntime,
  QuestionnaireOptionAVoterRuntime,
} from "./questionnaireOptionARuntime";
import { listBlindRequests, readBlindIssuance } from "./questionnaireOptionAStorage";
import { publishOptionABlindIssuanceDm } from "./questionnaireOptionABlindDm";
import type { SignerService } from "./services/signerService";

vi.mock("./questionnaireOptionAInviteDm", () => ({
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([]),
  publishOptionAInviteDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-invite-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
}));

vi.mock("./questionnaireOptionABlindDm", () => ({
  fetchOptionABallotAcceptanceDms: vi.fn().mockResolvedValue([]),
  fetchOptionABallotAcceptanceDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABallotSubmissionDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestDmsWithNsec: vi.fn().mockResolvedValue([]),
  publishOptionABallotAcceptanceDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-acceptance-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABallotSubmissionDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-submission-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindIssuanceDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-issuance-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindRequestDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-request-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
}));

function signer(npub: string): SignerService {
  return {
    async isAvailable() {
      return true;
    },
    async getPublicKey() {
      return npub;
    },
    async signMessage(message: string) {
      return `sig:${npub}:${message}`;
    },
    async signEvent<T extends Record<string, unknown>>(event: T) {
      return { ...event, pubkey: npub };
    },
  };
}

describe("questionnaireOptionARuntime", () => {
  const electionId = "election_runtime_1";
  const coordinatorNpub = "npub1coordinatorruntime0000000000000000000000000000";
  const voterNpub = "npub1voterruntime00000000000000000000000000000000000000";
  const otherNpub = "npub1otherruntime00000000000000000000000000000000000000";

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("restores login state and invite mismatch is rejected", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    const loggedIn = await voter.loginWithSigner(invite);
    expect(loggedIn.loginVerified).toBe(true);

    const wrongVoter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    await expect(wrongVoter.loginWithSigner(invite)).rejects.toThrow(/different Nostr account/i);

    const resumed = await voter.loginWithSigner(null);
    expect(resumed.loginVerified).toBe(true);
  });

  it("runs request -> issuance -> submit -> acceptance and supports resume", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot();

    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    await voter.submitVote(["q1"]);
    const submitted = voter.getSnapshot()?.submission;
    expect(submitted?.responseNpub).toBeTruthy();
    expect(submitted?.responseNpub).not.toBe(voterNpub);
    expect(submitted?.invitedNpub).toBe(submitted?.responseNpub);
    await coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();

    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    const resumed = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await resumed.loginWithSigner(null);
    resumed.refreshIssuanceAndAcceptance();
    expect(resumed.getSnapshot()?.credentialReady).toBe(true);
    expect(resumed.getSnapshot()?.submissionAccepted).toBe(true);
  });

  it("reuses an in-flight blind request across retries and republishes existing issuance", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(sentInvite.invite);

    const first = await voter.requestBlindBallot();
    const requestId = first.blindRequest?.requestId;
    expect(requestId).toBeTruthy();

    const retried = await voter.requestBlindBallot();
    expect(retried.blindRequest?.requestId).toBe(requestId);
    expect(listBlindRequests(electionId).map((entry) => entry.requestId)).toEqual([requestId]);

    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    const issued = readBlindIssuance(requestId ?? "");
    expect(issued?.requestId).toBe(requestId);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(1);

    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    expect(readBlindIssuance(requestId ?? "")).toEqual(issued);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(1);

    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    expect(readBlindIssuance(requestId ?? "")).toEqual(issued);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate issuance and duplicate accepted submissions from inflating unique count", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);

    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();

    // Re-request after issuance is idempotent and should not mint a second credential.
    const issuedRequestId = voter.getSnapshot()?.blindRequest?.requestId;
    const retryAfterIssuance = await voter.requestBlindBallot();
    expect(retryAfterIssuance.blindRequest?.requestId).toBe(issuedRequestId);

    await voter.submitVote(["q1"]);
    await coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    // Re-submission should not increase accepted unique count.
    await expect(voter.submitVote(["q1"])).rejects.toThrow();
    await coordinator.processPendingSubmissions(["q1"]);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);
  });

  it("allows non-whitelisted voter request then manual coordinator authorization", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    await voter.loginWithSigner(null);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot();

    await coordinator.processPendingBlindRequests();
    expect(coordinator.getPendingAuthorizations().some((entry) => entry.invitedNpub === otherNpub)).toBe(true);

    await coordinator.authorizeRequester(otherNpub);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
  });

  it("binds an invite to a local ephemeral voter identity when explicitly allowed", async () => {
    const inviteRecipientNpub = "npub1inviteerecipient0000000000000000000000000000000";
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(inviteRecipientNpub), electionId);
    const state = voter.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      invite: {
        type: "election_invite",
        schemaVersion: 1,
        electionId,
        title: "Runtime",
        description: "Test",
        voteUrl: "https://example.org/vote",
        invitedNpub: inviteRecipientNpub,
        coordinatorNpub,
        expiresAt: null,
      },
      allowInviteRecipientMismatch: true,
    });

    expect(state.loginVerified).toBe(true);
    expect(state.invitedNpub).toBe(voterNpub);
    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
  });

  it("loads invite from mailbox when voter logs in without URL invite", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    const loggedIn = await voter.loginWithSigner(null);
    expect(loggedIn.loginVerified).toBe(true);
    expect(loggedIn.inviteMessage?.invitedNpub).toBe(voterNpub);
    expect(loggedIn.inviteMessage?.electionId).toBe(electionId);
  });

  it("processes pending requests across multiple elections for the same coordinator", async () => {
    const electionIdOne = "election_runtime_multi_1";
    const electionIdTwo = "election_runtime_multi_2";
    const coordinator = signer(coordinatorNpub);

    const coordinatorOne = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdOne);
    await coordinatorOne.loginWithSigner({ title: "Runtime 1", description: "Test", state: "open" });
    coordinatorOne.addWhitelistNpub(voterNpub);
    await coordinatorOne.sendInvite(voterNpub, {
      title: "Runtime 1",
      description: "Test",
      voteUrl: "https://example.org/vote/1",
    });

    const coordinatorTwo = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdTwo);
    await coordinatorTwo.loginWithSigner({ title: "Runtime 2", description: "Test", state: "open" });
    coordinatorTwo.addWhitelistNpub(voterNpub);
    const sentTwo = await coordinatorTwo.sendInvite(voterNpub, {
      title: "Runtime 2",
      description: "Test",
      voteUrl: "https://example.org/vote/2",
    });

    const voterTwo = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionIdTwo);
    await voterTwo.loginWithSigner(sentTwo.invite);
    await voterTwo.requestBlindBallot();

    const processed = await processOptionAQueuesForCoordinator({
      coordinatorNpub,
      signer: coordinator,
      preferredElectionId: electionIdOne,
    });
    expect(processed.processedElectionIds).toContain(electionIdTwo);

    voterTwo.refreshIssuanceAndAcceptance();
    expect(voterTwo.getSnapshot()?.credentialReady).toBe(true);
  });
});
