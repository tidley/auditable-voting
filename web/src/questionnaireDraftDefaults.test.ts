// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildNamespacedLocalStorageKey } from "./appStorageNamespace";
import { resetStoredQuestionnaireDraftId, storeBrowserOnlyIssuer, writeStoredIssuerSettings } from "./QuestionnaireCoordinatorPanel";
import { loadStoredWorkerDelegation, upsertStoredWorkerDelegation } from "./questionnaireWorkerDelegation";
import { loadElectionSummary, upsertElectionSummary } from "./questionnaireOptionAStorage";

const DRAFT_KEY = "coordinator.questionnaire-draft-data.v1";

function readDraft() {
  return JSON.parse(window.localStorage.getItem(buildNamespacedLocalStorageKey(DRAFT_KEY)) ?? "{}");
}

function seedDelegatedIssuer(electionId: string) {
  upsertStoredWorkerDelegation({
    electionId,
    mode: "delegated_worker",
    activeDelegation: {
      type: "worker_delegation",
      schemaVersion: 1,
      delegationId: "delegation_test",
      electionId,
      coordinatorNpub: "npub1coordinator",
      workerNpub: "npub1worker",
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://relay.example"],
      issuedAt: "2026-11-22T00:00:00.000Z",
      expiresAt: "2030-11-22T00:00:00.000Z",
    },
    lastRevocation: null,
    lastUpdatedAt: "2026-11-22T00:00:00.000Z",
  });
  upsertElectionSummary({
    electionId,
    title: "Published",
    description: "",
    state: "open",
    coordinatorNpub: "npub1coordinator",
    issueBlindTokensWorker: {
      delegationId: "delegation_test",
      workerNpub: "npub1worker",
    },
  });
}

describe("new-round issuer defaults", () => {
  beforeEach(() => window.localStorage.clear());

  it("resets delegation fields when starting a new round", () => {
    window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_KEY), JSON.stringify({
      questionnaireId: "q_old",
      title: { en: "Old" },
      description: { en: "" },
      closeTimerEnabled: false,
      closeAfterMinutes: "60",
      questions: [],
      delegationMode: "delegated_worker",
      delegatedWorkerNpub: "npub18xnvgfzgnls06s54eyszu6tet5yfqqys02ks70x03drykx9zzmhs4txsr7",
      delegatedWorkerControlRelays: "wss://relay.example",
      delegatedWorkerExpiryEnabled: true,
      delegatedWorkerExpiryMinutes: "60",
      privateWorkerEnabled: true,
      generatedWorkerNsec: "nsec1secret",
      generatedWorkerNpub: "npub1worker",
    }));

    const nextId = resetStoredQuestionnaireDraftId();
    const stored = JSON.parse(window.localStorage.getItem(buildNamespacedLocalStorageKey(DRAFT_KEY)) ?? "{}");
    expect(stored.questionnaireId).toBe(nextId);
    expect(stored.delegationMode).toBe("browser_only");
    expect(stored.delegatedWorkerNpub).toBe("");
    expect(stored.delegatedWorkerControlRelays).toBe("");
    expect(stored.delegatedWorkerExpiryEnabled).toBe(false);
    expect(stored.privateWorkerEnabled).toBe(false);
    expect(stored.generatedWorkerNsec).toBe("");
    expect(stored.generatedWorkerNpub).toBe("");
  });

  it("persists issuer settings without losing the definition draft", () => {
    window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_KEY), JSON.stringify({
      questionnaireId: "q_published",
      title: { en: "Published" },
      description: { en: "" },
      closeTimerEnabled: false,
      closeAfterMinutes: "60",
      questions: [],
      delegationMode: "delegated_worker",
      delegatedWorkerNpub: "npub1worker",
    }));

    writeStoredIssuerSettings({
      questionnaireId: "q_published",
      delegationMode: "browser_only",
    });

    const stored = readDraft();
    expect(stored.questionnaireId).toBe("q_published");
    expect(stored.title).toEqual({ en: "Published" });
    expect(stored.delegationMode).toBe("browser_only");
    expect(stored.delegatedWorkerNpub).toBe("");
  });

  it("clears the stored delegation and summary when switching to Browser only", () => {
    seedDelegatedIssuer("q_published");
    window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_KEY), JSON.stringify({
      questionnaireId: "q_published",
      delegationMode: "delegated_worker",
      delegatedWorkerNpub: "npub1worker",
    }));

    storeBrowserOnlyIssuer({ electionId: "q_published" });

    expect(readDraft().delegationMode).toBe("browser_only");
    expect(loadStoredWorkerDelegation("q_published")?.mode).toBe("browser_only");
    expect(loadStoredWorkerDelegation("q_published")?.activeDelegation).toBeNull();
    expect(loadElectionSummary("q_published")?.issueBlindTokensWorker).toBeNull();
  });
});
