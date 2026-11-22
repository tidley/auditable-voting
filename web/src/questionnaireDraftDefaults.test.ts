// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildNamespacedLocalStorageKey } from "./appStorageNamespace";
import { resetStoredQuestionnaireDraftId } from "./QuestionnaireCoordinatorPanel";

const DRAFT_KEY = "coordinator.questionnaire-draft-data.v1";

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
});
