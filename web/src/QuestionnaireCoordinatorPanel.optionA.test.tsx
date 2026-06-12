// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { QUESTIONNAIRE_DEFINITION_KIND } from "./questionnaireNostr";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

const sharedNostrPoolMocks = vi.hoisted(() => ({
  querySync: vi.fn(),
  subscribeMany: vi.fn(),
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({
    querySync: sharedNostrPoolMocks.querySync,
    subscribeMany: sharedNostrPoolMocks.subscribeMany,
  }),
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";
import { upsertElectionSummary } from "./questionnaireOptionAStorage";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";

function makeDefinition(input: {
  questionnaireId: string;
  title: string;
  coordinatorNpub: string;
}) {
  return {
    schemaVersion: 1 as const,
    eventType: "questionnaire_definition" as const,
    responseMode: "blind_token" as const,
    questionnaireId: input.questionnaireId,
    title: input.title,
    description: "",
    createdAt: 1781200000,
    openAt: 1781200000,
    closeAt: 1781203600,
    coordinatorPubkey: input.coordinatorNpub,
    coordinatorEncryptionPubkey: input.coordinatorNpub,
    responseVisibility: "public" as const,
    eligibilityMode: "allowlist" as const,
    allowMultipleResponsesPerPubkey: false,
    questions: [{
      questionId: "q1",
      prompt: "Proceed?",
      required: true,
      type: "yes_no" as const,
    }],
  };
}

function makeDefinitionEvent(input: {
  id: string;
  pubkey: string;
  questionnaireId: string;
  title: string;
  coordinatorNpub: string;
  createdAt?: number;
}) {
  return {
    id: input.id,
    pubkey: input.pubkey,
    created_at: input.createdAt ?? 1781200000,
    kind: QUESTIONNAIRE_DEFINITION_KIND,
    tags: [["q", input.questionnaireId], ["questionnaire-id", input.questionnaireId]],
    content: JSON.stringify(makeDefinition(input)),
    sig: "0".repeat(128),
  };
}

beforeEach(() => {
  sharedNostrPoolMocks.querySync.mockResolvedValue([]);
  sharedNostrPoolMocks.subscribeMany.mockReturnValue({
    close: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("uses the standard coordinator questionnaire form even when option_a is requested", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Questionnaire ID")).toBeTruthy();
    expect(screen.getByText("Generate ID")).toBeTruthy();
    expect(screen.queryByText("Show invite link")).toBeNull();
  });

  it("keeps audit proxy setup out of the build actions until publication", () => {
    const onConfigureWorker = vi.fn();
    render(<QuestionnaireCoordinatorPanel onConfigureWorker={onConfigureWorker} />);

    expect(screen.queryByText("Set up proxy")).toBeNull();

    expect(onConfigureWorker).not.toHaveBeenCalled();
  });

  it("does not show the JSON preview controls in the build actions", () => {
    render(<QuestionnaireCoordinatorPanel />);

    expect(screen.queryByRole("button", { name: "Preview JSON" })).toBeNull();
    expect(screen.queryByText("Draft preview")).toBeNull();
  });

  it("generates a new questionnaire id when the coordinator New identity event fires", () => {
    render(<QuestionnaireCoordinatorPanel />);

    const idInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    const previousId = idInput.value;

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
  });

  it("shows locally known organiser questionnaires in the live status selector", async () => {
    const coordinatorNpub = "npub1organiser";
    upsertElectionSummary({
      electionId: "q_first_local",
      title: "First local questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-01T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    upsertElectionSummary({
      electionId: "q_second_local",
      title: "Second local questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    upsertElectionSummary({
      electionId: "q_other_organiser",
      title: "Other organiser questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-03T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub: "npub1other",
    });

    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      const optionText = [...selector.options].map((option) => option.textContent ?? "");
      expect(optionText.some((text) => text.includes("First local questionnaire - q_first_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Second local questionnaire - q_second_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Other organiser questionnaire"))).toBe(false);
    });
  });

  it("hides result publishing actions on Session when the selected questionnaire is still a draft", async () => {
    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub='npub1organiser' />);

    expect(await screen.findByRole("combobox", { name: "Questionnaire" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish results" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close + publish results" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByText("Publish a questionnaire to inspect results.")).toBeTruthy();
  });

  it("prefers the published summary title over a cached draft title in the live status selector", async () => {
    const coordinatorNpub = "npub1organiser";
    storeCachedQuestionnaireDefinition(makeDefinition({
      questionnaireId: "q_cached_title",
      title: "Copied draft title",
      coordinatorNpub,
    }));
    upsertElectionSummary({
      electionId: "q_cached_title",
      title: "Published questionnaire title",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      const optionText = [...selector.options].map((option) => option.textContent ?? "");
      expect(optionText.some((text) => text.includes("Published questionnaire title - q_cached_title"))).toBe(true);
      expect(optionText.some((text) => text.includes("Copied draft title"))).toBe(false);
    });
  });

  it("ignores public questionnaire definitions that were not signed by the organiser", async () => {
    const coordinatorHex = "a".repeat(64);
    const otherHex = "b".repeat(64);
    const coordinatorNpub = nip19.npubEncode(coordinatorHex);
    sharedNostrPoolMocks.querySync.mockImplementation(async (_relays, filter) => {
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(QUESTIONNAIRE_DEFINITION_KIND)) {
        return [
          makeDefinitionEvent({
            id: "spoofed-definition",
            pubkey: otherHex,
            questionnaireId: "q_spoofed",
            title: "Spoofed questionnaire",
            coordinatorNpub,
            createdAt: 1781201000,
          }),
          makeDefinitionEvent({
            id: "own-definition",
            pubkey: coordinatorHex,
            questionnaireId: "q_own_public",
            title: "Owned public questionnaire",
            coordinatorNpub,
            createdAt: 1781202000,
          }),
        ];
      }
      return [];
    });

    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      const optionText = [...selector.options].map((option) => option.textContent ?? "");
      expect(optionText.some((text) => text.includes("Owned public questionnaire - q_own_public"))).toBe(true);
      expect(optionText.some((text) => text.includes("Spoofed questionnaire"))).toBe(false);
    });
  });

  it("shows only the active draft in the build page selector", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_current_draft",
        title: "Current draft",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        questions: [{
          questionId: "q1",
          prompt: "Proceed?",
          required: true,
          type: "yes_no",
        }],
      }),
    );
    upsertElectionSummary({
      electionId: "q_previous_one",
      title: "Previous one",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    upsertElectionSummary({
      electionId: "q_previous_two",
      title: "Previous two",
      description: "",
      state: "open",
      openedAt: "2026-06-03T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      expect(sharedNostrPoolMocks.querySync).toHaveBeenCalled();
    });

    expect([...selector.options].map((option) => option.value)).toEqual(["q_current_draft"]);
  });

  it("keeps the selector on the build page and locks published questionnaire fields", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_published_readonly",
        title: "Published readonly questionnaire",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        questions: [{
          questionId: "q1",
          prompt: "Proceed?",
          required: true,
          type: "yes_no",
        }],
      }),
    );
    storeCachedQuestionnaireDefinition(makeDefinition({
      questionnaireId: "q_published_readonly",
      title: "Published readonly questionnaire",
      coordinatorNpub,
    }));
    upsertElectionSummary({
      electionId: "q_published_readonly",
      title: "Published readonly questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      expect([...selector.options].map((option) => option.value)).toEqual(["q_published_readonly"]);
    });

    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const questionnaireIdInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    await waitFor(() => {
      expect(titleInput.value).toBe("Published readonly questionnaire");
      expect(questionnaireIdInput.value).toBe("q_published_readonly");
    });
    expect(titleInput.matches(":disabled")).toBe(true);
    expect(questionnaireIdInput.matches(":disabled")).toBe(true);
    expect((screen.getByDisplayValue("Proceed?") as HTMLInputElement).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Publish questionnaire" })).toBeNull();
  });

  it("keeps locally cached drafts editable until they have a published signal", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_cached_draft",
        title: "Cached local draft",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        questions: [{
          questionId: "q1",
          prompt: "Proceed?",
          required: true,
          type: "yes_no",
        }],
      }),
    );
    storeCachedQuestionnaireDefinition(makeDefinition({
      questionnaireId: "q_cached_draft",
      title: "Cached local draft",
      coordinatorNpub,
    }));

    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const questionnaireIdInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    await waitFor(() => {
      expect(titleInput.value).toBe("Cached local draft");
      expect(questionnaireIdInput.value).toBe("q_cached_draft");
    });
    expect(titleInput.matches(":disabled")).toBe(false);
    expect(questionnaireIdInput.matches(":disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Publish questionnaire" })).toBeTruthy();
  });

  it("keeps fresh local runtime summaries editable until a definition is published", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_runtime_open_draft",
        title: "Runtime-created draft",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        questions: [{
          questionId: "q1",
          prompt: "Proceed?",
          required: true,
          type: "yes_no",
        }],
      }),
    );
    upsertElectionSummary({
      electionId: "q_runtime_open_draft",
      title: "Runtime-created draft",
      description: "",
      state: "open",
      openedAt: "2026-06-12T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const questionnaireIdInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    const generateIdButton = screen.getByRole("button", { name: "Generate ID" });
    await waitFor(() => {
      expect(titleInput.value).toBe("Runtime-created draft");
      expect(questionnaireIdInput.value).toBe("q_runtime_open_draft");
    });
    expect(titleInput.matches(":disabled")).toBe(false);
    expect(questionnaireIdInput.matches(":disabled")).toBe(false);
    expect(generateIdButton.matches(":disabled")).toBe(false);
    expect(screen.getByText("Questionnaire not yet published")).toBeTruthy();
  });
});
