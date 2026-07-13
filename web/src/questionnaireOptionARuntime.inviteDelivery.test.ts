// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignerService } from "./services/signerService";

const publishOptionAInviteDm = vi.fn();
const fetchActiveWorkerDelegation = vi.fn();
const fetchLatestPublishedDefinition = vi.fn();

vi.mock("./questionnaireOptionAInviteDm", () => ({
  publishOptionAInviteDm: (...args: unknown[]) => publishOptionAInviteDm(...args),
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([]),
}));

vi.mock("./questionnaireTransport", () => ({
  fetchQuestionnaireActiveWorkerDelegationForCapability: (...args: unknown[]) => fetchActiveWorkerDelegation(...args),
  fetchLatestQuestionnaireDefinitionByCoordinator: (...args: unknown[]) => fetchLatestPublishedDefinition(...args),
  fetchQuestionnaireProvisionalResponses: vi.fn().mockResolvedValue([]),
}));

import { QuestionnaireOptionACoordinatorRuntime } from "./questionnaireOptionARuntime";
import { questionnaireDefinitionEventHash, questionnaireDefinitionHash } from "./questionnaireDefinitionReference";

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

describe("QuestionnaireOptionACoordinatorRuntime invite delivery messaging", () => {
  const electionId = "election_runtime_dm";
  const coordinatorNpub = "npub1coordinatorruntime0000000000000000000000000000";
  const voterNpub = "npub1voterruntime00000000000000000000000000000000000000";

  beforeEach(() => {
    window.localStorage.clear();
    publishOptionAInviteDm.mockReset();
    fetchActiveWorkerDelegation.mockReset().mockResolvedValue(null);
    fetchLatestPublishedDefinition.mockReset().mockResolvedValue(null);
  });

  it("reports dmDelivered=true when publish succeeds", async () => {
    publishOptionAInviteDm.mockResolvedValue({
      eventId: "event-1",
      successes: 1,
      failures: 0,
      relayResults: [{ relay: "wss://example.test", success: true }],
    });
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    const sent = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    expect(sent.dmDelivered).toBe(true);
    expect(sent.dmFailureReason).toBeNull();
    expect(sent.invite.invitedNpub).toBe(voterNpub);
  });

  it("reports dmDelivered=false with failure reason when publish fails", async () => {
    publishOptionAInviteDm.mockRejectedValue(new Error("relay timeout"));
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    const sent = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    expect(sent.dmDelivered).toBe(false);
    expect(sent.dmFailureReason).toMatch(/relay timeout/i);
    expect(sent.invite.invitedNpub).toBe(voterNpub);
  });

  it("passes fallback nsec to DM publish when coordinator uses local key", async () => {
    publishOptionAInviteDm.mockResolvedValue({
      eventId: "event-2",
      successes: 1,
      failures: 0,
      relayResults: [{ relay: "wss://example.test", success: true }],
    });
    const fallbackNsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw2xj9";
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(
      signer(coordinatorNpub),
      electionId,
      fallbackNsec,
    );
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    expect(publishOptionAInviteDm).toHaveBeenCalledTimes(1);
    expect(publishOptionAInviteDm).toHaveBeenCalledWith(expect.objectContaining({
      fallbackNsec,
      invite: expect.objectContaining({
        invitedNpub: voterNpub,
      }),
    }));
  });

  it("embeds the active proxy and actual published definition in the voter invite", async () => {
    const workerNpub = "npub1worker000000000000000000000000000000000000000000000000";
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      protocolVersion: 2 as const,
      flowMode: "public_submission_v1" as const,
      responseMode: "blind_token" as const,
      questionnaireId: electionId,
      title: "Published questionnaire",
      description: "Published definition",
      createdAt: 1783945621,
      openAt: 1783945621,
      closeAt: 1783949221,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      questions: [{
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Proceed?",
        required: true,
      }],
    };
    const publishedContent = JSON.stringify({
      ...definition,
      allowMultipleResponsesPerPubkey: undefined,
    });
    const publishedHash = questionnaireDefinitionEventHash(publishedContent);
    fetchLatestPublishedDefinition.mockResolvedValue({
      event: { id: "published-definition-event", created_at: 1783945622, content: publishedContent },
      definition,
      definitionHash: publishedHash,
    });
    fetchActiveWorkerDelegation.mockResolvedValue({
      type: "worker_delegation",
      schemaVersion: 1,
      delegationId: "delegation_live_proxy",
      electionId,
      coordinatorNpub,
      workerNpub,
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://relay.nostr.net"],
      issuedAt: "2026-07-13T12:29:38.018Z",
      expiresAt: "2036-07-10T12:29:38.018Z",
    });
    publishOptionAInviteDm.mockResolvedValue({
      eventId: "invite-event",
      successes: 1,
      failures: 0,
      relayResults: [],
    });
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    const sent = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    expect(sent.invite.definitionReference).toMatchObject({
      definitionEventId: "published-definition-event",
      definitionHash: publishedHash,
    });
    expect(sent.invite.definitionReference?.definitionHash).not.toBe(questionnaireDefinitionHash(definition));
    expect(sent.invite.issueBlindTokensWorker).toMatchObject({
      delegationId: "delegation_live_proxy",
      workerNpub,
    });
  });
});
