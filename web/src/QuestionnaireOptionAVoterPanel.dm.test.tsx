// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  listInvitesFromMailbox: vi.fn((): unknown[] => []),
}));

vi.mock("./questionnaireInvite", () => ({
  parseInviteFromUrl: () => {
    const params = new URLSearchParams(window.location.search);
    const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
    const inviteCode = (params.get("invite_code") ?? params.get("code") ?? "").trim() || null;
    const coordinatorNpub = (params.get("coordinator") ?? "").trim() || null;
    return { electionId, invite: null, inviteCode, coordinatorNpub };
  },
}));

vi.mock("./questionnaireTransport", () => ({
  fetchQuestionnaireActiveWorkerDelegationForCapability: vi.fn().mockResolvedValue(null),
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
  listInvitesFromMailbox: optionAStorageMocks.listInvitesFromMailbox,
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
import { QuestionnaireOptionAVoterRuntime } from "./questionnaireOptionARuntime";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { fetchQuestionnaireDefinitions } from "./questionnaireTransport";
import { fetchOptionAInviteDms } from "./questionnaireOptionAInviteDm";

const fetchQuestionnaireDefinitionsMock = vi.mocked(fetchQuestionnaireDefinitions);
const fetchOptionAInviteDmsMock = vi.mocked(fetchOptionAInviteDms);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  optionAStorageMocks.listInvitesFromMailbox.mockReset();
  optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([]);
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

    const { rerender } = render(<QuestionnaireOptionAVoterPanel />);
    await screen.findByText(/Public prompt/);
    expect(screen.getByText("Public definition")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Login" }));

    rerender(<QuestionnaireOptionAVoterPanel displayMode='settings' />);
    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Organiser:")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/No invite DM was readable/i)).toBeNull();
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

    const { rerender } = render(<QuestionnaireOptionAVoterPanel localVoterNpub={"npub1" + "a".repeat(58)} autoSignerLogin />);

    await screen.findByText(/Gateway prompt/);
    rerender(<QuestionnaireOptionAVoterPanel displayMode='settings' localVoterNpub={"npub1" + "a".repeat(58)} autoSignerLogin />);
    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Organiser:")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/No invite DM was readable/i)).toBeNull();
    expect(fetchOptionAInviteDmsMock).not.toHaveBeenCalled();
  });

  it("adopts announced questionnaire id when election id is missing", async () => {
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_auto_123"]} />);

    await waitFor(() => {
      expect(screen.getByText("q_auto_123")).toBeTruthy();
    });
    expect(screen.queryByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_auto_123"))).toBeNull();
    expect(screen.queryByRole("button", { name: "Show ballot status" })).toBeNull();
  });

  it("lets an admitted voter answer the next questionnaire from the top selector", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "q".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const makeDefinition = (questionnaireId: string, title: string, prompt: string) => ({
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      responseMode: "blind_token" as const,
      questionnaireId,
      title,
      description: "",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      blindSigningPublicKey: {
        scheme: "rsabssa-sha384-pss-deterministic-v1" as const,
        keyId: "blind_key",
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: `${questionnaireId}_q1`,
        type: "yes_no" as const,
        prompt,
        required: true,
      }],
    });
    const initialDefinition = makeDefinition("q_initial_question", "Initial question", "Initial prompt");
    const nextDefinition = makeDefinition("q_next_question", "Next question", "Next prompt");
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_initial_question",
        title: "Initial question",
        description: "",
        voteUrl: "https://example.test/vote?q=q_initial_question",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: initialDefinition.blindSigningPublicKey,
        definition: initialDefinition,
        expiresAt: null,
      },
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_next_question",
        title: "Next question",
        description: "",
        voteUrl: "https://example.test/vote?q=q_next_question",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: nextDefinition.blindSigningPublicKey,
        definition: nextDefinition,
        expiresAt: null,
      },
    ]);
    const requestedElectionIds: string[] = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        requestedElectionIds.push(this.getSnapshot()?.electionId ?? "");
        return this.getSnapshot()!;
      });

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_initial_question"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      expect([...selector.options].map((option) => option.textContent)).toEqual([
        expect.stringContaining("Initial question"),
        expect.stringContaining("Next question"),
      ]);
    });

    await user.click(screen.getByRole("button", { name: "Answer next" }));

    await waitFor(() => {
      expect(requestedElectionIds).toContain("q_next_question");
    });
  });

  it("can hide the vote-page Login action when login is provided by the app menu", async () => {
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_menu_login"]} showLoginAction={false} />);

    await waitFor(() => {
      expect(screen.getByText("q_menu_login")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Login" })).toBeNull();
  });

  it("replaces a stale announced questionnaire id when there is no in-flight request", async () => {
    const { rerender } = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old"]} />);

    await waitFor(() => {
      expect(screen.getByText("q_old")).toBeTruthy();
    });

    rerender(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_old", "q_new"]} />);

    await waitFor(() => {
      expect(screen.getByText("q_new")).toBeTruthy();
    });
  });

  it("refresh status bootstraps a local ephemeral voter without requiring signer login", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireOptionAVoterPanel displayMode='settings' announcedQuestionnaireIds={["q_local"]} localVoterNpub={"npub1" + "c".repeat(58)} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Questionnaire ID: q_local")).length).toBeGreaterThan(0);
    });

    await user.click(screen.getAllByRole("button", { name: "Refresh status" }).at(-1)!);

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Identity confirmed: Yes")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Login is required.")).toBeNull();
  });

  it("hides ballot details in settings when no vote context is active", () => {
    render(<QuestionnaireOptionAVoterPanel displayMode='settings' />);

    expect(screen.queryByRole("region", { name: "Ballot details" })).toBeNull();
  });

  it("shows ballot details in settings while taking part in a vote", async () => {
    const localVoterNpub = "npub1" + "d".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_ballot_debug",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_ballot_debug",
        requestId: "request_ballot_debug",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded_debug",
        tokenCommitment: "commitment_ballot_debug",
        blindSigningKeyId: "blind_key_debug",
        clientNonce: "nonce_debug",
        createdAt: "2026-04-18T00:00:01.000Z",
      },
      blindRequestSent: true,
      blindRequestSentAt: "2026-04-18T00:00:02.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_ballot_debug",
        requestId: "request_ballot_debug",
        issuanceId: "issuance_ballot_debug",
        invitedNpub: localVoterNpub,
        tokenCommitment: "commitment_ballot_debug",
        blindSigningKeyId: "blind_key_debug",
        blindSignature: "sig_ballot_debug",
        issuedAt: "2026-04-18T00:00:03.000Z",
      },
      credentialReady: true,
      draftResponses: [],
      submission: null,
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-04-18T00:00:04.000Z",
    });

    render(
      <QuestionnaireOptionAVoterPanel
        displayMode='settings'
        announcedQuestionnaireIds={["q_ballot_debug"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    const details = await screen.findByRole("region", { name: "Ballot details" });
    expect(within(details).getByText("Request ID")).toBeTruthy();
    expect(within(details).getByText("request_ballot_debug")).toBeTruthy();
    expect(within(details).getByText("Credential ID")).toBeTruthy();
    expect(within(details).getByText("issuance_ballot_debug")).toBeTruthy();
    expect(within(details).getByText("Token commitment")).toBeTruthy();
    expect(within(details).getByText("commitment_ballot_debug")).toBeTruthy();
    expect(within(details).queryByText("sig_ballot_debug")).toBeNull();
  });

  it("sends the delayed page-load ballot request for a linked local voter", async () => {
    const localVoterNpub = "npub1" + "h".repeat(58);
    const coordinatorAtRequest: string[] = [];
    const requestSpy = vi
      .spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        coordinatorAtRequest.push(this.getSnapshot()?.coordinatorNpub ?? "");
        return this.getSnapshot()!;
      });
    window.history.pushState(null, "", "/?role=voter&q=q_delayed_auto_request");
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_delayed_auto_request",
      title: "Delayed auto request",
      description: "Cached description",
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
        prompt: "Delayed prompt",
        required: true,
      }],
    });

    render(
      <QuestionnaireOptionAVoterPanel
        localVoterNpub={localVoterNpub}
      />,
    );

    await screen.findByText(/Delayed prompt/);

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalled();
    }, { timeout: 2500 });
    expect(coordinatorAtRequest).toEqual(["npub1" + "b".repeat(58)]);
  });

  it("does not surface stale mailbox invites for a linked questionnaire", async () => {
    const localVoterNpub = "npub1" + "k".repeat(58);
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([{
      type: "election_invite",
      schemaVersion: 1,
      electionId: "q_stale_mailbox",
      title: "Stale questionnaire",
      description: "",
      voteUrl: "https://example.test/vote?q=q_stale_mailbox",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "d".repeat(58),
      expiresAt: null,
    }]);
    fetchOptionAInviteDmsMock.mockResolvedValue([]);
    window.history.pushState(null, "", "/?role=voter&q=q_linked_current");
    fetchQuestionnaireDefinitionsMock.mockResolvedValue([{
      event: { created_at: 20 },
      definition: {
        schemaVersion: 1,
        eventType: "questionnaire_definition",
        responseMode: "blind_token",
        questionnaireId: "q_linked_current",
        title: "Current questionnaire",
        description: "Current description",
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
          prompt: "Current prompt",
          required: true,
        }],
      },
    } as Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]]);

    render(<QuestionnaireOptionAVoterPanel localVoterNpub={localVoterNpub} />);

    await screen.findByText(/Current prompt/);
    expect(screen.getByText("q_linked_current")).toBeTruthy();
    expect(screen.queryByText(/Stale questionnaire/)).toBeNull();
    expect(screen.queryByText(/q_stale_mailbox/)).toBeNull();
  });

  it("shows an announced next admitted invite on a linked questionnaire without showing unrelated stale invites", async () => {
    const localVoterNpub = "npub1" + "n".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    window.history.pushState(null, "", `/?role=voter&q=q_linked_initial&coordinator=${coordinatorNpub}`);
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_linked_initial",
        title: "Initial admitted questionnaire",
        description: "",
        voteUrl: "https://example.test/vote?q=q_linked_initial",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        expiresAt: null,
      },
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_linked_next",
        title: "Next admitted questionnaire",
        description: "",
        voteUrl: "https://example.test/vote?q=q_linked_next",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        expiresAt: null,
      },
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_unrelated_stale",
        title: "Unrelated stale questionnaire",
        description: "",
        voteUrl: "https://example.test/vote?q=q_unrelated_stale",
        invitedNpub: localVoterNpub,
        coordinatorNpub: "npub1" + "d".repeat(58),
        expiresAt: null,
      },
    ]);

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_linked_initial", "q_linked_next"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      expect([...selector.options].map((option) => option.textContent)).toEqual([
        expect.stringContaining("Initial admitted questionnaire"),
        expect.stringContaining("Next admitted questionnaire"),
      ]);
    });
    expect(screen.queryByText(/Unrelated stale questionnaire/)).toBeNull();
    expect(screen.queryByText(/q_unrelated_stale/)).toBeNull();
  });

  it("waits for the linked questionnaire blind-signing key before nonce ballot request", async () => {
    const localVoterNpub = "npub1" + "m".repeat(58);
    const coordinatorAtRequest: string[] = [];
    const requestSpy = vi
      .spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        coordinatorAtRequest.push(this.getSnapshot()?.coordinatorNpub ?? "");
        return this.getSnapshot()!;
      });
    let resolveDefinitions: (entries: Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>) => void = () => undefined;
    fetchQuestionnaireDefinitionsMock.mockImplementation(() => new Promise((resolve) => {
      resolveDefinitions = resolve;
    }));
    fetchOptionAInviteDmsMock.mockResolvedValue([]);
    window.history.pushState(null, "", "/?role=voter&q=q_slow_definition&request_ballot=1");

    render(
      <QuestionnaireOptionAVoterPanel
        localVoterNpub={localVoterNpub}
        requestBlindBallotNonce={1}
      />,
    );

    await waitFor(() => {
      expect(fetchQuestionnaireDefinitionsMock).toHaveBeenCalled();
    });
    expect(requestSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveDefinitions([{
        event: { created_at: 20 },
        definition: {
          schemaVersion: 1,
          eventType: "questionnaire_definition",
          responseMode: "blind_token",
          questionnaireId: "q_slow_definition",
          title: "Slow definition questionnaire",
          description: "Loaded late",
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
            prompt: "Slow definition prompt",
            required: true,
          }],
        },
      } as Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>[number]]);
    });

    await screen.findByText(/Slow definition prompt/);
    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });
    expect(coordinatorAtRequest).toEqual(["npub1" + "b".repeat(58)]);
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

    await screen.findByText(/Cached question prompt/);
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

  it("uses verifier copy while a completed response is waiting for a ballot credential", async () => {
    const user = userEvent.setup();
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_waiting_button_copy",
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
        prompt: "Ready to submit",
        required: true,
      }],
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_waiting_button_copy"]} />);

    await user.click(await screen.findByRole("button", { name: "Yes" }));

    const submitButton = screen.getByRole("button", { name: "Verifying vote request" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Waiting for coordinator..." })).toBeNull();
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

    const { rerender } = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);

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
    rerender(<QuestionnaireOptionAVoterPanel displayMode='settings' announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);
    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() => {
      expect(screen.getAllByText((_, element) => (element?.textContent ?? "").includes("Ballot credential: Received")).length).toBeGreaterThan(0);
    });
    rerender(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);
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

    await screen.findByText(/Issued definition prompt/);
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
    expect((screen.getByRole("button", { name: "Please answer all required questions" }) as HTMLButtonElement).disabled).toBe(true);
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
        responseNpub: "npub1" + "r".repeat(58),
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

    const identityRegion = await screen.findByRole("region", { name: "Voter ID used for private submission" });
    expect(screen.getAllByLabelText(/Expand QR for token/i).length).toBeGreaterThan(0);
    expect(within(identityRegion).getByText("Questionnaire ID")).toBeTruthy();
    expect(within(identityRegion).getByText("q_submitted_marker")).toBeTruthy();
    expect(screen.getByText("Submission ID")).toBeTruthy();
    expect(screen.getByText("submission_submitted_marker")).toBeTruthy();
    expect(screen.getAllByText("Voter ID used for private submission").length).toBeGreaterThan(0);
    expect(screen.getAllByText("rrrrrrr").length).toBeGreaterThan(0);
    expect(screen.getByText("Submittor identity - full")).toBeTruthy();
    expect(screen.getByText("npub1" + "r".repeat(58))).toBeTruthy();
  });
});
