import React from "react";
import { createRoot } from "react-dom/client";
import DeliveryPanel from "../src/otpDelivery/DeliveryPanel";
import type { QuestionnaireDefinition } from "../src/questionnaireProtocol";
import "../src/styles.css";

const definition = {
  questionnaireId: "resident-email-harness",
  title: "Resident email admission harness",
  questions: [],
} as unknown as QuestionnaireDefinition;

const root = document.getElementById("root");
if (!root) throw new Error("resident email harness root missing");

createRoot(root).render(React.createElement(DeliveryPanel, {
  electionId: definition.questionnaireId,
  definition,
  runtime: { addPaperBallotAdmission() {} } as never,
  voterUrl: "https://tidley.github.io/auditable-voting/?role=voter&q=resident-email-harness&coordinator=npub1test",
}));
