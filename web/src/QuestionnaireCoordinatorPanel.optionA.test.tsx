// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";

afterEach(() => {
  cleanup();
});

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("uses the standard coordinator questionnaire form even when option_a is requested", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Build questionnaire")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Questionnaire ID")).toBeTruthy();
    expect(screen.getByText("Generate ID")).toBeTruthy();
  });

  it("opens audit proxy setup and generates proxy credentials from the checklist button", () => {
    const onConfigureWorker = vi.fn();
    render(<QuestionnaireCoordinatorPanel onConfigureWorker={onConfigureWorker} />);

    const auditProxyHeading = screen.getAllByText("Audit proxy")
      .find((element) => element.tagName.toLowerCase() === "h2");
    const auditProxySection = auditProxyHeading.closest("section");
    expect(auditProxySection?.className).toContain("is-collapsed");

    fireEvent.click(screen.getByText("Set up audit proxy"));

    expect(onConfigureWorker).toHaveBeenCalled();
    expect(auditProxySection?.className).not.toContain("is-collapsed");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("delegated_worker");
    expect(screen.getByText(/Generated audit proxy npub:/)).toBeTruthy();
  });
});
