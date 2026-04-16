// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignerService } from "./services/signerService";

const publishOptionAInviteDm = vi.fn();

vi.mock("./questionnaireOptionAInviteDm", () => ({
  publishOptionAInviteDm: (...args: unknown[]) => publishOptionAInviteDm(...args),
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([]),
}));

import { QuestionnaireOptionACoordinatorRuntime } from "./questionnaireOptionARuntime";

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
});
