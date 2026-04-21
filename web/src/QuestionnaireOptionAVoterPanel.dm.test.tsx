// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const optionAStorageMocks = vi.hoisted(() => ({
  loadVoterState: vi.fn((): unknown => null),
  readElectionPrivateRelayPrefs: vi.fn((): unknown => []),
  recordElectionPrivateRelaySuccesses: vi.fn((): void => undefined),
  readBallotSubmissionAckRecord: vi.fn((): unknown => null),
  readBlindRequestAckRecord: vi.fn((): unknown => null),
  readBlindIssuance: vi.fn((): unknown => null),
  readBlindIssuanceAckRecord: vi.fn((): unknown => null),
  readAcceptance: vi.fn((): unknown => null),
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
  readElectionPrivateRelayPrefs: optionAStorageMocks.readElectionPrivateRelayPrefs,
  readBallotSubmissionAckRecord: optionAStorageMocks.readBallotSubmissionAckRecord,
  readAcceptance: optionAStorageMocks.readAcceptance,
  readBlindRequestAckRecord: optionAStorageMocks.readBlindRequestAckRecord,
  readBlindIssuance: optionAStorageMocks.readBlindIssuance,
  readBlindIssuanceAckRecord: optionAStorageMocks.readBlindIssuanceAckRecord,
  readInviteFromMailbox: () => null,
  recordElectionPrivateRelaySuccesses: optionAStorageMocks.recordElectionPrivateRelaySuccesses,
  saveVoterState: () => undefined,
  upsertElectionSummary: vi.fn(),
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
import { fetchQuestionnaireDefinitions } from "./questionnaireTransport";
import { fetchOptionAInviteDms } from "./questionnaireOptionAInviteDm";

const fetchQuestionnaireDefinitionsMock = vi.mocked(fetchQuestionnaireDefinitions);
const fetchOptionAInviteDmsMock = vi.mocked(fetchOptionAInviteDms);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.pushState(null, "", "/");
  fetchQuestionnaireDefinitionsMock.mockReset();
  fetchQuestionnaireDefinitionsMock.mockResolvedValue([]);
  fetchOptionAInviteDmsMock.mockReset();
  fetchOptionAInviteDmsMock.mockResolvedValue([
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
  ]);
  optionAStorageMocks.loadVoterState.mockReset();
  optionAStorageMocks.loadVoterState.mockReturnValue(null);
  optionAStorageMocks.readElectionPrivateRelayPrefs.mockReset();
  optionAStorageMocks.readElectionPrivateRelayPrefs.mockReturnValue([]);
  optionAStorageMocks.recordElectionPrivateRelaySuccesses.mockReset();
  optionAStorageMocks.readBallotSubmissionAckRecord.mockReset();
  optionAStorageMocks.readBallotSubmissionAckRecord.mockReturnValue(null);
  optionAStorageMocks.readBlindRequestAckRecord.mockReset();
  optionAStorageMocks.readBlindRequestAckRecord.mockReturnValue(null);
  optionAStorageMocks.readBlindIssuance.mockReset();
  optionAStorageMocks.readBlindIssuance.mockReturnValue(null);
  optionAStorageMocks.readBlindIssuanceAckRecord.mockReset();
  optionAStorageMocks.readBlindIssuanceAckRecord.mockReturnValue(null);
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

  it("opens a linked public questionnaire after signer login when invite DMs are unreadable", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?role=voter&q=q_public_link");
    fetchOptionAInviteDmsMock.mockResolvedValue([]);
    fetchQuestionnaireDefinitionsMock.mockResolvedValue([{
      event: { created_at: 20 },
      definition: {
        schemaVersion: 1,
        eventType: "questionnaire_definition",
        responseMode: "blind_token",
        questionnaireId: "q_public_link",
        title: "Linked questionnaire",
        description: "Public definition",
        createdAt: 1,
        openAt: 1,
        closeAt: 9999999999,
        coordinatorPubkey: "npub1" + "b".repeat(58),
        coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
        responseVisibility: "private",
        eligibilityMode: "open",
        allowMultipleResponsesPerPubkey: false,
        blindSigningPublicKey: {
          scheme: "rsabssa-sha384-pss-deterministic-v1",
          keyId: "blind_key",
          jwk: { kty: "RSA", e: "AQAB", n: "test" },
        },
        questions: [{
          questionId: "q1",
          type: "yes_no",
          prompt: "Public prompt",
          required: true,
        }],
      },
    } as Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]]);

    render(<QuestionnaireOptionAVoterPanel />);
    await screen.findByText("Public prompt");

    await user.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Coordinator:")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/No invite DM was readable/i)).toBeNull();
    expect(screen.getByText("Public definition")).toBeTruthy();
    expect(fetchOptionAInviteDmsMock).not.toHaveBeenCalled();
  });

  it("auto logs in with the signer when a linked questionnaire is opened from the gateway", async () => {
    window.history.pushState(null, "", "/?role=voter&q=q_gateway_link");
    fetchOptionAInviteDmsMock.mockResolvedValue([]);
    fetchQuestionnaireDefinitionsMock.mockResolvedValue([{
      event: { created_at: 20 },
      definition: {
        schemaVersion: 1,
        eventType: "questionnaire_definition",
        responseMode: "blind_token",
        questionnaireId: "q_gateway_link",
        title: "Gateway questionnaire",
        description: "",
        createdAt: 1,
        openAt: 1,
        closeAt: 9999999999,
        coordinatorPubkey: "npub1" + "b".repeat(58),
        coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
        responseVisibility: "private",
        eligibilityMode: "open",
        allowMultipleResponsesPerPubkey: false,
        questions: [{
          questionId: "q1",
          type: "yes_no",
          prompt: "Gateway prompt",
          required: true,
        }],
      },
    } as Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]]);

    render(<QuestionnaireOptionAVoterPanel localVoterNpub={"npub1" + "a".repeat(58)} autoSignerLogin />);

    await screen.findByText("Gateway prompt");
    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Coordinator:")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/No invite DM was readable/i)).toBeNull();
    expect(fetchOptionAInviteDmsMock).not.toHaveBeenCalled();
  });

  it("adopts announced questionnaire id when election id is missing", async () => {
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_auto_123"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_auto_123")).length).toBeGreaterThan(0);
    });
  });

  it("replaces a stale announced questionnaire id when there is no in-flight request", async () => {
    const { rerender } = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_old")).length).toBeGreaterThan(0);
    });

    rerender(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old", "q_new"]} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_new")).length).toBeGreaterThan(0);
    });
  });

  it("refresh status bootstraps a local ephemeral voter without requiring signer login", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_local"]} localVoterNpub={"npub1" + "c".repeat(58)} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_local")).length).toBeGreaterThan(0);
    });

    await user.click(screen.getAllByRole("button", { name: "Refresh status" }).at(-1)!);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Identity confirmed: Yes")).length).toBeGreaterThan(0);
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

  it("marks the selected yes/no answer visually", async () => {
    const user = userEvent.setup();
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_yes_no_selected",
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
        prompt: "Choose yes or no",
        required: true,
      }],
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_yes_no_selected"]} />);

    const yesButton = await screen.findByRole("button", { name: "Yes" });
    const noButton = screen.getByRole("button", { name: "No" });
    await user.click(yesButton);

    expect(yesButton.className).toContain("is-active");
    expect(noButton.className).toContain("is-dimmed");
    expect(yesButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps drafted answers when the blind ballot credential arrives", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "d".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      responseMode: "blind_token" as const,
      questionnaireId: "q_preserve_answers",
      title: "Cached questionnaire",
      description: "Cached description",
      createdAt: 1,
      openAt: 1,
      closeAt: 999,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      questions: [{
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Keep this answer",
        required: true,
      }],
    };
    const blindRequest = {
      type: "blind_ballot_request" as const,
      schemaVersion: 1 as const,
      electionId: "q_preserve_answers",
      requestId: "request_preserve_answers",
      invitedNpub: localVoterNpub,
      blindedMessage: "blinded",
      clientNonce: "nonce",
      createdAt: "2026-04-18T00:00:00.000Z",
    };
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_preserve_answers",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest,
      blindRequestSent: true,
      blindRequestSentAt: "2026-04-18T00:00:00.000Z",
      blindIssuance: null,
      credentialReady: false,
      draftResponses: [],
      submission: null,
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-04-18T00:00:00.000Z",
    });
    storeCachedQuestionnaireDefinition(definition);

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);

    const yesButton = await screen.findByRole("button", { name: "Yes" });
    await user.click(yesButton);
    expect(yesButton.getAttribute("aria-pressed")).toBe("true");

    optionAStorageMocks.readBlindIssuance.mockReturnValue({
      type: "blind_ballot_response",
      schemaVersion: 1,
      electionId: "q_preserve_answers",
      requestId: "request_preserve_answers",
      issuanceId: "issuance_preserve_answers",
      invitedNpub: localVoterNpub,
      blindSignature: "sig_preserve_answers",
      definition,
      issuedAt: "2026-04-18T00:01:00.000Z",
    });
    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Ballot credential: Received")).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole("button", { name: "Yes" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "No" }).className).toContain("is-dimmed");
  });

  it("renders questions from the blind issuance definition when public definition fetch is empty", async () => {
    const localVoterNpub = "npub1" + "e".repeat(58);
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
    const localVoterNpub = "npub1" + "f".repeat(58);
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
    expect((screen.getByRole("button", { name: "Please answer all questions marked 'Required'" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the submitted responder marker with QR after submission", async () => {
    const localVoterNpub = "npub1" + "g".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_submitted_marker",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_submitted_marker",
        requestId: "request_submitted_marker",
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
        electionId: "q_submitted_marker",
        requestId: "request_submitted_marker",
        issuanceId: "issuance_submitted_marker",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_submitted_marker",
        issuedAt: "2026-04-18T00:00:00.000Z",
      },
      credentialReady: true,
      draftResponses: [],
      submission: {
        type: "ballot_submission",
        schemaVersion: 1,
        electionId: "q_submitted_marker",
        submissionId: "submission_submitted_marker",
        invitedNpub: localVoterNpub,
        credential: "sig_submitted_marker",
        nullifier: "nullifier_submitted_marker",
        payload: {
          electionId: "q_submitted_marker",
          responses: [],
        },
        submittedAt: "2026-04-18T00:01:00.000Z",
      },
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-04-18T00:01:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_submitted_marker"]} localVoterNpub={localVoterNpub} />);

    await screen.findByRole("region", { name: "Submitted responder marker" });
    expect(screen.getAllByLabelText(/Expand QR for token/i).length).toBeGreaterThan(0);
  });
});
