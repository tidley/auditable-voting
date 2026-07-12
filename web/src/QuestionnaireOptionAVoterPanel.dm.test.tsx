// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deriveIdentityWords } from "./identityWords";

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
  buildQuestionnaireInviteUrl: (input: {
    baseUrl?: string;
    electionId: string;
    coordinatorNpub?: string | null;
    inviteCode?: string | null;
    autoRequestBallot?: boolean;
  }) => {
    const url = new URL(input.baseUrl ?? "https://example.test/");
    url.searchParams.set("role", "voter");
    url.searchParams.set("q", input.electionId);
    if (input.coordinatorNpub?.trim()) {
      url.searchParams.set("coordinator", input.coordinatorNpub.trim());
    }
    if (input.inviteCode?.trim()) {
      url.searchParams.set("invite_code", input.inviteCode.trim());
    }
    if (input.autoRequestBallot) {
      url.searchParams.set("request_ballot", "1");
    }
    return url.toString();
  },
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
  fetchQuestionnairePrivateInviteStatus: vi.fn().mockResolvedValue(null),
  fetchQuestionnaireProvisionalResponses: vi.fn().mockResolvedValue([]),
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

import QuestionnaireOptionAVoterPanel, { formatVoteActionButtonText } from "./QuestionnaireOptionAVoterPanel";
import { QuestionnaireOptionAVoterRuntime } from "./questionnaireOptionARuntime";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { fetchQuestionnaireDefinitions, fetchQuestionnairePrivateInviteStatus } from "./questionnaireTransport";
import { fetchOptionAInviteDms } from "./questionnaireOptionAInviteDm";
import {
  hashQuestionnaireInviteCode,
  hashQuestionnairePrivateInviteClaim,
} from "./questionnaireInviteCode";

const fetchQuestionnaireDefinitionsMock = vi.mocked(fetchQuestionnaireDefinitions);
const fetchQuestionnairePrivateInviteStatusMock = vi.mocked(fetchQuestionnairePrivateInviteStatus);
const fetchOptionAInviteDmsMock = vi.mocked(fetchOptionAInviteDms);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.pushState(null, "", "/");
  fetchQuestionnaireDefinitionsMock.mockReset();
  fetchQuestionnaireDefinitionsMock.mockResolvedValue([]);
  fetchQuestionnairePrivateInviteStatusMock.mockReset();
  fetchQuestionnairePrivateInviteStatusMock.mockResolvedValue(null);
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
  it("shows an in-flight submit label until the next action state is available", () => {
    const baseInput = {
      snapshot: null,
      requiredQuestionsAnswered: true,
      canSubmitNow: true,
      blindSigningKeyReady: true,
      ballotRequestSent: true,
      credentialReady: true,
      coordinatorNpub: "npub1organiser",
      responseSubmitted: false,
      perQuestionMode: false,
      allQuestionResponsesSubmitted: false,
      canAdvanceQuestionBeforeSubmit: false,
    };

    expect(formatVoteActionButtonText({ ...baseInput, submitInFlight: true })).toBe("Submitting...");
    expect(formatVoteActionButtonText({
      ...baseInput,
      canSubmitNow: false,
      responseSubmitted: true,
      submitInFlight: false,
    })).toBe("View results");
    expect(formatVoteActionButtonText({
      ...baseInput,
      canSubmitNow: false,
      requiredQuestionsAnswered: false,
      perQuestionMode: true,
      canAdvanceQuestionBeforeSubmit: true,
      submitInFlight: false,
    })).toBe("Next");
  });

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
        expect.stringContaining("Initial question - q_initial_question"),
        expect.stringContaining("Next question - q_next_question"),
      ]);
    });

    expect(screen.queryByRole("button", { name: /Answer next/ })).toBeNull();
    await user.selectOptions(selector, selector.options[1]?.value ?? "");

    await waitFor(() => {
      expect(requestedElectionIds).toContain("q_next_question");
    });
  });

  it("force-resends a pending next-questionnaire ballot request from Answer next", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "r".repeat(58);
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
        keyId: `${questionnaireId}_blind_key`,
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: `${questionnaireId}_q1`,
        type: "yes_no" as const,
        prompt,
        required: true,
      }],
    });
    const initialDefinition = makeDefinition("q_pending_initial", "Pending initial", "Pending initial prompt");
    const nextDefinition = makeDefinition("q_pending_next", "Pending next", "Pending next prompt");
    optionAStorageMocks.loadVoterState.mockImplementation((input: unknown) => {
      const electionId = typeof input === "object" && input && "electionId" in input
        ? String((input as { electionId?: unknown }).electionId ?? "")
        : "";
      if (electionId === "q_pending_initial") {
        return {
          electionId: "q_pending_initial",
          invitedNpub: localVoterNpub,
          coordinatorNpub,
          loginVerified: true,
          loginVerifiedAt: "2026-06-17T11:59:00.000Z",
          inviteMessage: null,
          blindRequest: null,
          blindRequests: {},
          blindRequestSent: true,
          blindRequestSentAt: "2026-06-17T11:59:00.000Z",
          blindIssuance: null,
          blindIssuances: {},
          credentialReady: false,
          blindTokenSecret: null,
          blindTokenSecrets: {},
          draftResponses: [],
          submission: {
            type: "ballot_submission",
            schemaVersion: 1,
            electionId: "q_pending_initial",
            submissionId: "submission_pending_initial",
            invitedNpub: localVoterNpub,
            responseNpub: "npub1" + "i".repeat(58),
            credential: "sig_pending_initial",
            nullifier: "nullifier_pending_initial",
            payload: {
              electionId: "q_pending_initial",
              responses: [{ questionId: "q_pending_initial_q1", type: "yes_no", answer: "yes" }],
            },
            submittedAt: "2026-06-17T11:59:30.000Z",
          },
          submissions: {},
          submissionAccepted: null,
          submissionAcceptedAt: null,
          submissionDecisions: {},
          lastUpdatedAt: "2026-06-17T11:59:30.000Z",
        };
      }
      if (electionId !== "q_pending_next") {
        return null;
      }
      return {
        electionId: "q_pending_next",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        loginVerified: true,
        loginVerifiedAt: "2026-06-17T12:00:00.000Z",
        inviteMessage: null,
        blindRequest: {
          type: "blind_ballot_request",
          schemaVersion: 1,
          electionId: "q_pending_next",
          requestId: "request_pending_next",
          invitedNpub: localVoterNpub,
          blindedMessage: "blinded_pending_next",
          blindSigningKeyId: nextDefinition.blindSigningPublicKey.keyId,
          clientNonce: "nonce_pending_next",
          createdAt: "2026-06-17T12:00:00.000Z",
          lastSentAt: "2026-06-17T12:00:01.000Z",
        },
        blindRequests: {},
        blindRequestSent: true,
        blindRequestSentAt: "2026-06-17T12:00:01.000Z",
        blindIssuance: null,
        blindIssuances: {},
        credentialReady: false,
        blindTokenSecret: null,
        blindTokenSecrets: {},
        draftResponses: [],
        submission: null,
        submissions: {},
        submissionAccepted: null,
        submissionAcceptedAt: null,
        submissionDecisions: {},
        lastUpdatedAt: "2026-06-17T12:00:01.000Z",
      };
    });
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_pending_initial",
        title: "Pending initial",
        description: "",
        voteUrl: "https://example.test/vote?q=q_pending_initial",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: initialDefinition.blindSigningPublicKey,
        definition: initialDefinition,
        expiresAt: null,
      },
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_pending_next",
        title: "Pending next",
        description: "",
        voteUrl: "https://example.test/vote?q=q_pending_next",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: nextDefinition.blindSigningPublicKey,
        definition: nextDefinition,
        expiresAt: null,
      },
    ]);
    const requestCalls: Array<{
      electionId: string;
      options: Parameters<QuestionnaireOptionAVoterRuntime["requestBlindBallot"]>[0];
    }> = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(
        this: QuestionnaireOptionAVoterRuntime,
        options?: Parameters<QuestionnaireOptionAVoterRuntime["requestBlindBallot"]>[0],
      ) {
        requestCalls.push({ electionId: this.getSnapshot()?.electionId ?? "", options });
        return this.getSnapshot()!;
      });

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_pending_initial"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    await screen.findByRole("combobox", { name: "Questionnaire" });
    await user.click(screen.getByRole("button", { name: /Answer next/ }));

    await waitFor(() => {
      expect(requestCalls).toContainEqual({
        electionId: "q_pending_next",
        options: { forceResend: true },
      });
    });
  });

  it("prefetches the next questionnaire ballot when Answer next appears", async () => {
    const localVoterNpub = "npub1" + "p".repeat(58);
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
        keyId: `${questionnaireId}_blind_key`,
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: `${questionnaireId}_q1`,
        type: "yes_no" as const,
        prompt,
        required: true,
      }],
    });
    const initialDefinition = makeDefinition("q_prefetch_initial", "Prefetch initial", "Prefetch initial prompt");
    const nextDefinition = makeDefinition("q_prefetch_next", "Prefetch next", "Prefetch next prompt");
    optionAStorageMocks.loadVoterState.mockImplementation((input: unknown) => {
      const electionId = typeof input === "object" && input && "electionId" in input
        ? String((input as { electionId?: unknown }).electionId ?? "")
        : "";
      if (electionId !== "q_prefetch_initial") {
        return null;
      }
      return {
        electionId: "q_prefetch_initial",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        loginVerified: true,
        loginVerifiedAt: "2026-06-19T12:00:00.000Z",
        inviteMessage: null,
        blindRequest: null,
        blindRequests: {},
        blindRequestSent: true,
        blindRequestSentAt: "2026-06-19T12:00:00.000Z",
        blindIssuance: null,
        blindIssuances: {},
        credentialReady: false,
        blindTokenSecret: null,
        blindTokenSecrets: {},
        draftResponses: [],
        submission: {
          type: "ballot_submission",
          schemaVersion: 1,
          electionId: "q_prefetch_initial",
          submissionId: "submission_prefetch_initial",
          invitedNpub: localVoterNpub,
          responseNpub: "npub1" + "z".repeat(58),
          credential: "sig_prefetch_initial",
          nullifier: "nullifier_prefetch_initial",
          payload: {
            electionId: "q_prefetch_initial",
            responses: [{ questionId: "q_prefetch_initial_q1", type: "yes_no", answer: "yes" }],
          },
          submittedAt: "2026-06-19T12:00:30.000Z",
        },
        submissions: {},
        submissionAccepted: null,
        submissionAcceptedAt: null,
        submissionDecisions: {},
        lastUpdatedAt: "2026-06-19T12:00:30.000Z",
      };
    });
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_prefetch_initial",
        title: "Prefetch initial",
        description: "",
        voteUrl: "https://example.test/vote?q=q_prefetch_initial",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: initialDefinition.blindSigningPublicKey,
        definition: initialDefinition,
        expiresAt: null,
      },
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_prefetch_next",
        title: "Prefetch next",
        description: "",
        voteUrl: "https://example.test/vote?q=q_prefetch_next",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: nextDefinition.blindSigningPublicKey,
        definition: nextDefinition,
        expiresAt: null,
      },
    ]);
    const requestCalls: string[] = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        requestCalls.push(this.getSnapshot()?.electionId ?? "");
        return this.getSnapshot()!;
      });

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_prefetch_initial"]}
        localVoterNpub={localVoterNpub}
        localVoterNsec='nsec1prefetch'
      />,
    );

    expect(await screen.findByRole("button", { name: /Answer next/ })).toBeTruthy();
    await waitFor(() => {
      expect(requestCalls).toContain("q_prefetch_next");
    });
  });

  it("keeps the current public questionnaire in the selector when a new admitted invite arrives", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "s".repeat(58);
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
    const initialDefinition = makeDefinition("q_public_initial", "Public initial", "Initial public prompt");
    const nextDefinition = makeDefinition("q_public_next", "Public next", "Next public prompt");
    storeCachedQuestionnaireDefinition(initialDefinition);
    storeCachedQuestionnaireDefinition(nextDefinition);
    optionAStorageMocks.listInvitesFromMailbox.mockReturnValue([
      {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_public_next",
        title: "Public next",
        description: "",
        voteUrl: "https://example.test/vote?q=q_public_next",
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
    window.history.pushState(null, "", `/?role=voter&q=q_public_initial&coordinator=${coordinatorNpub}`);

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_public_initial", "q_public_next"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      expect([...selector.options].map((option) => option.textContent)).toEqual([
        expect.stringContaining("Public initial - q_public_initial"),
        expect.stringContaining("Public next - q_public_next"),
      ]);
    });
    expect(screen.getByText(/Initial public prompt/)).toBeTruthy();

    expect(screen.queryByRole("button", { name: /Answer next/ })).toBeNull();
    await user.selectOptions(selector, selector.options[1]?.value ?? "");

    await waitFor(() => {
      expect(requestedElectionIds).toContain("q_public_next");
    });
  });

  it("blocks a private invite link already redeemed by another identity before requesting a ballot", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "u".repeat(58);
    const otherVoterNpub = "npub1" + "v".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const inviteCode = "already-used-private-code";
    const codeHash = await hashQuestionnaireInviteCode(inviteCode);
    const otherClaimHash = await hashQuestionnairePrivateInviteClaim({ codeHash, npub: otherVoterNpub });
    const onMessageOrganiser = vi.fn();
    const onBackToJoin = vi.fn();
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_private_used",
      title: "Used private questionnaire",
      description: "Private description",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Private prompt",
        required: true,
      }],
    });
    fetchQuestionnairePrivateInviteStatusMock.mockResolvedValue({
      event: { id: "status-used", created_at: 20 },
      status: {
        schemaVersion: 1,
        eventType: "questionnaire_private_invite_status",
        questionnaireId: "q_private_used",
        codeHash,
        state: "redeemed",
        createdAt: 20,
        coordinatorPubkey: coordinatorNpub,
        redeemedNpubHash: otherClaimHash,
        redeemedAt: "2026-06-12T12:00:00.000Z",
        revokedAt: null,
      },
    } as Awaited<ReturnType<typeof fetchQuestionnairePrivateInviteStatus>>);
    const requestBlindBallot = vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        return this.getSnapshot()!;
      });
    window.history.pushState(null, "", `/?role=voter&q=q_private_used&coordinator=${coordinatorNpub}&invite_code=${inviteCode}&request_ballot=1`);

    render(
      <QuestionnaireOptionAVoterPanel
        localVoterNpub={localVoterNpub}
        onMessageOrganiser={onMessageOrganiser}
        onBackToJoin={onBackToJoin}
      />,
    );

    expect(await screen.findByText("Private invite already used")).toBeTruthy();
    expect(screen.queryByText(/This private invite can only be used once/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Open general invite" })).toBeTruthy();
    expect(screen.queryByText("Used private questionnaire")).toBeNull();
    expect(screen.queryByText("Private description")).toBeNull();
    expect(screen.queryByText("Private prompt")).toBeNull();
    expect(screen.queryByText("q_private_used")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Message organiser" }));
    await user.click(screen.getByRole("button", { name: "Back to Join" }));

    expect(onMessageOrganiser).toHaveBeenCalledWith(coordinatorNpub);
    expect(onBackToJoin).toHaveBeenCalledTimes(1);
    expect(requestBlindBallot).not.toHaveBeenCalled();
  });

  it("continues a private invite link already claimed by the same local identity", async () => {
    const localVoterNpub = "npub1" + "w".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const inviteCode = "same-device-private-code";
    const codeHash = await hashQuestionnaireInviteCode(inviteCode);
    const localClaimHash = await hashQuestionnairePrivateInviteClaim({ codeHash, npub: localVoterNpub });
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_private_same",
      title: "Same private questionnaire",
      description: "Private description",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Private prompt",
        required: true,
      }],
    });
    fetchQuestionnairePrivateInviteStatusMock.mockResolvedValue({
      event: { id: "status-same", created_at: 20 },
      status: {
        schemaVersion: 1,
        eventType: "questionnaire_private_invite_status",
        questionnaireId: "q_private_same",
        codeHash,
        state: "redeemed",
        createdAt: 20,
        coordinatorPubkey: coordinatorNpub,
        redeemedNpubHash: localClaimHash,
        redeemedAt: "2026-06-12T12:00:00.000Z",
        revokedAt: null,
      },
    } as Awaited<ReturnType<typeof fetchQuestionnairePrivateInviteStatus>>);
    const requestBlindBallot = vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        return this.getSnapshot()!;
      });
    window.history.pushState(null, "", `/?role=voter&q=q_private_same&coordinator=${coordinatorNpub}&invite_code=${inviteCode}&request_ballot=1`);

    render(<QuestionnaireOptionAVoterPanel localVoterNpub={localVoterNpub} />);

    await waitFor(() => {
      expect(requestBlindBallot).toHaveBeenCalled();
    });
    expect(screen.queryByText("Private invite already used")).toBeNull();
  });

  it("requests a private invite ballot when no status event is visible yet", async () => {
    const localVoterNpub = "npub1" + "x".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const inviteCode = "private-code-without-visible-status";
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_private_status_missing",
      title: "Private status missing",
      description: "Private description",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Private prompt",
        required: true,
      }],
    });
    fetchQuestionnairePrivateInviteStatusMock.mockResolvedValue(null);
    const requestBlindBallot = vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        return this.getSnapshot()!;
      });
    window.history.pushState(null, "", `/?role=voter&q=q_private_status_missing&coordinator=${coordinatorNpub}&invite_code=${inviteCode}&request_ballot=1`);

    render(<QuestionnaireOptionAVoterPanel localVoterNpub={localVoterNpub} />);

    await waitFor(() => {
      expect(requestBlindBallot).toHaveBeenCalled();
    });
    expect(fetchQuestionnairePrivateInviteStatusMock).toHaveBeenCalledWith(expect.objectContaining({
      questionnaireId: "q_private_status_missing",
      timeBudgetMs: 1800,
      maxPages: 2,
    }));
    expect(screen.queryByText("Private invite already used")).toBeNull();
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
    expect(within(details).queryByText("commitment_ballot_debug")).toBeNull();
    expect(within(details).queryByText("sig_ballot_debug")).toBeNull();
  });

  it("shows a main-page resend action while waiting for a signer-backed ballot credential", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "w".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_waiting_resend",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_waiting_resend",
        requestId: "request_waiting_resend",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded_waiting_resend",
        blindSigningKeyId: "blind_key",
        clientNonce: "nonce_waiting_resend",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
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
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_waiting_resend",
      title: "Waiting resend",
      description: "",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Waiting resend prompt",
        required: true,
      }],
    });
    const requestSpy = vi
      .spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        return this.getSnapshot()!;
      });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_waiting_resend"]} localVoterNpub={localVoterNpub} />);

    await screen.findByText(/Waiting resend prompt/);
    await user.click(screen.getByRole("button", { name: "Resend request" }));

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith({ forceResend: true });
    });
  });

  it("shows the manual resend action after the resend cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T00:00:05.000Z"));
    const localVoterNpub = "npub1" + "w".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_waiting_resend_delay",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_waiting_resend_delay",
        requestId: "request_waiting_resend_delay",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded_waiting_resend_delay",
        blindSigningKeyId: "blind_key",
        clientNonce: "nonce_waiting_resend_delay",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
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
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_waiting_resend_delay",
      title: "Waiting resend delay",
      description: "",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Waiting resend delay prompt",
        required: true,
      }],
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_waiting_resend_delay"]} localVoterNpub={localVoterNpub} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Waiting resend delay prompt/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resend request" })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByRole("button", { name: "Resend request" })).toBeTruthy();
  });

  it("automatically retries signer-backed blind requests after the resend cooldown", async () => {
    const localVoterNpub = "npub1" + "x".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_waiting_auto_retry",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-04-18T00:00:00.000Z",
      inviteMessage: null,
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_waiting_auto_retry",
        requestId: "request_waiting_auto_retry",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded_waiting_auto_retry",
        blindSigningKeyId: "blind_key",
        clientNonce: "nonce_waiting_auto_retry",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
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
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_waiting_auto_retry",
      title: "Waiting auto retry",
      description: "",
      createdAt: 1,
      openAt: 1,
      closeAt: 9999999999,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
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
        prompt: "Waiting auto retry prompt",
        required: true,
      }],
    });
    const requestSpy = vi
      .spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(this: QuestionnaireOptionAVoterRuntime) {
        return this.getSnapshot()!;
      });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_waiting_auto_retry"]} localVoterNpub={localVoterNpub} />);

    await screen.findByText(/Waiting auto retry prompt/);
    expect(requestSpy).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith({ forceResend: true, minRetryMs: 10_000 });
    });
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
    expect(screen.queryByText("Retrieving questions.")).toBeNull();
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
    expect(screen.queryByText("Required")).toBeNull();
  });

  it("lets voters remove a ranked option from the selected row", async () => {
    const user = userEvent.setup();
    storeCachedQuestionnaireDefinition({
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      responseMode: "blind_token",
      questionnaireId: "q_rank_remove_selected",
      title: "Ranked questionnaire",
      description: "Ranked description",
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
        type: "rank",
        prompt: "Rank these options",
        required: true,
        minimumRanked: 1,
        options: [
          { optionId: "option_1", label: "Title of option 1" },
          { optionId: "option_2", label: "Title of option 2" },
        ],
      }],
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_rank_remove_selected"]} />);

    expect(await screen.findByText("Choose 1 more")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /Title of option 1.*Add as #1/ }));

    const selectedOption = await screen.findByRole("button", { name: "Remove Title of option 1 as #1" });
    expect(selectedOption.textContent).toContain("1. Title of option 1");
    expect(selectedOption.textContent).toContain("Remove as #1");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Choose 1 more")).toBeNull();
    expect(screen.queryByText("1/1 selected")).toBeNull();

    await user.click(selectedOption);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Remove Title of option 1 as #1" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /Title of option 1.*Add as #1/ })).toBeTruthy();
    expect(screen.getByText("Choose 1 more")).toBeTruthy();
  });

  it("shows staged ballot progress copy before a response can be submitted", async () => {
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

    expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.queryByText("Cached questionnaire")).toBeNull();
    expect(screen.queryByText("Cached description")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Yes" }));

    const submitButton = screen.getByRole("button", { name: "1/3 Confirming identity" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Verifying vote request" })).toBeNull();
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

    const view = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);
    const { rerender } = view;

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

    await waitFor(() => {
      expect(window.localStorage.length).toBeGreaterThan(0);
    });
    view.unmount();
    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_preserve_answers"]} localVoterNpub={localVoterNpub} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Yes" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "No" }).className).toContain("is-dimmed");
    });
  });

  it("renders questions from the blind issuance definition when public definition fetch is empty", async () => {
    const user = userEvent.setup();
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

    expect(await screen.findByText("Issued questionnaire")).toBeTruthy();
    expect(screen.getByText("Definition delivered with issuance")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText(/Issued definition prompt/);
    expect(screen.queryByText("Issued questionnaire")).toBeNull();
    expect(screen.queryByText("Definition delivered with issuance")).toBeNull();
    expect(screen.queryByText("Retrieving questions.")).toBeNull();
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

    await screen.findByText("Retrieving questions.");
    expect((screen.getByRole("button", { name: "Answer required questions to continue" }) as HTMLButtonElement).disabled).toBe(true);
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

    const receiptRegion = await screen.findByRole("region", { name: "Vote receipt details" });
    expect(within(receiptRegion).getByRole("img", { name: "Anonymous voting identity" })).toBeTruthy();
    expect(within(receiptRegion).queryByLabelText(/Expand QR for token/i)).toBeNull();
    expect(within(receiptRegion).queryByText("QR code")).toBeNull();
    expect(screen.getByText("Vote receipt")).toBeTruthy();
    expect(within(receiptRegion).queryByText(/Waiting for/i)).toBeNull();
    expect(within(receiptRegion).getByText("Lookup keys")).toBeTruthy();
    expect(within(receiptRegion).queryByText("Anonymous npub")).toBeNull();
    expect(within(receiptRegion).getByText("Submitted")).toBeTruthy();
    expect(screen.getAllByText("RRR-RRR").length).toBeGreaterThan(0);
    expect(within(receiptRegion).queryByText("Identity words")).toBeNull();
    const finderWords = within(receiptRegion).getByText(deriveIdentityWords("npub1" + "r".repeat(58)));
    const anonymousNpub = within(receiptRegion).getByText("RRR-RRR");
    expect(anonymousNpub.compareDocumentPosition(finderWords) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(receiptRegion).getByText("Advanced details")).toBeTruthy();
    await userEvent.click(within(receiptRegion).getByText("Advanced details"));
    expect(within(receiptRegion).getByText("Questionnaire ID")).toBeTruthy();
    expect(within(receiptRegion).getByText("q_submitted_marker")).toBeTruthy();
    expect(within(receiptRegion).getByText("Submission ID")).toBeTruthy();
    expect(within(receiptRegion).getByText("submission_submitted_marker")).toBeTruthy();
    expect(within(receiptRegion).getByText("Anonymous identity npub")).toBeTruthy();
    expect(within(receiptRegion).getByText("npub1" + "r".repeat(58))).toBeTruthy();
  });

  it("shows the other proxy vote receipt underneath", async () => {
    const localVoterNpub = "npub1" + "p".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const firstResponseNpub = "npub1" + "f".repeat(58);
    const secondResponseNpub = "npub1" + "s".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_proxy_receipt",
      title: "Proxy receipt",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseMode: "blind_token" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      credentialsPerVoter: 2 as const,
      blindSigningPublicKey: {
        scheme: "rsabssa-sha384-pss-deterministic-v1" as const,
        keyId: "blind_key",
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Approve proxy item?",
        required: true,
        ballotSlot: { slotId: "proxy-item", slotIndex: 1, version: 1 },
      }],
    };
    storeCachedQuestionnaireDefinition(definition);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_proxy_receipt",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_proxy_receipt",
        title: "Proxy receipt",
        description: "",
        voteUrl: "https://example.test/vote?q=q_proxy_receipt",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: definition.blindSigningPublicKey,
        definition,
        credentialsPerVoter: 2,
        expiresAt: null,
      },
      blindRequest: null,
      blindRequests: {},
      blindRequestSent: true,
      blindIssuance: null,
      blindIssuances: {},
      blindTokenSecrets: {},
      credentialReady: true,
      draftResponses: [],
      submissions: {
        "slot:1:v1": {
          type: "ballot_submission",
          schemaVersion: 1,
          electionId: "q_proxy_receipt",
          submissionId: "submission_proxy_1",
          invitedNpub: localVoterNpub,
          responseNpub: firstResponseNpub,
          tokenCommitment: "commitment_proxy_1",
          blindSigningKeyId: "blind_key",
          credential: "sig_proxy_1",
          nullifier: "nullifier_proxy_1",
          credentialBundle: [{
            questionId: "q1",
            tokenCommitment: "commitment_proxy_1",
            blindSigningKeyId: "blind_key",
            credential: "sig_proxy_1",
            nullifier: "nullifier_proxy_1",
            ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1 },
          }],
          payload: {
            electionId: "q_proxy_receipt",
            responses: [{ questionId: "q1", type: "yes_no", answer: "yes" }],
          },
          submittedAt: "2026-06-15T23:01:00.000Z",
        },
        "slot:1:v1:c2": {
          type: "ballot_submission",
          schemaVersion: 1,
          electionId: "q_proxy_receipt",
          submissionId: "submission_proxy_2",
          invitedNpub: localVoterNpub,
          responseNpub: secondResponseNpub,
          tokenCommitment: "commitment_proxy_2",
          blindSigningKeyId: "blind_key",
          credential: "sig_proxy_2",
          nullifier: "nullifier_proxy_2",
          credentialBundle: [{
            questionId: "q1",
            tokenCommitment: "commitment_proxy_2",
            blindSigningKeyId: "blind_key",
            credential: "sig_proxy_2",
            nullifier: "nullifier_proxy_2",
            ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1, credentialIndex: 2 },
          }],
          payload: {
            electionId: "q_proxy_receipt",
            responses: [{ questionId: "q1", type: "yes_no", answer: "no" }],
          },
          submittedAt: "2026-06-15T23:02:00.000Z",
        },
      },
      submissionAccepted: null,
      submissionAcceptedAt: null,
      submissionDecisions: {},
      lastUpdatedAt: "2026-06-15T23:02:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_proxy_receipt"]} localVoterNpub={localVoterNpub} />);

    const receiptRegion = await screen.findByRole("region", { name: "Vote receipt" });
    const otherReceipts = within(receiptRegion).getByLabelText("Other proxy vote receipts");
    expect(within(otherReceipts).getByText("Separate vote 2")).toBeTruthy();
    expect(within(otherReceipts).getByText(deriveIdentityWords(secondResponseNpub))).toBeTruthy();
    expect(within(otherReceipts).getByText("SSS-SSS")).toBeTruthy();
    expect(within(receiptRegion).getByText(deriveIdentityWords(firstResponseNpub))).toBeTruthy();
  });

  it("shows one question at a time for grouped ballot questions", async () => {
    const localVoterNpub = "npub1" + "g".repeat(58);
    const responseNpub = "npub1" + "k".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_grouped_complete",
      title: "Grouped complete",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseMode: "course_feedback" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      questions: [
        {
          questionId: "q1",
          type: "yes_no" as const,
          prompt: "First grouped question",
          required: true,
          ballotSlot: { slotId: "shared-slot", slotIndex: 1, version: 1 },
        },
        {
          questionId: "q2",
          type: "yes_no" as const,
          prompt: "Second grouped question",
          required: true,
          ballotSlot: { slotId: "shared-slot", slotIndex: 1, version: 1 },
        },
      ],
    };
    const submission = {
      type: "ballot_submission" as const,
      schemaVersion: 1 as const,
      electionId: "q_grouped_complete",
      submissionId: "submission_grouped_complete",
      invitedNpub: localVoterNpub,
      responseNpub,
      credential: "sig_grouped_complete",
      nullifier: "nullifier_grouped_complete",
      payload: {
        electionId: "q_grouped_complete",
        responses: [
          { questionId: "q1", type: "yes_no" as const, answer: "yes" as const },
          { questionId: "q2", type: "yes_no" as const, answer: "no" as const },
        ],
      },
      submittedAt: "2026-06-15T23:01:00.000Z",
    };
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_grouped_complete",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: null,
      blindRequest: null,
      blindRequestSent: true,
      blindRequestSentAt: "2026-06-15T23:00:00.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_grouped_complete",
        requestId: "request_grouped_complete",
        issuanceId: "issuance_grouped_complete",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_grouped_complete",
        definition,
        issuedAt: "2026-06-15T23:00:00.000Z",
      },
      blindIssuances: {
        "slot:1:v1": {
          type: "blind_ballot_response",
          schemaVersion: 1,
          electionId: "q_grouped_complete",
          requestId: "request_grouped_complete",
          issuanceId: "issuance_grouped_complete",
          invitedNpub: localVoterNpub,
          blindSignature: "sig_grouped_complete",
          ballotScope: { slotId: "shared-slot", slotIndex: 1, version: 1 },
          definition,
          issuedAt: "2026-06-15T23:00:00.000Z",
        },
      },
      credentialReady: true,
      draftResponses: [],
      submissions: {
        q1: submission,
        q2: submission,
      },
      submissionDecisions: {
        q1: { accepted: true, decidedAt: "2026-06-15T23:02:00.000Z" },
        q2: { accepted: true, decidedAt: "2026-06-15T23:02:00.000Z" },
      },
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-06-15T23:02:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_grouped_complete"]} localVoterNpub={localVoterNpub} />);

    expect(await screen.findByText("Question 1 of 2")).toBeTruthy();
    expect(screen.queryByText(/Complete/)).toBeNull();
    expect(screen.getAllByText("First grouped question").length).toBeGreaterThan(0);
    expect(screen.queryByText("Second grouped question")).toBeNull();
    expect((screen.getByRole("button", { name: /Previous/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Question 2 of 2")).toBeTruthy();
    expect(screen.queryByText("First grouped question")).toBeNull();
    expect(screen.getAllByText("Second grouped question").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "View results" })).toBeTruthy();
    expect(screen.queryByText("Questionnaire results")).toBeNull();
    const receiptRegion = await screen.findByRole("region", { name: "Vote receipt details" });
    expect(within(receiptRegion).queryByText("Second grouped question")).toBeNull();
    expect(within(receiptRegion).getByText("Submitted")).toBeTruthy();
    expect(within(receiptRegion).getByText("Anonymous voting identity")).toBeTruthy();
  });

  it("advances answered grouped ballot questions before showing the final required gate", async () => {
    const localVoterNpub = "npub1" + "g".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_grouped_draft_next",
      title: "Grouped draft",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseMode: "course_feedback" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      questions: [
        {
          questionId: "q1",
          type: "yes_no" as const,
          prompt: "First grouped question",
          required: true,
          ballotSlot: { slotId: "shared-slot", slotIndex: 1, version: 1 },
        },
        {
          questionId: "q2",
          type: "yes_no" as const,
          prompt: "Second grouped question",
          required: true,
          ballotSlot: { slotId: "shared-slot", slotIndex: 1, version: 1 },
        },
      ],
    };
    storeCachedQuestionnaireDefinition(definition);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_grouped_draft_next",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: null,
      blindRequest: null,
      blindRequestSent: true,
      blindRequestSentAt: "2026-06-15T23:00:00.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_grouped_draft_next",
        requestId: "request_grouped_draft_next",
        issuanceId: "issuance_grouped_draft_next",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_grouped_draft_next",
        definition,
        issuedAt: "2026-06-15T23:00:00.000Z",
      },
      blindIssuances: {
        "slot:1:v1": {
          type: "blind_ballot_response",
          schemaVersion: 1,
          electionId: "q_grouped_draft_next",
          requestId: "request_grouped_draft_next",
          issuanceId: "issuance_grouped_draft_next",
          invitedNpub: localVoterNpub,
          blindSignature: "sig_grouped_draft_next",
          ballotScope: { slotId: "shared-slot", slotIndex: 1, version: 1 },
          definition,
          issuedAt: "2026-06-15T23:00:00.000Z",
        },
      },
      credentialReady: true,
      draftResponses: [],
      submissions: {},
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-06-15T23:00:00.000Z",
    });

    const { container } = render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_grouped_draft_next"]} localVoterNpub={localVoterNpub} />);
    const nav = () => within(container.querySelector(".simple-questionnaire-question-nav") as HTMLElement);

    expect(await screen.findByText("Question 1 of 2")).toBeTruthy();
    expect(nav().getByRole("button", { name: /Next/ }).className).not.toContain("is-ready");
    await userEvent.click(nav().getByRole("button", { name: /Next/ }));

    expect(await screen.findByText("Question 2 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "No" }));
    expect(nav().queryByRole("button", { name: /Submit/ })).toBeNull();
    expect(container.querySelector(".simple-optiona-voter-controls")).toBeNull();

    await userEvent.click(nav().getByRole("button", { name: /Previous/ }));
    expect(await screen.findByText("Question 1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(nav().getByRole("button", { name: /Next/ }).className).toContain("is-ready");
    await userEvent.click(nav().getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Question 2 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "No" }));
    const submitButton = nav().getByRole("button", { name: /Submit/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    expect(container.querySelector(".simple-optiona-voter-controls")).toBeNull();
  });

  it("shows proxy voter ballots together and submits them as separate votes", async () => {
    const user = userEvent.setup();
    const localVoterNpub = "npub1" + "x".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    fetchOptionAInviteDmsMock.mockResolvedValue([]);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_proxy_together",
      title: "Proxy together",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseMode: "blind_token" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      credentialsPerVoter: 2 as const,
      blindSigningPublicKey: {
        scheme: "rsabssa-sha384-pss-deterministic-v1" as const,
        keyId: "blind_key",
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Approve proxy item?",
        required: true,
        ballotSlot: { slotId: "proxy-item", slotIndex: 1, version: 1 },
      }],
    };
    storeCachedQuestionnaireDefinition(definition);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_proxy_together",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_proxy_together",
        title: "Proxy together",
        description: "",
        voteUrl: "https://example.test/vote?q=q_proxy_together",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: definition.blindSigningPublicKey,
        definition,
        credentialsPerVoter: 2,
        expiresAt: null,
      },
      blindRequest: null,
      blindRequests: {
        "slot:1:v1": {
          type: "blind_ballot_request",
          schemaVersion: 1,
          electionId: "q_proxy_together",
          requestId: "request_proxy_1",
          invitedNpub: localVoterNpub,
          blindedMessage: "blinded_proxy_1",
          clientNonce: "nonce_proxy_1",
          blindSigningKeyId: "blind_key",
          ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1 },
          createdAt: "2026-06-15T23:00:00.000Z",
          lastSentAt: "2026-06-15T23:00:00.000Z",
        },
        "slot:1:v1:c2": {
          type: "blind_ballot_request",
          schemaVersion: 1,
          electionId: "q_proxy_together",
          requestId: "request_proxy_2",
          invitedNpub: localVoterNpub,
          blindedMessage: "blinded_proxy_2",
          clientNonce: "nonce_proxy_2",
          blindSigningKeyId: "blind_key",
          ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1, credentialIndex: 2 },
          createdAt: "2026-06-15T23:00:00.000Z",
          lastSentAt: "2026-06-15T23:00:00.000Z",
        },
      },
      blindRequestSent: true,
      blindIssuance: null,
      blindIssuances: {
        "slot:1:v1": {
          type: "blind_ballot_response",
          schemaVersion: 1,
          electionId: "q_proxy_together",
          requestId: "request_proxy_1",
          issuanceId: "issuance_proxy_1",
          invitedNpub: localVoterNpub,
          blindSignature: "sig_proxy_1",
          blindSigningKeyId: "blind_key",
          ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1 },
          definition,
          issuedAt: "2026-06-15T23:00:00.000Z",
        },
        "slot:1:v1:c2": {
          type: "blind_ballot_response",
          schemaVersion: 1,
          electionId: "q_proxy_together",
          requestId: "request_proxy_2",
          issuanceId: "issuance_proxy_2",
          invitedNpub: localVoterNpub,
          blindSignature: "sig_proxy_2",
          blindSigningKeyId: "blind_key",
          ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1, credentialIndex: 2 },
          definition,
          issuedAt: "2026-06-15T23:00:00.000Z",
        },
      },
      blindTokenSecrets: {},
      credentialReady: true,
      draftResponses: [],
      submissions: {},
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-06-15T23:00:00.000Z",
    });
    const draftBatches: unknown[][] = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "updateDraftResponses")
      .mockImplementation((responses) => {
        draftBatches.push(responses);
      });
    const submitCalls: Array<{
      requiredQuestionIds: string[];
      options: Parameters<QuestionnaireOptionAVoterRuntime["submitVote"]>[1];
    }> = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "submitVote")
      .mockImplementation(async function mockedSubmitVote(
        this: QuestionnaireOptionAVoterRuntime,
        requiredQuestionIds,
        options,
      ) {
        submitCalls.push({ requiredQuestionIds, options });
        return this.getSnapshot();
      });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_proxy_together"]} localVoterNpub={localVoterNpub} />);

    await user.click(await screen.findByRole("button", { name: "Start" }));
    const firstVote = await screen.findByRole("region", { name: "Separate vote 1 of 2" });
    const secondVote = screen.getByRole("region", { name: "Separate vote 2 of 2" });
    await user.click(within(firstVote).getByRole("button", { name: "Yes" }));
    await user.click(within(secondVote).getByRole("button", { name: "No" }));
    await waitFor(() => {
      expect(within(firstVote).getByRole("button", { name: "Yes" }).getAttribute("aria-pressed")).toBe("true");
      expect(within(secondVote).getByRole("button", { name: "No" }).getAttribute("aria-pressed")).toBe("true");
    });

    await user.click(await screen.findByRole("button", { name: "Submit 2 separate votes" }));

    await waitFor(() => {
      expect(submitCalls.map((call) => call.options?.credentialIndex)).toEqual([1, 2]);
      expect(submitCalls.map((call) => call.options?.questionIds)).toEqual([["q1"], ["q1"]]);
      expect(submitCalls.map((call) => call.requiredQuestionIds)).toEqual([["q1"], ["q1"]]);
      expect(draftBatches).toEqual([
        [{ questionId: "q1", type: "yes_no", answer: "yes" }],
        [{ questionId: "q1", type: "yes_no", answer: "no" }],
      ]);
    });
  });

  it("picks up a later proxy-voter invite while a public-link ballot request is pending", async () => {
    const localVoterNpub = "npub1" + "v".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_proxy_late_invite",
      title: "Late proxy invite",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseMode: "blind_token" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      blindSigningPublicKey: {
        scheme: "rsabssa-sha384-pss-deterministic-v1" as const,
        keyId: "blind_key",
        jwk: { kty: "RSA", e: "AQAB", n: "test" },
      },
      questions: [{
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Approve proxy item?",
        required: true,
        ballotSlot: { slotId: "proxy-item", slotIndex: 1, version: 1 },
      }],
    };
    storeCachedQuestionnaireDefinition(definition);
    fetchOptionAInviteDmsMock.mockResolvedValue([{
      type: "election_invite",
      schemaVersion: 1,
      electionId: "q_proxy_late_invite",
      title: "Late proxy invite",
      description: "",
      voteUrl: "https://example.test/vote?q=q_proxy_late_invite",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      blindSigningPublicKey: definition.blindSigningPublicKey,
      definition,
      credentialsPerVoter: 2,
      expiresAt: null,
    }]);
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_proxy_late_invite",
      invitedNpub: localVoterNpub,
      coordinatorNpub,
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: {
        type: "election_invite",
        schemaVersion: 1,
        electionId: "q_proxy_late_invite",
        title: "Late proxy invite",
        description: "",
        voteUrl: "https://example.test/vote?q=q_proxy_late_invite",
        invitedNpub: localVoterNpub,
        coordinatorNpub,
        blindSigningPublicKey: definition.blindSigningPublicKey,
        definition,
        expiresAt: null,
      },
      blindRequest: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_proxy_late_invite",
        requestId: "request_proxy_1",
        invitedNpub: localVoterNpub,
        blindedMessage: "blinded_proxy_1",
        clientNonce: "nonce_proxy_1",
        blindSigningKeyId: "blind_key",
        ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1 },
        createdAt: "2026-06-15T23:00:00.000Z",
        lastSentAt: "2026-06-15T23:00:00.000Z",
      },
      blindRequests: {
        "slot:1:v1": {
          type: "blind_ballot_request",
          schemaVersion: 1,
          electionId: "q_proxy_late_invite",
          requestId: "request_proxy_1",
          invitedNpub: localVoterNpub,
          blindedMessage: "blinded_proxy_1",
          clientNonce: "nonce_proxy_1",
          blindSigningKeyId: "blind_key",
          ballotScope: { slotId: "proxy-item", slotIndex: 1, version: 1 },
          createdAt: "2026-06-15T23:00:00.000Z",
          lastSentAt: "2026-06-15T23:00:00.000Z",
        },
      },
      blindRequestSent: true,
      blindRequestSentAt: "2026-06-15T23:00:00.000Z",
      blindIssuance: null,
      blindIssuances: {},
      blindTokenSecret: null,
      blindTokenSecrets: {},
      credentialReady: false,
      draftResponses: [],
      submissions: {},
      submissionAccepted: null,
      submissionAcceptedAt: null,
      lastUpdatedAt: "2026-06-15T23:00:00.000Z",
    });
    const requestCalls: Array<Parameters<QuestionnaireOptionAVoterRuntime["requestBlindBallot"]>[0]> = [];
    vi.spyOn(QuestionnaireOptionAVoterRuntime.prototype, "requestBlindBallot")
      .mockImplementation(async function mockedRequestBlindBallot(
        this: QuestionnaireOptionAVoterRuntime,
        options?: Parameters<QuestionnaireOptionAVoterRuntime["requestBlindBallot"]>[0],
      ) {
        requestCalls.push(options);
        return this.getSnapshot()!;
      });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_proxy_late_invite"]} localVoterNpub={localVoterNpub} />);

    await waitFor(() => {
      expect(fetchOptionAInviteDmsMock).toHaveBeenCalled();
      expect(requestCalls).toContainEqual({ forceResend: true });
    });
  });

  it("does not mark a per-question session all answered after only one ballot submission", async () => {
    const localVoterNpub = "npub1" + "p".repeat(58);
    const coordinatorNpub = "npub1" + "b".repeat(58);
    const makeDefinition = (questionnaireId: string, title: string, questionCount: number) => ({
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId,
      title,
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: coordinatorNpub,
      coordinatorEncryptionPubkey: coordinatorNpub,
      responseMode: "blind_token" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      questions: Array.from({ length: questionCount }, (_, index) => ({
        questionId: `q${index + 1}`,
        type: "yes_no" as const,
        prompt: `Question ${index + 1}`,
        required: true,
        ballotSlot: { slotId: `slot-${index + 1}`, slotIndex: index + 1, version: 1 },
      })),
    });
    const firstDefinition = makeDefinition("q_first_session", "First session", 1);
    const secondDefinition = makeDefinition("q_second_session", "Second session", 2);
    storeCachedQuestionnaireDefinition(firstDefinition);
    storeCachedQuestionnaireDefinition(secondDefinition);
    const firstSubmission = {
      type: "ballot_submission" as const,
      schemaVersion: 1 as const,
      electionId: "q_first_session",
      submissionId: "submission_first",
      invitedNpub: localVoterNpub,
      responseNpub: "npub1" + "1".repeat(58),
      credential: "sig_first",
      nullifier: "nullifier_first",
      payload: {
        electionId: "q_first_session",
        responses: [{ questionId: "q1", type: "yes_no" as const, answer: "yes" as const }],
      },
      submittedAt: "2026-06-15T23:01:00.000Z",
    };
    const partialSecondSubmission = {
      type: "ballot_submission" as const,
      schemaVersion: 1 as const,
      electionId: "q_second_session",
      submissionId: "submission_second_q1",
      invitedNpub: localVoterNpub,
      responseNpub: "npub1" + "2".repeat(58),
      credential: "sig_second_q1",
      nullifier: "nullifier_second_q1",
      payload: {
        electionId: "q_second_session",
        responses: [{ questionId: "q1", type: "yes_no" as const, answer: "yes" as const }],
      },
      submittedAt: "2026-06-15T23:02:00.000Z",
    };
    optionAStorageMocks.loadVoterState.mockImplementation((input: unknown) => {
      const electionId = typeof input === "object" && input && "electionId" in input
        ? String((input as { electionId?: unknown }).electionId ?? "")
        : "";
      if (electionId === "q_first_session") {
        return {
          electionId,
          invitedNpub: localVoterNpub,
          coordinatorNpub,
          loginVerified: true,
          loginVerifiedAt: "2026-06-15T23:00:00.000Z",
          inviteMessage: null,
          blindRequest: null,
          blindRequestSent: true,
          blindIssuance: null,
          blindIssuances: {
            "slot:1:v1": {
              type: "blind_ballot_response",
              schemaVersion: 1,
              electionId,
              requestId: "request_first",
              issuanceId: "issuance_first",
              invitedNpub: localVoterNpub,
              blindSignature: "sig_first",
              definition: firstDefinition,
              issuedAt: "2026-06-15T23:00:00.000Z",
            },
          },
          credentialReady: true,
          draftResponses: [],
          submission: firstSubmission,
          submissions: { q1: firstSubmission },
          submissionAccepted: null,
          submissionAcceptedAt: null,
          lastUpdatedAt: "2026-06-15T23:01:00.000Z",
        };
      }
      if (electionId === "q_second_session") {
        return {
          electionId,
          invitedNpub: localVoterNpub,
          coordinatorNpub,
          loginVerified: true,
          loginVerifiedAt: "2026-06-15T23:00:00.000Z",
          inviteMessage: null,
          blindRequest: null,
          blindRequestSent: true,
          blindIssuance: null,
          blindIssuances: {
            "slot:1:v1": {
              type: "blind_ballot_response",
              schemaVersion: 1,
              electionId,
              requestId: "request_second_q1",
              issuanceId: "issuance_second_q1",
              invitedNpub: localVoterNpub,
              blindSignature: "sig_second_q1",
              definition: secondDefinition,
              issuedAt: "2026-06-15T23:00:00.000Z",
            },
            "slot:2:v1": {
              type: "blind_ballot_response",
              schemaVersion: 1,
              electionId,
              requestId: "request_second_q2",
              issuanceId: "issuance_second_q2",
              invitedNpub: localVoterNpub,
              blindSignature: "sig_second_q2",
              definition: secondDefinition,
              issuedAt: "2026-06-15T23:00:00.000Z",
            },
          },
          credentialReady: true,
          draftResponses: [],
          submission: partialSecondSubmission,
          submissions: { q1: partialSecondSubmission },
          submissionAccepted: null,
          submissionAcceptedAt: null,
          lastUpdatedAt: "2026-06-15T23:02:00.000Z",
        };
      }
      return null;
    });

    render(
      <QuestionnaireOptionAVoterPanel
        announcedQuestionnaireIds={["q_first_session", "q_second_session"]}
        localVoterNpub={localVoterNpub}
      />,
    );

    expect(await screen.findByText("Ballot 2 · Question 2/2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Please answer all required questions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All answered" })).toBeNull();
  });

  it("shows the selected per-question submission identity", async () => {
    const localVoterNpub = "npub1" + "h".repeat(58);
    const firstResponseNpub = "npub1" + "1".repeat(58);
    const secondResponseNpub = "npub1" + "2".repeat(58);
    const staleLegacyResponseNpub = "npub1" + "z".repeat(58);
    const definition = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_definition" as const,
      questionnaireId: "q_per_question_identity",
      title: "Per-question identity",
      description: "",
      createdAt: 1781540000,
      openAt: 1781540000,
      closeAt: 1781543600,
      coordinatorPubkey: "npub1" + "b".repeat(58),
      coordinatorEncryptionPubkey: "npub1" + "b".repeat(58),
      responseMode: "course_feedback" as const,
      responseVisibility: "private" as const,
      eligibilityMode: "open" as const,
      allowMultipleResponsesPerPubkey: false,
      ballotCredentialMode: "per_question" as const,
      questions: [
        {
          questionId: "q1",
          type: "yes_no" as const,
          prompt: "First question",
          required: true,
        },
        {
          questionId: "q2",
          type: "yes_no" as const,
          prompt: "Second question",
          required: true,
        },
      ],
    };
    optionAStorageMocks.loadVoterState.mockReturnValue({
      electionId: "q_per_question_identity",
      invitedNpub: localVoterNpub,
      coordinatorNpub: "npub1" + "b".repeat(58),
      loginVerified: true,
      loginVerifiedAt: "2026-06-15T23:00:00.000Z",
      inviteMessage: null,
      blindRequest: null,
      blindRequestSent: true,
      blindRequestSentAt: "2026-06-15T23:00:00.000Z",
      blindIssuance: {
        type: "blind_ballot_response",
        schemaVersion: 1,
        electionId: "q_per_question_identity",
        requestId: "request_legacy",
        issuanceId: "issuance_legacy",
        invitedNpub: localVoterNpub,
        blindSignature: "sig_legacy",
        definition,
        issuedAt: "2026-06-15T23:00:00.000Z",
      },
      credentialReady: true,
      draftResponses: [],
      responseNpub: staleLegacyResponseNpub,
      submission: {
        type: "ballot_submission",
        schemaVersion: 1,
        electionId: "q_per_question_identity",
        submissionId: "submission_legacy",
        invitedNpub: localVoterNpub,
        responseNpub: staleLegacyResponseNpub,
        credential: "sig_legacy",
        nullifier: "nullifier_legacy",
        payload: {
          electionId: "q_per_question_identity",
          responses: [],
        },
        submittedAt: "2026-06-15T23:00:00.000Z",
      },
      submissions: {
        q1: {
          type: "ballot_submission",
          schemaVersion: 1,
          electionId: "q_per_question_identity",
          submissionId: "submission_question_one",
          invitedNpub: localVoterNpub,
          responseNpub: firstResponseNpub,
          credential: "sig_q1",
          nullifier: "nullifier_q1",
          payload: {
            electionId: "q_per_question_identity",
            responses: [{ questionId: "q1", type: "yes_no", answer: "yes" }],
          },
          submittedAt: "2026-06-15T23:01:00.000Z",
        },
        q2: {
          type: "ballot_submission",
          schemaVersion: 1,
          electionId: "q_per_question_identity",
          submissionId: "submission_question_two",
          invitedNpub: localVoterNpub,
          responseNpub: secondResponseNpub,
          credential: "sig_q2",
          nullifier: "nullifier_q2",
          payload: {
            electionId: "q_per_question_identity",
            responses: [{ questionId: "q2", type: "yes_no", answer: "no" }],
          },
          submittedAt: "2026-06-15T23:02:00.000Z",
        },
      },
      submissionAccepted: null,
      submissionAcceptedAt: null,
      submissionDecisions: {},
      lastUpdatedAt: "2026-06-15T23:02:00.000Z",
    });

    render(<QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={["q_per_question_identity"]} localVoterNpub={localVoterNpub} />);

    expect(screen.queryByRole("region", { name: "Current question ballot IDs" })).toBeNull();
    const receiptRegion = await screen.findByRole("region", { name: "Vote receipt" });
    await userEvent.click(within(receiptRegion).getByText("Advanced details"));
    expect(within(receiptRegion).getByText("submission_question_one")).toBeTruthy();
    expect(within(receiptRegion).getByText(firstResponseNpub)).toBeTruthy();
    expect(within(receiptRegion).queryByText("submission_legacy")).toBeNull();
    expect(within(receiptRegion).queryByText(staleLegacyResponseNpub)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await within(receiptRegion).findByText("submission_question_two")).toBeTruthy();
    expect(within(receiptRegion).getByText(secondResponseNpub)).toBeTruthy();
    expect(within(receiptRegion).queryByText(firstResponseNpub)).toBeNull();
  });
});
