// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./questionnaireInvite", () => ({
  parseInviteFromUrl: () => ({ electionId: null, invite: null }),
}));

vi.mock("./questionnaireTransport", () => ({
  fetchQuestionnaireDefinitions: vi.fn().mockResolvedValue([]),
}));

vi.mock("./services/signerService", () => ({
  createSignerService: () => ({
    isAvailable: async () => true,
    getPublicKey: async () => "npub1" + "a".repeat(58),
    signMessage: async () => "sig",
    signEvent: async <T extends Record<string, unknown>>(event: T) => event,
  }),
  SignerServiceError: class SignerServiceError extends Error {},
}));

vi.mock("./questionnaireOptionAStorage", () => ({
  enqueueBlindRequest: () => undefined,
  listInvitesFromMailbox: () => [],
  listInvitesForElectionFromMailbox: () => [],
  loadElectionSummary: () => null,
  loadVoterState: () => null,
  publishInviteToMailbox: () => undefined,
  readAcceptance: () => null,
  readBlindIssuance: () => null,
  readInviteFromMailbox: () => null,
  saveVoterState: () => undefined,
}));

vi.mock("./questionnaireOptionAInviteDm", () => ({
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([
    {
      type: "election_invite",
      schemaVersion: 1,
      electionId: "election_test_1",
      title: "Test Invite",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: "npub1" + "a".repeat(58),
      coordinatorNpub: "npub1" + "b".repeat(58),
      expiresAt: null,
    },
  ]),
}));

import QuestionnaireOptionAVoterPanel from "./QuestionnaireOptionAVoterPanel";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("QuestionnaireOptionAVoterPanel DM retrieval", () => {
  it("loads pending invites after signer login", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireOptionAVoterPanel />);

    expect(screen.queryByRole("button", { name: "Check invites" })).toBeNull();
    const loginButton = screen.getByRole("button", { name: "Login" });
    await user.click(loginButton);

    await screen.findByText(/Pending invites/i);
    expect(screen.getByText("Test Invite")).toBeTruthy();
  });

  it("adopts announced questionnaire id when election id is missing", async () => {
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_auto_123"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Election ID: q_auto_123")).length).toBeGreaterThan(0);
    });
  });

  it("replaces a stale announced questionnaire id when there is no in-flight request", async () => {
    const { rerender } = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Election ID: q_old")).length).toBeGreaterThan(0);
    });

    rerender(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old", "q_new"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Election ID: q_new")).length).toBeGreaterThan(0);
    });
  });

  it("refresh status bootstraps a local ephemeral voter without requiring signer login", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_local"]} localVoterNpub={"npub1" + "c".repeat(58)} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Election ID: q_local")).length).toBeGreaterThan(0);
    });

    await user.click(screen.getAllByRole("button", { name: "Refresh status" }).at(-1)!);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Login verified: Yes")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Login is required.")).toBeNull();
  });

  it("renders questions from cached questionnaire definition when relay fetch is empty", async () => {
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_cached_definition",
      title: "Cached questionnaire",
      description: "Cached description",
      createdAt: 1,
      openAt: 1,
      closeAt: 999,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseVisibility: "private",
      eligibilityMode: "open",
      allowMultipleResponsesPerPubkey: false,
      questions: [{
        questionId: "q1",
        type: "yes_no",
        prompt: "Cached question prompt",
        required: true,
      }],
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_cached_definition"]} />);

    await screen.findByText("Cached question prompt");
    expect(screen.queryByText("Waiting for questions to be published.")).toBeNull();
  });
});
