// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./QuestionnaireOptionAVoterPanel", () => ({
  default: () => <div>Option A Voter Panel</div>,
}));

import QuestionnaireVoterPanel from "./QuestionnaireVoterPanel";

describe("QuestionnaireVoterPanel single entry", () => {
  it("renders Option A voter panel by default", () => {
    render(<QuestionnaireVoterPanel />);
    expect(screen.getByText("Option A Voter Panel")).toBeTruthy();
  });
});
