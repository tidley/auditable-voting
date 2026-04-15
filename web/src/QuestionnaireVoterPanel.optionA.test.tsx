// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

vi.mock("./QuestionnaireOptionAVoterPanel", () => ({
  default: () => <div>Option A Voter Panel</div>,
}));

import QuestionnaireVoterPanel from "./QuestionnaireVoterPanel";

describe("QuestionnaireVoterPanel option_a mode", () => {
  it("renders Option A voter panel when flow mode is option_a", () => {
    render(<QuestionnaireVoterPanel />);
    expect(screen.getByText("Option A Voter Panel")).toBeTruthy();
  });
});
