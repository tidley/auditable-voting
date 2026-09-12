// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

const sharedNostrPoolMocks = vi.hoisted(() => ({
  querySync: vi.fn(),
  subscribeMany: vi.fn(),
}));

const questionnaireNostrMocks = vi.hoisted(() => ({
  publishQuestionnaireDefinition: vi.fn(),
  publishQuestionnaireParticipantCount: vi.fn(),
  publishQuestionnaireState: vi.fn(),
}));

vi.mock("./questionnaireNostr", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireNostr")>("./questionnaireNostr");
  return {
    ...actual,
    publishQuestionnaireDefinition: questionnaireNostrMocks.publishQuestionnaireDefinition,
    publishQuestionnaireParticipantCount: questionnaireNostrMocks.publishQuestionnaireParticipantCount,
    publishQuestionnaireState: questionnaireNostrMocks.publishQuestionnaireState,
  };
});

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({
    querySync: sharedNostrPoolMocks.querySync,
    subscribeMany: sharedNostrPoolMocks.subscribeMany,
  }),
}));

vi.mock("./questionnaireWorkerDelegation", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireWorkerDelegation")>("./questionnaireWorkerDelegation");
  return {
    ...actual,
    nextWorkerElectionConfigVersion: vi.fn(actual.nextWorkerElectionConfigVersion),
    publishWorkerDelegationCertificate: vi.fn().mockResolvedValue({
      eventId: "mock-worker-delegation",
      successes: 1,
      failures: 0,
      relayResults: [],
    }),
  };
});

vi.mock("./questionnaireOptionABlindDm", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireOptionABlindDm")>("./questionnaireOptionABlindDm");
  return {
    ...actual,
    fetchOptionAWorkerStatusDmsWithNsec: vi.fn().mockResolvedValue([]),
    publishOptionAWorkerDelegationDm: vi.fn().mockResolvedValue({
      eventId: "mock-worker-delegation-dm",
      successes: 1,
      failures: 0,
      relayResults: [],
    }),
    publishOptionAWorkerElectionConfigDm: vi.fn().mockResolvedValue({
      eventId: "mock-worker-config-dm",
      successes: 1,
      failures: 0,
      relayResults: [],
    }),
  };
});

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";

beforeEach(() => {
  sharedNostrPoolMocks.querySync.mockResolvedValue([]);
  sharedNostrPoolMocks.subscribeMany.mockReturnValue({
    close: vi.fn(),
  });
  questionnaireNostrMocks.publishQuestionnaireDefinition.mockImplementation(async (input) => ({
    eventId: "mock-published-definition-event",
    event: {
      id: "mock-published-definition-event",
      pubkey: "",
      created_at: input.definition.createdAt,
      kind: 6420,
      tags: [["q", input.definition.questionnaireId], ["questionnaire-id", input.definition.questionnaireId]],
      content: JSON.stringify(input.definition),
      sig: "0".repeat(128),
    },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
  }));
  questionnaireNostrMocks.publishQuestionnaireParticipantCount.mockResolvedValue({
    eventId: "mock-participant-count-event",
    event: { id: "mock-participant-count-event", kind: 6428, tags: [] },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
  });
  questionnaireNostrMocks.publishQuestionnaireState.mockResolvedValue({
    eventId: "mock-state-event",
    event: { id: "mock-state-event", kind: 6421, tags: [["state", "open"]] },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

function readStoredDraft() {
  return JSON.parse(
    window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1")) ?? "{}",
  );
}

describe("QuestionnaireCoordinatorPanel conditional questions UI", () => {
  it("renders Show always / Show if dropdown for each question", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // The first question should have a "Show if" visibility select
    const visibilitySelect = screen.getByLabelText("Question 1 visibility") as HTMLSelectElement;
    expect(visibilitySelect).toBeTruthy();
    expect(visibilitySelect.value).toBe("always");
  });

  it("switching to Show if reveals dependency question dropdown", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Add a second question so we have an earlier question to depend on
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    // Question 2 should have a visibility select
    const visibilitySelect = screen.getByLabelText("Question 2 visibility") as HTMLSelectElement;
    fireEvent.change(visibilitySelect, { target: { value: "conditional" } });

    // Now the dependency question dropdown should appear
    expect(screen.getByLabelText("Question 2 depends on")).toBeTruthy();
  });

  it("dependency dropdown only lists earlier questions", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Add a second and third question
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    // Set question 3 to conditional
    const visibilitySelect = screen.getByLabelText("Question 3 visibility") as HTMLSelectElement;
    fireEvent.change(visibilitySelect, { target: { value: "conditional" } });

    const depSelect = screen.getByLabelText("Question 3 depends on") as HTMLSelectElement;
    const optionValues = [...depSelect.options].map((opt) => opt.value);

    // Should contain question 1 and 2, but NOT question 3 itself
    expect(optionValues).toContain("q1");
    expect(optionValues).toContain("q2");
    expect(optionValues).not.toContain("q3");
  });

  it("selecting a yes_no dependency shows Yes/No radio options", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Add a second question (Q1 is yes_no by default)
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    // Set question 2 to conditional
    fireEvent.change(screen.getByLabelText("Question 2 visibility"), { target: { value: "conditional" } });

    // Select question 1 as the dependency
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });

    // Since Q1 is yes_no, we should see Yes/No radio buttons
    expect(screen.getByLabelText("Question 2 required answer Yes")).toBeTruthy();
    expect(screen.getByLabelText("Question 2 required answer No")).toBeTruthy();
  });

  it("selecting a multiple_choice dependency shows option checkboxes", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Change Q1 to multiple_choice
    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "multiple_choice" } });

    // Add a second question
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    // Set question 2 to conditional
    fireEvent.change(screen.getByLabelText("Question 2 visibility"), { target: { value: "conditional" } });

    // Select question 1 as the dependency
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });

    // Since Q1 is multiple_choice with option_1 and option_2, we should see checkboxes
    expect(screen.getByLabelText("Question 2 require option_1")).toBeTruthy();
    expect(screen.getByLabelText("Question 2 require option_2")).toBeTruthy();
  });

  it("produces correct showIf in definition for yes_no dependency", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);

    render(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
      />,
    );

    // Set a title so the form is valid
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Test election" } });

    // Add a second question
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    // Set Q2 prompt
    fireEvent.change(screen.getByLabelText("Question 2 prompt"), { target: { value: "Follow up" } });

    // Set Q2 to conditional
    fireEvent.change(screen.getByLabelText("Question 2 visibility"), { target: { value: "conditional" } });

    // Select Q1 as dependency
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });

    // Select "Yes" as required answer
    fireEvent.click(screen.getByLabelText("Question 2 required answer Yes"));

    // Wait for localStorage persistence
    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toEqual({
        dependsOnQuestionId: "q1",
        requiredAnswer: { answerType: "yes_no", value: true },
      });
    });
  });

  it("produces correct showIf in definition for multiple_choice dependency", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);

    render(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
      />,
    );

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Test election" } });

    // Change Q1 to multiple_choice
    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "multiple_choice" } });

    // Add a second question
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    fireEvent.change(screen.getByLabelText("Question 2 prompt"), { target: { value: "Follow up" } });

    // Set Q2 to conditional
    fireEvent.change(screen.getByLabelText("Question 2 visibility"), { target: { value: "conditional" } });

    // Select Q1 as dependency
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });

    // Check option_1 as required
    fireEvent.click(screen.getByLabelText("Question 2 require option_1"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toEqual({
        dependsOnQuestionId: "q1",
        requiredAnswer: { answerType: "multiple_choice", selectedOptionIds: ["option_1"] },
      });
    });
  });

  it("switching back to Show always clears showIf", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    const visibilitySelect = screen.getByLabelText("Question 2 visibility") as HTMLSelectElement;

    // Set to conditional and configure
    fireEvent.change(visibilitySelect, { target: { value: "conditional" } });
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });
    fireEvent.click(screen.getByLabelText("Question 2 required answer Yes"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeTruthy();
    });

    // Switch back to always
    fireEvent.change(visibilitySelect, { target: { value: "always" } });

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeNull();
    });
  });

  it("first question cannot be conditional (no earlier questions)", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Q1 visibility dropdown should only have "always" option
    const visibilitySelect = screen.getByLabelText("Question 1 visibility") as HTMLSelectElement;
    const optionValues = [...visibilitySelect.options].map((opt) => opt.value);
    expect(optionValues).toEqual(["always"]);
  });

  it("persists showIf through localStorage reload", async () => {
    const { unmount } = render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    fireEvent.change(screen.getByLabelText("Question 2 visibility"), { target: { value: "conditional" } });
    fireEvent.change(screen.getByLabelText("Question 2 depends on"), { target: { value: "q1" } });
    fireEvent.click(screen.getByLabelText("Question 2 required answer Yes"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeTruthy();
    });

    unmount();
    cleanup();

    // Re-mount — the showIf should be restored from localStorage
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    const visibilitySelect = screen.getByLabelText("Question 2 visibility") as HTMLSelectElement;
    expect(visibilitySelect.value).toBe("conditional");

    const depSelect = screen.getByLabelText("Question 2 depends on") as HTMLSelectElement;
    expect(depSelect.value).toBe("q1");

    const yesRadio = screen.getByLabelText("Question 2 required answer Yes") as HTMLInputElement;
    expect(yesRadio.checked).toBe(true);
  });
});