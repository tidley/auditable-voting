// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  fetchQuestionnaireDefinitions: vi.fn(),
  fetchQuestionnaireState: vi.fn(),
  fetchQuestionnaireResultSummary: vi.fn(),
  fetchQuestionnaireParticipantCount: vi.fn(),
  fetchQuestionnaireBlindResponses: vi.fn(),
  fetchQuestionnaireSubmissionDecisions: vi.fn(),
  fetchQuestionnaireWorkerDelegationStatus: vi.fn(),
  verifyQuestionnaireBlindResponseProofs: vi.fn(),
}));

vi.mock("./questionnaireTransport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./questionnaireTransport")>();
  return {
    ...actual,
    fetchQuestionnaireDefinitions: transportMocks.fetchQuestionnaireDefinitions,
    fetchQuestionnaireState: transportMocks.fetchQuestionnaireState,
    fetchQuestionnaireResultSummary: transportMocks.fetchQuestionnaireResultSummary,
    fetchQuestionnaireParticipantCount: transportMocks.fetchQuestionnaireParticipantCount,
    fetchQuestionnaireBlindResponses: transportMocks.fetchQuestionnaireBlindResponses,
    fetchQuestionnaireSubmissionDecisions: transportMocks.fetchQuestionnaireSubmissionDecisions,
    fetchQuestionnaireWorkerDelegationStatus: transportMocks.fetchQuestionnaireWorkerDelegationStatus,
    verifyQuestionnaireBlindResponseProofs: transportMocks.verifyQuestionnaireBlindResponseProofs,
  };
});

vi.mock("./questionnaireNostr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./questionnaireNostr")>();
  return {
    ...actual,
    subscribeQuestionnaireEventKinds: vi.fn(() => () => undefined),
  };
});

const definitions = [
  makeDefinitionEntry("q_first", "First questionnaire", 1_777_000_200),
  makeDefinitionEntry("q_second", "Second questionnaire", 1_777_000_100),
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("SimpleAuditorApp", () => {
  it("fetches responses for the newly selected round", async () => {
    const user = userEvent.setup();
    setupTransportMocks();
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireBlindResponses).toHaveBeenCalledWith(
        expect.objectContaining({ questionnaireId: "q_first" }),
      );
    });

    await user.selectOptions(screen.getByLabelText("Round"), "q_second");

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireBlindResponses).toHaveBeenCalledWith(
        expect.objectContaining({ questionnaireId: "q_second" }),
      );
    });
  });

  it("uses a paginated response target derived from published result totals", async () => {
    setupTransportMocks();
    transportMocks.fetchQuestionnaireResultSummary.mockImplementation(async (input?: { questionnaireId?: string }) => {
      const questionnaireId = input?.questionnaireId?.trim();
      return questionnaireId ? [makeResultSummaryEntry(questionnaireId, 1200, 0)] : [];
    });
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireBlindResponses).toHaveBeenCalledWith(
        expect.objectContaining({
          questionnaireId: "q_first",
          readRelayLimit: 5,
          maxPages: 32,
          timeBudgetMs: 30_000,
        }),
      );
    });
    const firstResponseFetch = transportMocks.fetchQuestionnaireBlindResponses.mock.calls
      .map(([input]) => input as { questionnaireId: string; limit: number })
      .find((input) => input.questionnaireId === "q_first");

    expect(firstResponseFetch?.limit).toBeGreaterThanOrEqual(1320);
  });
});

function setupTransportMocks() {
  transportMocks.fetchQuestionnaireDefinitions.mockReset();
  transportMocks.fetchQuestionnaireDefinitions.mockImplementation(async (input?: { questionnaireId?: string }) => {
    const questionnaireId = input?.questionnaireId?.trim();
    return questionnaireId
      ? definitions.filter((entry) => entry.definition.questionnaireId === questionnaireId)
      : definitions;
  });
  transportMocks.fetchQuestionnaireState.mockReset();
  transportMocks.fetchQuestionnaireState.mockResolvedValue([]);
  transportMocks.fetchQuestionnaireResultSummary.mockReset();
  transportMocks.fetchQuestionnaireResultSummary.mockResolvedValue([]);
  transportMocks.fetchQuestionnaireParticipantCount.mockReset();
  transportMocks.fetchQuestionnaireParticipantCount.mockResolvedValue([]);
  transportMocks.fetchQuestionnaireBlindResponses.mockReset();
  transportMocks.fetchQuestionnaireBlindResponses.mockImplementation(async (input: { questionnaireId: string }) => [
    makeResponseEntry(input.questionnaireId),
  ]);
  transportMocks.fetchQuestionnaireSubmissionDecisions.mockReset();
  transportMocks.fetchQuestionnaireSubmissionDecisions.mockResolvedValue([]);
  transportMocks.fetchQuestionnaireWorkerDelegationStatus.mockReset();
  transportMocks.fetchQuestionnaireWorkerDelegationStatus.mockResolvedValue(null);
  transportMocks.verifyQuestionnaireBlindResponseProofs.mockReset();
  transportMocks.verifyQuestionnaireBlindResponseProofs.mockResolvedValue(new Set<string>());
}

function makeDefinitionEntry(questionnaireId: string, title: string, createdAt: number) {
  return {
    event: {
      id: `definition_${questionnaireId}`,
      kind: 30_101,
      pubkey: "npub1organiser",
      created_at: createdAt,
      tags: [],
      content: "",
      sig: "sig",
    },
    definition: {
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      questionnaireId,
      title,
      description: "",
      coordinatorPubkey: "npub1organiser",
      createdAt,
      openAt: createdAt,
      closeAt: createdAt + 600,
      questions: [],
      questionnaireRelays: ["wss://relay.example.test"],
      blindSigningPublicKey: null,
    },
  };
}

function makeResponseEntry(questionnaireId: string) {
  return {
    event: {
      id: `response_${questionnaireId}`,
      kind: 30_104,
      pubkey: `npub1submitter${questionnaireId}`,
      created_at: 1_777_000_300,
      tags: [],
      content: "",
      sig: "sig",
    },
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId,
      responseId: `submission_${questionnaireId}`,
      submittedAt: 1_777_000_300,
      authorPubkey: `npub1submitter${questionnaireId}`,
      tokenNullifier: `nullifier_${questionnaireId}`,
      tokenProof: {
        tokenCommitment: `commitment_${questionnaireId}`,
        questionnaireId,
        signature: "signature",
      },
      answers: [],
    },
  };
}

function makeResultSummaryEntry(questionnaireId: string, acceptedResponseCount: number, rejectedResponseCount: number) {
  return {
    event: {
      id: `result_${questionnaireId}`,
      kind: 30_105,
      pubkey: "npub1worker",
      created_at: 1_777_000_400,
      tags: [["q", questionnaireId]],
      content: "",
      sig: "sig",
    },
    summary: {
      schemaVersion: 1,
      eventType: "questionnaire_result_summary",
      questionnaireId,
      createdAt: 1_777_000_400,
      coordinatorPubkey: "npub1organiser",
      acceptedResponseCount,
      rejectedResponseCount,
      acceptedNullifierCount: acceptedResponseCount,
      questionSummaries: [],
    },
  };
}
