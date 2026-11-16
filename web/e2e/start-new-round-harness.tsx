import React from "react";
import { createRoot } from "react-dom/client";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import QuestionnaireCoordinatorPanel from "../src/QuestionnaireCoordinatorPanel";
import { storeCachedQuestionnaireDefinition } from "../src/questionnaireDefinitionCache";
import { upsertElectionSummary } from "../src/questionnaireOptionAStorage";
import { buildNamespacedLocalStorageKey } from "../src/appStorageNamespace";
import type { QuestionnaireDefinition } from "../src/questionnaireProtocol";
import "../src/styles.css";

/**
 * Dev-only integration harness for the round-start flow. It mounts the real
 * coordinator panel with a published questionnaire and no invited-voter roster.
 * Relay publishing is intentionally out of scope here; the component tests
 * cover the publish call and the organiser flow covers the edit surface.
 */

const PUBLISHED_ID = "q_round_one_published";
const NEW_ROUND_ID = "q_round_two_draft";
const DRAFT_DATA_KEY = "coordinator.questionnaire-draft-data.v1";
const DRAFT_ID_KEY = "coordinator.questionnaire-draft-id.v1";

const coordinatorSecret = generateSecretKey();
const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecret));
const coordinatorNsec = nip19.nsecEncode(coordinatorSecret);

const draftData = {
  questionnaireId: PUBLISHED_ID,
  title: "Round one",
  description: "First round",
  closeTimerEnabled: false,
  closeAfterMinutes: "60",
  questions: [{
    questionId: "q1",
    prompt: "Proceed?",
    required: true,
    type: "yes_no" as const,
  }],
};

function definition(questionnaireId: string, title: string): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: "blind_token",
    questionnaireId,
    title,
    description: "First round",
    createdAt: 1781200000,
    openAt: 1781200000,
    closeAt: 1781203600,
    coordinatorPubkey: coordinatorNpub,
    coordinatorEncryptionPubkey: coordinatorNpub,
    responseVisibility: "public",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: draftData.questions,
  };
}

// Seed one published round and its editable setup. There is no invited roster.
storeCachedQuestionnaireDefinition(definition(PUBLISHED_ID, "Round one"));
upsertElectionSummary({
  electionId: PUBLISHED_ID,
  title: "Round one",
  description: "First round",
  state: "open",
  openedAt: "2026-06-02T10:00:00.000Z",
  closedAt: null,
  coordinatorNpub,
});
window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_DATA_KEY), JSON.stringify(draftData));
window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_ID_KEY), PUBLISHED_ID);

function Harness() {
  const [newRoundMode, setNewRoundMode] = React.useState(false);
  const [draftQuestionnaireId, setDraftQuestionnaireId] = React.useState("");

  function startNewRound() {
    const nextDraft = { ...draftData, questionnaireId: NEW_ROUND_ID };
    window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_DATA_KEY), JSON.stringify(nextDraft));
    window.localStorage.setItem(buildNamespacedLocalStorageKey(DRAFT_ID_KEY), NEW_ROUND_ID);
    setDraftQuestionnaireId(NEW_ROUND_ID);
    setNewRoundMode(true);
  }

  return (
    <QuestionnaireCoordinatorPanel
      view='build'
      coordinatorNpub={coordinatorNpub}
      coordinatorNsec={coordinatorNsec}
      initialQuestionnaireId={PUBLISHED_ID}
      canAddSession
      onAddSession={startNewRound}
      newRoundMode={newRoundMode}
      draftQuestionnaireId={draftQuestionnaireId}
      canApplyAdmissionsOnPublish={false}
    />
  );
}

const root = document.getElementById("harness-root");
if (!root) {
  throw new Error("harness root missing");
}
createRoot(root).render(<Harness />);
