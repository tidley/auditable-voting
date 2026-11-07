// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it('places the questionnaire ID inside the shared settings disclosure', () => {
    render(<QuestionnaireCoordinatorPanel view='build' />);
    expect(screen.getByLabelText('Questionnaire ID').closest('details')?.querySelector('summary')?.textContent).toBe('Questionnaire settings');
  });

  it('requires a non-blank description before publishing a draft', () => {
    const secret = generateSecretKey();
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={nip19.npubEncode(getPublicKey(secret))} coordinatorNsec={nip19.nsecEncode(secret)} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Residents vote' } });
    fireEvent.change(screen.getByLabelText('Question 1 prompt'), { target: { value: 'Do you agree?' } });
    const publish = screen.getByRole('button', { name: 'Go Live' }) as HTMLButtonElement;
    const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(description.required).toBe(true);
    expect(publish.disabled).toBe(true);
    fireEvent.change(description, { target: { value: '   ' } });
    expect(publish.disabled).toBe(true);
    fireEvent.change(description, { target: { value: 'Decide whether to adopt the proposal.' } });
    expect(publish.disabled).toBe(false);
    fireEvent.change(description, { target: { value: '' } });
    expect(publish.disabled).toBe(true);
  });

  it('keeps the questionnaire selector available when results are hidden on the voters step', () => {
    const { rerender } = render(<QuestionnaireCoordinatorPanel view='responses' hideResults coordinatorNpub='npub1organiser' />);
    expect(screen.getByLabelText('Questionnaire')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Live Results' })).toBeNull();
    rerender(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub='npub1organiser' />);
    expect(screen.getByRole('heading', { name: 'Live Results' })).toBeTruthy();
  });

  it("renders a follow-up as question 1-A inside its parent's card", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);
    fireEvent.click(screen.getByRole('button', { name: 'Add follow-up to question 1' }));
    const child = screen.getByRole('group', { name: 'Question 1-A' });
    const parent = screen.getByRole('group', { name: 'Question 1' });
    expect(parent.contains(child)).toBe(true);
    expect(within(child).getByText('1-A', { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Question' }));
    expect(screen.getByRole('group', { name: 'Question 2' })).toBeTruthy();
  });
  it('moves a parent with its children and keeps child ordering within the parent', async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);
    fireEvent.click(screen.getByRole('button', { name: 'Add follow-up to question 1' }));
    expect((screen.getByRole('button', { name: 'Move question 1-A up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move question 1-A down' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move question 1 down' }));
    await waitFor(() => expect(readStoredDraft().questions.map((entry: {questionId: string}) => entry.questionId)).toEqual(['q3', 'q1', 'q2']));
    expect(screen.getByRole('group', { name: 'Question 2' }).contains(screen.getByRole('group', { name: 'Question 2-A' }))).toBe(true);
  });
  it("adds a linked follow-up immediately after its parent without a prior-question picker", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);
    fireEvent.change(screen.getByLabelText("Question 1 prompt"), { target: { value: "Do you agree?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));
    fireEvent.change(screen.getByLabelText("Question 2 prompt"), { target: { value: "Unrelated question" } });
    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    expect((screen.getByLabelText("Question 2 prompt") as HTMLInputElement).value).toBe("Unrelated question");
    expect(screen.queryByLabelText("Question 1 visibility")).toBeNull();
    expect(screen.queryByLabelText("Question 2 depends on")).toBeNull();
    expect(screen.getByText("Follow-up to question 1")).toBeTruthy();
    await waitFor(() => expect(readStoredDraft().questions[1].showIf).toEqual({
      dependsOnQuestionId: "q1", requiredAnswer: { answerType: "yes_no", value: true },
    }));
  });
  it("creates a follow-up for a multiple-choice answer and inherits the parent's voter group", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);
    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "multiple_choice" } });
    fireEvent.change(screen.getByLabelText("Add voter group"), { target: { value: "Residents" } });
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    const group = (screen.getByLabelText("Question 1 voter group") as HTMLSelectElement).options[1].value;
    fireEvent.change(screen.getByLabelText("Question 1 voter group"), { target: { value: group } });
    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    await waitFor(() => {
      const questions = readStoredDraft().questions;
      expect(questions[1].showIf).toEqual({ dependsOnQuestionId: questions[0].questionId, requiredAnswer: { answerType: "multiple_choice", selectedOptionIds: ["option_1"] } });
      expect(questions[1].requiredScope).toBe(group);
    });
  });
  it("keeps the parent link when changing the follow-up question type", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);
    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    fireEvent.change(screen.getByLabelText("Question 1-A type"), { target: { value: "multiple_choice" } });
    await waitFor(() => expect(readStoredDraft().questions[1].showIf?.dependsOnQuestionId).toBe("q1"));
    expect(screen.getByLabelText("Question 1-A required answer Yes")).toBeTruthy();
  });
  it("offers follow-ups without a misleading visibility dropdown on the first question", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    expect(screen.queryByLabelText("Question 1 visibility")).toBeNull();
    expect(screen.getByRole("button", { name: "Add follow-up to question 1" })).toBeTruthy();
  });

  it("adds a follow-up with the triggering answer controls", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    expect(screen.getByLabelText("Question 1-A required answer Yes")).toBeTruthy();
    expect(screen.queryByLabelText("Question 2 depends on")).toBeNull();
  });

  it("can create a nested follow-up linked to the selected parent", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1-A" }));
    await waitFor(() => expect(readStoredDraft().questions[2].showIf.dependsOnQuestionId).toBe("q2"));
  });

  it("selecting a yes_no dependency shows Yes/No radio options", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));

    // Since Q1 is yes_no, we should see Yes/No radio buttons
    expect(screen.getByLabelText("Question 1-A required answer Yes")).toBeTruthy();
    expect(screen.getByLabelText("Question 1-A required answer No")).toBeTruthy();
  });

  it("a single-choice parent shows mutually exclusive answer triggers", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // Change Q1 to multiple_choice
    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "multiple_choice" } });

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));

    // Since Q1 is multiple_choice with option_1 and option_2, we should see checkboxes
    expect(screen.getByLabelText("Question 1-A require option_1")).toBeTruthy();
    expect(screen.getByLabelText("Question 1-A require option_2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Question 1-A require option_2"));
    await waitFor(() => expect(readStoredDraft().questions[1].showIf.requiredAnswer.selectedOptionIds).toEqual(["option_2"]));
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

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));

    // Set Q2 prompt
    fireEvent.change(screen.getByLabelText("Question 1-A prompt"), { target: { value: "Follow up" } });

    // Select "Yes" as required answer
    fireEvent.click(screen.getByLabelText("Question 1-A required answer Yes"));

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

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));

    fireEvent.change(screen.getByLabelText("Question 1-A prompt"), { target: { value: "Follow up" } });

    // Check option_1 as required
    fireEvent.click(screen.getByLabelText("Question 1-A require option_1"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toEqual({
        dependsOnQuestionId: "q1",
        requiredAnswer: { answerType: "multiple_choice", selectedOptionIds: ["option_1"] },
      });
    });
  });

  it("making a follow-up standalone clears showIf", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    fireEvent.click(screen.getByLabelText("Question 1-A required answer Yes"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Make question 1-A standalone" }));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeNull();
    });
  });

  it("disables follow-up creation for unsupported parent answer types", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "free_text" } });
    expect((screen.getByRole("button", { name: "Add follow-up to question 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("persists showIf through localStorage reload", async () => {
    const { unmount } = render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add follow-up to question 1" }));
    fireEvent.click(screen.getByLabelText("Question 1-A required answer Yes"));

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[1].showIf).toBeTruthy();
    });

    unmount();
    cleanup();

    // Re-mount — the showIf should be restored from localStorage
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    expect(screen.getByText("Follow-up to question 1")).toBeTruthy();

    const yesRadio = screen.getByLabelText("Question 1-A required answer Yes") as HTMLInputElement;
    expect(yesRadio.checked).toBe(true);
  });
});
