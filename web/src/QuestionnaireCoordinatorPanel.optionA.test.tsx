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
    expect(screen.getByText("Setup vote")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Vote ID")).toBeTruthy();
    expect(screen.getByText("Generate ID")).toBeTruthy();
    expect(screen.queryByText("Show invite link")).toBeNull();
  });

  it("keeps audit proxy setup out of the build actions until publication", () => {
    const onConfigureWorker = vi.fn();
    render(<QuestionnaireCoordinatorPanel onConfigureWorker={onConfigureWorker} />);

    const auditProxyHeading = screen.getAllByText("Audit proxy")
      .find((element) => element.tagName.toLowerCase() === "h2");
    const auditProxySection = auditProxyHeading.closest("section");
    expect(auditProxySection?.className).toContain("is-collapsed");
    expect(screen.queryByText("Set up proxy")).toBeNull();

    fireEvent.click(auditProxySection?.querySelector("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "delegated_worker" } });
    fireEvent.click(screen.getByText("Generate new account"));

    expect(onConfigureWorker).not.toHaveBeenCalled();
    expect(auditProxySection?.className).not.toContain("is-collapsed");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("delegated_worker");
    expect(screen.getByLabelText("Generated audit proxy nsec (store securely)")).toBeTruthy();
  });

  it("marks the JSON preview button as an expandable toggle", () => {
    render(<QuestionnaireCoordinatorPanel />);

    const previewButton = screen.getByRole("button", { name: "Preview JSON" });
    expect(previewButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(previewButton);

    expect(previewButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Draft preview")).toBeTruthy();

    fireEvent.click(previewButton);

    expect(previewButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Draft preview")).toBeNull();
  });

  it("generates a new questionnaire id when the coordinator New identity event fires", () => {
    render(<QuestionnaireCoordinatorPanel />);

    const idInput = screen.getByLabelText("Vote ID") as HTMLInputElement;
    const previousId = idInput.value;

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
  });
});
