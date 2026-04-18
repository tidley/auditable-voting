// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const optionAStorageMocks = vi.hoisted(() => ({
  loadVoterState: vi.fn(() => null),
  readBlindIssuance: vi.fn(() => null),
  readAcceptance: vi.fn(() => null),
}));

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
  loadVoterState: optionAStorageMocks.loadVoterState,
  publishInviteToMailbox: () => undefined,
  readAcceptance: optionAStorageMocks.readAcceptance,
  readBlindIssuance: optionAStorageMocks.readBlindIssuance,
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
  optionAStorageMocks.loadVoterState.mockReset();
  optionAStorageMocks.loadVoterState.mockReturnValue(null);
  optionAStorageMocks.readBlindIssuance.mockReset();
  optionAStorageMocks.readBlindIssuance.mockReturnValue(null);
  optionAStorageMocks.readAcceptance.mockReset();
  optionAStorageMocks.readAcceptance.mockReturnValue(null);
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

  it("renders questions from the blind issuance definition when public definition fetch is empty", async () => {
    const localVoterNpub = "npub1" + "d".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      responseMode: "blind_token" as const,
      questionnaireId: "q_issued_definition",
      title: "Issued questionnaire",
      description: "Definition delivered with issuance",
      createdAt: 1,
      openAt: 1,
      closeAt: 999,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      questions: [{
        questionId: "issued_q1",
        type: "yes_no" as const,
        prompt: "Issued definition prompt",
        required: true,
      }],
    };
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_issued_definition",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_issued_definition",
        requestId: "request_issued_definition",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded",
        clientNonce: "nonce",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      blindRequestSent: true,
      blindRequestSentAt: "2026-04-18T00:00:00.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_issued_definition",
        requestId: "request_issued_definition",
        issuanceId: "issuance_issued_definition",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_issued_definition",
        definition,
        issuedAt: "2026-04-18T00:00:00.000Z",
      },
      credentialReady: true,
      draftResponses: [],
      submission: null,
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-04-18T00:00:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_issued_definition"]} localVoterNpub={localVoterNpub} />);

    await screen.findByText("Issued definition prompt");
    expect(screen.queryByText("Waiting for questions to be published.")).toBeNull();
  });

  it("keeps submit disabled while a credential exists but no questions are rendered", async () => {
    const localVoterNpub = "npub1" + "e".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_missing_definition",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_missing_definition",
        requestId: "request_missing_definition",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded",
        clientNonce: "nonce",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      blindRequestSent: true,
      blindRequestSentAt: "2026-04-18T00:00:00.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_missing_definition",
        requestId: "request_missing_definition",
        issuanceId: "issuance_missing_definition",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_missing_definition",
        issuedAt: "2026-04-18T00:00:00.000Z",
      },
      credentialReady: true,
      draftResponses: [],
      submission: null,
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-04-18T00:00:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_missing_definition"]} localVoterNpub={localVoterNpub} />);

    await screen.findByText("Waiting for questions to be published.");
    expect((screen.getByRole("button", { name: "Submit response" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
