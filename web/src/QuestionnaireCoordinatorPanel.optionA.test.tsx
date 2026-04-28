// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("uses the standard coordinator questionnaire form even when option_a is requested", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Build questionnaire")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByText("Advanced identity")).toBeTruthy();
  });
});
