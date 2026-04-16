// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  processOptionAQueuesForCoordinator,
  QuestionnaireOptionACoordinatorRuntime,
  QuestionnaireOptionAVoterRuntime,
} from "./questionnaireOptionARuntime";
import type { SignerService } from "./services/signerService";

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
    voter.requestBlindBallot();

    coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    voter.submitVote(["q1"]);
    coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();

    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    const resumed = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await resumed.loginWithSigner(null);
    resumed.refreshIssuanceAndAcceptance();
    expect(resumed.getSnapshot()?.credentialReady).toBe(true);
    expect(resumed.getSnapshot()?.submissionAccepted).toBe(true);
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

    voter.requestBlindBallot();
    coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();

    // Re-request after issuance should not mint a second accepted credential.
    expect(() => voter.requestBlindBallot()).toThrow();

    voter.submitVote(["q1"]);
    coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    // Re-submission should not increase accepted unique count.
    expect(() => voter.submitVote(["q1"])).toThrow();
    coordinator.processPendingSubmissions(["q1"]);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);
  });

  it("allows non-whitelisted voter request then manual coordinator authorization", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    await voter.loginWithSigner(null);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    voter.requestBlindBallot();

    coordinator.processPendingBlindRequests();
    expect(coordinator.getPendingAuthorizations().some((entry) => entry.invitedNpub === otherNpub)).toBe(true);

    coordinator.authorizeRequester(otherNpub);
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
    voterTwo.requestBlindBallot();

    const processed = processOptionAQueuesForCoordinator({
      coordinatorNpub,
      signer: coordinator,
      preferredElectionId: electionIdOne,
    });
    expect(processed.processedElectionIds).toContain(electionIdTwo);

    voterTwo.refreshIssuanceAndAcceptance();
    expect(voterTwo.getSnapshot()?.credentialReady).toBe(true);
  });
});
