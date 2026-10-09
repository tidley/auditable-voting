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

describe("QuestionnaireCoordinatorPanel multilingual creation UI", () => {
  it("renders a Translations toggle for the title field", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    // The English title field keeps its original label.
    expect(screen.getByLabelText("Title")).toBeTruthy();

    // A Translations toggle is present (one per localised field; title is first).
    const toggles = screen.getAllByRole("button", { name: "Translations" });
    expect(toggles.length).toBeGreaterThan(0);
  });

  it("reveals French and Tamil title inputs when Translations is expanded", () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    const toggles = screen.getAllByRole("button", { name: "Translations" });
    fireEvent.click(toggles[0]);

    expect(screen.getByLabelText("Title (French)")).toBeTruthy();
    expect(screen.getByLabelText("Title (Tamil)")).toBeTruthy();
  });

  it("produces a localised title in the published definition", async () => {
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

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Community vote" } });

    // Expand translations and fill French + Tamil.
    const toggles = screen.getAllByRole("button", { name: "Translations" });
    fireEvent.click(toggles[0]);
    fireEvent.change(screen.getByLabelText("Title (French)"), { target: { value: "Vote communautaire" } });
    fireEvent.change(screen.getByLabelText("Title (Tamil)"), { target: { value: "சமூக வாக்கெடுப்பு" } });

    // Fill the question prompt so the draft is valid.
    fireEvent.change(screen.getByLabelText("Question 1 prompt"), { target: { value: "Proceed?" } });

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.title).toEqual({
        en: "Community vote",
        fr: "Vote communautaire",
        ta: "சமூக வாக்கெடுப்பு",
      });
    });
  });

  it("produces a localised question prompt in the published definition", async () => {
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

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Community vote" } });

    // Expand the prompt's translations and fill French + Tamil.
    // Toggle order: title (0), description (1), prompt (2).
    const promptToggles = screen.getAllByRole("button", { name: "Translations" });
    fireEvent.click(promptToggles[2]);
    fireEvent.change(screen.getByLabelText("Question 1 prompt (French)"), { target: { value: "Procéder ?" } });
    fireEvent.change(screen.getByLabelText("Question 1 prompt (Tamil)"), { target: { value: "தொடரவா?" } });

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.questions[0].prompt).toEqual({
        en: "",
        fr: "Procéder ?",
        ta: "தொடரவா?",
      });
    });
  });

  it("produces localised option labels for a multiple_choice question", async () => {
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

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Community vote" } });
    fireEvent.change(screen.getByLabelText("Question 1 type"), { target: { value: "multiple_choice" } });

    // Expand the first option's translations.
    // Toggle order: title (0), description (1), prompt (2), option 1 (3), option 2 (4).
    const optionToggles = screen.getAllByRole("button", { name: "Translations" });
    fireEvent.click(optionToggles[3]);
    fireEvent.change(screen.getByLabelText("Option 1 (French)"), { target: { value: "Oui" } });
    fireEvent.change(screen.getByLabelText("Option 1 (Tamil)"), { target: { value: "ஆம்" } });

    await waitFor(() => {
      const stored = readStoredDraft();
      const option = stored.questions[0].options[0];
      expect(option.label).toEqual({
        en: "Option 1",
        fr: "Oui",
        ta: "ஆம்",
      });
    });
  });

  it("keeps a plain-string title backward compatible when only English is entered", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "English only" } });

    await waitFor(() => {
      const stored = readStoredDraft();
      expect(stored.title).toEqual({ en: "English only" });
    });
  });
});
