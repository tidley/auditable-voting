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
import { questionnaireDefinitionHash } from "./questionnaireDefinitionReference";
import { createWorkerDelegationCertificate, upsertStoredWorkerDelegation, type WorkerCapability } from "./questionnaireWorkerDelegation";

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
  questionnaireNostrMocks.publishQuestionnaireDefinition.mockImplementation(async (input) => ({
    eventId: "mock-published-definition-event",
    event: {
      id: "mock-published-definition-event",
      pubkey: "",
      created_at: input.definition.createdAt,
      kind: QUESTIONNAIRE_DEFINITION_KIND,
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
    event: {
      id: "mock-participant-count-event",
      kind: 6428,
      tags: [],
    },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
  });
  questionnaireNostrMocks.publishQuestionnaireState.mockResolvedValue({
    eventId: "mock-state-event",
    event: {
      id: "mock-state-event",
      kind: 6421,
      tags: [["state", "open"]],
    },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
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

  it("keeps questionnaire questions under one hidden ballot index", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' coordinatorNpub='npub1organiser' />);

    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Question" }));

    expect(screen.queryByLabelText("Question 1 ballot index")).toBeNull();
    expect(screen.queryByLabelText("Question 2 ballot index")).toBeNull();
    expect(screen.queryByLabelText("Question 3 ballot index")).toBeNull();

    const stored = JSON.parse(
      window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1")) ?? "{}",
    ) as { questions?: Array<{ ballotSlot?: { slotIndex?: number; slotId?: string; version?: number } }> };

    expect(stored.questions?.[0]?.ballotSlot?.slotIndex).toBe(1);
    expect(stored.questions?.[1]?.ballotSlot?.slotIndex).toBe(1);
    expect(stored.questions?.[2]?.ballotSlot?.slotIndex).toBe(1);
    expect(stored.questions?.[0]?.ballotSlot?.slotId).toBe("ballot-1");
    expect(stored.questions?.[1]?.ballotSlot?.slotId).toBe("ballot-1");
    expect(stored.questions?.[2]?.ballotSlot?.slotId).toBe("ballot-1");
    expect(stored.questions?.[0]?.ballotSlot?.version).toBe(stored.questions?.[1]?.ballotSlot?.version);
    expect(stored.questions?.[1]?.ballotSlot?.version).toBe(stored.questions?.[2]?.ballotSlot?.version);
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
    const workerNpubInput = screen.getByLabelText("Audit proxy npub") as HTMLInputElement;
    const previousId = idInput.value;

    expect(screen.queryByLabelText("Generated audit proxy nsec (store securely)")).toBeNull();
    expect(workerNpubInput.value).toBe("");

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
    const workerNsecInput = await screen.findByLabelText("Generated audit proxy nsec (store securely)") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(workerNsecInput.value).toMatch(/^nsec1/);
      expect(workerNpubInput.value).toMatch(/^npub1/);
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

  it("refreshes a stored proxy account when the setup page is opened", async () => {
    const staleWorkerNpub = nip19.npubEncode("2".repeat(64));
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_stale_proxy_setup",
        title: "",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        questions: [{
          questionId: "q1",
          prompt: "Proceed?",
          required: true,
          type: "yes_no",
        }],
        delegationMode: "delegated_worker",
        delegatedWorkerNpub: staleWorkerNpub,
      }),
    );

    render(<QuestionnaireCoordinatorPanel view='build' buildPage='proxy' />);

    const workerNpubInput = await screen.findByLabelText("Audit proxy npub") as HTMLInputElement;
    const workerNsecInput = await screen.findByLabelText("Generated audit proxy nsec (store securely)") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(workerNpubInput.value).toMatch(/^npub1/);
      expect(workerNpubInput.value).not.toBe(staleWorkerNpub);
      expect(workerNsecInput.value).toMatch(/^nsec1/);
    });

    const quickStart = screen.getByLabelText("Quick start command") as HTMLTextAreaElement;
    expect(quickStart.value).toContain(workerNsecInput.value);
    expect(quickStart.value).toContain('WORKER_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net');
  });

  it("refreshes a manually generated proxy account when the setup page is reopened", async () => {
    render(<QuestionnaireCoordinatorPanel view='build' buildPage='proxy' />);

    fireEvent.click(screen.getByRole("button", { name: "Generate new account" }));

    const workerNsecInput = await screen.findByLabelText("Generated audit proxy nsec (store securely)") as HTMLTextAreaElement;
    const workerNpubInput = screen.getByLabelText("Audit proxy npub") as HTMLInputElement;
    const generatedWorkerNsec = workerNsecInput.value;
    const generatedWorkerNpub = workerNpubInput.value;
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1")) ?? "{}",
      ) as { generatedWorkerNsec?: string; generatedWorkerNpub?: string };
      expect(stored.generatedWorkerNsec).toBe(generatedWorkerNsec);
      expect(stored.generatedWorkerNpub).toBe(generatedWorkerNpub);
    });

    cleanup();
    render(<QuestionnaireCoordinatorPanel view='build' buildPage='proxy' />);

    const restoredWorkerNsecInput = await screen.findByLabelText("Generated audit proxy nsec (store securely)") as HTMLTextAreaElement;
    await waitFor(() => {
      expect((screen.getByLabelText("Audit proxy npub") as HTMLInputElement).value).toMatch(/^npub1/);
      expect((screen.getByLabelText("Audit proxy npub") as HTMLInputElement).value).not.toBe(generatedWorkerNpub);
      expect(restoredWorkerNsecInput.value).toMatch(/^nsec1/);
      expect(restoredWorkerNsecInput.value).not.toBe(generatedWorkerNsec);
    });
  });

  it("shows separate public and private DM relay lists in the worker quick start command", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);

    render(
      <QuestionnaireCoordinatorPanel
        coordinatorNpub={coordinatorNpub}
        coordinatorNsec={coordinatorNsec}
      />,
    );

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "delegated_worker" } });

    const quickStart = await screen.findByLabelText("Quick start command") as HTMLTextAreaElement;
    expect(quickStart.value).toContain('WORKER_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info,wss://relay.damus.io,wss://relay.primal.net"');
    expect(quickStart.value).toContain('WORKER_DM_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nip17.com,wss://relay.0xchat.com"');
    expect(quickStart.value).not.toContain('WORKER_DM_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol');
    expect(screen.queryByText("Audit proxy downloads")).toBeNull();
    expect(screen.queryByLabelText("Direct command-line launch")).toBeNull();
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
      expect(optionText).toEqual([
        "1. First local questionnaire - q_first_local",
        "2. Second local questionnaire - q_second_local",
      ]);
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
    expect(screen.queryByText("Publish a questionnaire to inspect results.")).toBeNull();
  });

  it("asks for in-app confirmation before closing and publishing results", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    storeCachedQuestionnaireDefinition(makeDefinition({
      questionnaireId: "q_publish_confirm",
      title: "Publish confirm",
      coordinatorNpub,
    }));
    upsertElectionSummary({
      electionId: "q_publish_confirm",
      title: "Publish confirm",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });

    try {
      render(
        <QuestionnaireCoordinatorPanel
          view='responses'
          coordinatorNpub={coordinatorNpub}
          coordinatorNsec={coordinatorNsec}
          knownVoterCount={2}
          optionAAcceptedCount={1}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Close + publish results" }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(questionnaireNostrMocks.publishQuestionnaireState).not.toHaveBeenCalled();
      expect(await screen.findByRole("dialog", { name: "Close and publish?" })).toBeTruthy();
      expect(screen.getByText(/Only 1 of 2 expected responses have been received/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Confirm and publish" })).toBeTruthy();
    } finally {
      confirmSpy.mockRestore();
    }
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

  it("uses the provided initial questionnaire id for response reads", async () => {
    const coordinatorNpub = "npub1organiser";
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_stored_draft",
        title: "Stored draft",
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
        view='responses'
        coordinatorNpub={coordinatorNpub}
        initialQuestionnaireId='q_from_url'
      />,
    );

    await waitFor(() => {
      const qTagQueries = sharedNostrPoolMocks.querySync.mock.calls
        .map(([, filter]) => filter as { "#q"?: string[] } | undefined)
        .filter((filter) => Array.isArray(filter?.["#q"]));
      expect(qTagQueries.some((filter) => filter?.["#q"]?.includes("q_from_url"))).toBe(true);
      expect(qTagQueries.some((filter) => filter?.["#q"]?.includes("q_stored_draft"))).toBe(false);
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

  it("shows previous organiser sessions in the build page selector", async () => {
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

    expect([...selector.options].map((option) => option.value)).toEqual([
      "q_previous_one",
      "q_previous_two",
      "q_current_draft",
    ]);
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
      expect(selector.options[0]?.textContent).toBe("1. Live draft - q_live_draft");
    });

    fireEvent.change(titleInput, { target: { value: "Edited live draft" } });
    await waitFor(() => {
      expect(selector.options[0]?.textContent).toBe("1. Edited live draft - q_live_draft");
    });

    fireEvent.change(questionnaireIdInput, { target: { value: "q_edited_live" } });
    await waitFor(() => {
      expect([...selector.options].map((option) => option.value)).toEqual(["q_edited_live"]);
      expect(selector.options[0]?.textContent).toBe("1. Edited live draft - q_edited_live");
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
    expect(screen.getByRole("heading", { name: /Add session/i })).toBeTruthy();
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

    const onReadinessChange = vi.fn();
    render(
      <QuestionnaireCoordinatorPanel
        view='build'
        coordinatorNpub={coordinatorNpub}
        onReadinessChange={onReadinessChange}
      />,
    );

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
    await waitFor(() => expect(onReadinessChange).toHaveBeenCalled());
    const latestReadiness = onReadinessChange.mock.calls.at(-1)?.[0] ?? [];
    expect(latestReadiness.find((item: { id: string }) => item.id === "question")).toBeUndefined();
    expect(latestReadiness.find((item: { id: string }) => item.id === "title")).toBeUndefined();
    expect(latestReadiness.find((item: { id: string }) => item.id === "description")).toBeUndefined();
    expect(latestReadiness.find((item: { id: string }) => item.id === "basics")).toMatchObject({
      label: "Title & Description",
      group: "questionnaire",
      action: "setup_basics",
      stageLabel: "1",
      complete: false,
    });
    expect(latestReadiness.find((item: { id: string }) => item.id === "answers")).toMatchObject({
      label: "Questions complete",
      group: "questionnaire",
      action: "setup_questions",
      stageLabel: "2",
      complete: true,
    });
    expect(latestReadiness.find((item: { id: string }) => item.id === "publish")).toMatchObject({
      label: "Published",
      group: "session",
      stageLabel: "3",
      complete: false,
    });
    expect(latestReadiness.find((item: { id: string }) => item.id === "proxy")).toMatchObject({
      label: "Set up proxy",
      group: "session",
      optional: true,
      stageLabel: "3a",
      complete: false,
    });
    expect(latestReadiness.find((item: { id: string }) => item.id === "invite")).toMatchObject({
      label: "Invite voters",
      group: "session",
      action: "invite_voters",
      stageLabel: "4",
      complete: false,
    });
  });

  it("configures the audit proxy from the just-published definition instead of stale cached definition state", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const workerNpub = nip19.npubEncode("9".repeat(64));
    const publishedBlindKey = await generateQuestionnaireBlindKeyPair();
    const staleBlindKey = await generateQuestionnaireBlindKeyPair();
    const staleDefinition = {
      ...makeDefinition({
        questionnaireId: "q_publish_proxy_hash",
        title: "Stale cached definition",
        coordinatorNpub,
      }),
      createdAt: 9999999999,
      openAt: 9999999999,
      closeAt: 10000003600,
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(staleBlindKey),
    };
    storeCachedQuestionnaireDefinition(staleDefinition);
    const draftElection = {
      electionId: "q_publish_proxy_hash",
      title: "Fresh published definition",
      description: "Fresh proxy setup",
      state: "draft" as const,
      openedAt: null,
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(publishedBlindKey),
    };
    upsertElectionSummary(draftElection);
    saveCoordinatorState({
      coordinatorNpub,
      state: {
        election: draftElection,
        whitelist: {},
        bearerInviteCodes: {},
        pendingBlindRequests: {},
        issuedBlindResponses: {},
        receivedSubmissions: {},
        acceptedNullifiers: {},
        acceptanceResults: {},
        blindSigningPrivateKey: publishedBlindKey,
        lastUpdatedAt: "2026-06-18T21:30:00.000Z",
      },
    });
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId: "q_publish_proxy_hash",
        title: "Fresh published definition",
        description: "Fresh proxy setup",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        delegationMode: "delegated_worker",
        delegatedWorkerNpub: workerNpub,
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
        blindSigningPublicKey={toQuestionnaireBlindPublicKey(publishedBlindKey)}
        knownVoterCount={1}
      />,
    );

    const publishButton = await screen.findByRole("button", { name: "Publish questionnaire" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(publishButton.matches(":disabled")).toBe(false);
    });
    fireEvent.click(publishButton);

    await waitFor(() => {
      expect(publishOptionAWorkerElectionConfigDm).toHaveBeenCalled();
    });

    const publishedDefinition = questionnaireNostrMocks.publishQuestionnaireDefinition.mock.calls[0]?.[0]?.definition;
    const workerConfigInput = vi.mocked(publishOptionAWorkerElectionConfigDm).mock.calls[0]?.[0];
    expect(publishedDefinition?.title).toBe("Fresh published definition");
    expect(workerConfigInput?.snapshot.definitionReference?.definitionEventId).toBe("mock-published-definition-event");
    expect(workerConfigInput?.snapshot.definitionReference?.definitionHash).toBe(questionnaireDefinitionHash(publishedDefinition));
    expect(workerConfigInput?.snapshot.definitionReference?.definitionHash).not.toBe(questionnaireDefinitionHash(staleDefinition));
    expect(workerConfigInput?.snapshot.blindSigningPrivateKey?.keyId).toBe(publishedBlindKey.keyId);
    expect(workerConfigInput?.snapshot.blindSigningPrivateKey?.keyId).not.toBe(staleBlindKey.keyId);
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

  it("resends worker config for the active delegation instead of minting a new delegation", async () => {
    const coordinatorSecret = generateSecretKey();
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);
    const workerNpub = nip19.npubEncode("4".repeat(64));
    const blindKey = await generateQuestionnaireBlindKeyPair();
    const questionnaireId = "q_proxy_config_resend";
    const definition = {
      ...makeDefinition({
        questionnaireId,
        title: "Proxy config resend",
        coordinatorNpub,
      }),
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(blindKey),
    };
    const capabilities: WorkerCapability[] = [
      "issue_blind_tokens",
      "verify_public_submissions",
      "publish_submission_decisions",
      "close_questionnaire",
      "publish_result_summary",
    ];
    const controlRelays = [
      "wss://vm-1734.lnvps.cloud/",
      "wss://relay.nostr.net",
      "wss://nos.lol",
      "wss://relay.nostr.info",
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ];
    const activeDelegation = createWorkerDelegationCertificate({
      electionId: questionnaireId,
      coordinatorNpub,
      workerNpub,
      capabilities,
      controlRelays,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    storeCachedQuestionnaireDefinition(definition);
    const election = {
      electionId: questionnaireId,
      title: "Proxy config resend",
      description: "",
      state: "draft" as const,
      openedAt: null,
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: definition.blindSigningPublicKey,
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
        blindSigningPrivateKey: blindKey,
        lastUpdatedAt: "2026-07-11T14:50:00.000Z",
      },
    });
    upsertStoredWorkerDelegation({
      electionId: questionnaireId,
      mode: "delegated_worker",
      activeDelegation,
      lastRevocation: null,
      lastUpdatedAt: "2026-07-11T14:50:00.000Z",
    });
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("coordinator.questionnaire-draft-data.v1"),
      JSON.stringify({
        questionnaireId,
        title: "Proxy config resend",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: "60",
        delegationMode: "delegated_worker",
        delegatedWorkerNpub: workerNpub,
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
        draftQuestionnaireId={questionnaireId}
        knownVoterCount={0}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Confirm configuration" }));

    await waitFor(() => {
      expect(publishOptionAWorkerElectionConfigDm).toHaveBeenCalledWith(expect.objectContaining({
        snapshot: expect.objectContaining({
          delegationId: activeDelegation.delegationId,
          expectedInviteeCount: 0,
          blindSigningPrivateKey: expect.objectContaining({
            keyId: blindKey.keyId,
          }),
        }),
      }));
    });
  });
});
