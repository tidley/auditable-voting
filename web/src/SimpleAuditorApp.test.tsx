// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  fetchQuestionnaireDefinitions: vi.fn(),
  fetchQuestionnaireState: vi.fn(),
  fetchQuestionnaireResultSummary: vi.fn(),
  fetchQuestionnaireParticipantCount: vi.fn(),
  fetchQuestionnaireBlindResponses: vi.fn(),
  fetchQuestionnaireProvisionalResponses: vi.fn(),
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
    fetchQuestionnaireProvisionalResponses: transportMocks.fetchQuestionnaireProvisionalResponses,
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
  document.getElementById("simple-auditor-menu-filters")?.remove();
  document.getElementById("simple-auditor-topbar-actions")?.remove();
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

  it("uses loaded verified response totals when the published summary is stale", async () => {
    setupTransportMocks();
    transportMocks.fetchQuestionnaireResultSummary.mockImplementation(async (input?: { questionnaireId?: string }) => {
      const questionnaireId = input?.questionnaireId?.trim();
      return questionnaireId ? [makeResultSummaryEntry(questionnaireId, 1, 0)] : [];
    });
    transportMocks.fetchQuestionnaireBlindResponses.mockImplementation(async (input: { questionnaireId: string }) => [
      makeResponseEntry(input.questionnaireId, "1"),
      makeResponseEntry(input.questionnaireId, "2"),
      makeResponseEntry(input.questionnaireId, "3"),
    ]);
    transportMocks.verifyQuestionnaireBlindResponseProofs.mockImplementation(async () => new Set([
      "submission_q_first_1",
      "submission_q_first_2",
      "submission_q_first_3",
      "submission_q_second_1",
      "submission_q_second_2",
      "submission_q_second_3",
    ]));
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("3/3 accepted (100%)");
    });
    expect(screen.queryByText("1/1 accepted (100%)")).toBeNull();
    expect(document.body.textContent).not.toContain("Accepted: 3 (100%).");
  });

  it("keeps manual refresh available while background refresh is waiting", async () => {
    setupTransportMocks();
    let resolveDefinitions: (entries: typeof definitions) => void = () => undefined;
    transportMocks.fetchQuestionnaireDefinitions.mockImplementation((input?: { questionnaireId?: string }) => {
      const questionnaireId = input?.questionnaireId?.trim();
      if (questionnaireId) {
        return Promise.resolve(definitions.filter((entry) => entry.definition.questionnaireId === questionnaireId));
      }
      return new Promise<typeof definitions>((resolve) => {
        resolveDefinitions = resolve;
      });
    });
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireDefinitions).toHaveBeenCalled();
    });
    const refreshButton = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.getAttribute("aria-disabled")).not.toBe("true");

    resolveDefinitions(definitions);
  });

  it("renders discovered questionnaire rounds before slow metadata fetches finish", async () => {
    setupTransportMocks();
    transportMocks.fetchQuestionnaireState.mockImplementation(() => new Promise(() => undefined));
    transportMocks.fetchQuestionnaireResultSummary.mockImplementation((input?: { questionnaireId?: string }) => (
      input?.questionnaireId ? new Promise(() => undefined) : Promise.resolve([])
    ));
    transportMocks.fetchQuestionnaireParticipantCount.mockImplementation(() => new Promise(() => undefined));
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    expect(await screen.findByRole("combobox", { name: "Round" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "First questionnaire · q_first" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Second questionnaire · q_second" })).toBeTruthy();
  });

  it("does not show background response refresh as a top-level status", async () => {
    const user = userEvent.setup();
    setupTransportMocks();
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp />);

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireBlindResponses).toHaveBeenCalledWith(
        expect.objectContaining({ questionnaireId: "q_first" }),
      );
    });

    let resolveSecondResponses: (entries: Array<ReturnType<typeof makeResponseEntry>>) => void = () => undefined;
    transportMocks.fetchQuestionnaireBlindResponses.mockImplementation(async (input: { questionnaireId: string }) => {
      if (input.questionnaireId === "q_second") {
        return new Promise<Array<ReturnType<typeof makeResponseEntry>>>((resolve) => {
          resolveSecondResponses = resolve;
        });
      }
      return [makeResponseEntry(input.questionnaireId)];
    });

    await user.selectOptions(screen.getByLabelText("Round"), "q_second");

    await waitFor(() => {
      expect(transportMocks.fetchQuestionnaireBlindResponses).toHaveBeenCalledWith(
        expect.objectContaining({ questionnaireId: "q_second" }),
      );
    });
    const refreshButton = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);

    resolveSecondResponses([makeResponseEntry("q_second")]);
  });

  it("renders observer filters in the supplied menu slot", async () => {
    setupTransportMocks();
    const menuSlot = document.createElement("div");
    menuSlot.id = "simple-auditor-menu-filters";
    const topBarSlot = document.createElement("div");
    topBarSlot.id = "simple-auditor-topbar-actions";
    document.body.append(menuSlot);
    document.body.append(topBarSlot);
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp filtersInMenu filtersMenuOpen />);

    await waitFor(() => {
      expect(within(menuSlot).getByLabelText("Round")).toBeTruthy();
    });
    const publicViewerPanel = screen.getByRole("heading", { name: "q_first" }).closest("section");
    expect(publicViewerPanel).toBeTruthy();
    expect(within(publicViewerPanel as HTMLElement).queryByLabelText("Search")).toBeNull();
    expect(within(publicViewerPanel as HTMLElement).queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(within(topBarSlot).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(within(menuSlot).getByLabelText("Search")).toBeTruthy();
    expect(within(menuSlot).getByLabelText("Questionnaire organiser identity")).toBeTruthy();
  });

  it("closes the observer menu after choosing a different questionnaire", async () => {
    const user = userEvent.setup();
    setupTransportMocks();
    const menuSlot = document.createElement("div");
    menuSlot.id = "simple-auditor-menu-filters";
    document.body.append(menuSlot);
    const closeMenu = vi.fn();
    const { default: SimpleAuditorApp } = await import("./SimpleAuditorApp");

    render(<SimpleAuditorApp filtersInMenu filtersMenuOpen onFiltersMenuClose={closeMenu} />);

    const roundSelect = await within(menuSlot).findByLabelText("Round");
    await user.selectOptions(roundSelect, "q_second");

    expect(closeMenu).toHaveBeenCalledTimes(1);
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
  transportMocks.fetchQuestionnaireProvisionalResponses.mockReset();
  transportMocks.fetchQuestionnaireProvisionalResponses.mockResolvedValue([]);
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

function makeResponseEntry(questionnaireId: string, suffix = "") {
  const idSuffix = suffix ? `_${suffix}` : "";
  return {
    event: {
      id: `response_${questionnaireId}${idSuffix}`,
      kind: 30_104,
      pubkey: `npub1submitter${questionnaireId}${idSuffix}`,
      created_at: 1_777_000_300,
      tags: [],
      content: "",
      sig: "sig",
    },
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId,
      responseId: `submission_${questionnaireId}${idSuffix}`,
      submittedAt: 1_777_000_300,
      authorPubkey: `npub1submitter${questionnaireId}${idSuffix}`,
      tokenNullifier: `nullifier_${questionnaireId}${idSuffix}`,
      tokenProof: {
        tokenCommitment: `commitment_${questionnaireId}${idSuffix}`,
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
