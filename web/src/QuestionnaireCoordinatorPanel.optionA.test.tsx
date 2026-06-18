// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
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

vi.mock("./questionnaireWorkerDelegation", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireWorkerDelegation")>("./questionnaireWorkerDelegation");
  return {
    ...actual,
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
import { loadCoordinatorState, saveCoordinatorState, upsertElectionSummary } from "./questionnaireOptionAStorage";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";
import { generateQuestionnaireBlindKeyPair, toQuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import { fetchOptionAWorkerStatusDmsWithNsec, publishOptionAWorkerElectionConfigDm } from "./questionnaireOptionABlindDm";

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
  vi.mocked(fetchOptionAWorkerStatusDmsWithNsec).mockResolvedValue([]);
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

  it("lets organisers group questions under one ballot index", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));
    const firstBallotIndex = screen.getByLabelText("Question 1 ballot index") as HTMLInputElement;
    const secondBallotIndex = screen.getByLabelText("Question 2 ballot index") as HTMLInputElement;

    expect(firstBallotIndex.value).toBe("1");
    expect(secondBallotIndex.value).toBe("2");

    fireEvent.change(secondBallotIndex, { target: { value: "1" } });

    await waitFor(() => {
      expect(secondBallotIndex.value).toBe("1");
    });

    const stored = JSON.parse(
      window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1")) ?? "{}",
    ) as { questions?: Array<{ ballotSlot?: { slotIndex?: number; slotId?: string; version?: number } }> };

    expect(stored.questions?.[0]?.ballotSlot?.slotIndex).toBe(1);
    expect(stored.questions?.[1]?.ballotSlot?.slotIndex).toBe(1);
    expect(stored.questions?.[0]?.ballotSlot?.slotId).toBe("ballot-1");
    expect(stored.questions?.[1]?.ballotSlot?.slotId).toBe("ballot-1");
    expect(stored.questions?.[0]?.ballotSlot?.version).toBe(stored.questions?.[1]?.ballotSlot?.version);
  });

  it("does not show the JSON preview controls in the build actions", () => {
    render(<QuestionnaireCoordinatorPanel />);

    expect(screen.queryByRole("button", { name: "Preview JSON" })).toBeNull();
    expect(screen.queryByText("Draft preview")).toBeNull();
  });

  it("generates a new questionnaire id and proxy identity when the coordinator New identity event fires", async () => {
    render(<QuestionnaireCoordinatorPanel />);

    const idInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "delegated_worker" } });
    const workerNsecInput = await screen.findByLabelText("Generated audit proxy nsec (store securely)") as HTMLTextAreaElement;
    const workerNpubInput = screen.getByLabelText("Audit proxy npub") as HTMLInputElement;
    const previousId = idInput.value;
    const previousWorkerNsec = workerNsecInput.value;
    const previousWorkerNpub = workerNpubInput.value;

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
    await waitFor(() => {
      expect(workerNsecInput.value).toMatch(/^nsec1/);
      expect(workerNsecInput.value).not.toBe(previousWorkerNsec);
      expect(workerNpubInput.value).toMatch(/^npub1/);
      expect(workerNpubInput.value).not.toBe(previousWorkerNpub);
    });
  });

  it("uses a live available proxy for delegated setup instead of a stale generated account", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const liveWorkerNpub = nip19.npubEncode("3".repeat(64));
    vi.mocked(fetchOptionAWorkerStatusDmsWithNsec).mockResolvedValue([{
      type: "worker_status",
      schemaVersion: 1,
      workerNpub: liveWorkerNpub,
      coordinatorNpub,
      workerVersion: "0.1.26",
      state: "active",
      heartbeatAt: "2026-06-17T23:30:00.000Z",
      delegationId: "delegation_previous",
      delegationState: "active",
      activeElectionId: "q_previous",
      advertisedRelays: ["wss://relay.nostr.net", "wss://nos.lol"],
      supportedCapabilities: ["issue_blind_tokens"],
    }]);

    render(
      <QuestionnaireCoordinatorPanel
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
      />,
    );

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "delegated_worker" } });

    await waitFor(() => {
      expect((screen.getByLabelText("Audit proxy npub") as HTMLInputElement).value).toBe(liveWorkerNpub);
    });
    expect(screen.queryByLabelText("Generated audit proxy nsec (store securely)")).toBeNull();
    expect((document.querySelector("#delegated-worker-relays") as HTMLTextAreaElement | null)?.value).toContain("wss://relay.nostr.net");
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
    upsertElectionSummary({
      electionId: "q_stale_mismatched",
      title: "Stale mismatched questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-04T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    storeCachedQuestionnaireDefinition(makeDefinition({
      questionnaireId: "q_stale_mismatched",
      title: "Stale mismatched questionnaire",
      coordinatorNpub: "npub1other",
    }));

    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      const optionText = [...selector.options].map((option) => option.textContent ?? "");
      expect(optionText.some((text) => text.includes("First local questionnaire - q_first_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Second local questionnaire - q_second_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Other organiser questionnaire"))).toBe(false);
      expect(optionText.some((text) => text.includes("Stale mismatched questionnaire"))).toBe(false);
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

  it("uses live build draft values for the selected questionnaire label", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_live_draft",
        title: "Live draft",
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
      electionId: "q_live_draft",
      title: "Old draft summary",
      description: "",
      state: "draft",
      openedAt: null,
      closedAt: null,
      coordinatorNpub,
    });

    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const questionnaireIdInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;

    await waitFor(() => {
      expect(selector.options[0]?.textContent).toBe("Live draft - q_live_draft");
    });

    fireEvent.change(titleInput, { target: { value: "Edited live draft" } });
    await waitFor(() => {
      expect(selector.options[0]?.textContent).toBe("Edited live draft - q_live_draft");
    });

    fireEvent.change(questionnaireIdInput, { target: { value: "q_edited_live" } });
    await waitFor(() => {
      expect([...selector.options].map((option) => option.value)).toEqual(["q_edited_live"]);
      expect(selector.options[0]?.textContent).toBe("Edited live draft - q_edited_live");
    });
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

  it("switches from a locked published questionnaire to the parent requested draft round", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_published_before_new_round",
        title: "Published before new round",
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
      questionnaireId: "q_published_before_new_round",
      title: "Published before new round",
      coordinatorNpub,
    }));
    upsertElectionSummary({
      electionId: "q_published_before_new_round",
      title: "Published before new round",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    const { rerender } = render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub={coordinatorNpub} />);

    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const questionnaireIdInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    await waitFor(() => {
      expect(questionnaireIdInput.value).toBe("q_published_before_new_round");
    });
    expect(titleInput.matches(":disabled")).toBe(true);
    expect(questionnaireIdInput.matches(":disabled")).toBe(true);

    rerender(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        newRoundMode
        draftQuestionnaireId='q_new_round_from_parent'
      />,
    );

    await waitFor(() => {
      expect(questionnaireIdInput.value).toBe("q_new_round_from_parent");
    });
    expect(titleInput.matches(":disabled")).toBe(false);
    expect(questionnaireIdInput.matches(":disabled")).toBe(false);
    expect(screen.getByRole("heading", { name: /New round/i })).toBeTruthy();
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

  it("does not configure the audit proxy when the local blind private key does not match the published vote key", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const workerNpub = nip19.npubEncode("1".repeat(64));
    const publishedBlindKey = await generateQuestionnaireBlindKeyPair();
    const mismatchedBlindKey = await generateQuestionnaireBlindKeyPair();
    const publicDefinition = {
      ...makeDefinition({
        questionnaireId: "q_proxy_key_mismatch",
        title: "Proxy key mismatch",
        coordinatorNpub,
      }),
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(publishedBlindKey),
    };
    storeCachedQuestionnaireDefinition(publicDefinition);
    const election = {
      electionId: "q_proxy_key_mismatch",
      title: "Proxy key mismatch",
      description: "",
      state: "open" as const,
      openedAt: "2026-06-17T22:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: publicDefinition.blindSigningPublicKey,
    };
    upsertElectionSummary(election);
    saveCoordinatorState({
      coordinatorNpub,
      state: {
        election,
        whitelist: {},
        bearerInviteCodes: {},
        pendingBlindRequests: {},
        issuedBlindResponses: {},
        receivedSubmissions: {},
        acceptedNullifiers: {},
        acceptanceResults: {},
        blindSigningPrivateKey: mismatchedBlindKey,
        lastUpdatedAt: "2026-06-17T22:00:00.000Z",
      },
    });
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_proxy_key_mismatch",
        title: "Proxy key mismatch",
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

    render(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
        draftQuestionnaireId='q_proxy_key_mismatch'
        knownVoterCount={1}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "delegated_worker" } });
    fireEvent.change(await screen.findByLabelText("Audit proxy npub"), { target: { value: workerNpub } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm configuration" }));

    await waitFor(() => {
      expect(screen.getByText(/Audit proxy not configured because no local blind-signing private key matches the published vote key/i)).toBeTruthy();
    });
  });

  it("recovers the matching local blind private key before configuring the audit proxy", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const workerNpub = nip19.npubEncode("2".repeat(64));
    const publishedBlindKey = await generateQuestionnaireBlindKeyPair();
    const mismatchedBlindKey = await generateQuestionnaireBlindKeyPair();
    const publicDefinition = {
      ...makeDefinition({
        questionnaireId: "q_proxy_key_recovery",
        title: "Proxy key recovery",
        coordinatorNpub,
      }),
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(publishedBlindKey),
    };
    storeCachedQuestionnaireDefinition(publicDefinition);
    const election = {
      electionId: "q_proxy_key_recovery",
      title: "Proxy key recovery",
      description: "",
      state: "open" as const,
      openedAt: "2026-06-17T22:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: publicDefinition.blindSigningPublicKey,
    };
    upsertElectionSummary(election);
    saveCoordinatorState({
      coordinatorNpub,
      state: {
        election,
        whitelist: {},
        bearerInviteCodes: {},
        pendingBlindRequests: {},
        issuedBlindResponses: {},
        receivedSubmissions: {},
        acceptedNullifiers: {},
        acceptanceResults: {},
        blindSigningPrivateKey: mismatchedBlindKey,
        lastUpdatedAt: "2026-06-17T22:00:00.000Z",
      },
    });
    saveCoordinatorState({
      coordinatorNpub,
      state: {
        election: {
          ...election,
          electionId: "q_previous_matching_key",
          title: "Previous matching key",
        },
        whitelist: {},
        bearerInviteCodes: {},
        pendingBlindRequests: {},
        issuedBlindResponses: {},
        receivedSubmissions: {},
        acceptedNullifiers: {},
        acceptanceResults: {},
        blindSigningPrivateKey: publishedBlindKey,
        lastUpdatedAt: "2026-06-17T21:00:00.000Z",
      },
    });
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_proxy_key_recovery",
        title: "Proxy key recovery",
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

    render(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
        draftQuestionnaireId='q_proxy_key_recovery'
        knownVoterCount={1}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "delegated_worker" } });
    fireEvent.change(await screen.findByLabelText("Audit proxy npub"), { target: { value: workerNpub } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm configuration" }));

    await waitFor(() => {
      expect(screen.getByText(/Audit proxy configured/i)).toBeTruthy();
    });
    expect(publishOptionAWorkerElectionConfigDm).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        blindSigningPrivateKey: expect.objectContaining({
          keyId: publishedBlindKey.keyId,
        }),
      }),
    }));
    expect(loadCoordinatorState({
      coordinatorNpub,
      electionId: "q_proxy_key_recovery",
    })?.blindSigningPrivateKey?.keyId).toBe(publishedBlindKey.keyId);
  });
});
