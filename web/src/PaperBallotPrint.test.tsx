// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PaperBallotPrint from "./PaperBallotPrint";
import { generatePaperBallot } from "./paperBallot";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";

afterEach(cleanup);
it("prints a code, expiry and conditional instructions without a secret-key reveal control", () => {
  const definition = { questionnaireId: "q-paper", title: "Budget", questions: [
    { questionId: "q1", type: "yes_no", prompt: "Approve?", required: true },
    { questionId: "q2", type: "free_text", prompt: "Explain", required: true,
      showIf: { dependsOnQuestionId: "q1", requiredAnswer: { answerType: "yes_no", value: false } } },
  ] } as QuestionnaireDefinition;
  render(<PaperBallotPrint ballot={generatePaperBallot({ definition, masterlistNumber: "ML-001", code: "ABCD1234EF", expiresAt: "2030-01-01T00:00:00Z" })} />);
  expect(screen.getByText("ABCD1-234EF")).toBeTruthy();
  expect(screen.getByText(/Answer only if question 1 \(Approve\?\) is applicable and answered No/)).toBeTruthy();
  expect(screen.getByText(/2030-01-01/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.body.textContent).not.toMatch(/nsec|npub|Serial:/);
});
