// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

vi.mock("./QuestionnaireOptionACoordinatorPanel", () => ({
  default: () => <div>Option A Coordinator Panel</div>,
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("renders Option A coordinator panel when flow mode is option_a", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Option A Coordinator Panel")).toBeTruthy();
  });
});
