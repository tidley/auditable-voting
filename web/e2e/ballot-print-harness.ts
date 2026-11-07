import React from "react";
import { createRoot } from "react-dom/client";
import PaperBallotCoordinatorPanel from "../src/PaperBallotCoordinatorPanel";
import PaperBallotCodeInput from '../src/PaperBallotCodeInput';
import "../src/styles.css";
import type { QuestionnaireDefinition } from "../src/questionnaireProtocol";

const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: "blind_token",
  questionnaireId: "review-harness-2024",
  title: "Community Garden Budget",
  createdAt: Date.now(),
  openAt: 0,
  closeAt: Number.MAX_SAFE_INTEGER,
  coordinatorPubkey: "0".repeat(64),
  coordinatorEncryptionPubkey: "0".repeat(64),
  responseVisibility: "public",
  eligibilityMode: "open",
  allowMultipleResponsesPerPubkey: false,
  questions: [
    {
      questionId: "q1",
      prompt: "Which option should we fund first?",
      required: true,
      type: "multiple_choice",
      multiSelect: true,
      options: [
        { optionId: "o1", label: "Raised beds" },
        { optionId: "o2", label: "Tool library" },
      ],
    },
    {
      questionId: "q2",
      prompt: "Any additional comments?",
      required: false,
      type: "free_text",
      maxLength: 1000,
      showIf: { dependsOnQuestionId: "q1", requiredAnswer: { answerType: "multiple_choice", selectedOptionIds: ["o1", "o2"] } },
    },
  ],
};

const root = document.getElementById("harness-root");
if (!root) {
  throw new Error("harness root missing");
}
// Only persistence is stubbed; generation, UI, print component and CSS are real.
function CodeEntryHarness() {
  const [code, setCode] = React.useState('');
  return React.createElement('section', { className: 'simple-settings-card', 'aria-label': 'Paper code entry preview' }, React.createElement(PaperBallotCodeInput, { value: code, onChange: setCode }));
}
createRoot(root).render(React.createElement(React.Fragment, null, React.createElement(PaperBallotCoordinatorPanel, {
  electionId: definition.questionnaireId,
  definition,
  runtime: { addPaperBallotAdmission() {} } as never,
}), React.createElement(CodeEntryHarness)));
