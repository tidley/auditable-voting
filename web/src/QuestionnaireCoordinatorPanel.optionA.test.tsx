// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("uses the standard coordinator questionnaire form even when option_a is requested", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Build questionnaire")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Questionnaire ID")).toBeTruthy();
    expect(screen.getByText("Generate ID")).toBeTruthy();
    expect(screen.getByText("Show questionnaire link")).toBeTruthy();
  });

  it("keeps audit proxy setup out of the build actions until publication", () => {
    const onConfigureWorker = vi.fn();
    render(<QuestionnaireCoordinatorPanel onConfigureWorker={onConfigureWorker} />);

    const auditProxyHeading = screen.getAllByText("Audit proxy")
      .find((element) => element.tagName.toLowerCase() === "h2");
    const auditProxySection = auditProxyHeading.closest("section");
    expect(auditProxySection?.className).toContain("is-collapsed");
    expect(screen.queryByText("Set up audit proxy")).toBeNull();

    fireEvent.click(auditProxySection?.querySelector("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "delegated_worker" } });
    fireEvent.click(screen.getByText("Generate new account"));

    expect(onConfigureWorker).not.toHaveBeenCalled();
    expect(auditProxySection?.className).not.toContain("is-collapsed");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("delegated_worker");
    expect(screen.getByLabelText("Generated audit proxy nsec (store securely)")).toBeTruthy();
  });

  it("generates a new questionnaire id when the coordinator New ID event fires", () => {
    render(<QuestionnaireCoordinatorPanel />);

    const idInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    const previousId = idInput.value;

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
  });
});
