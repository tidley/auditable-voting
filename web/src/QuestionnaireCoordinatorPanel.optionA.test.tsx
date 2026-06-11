// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./questionnaireFlowMode", () => ({
  getQuestionnaireFlowMode: () => "option_a",
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({
    querySync: vi.fn().mockResolvedValue([]),
    subscribeMany: vi.fn(() => ({
      close: vi.fn(),
    })),
  }),
}));

import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";
import { upsertElectionSummary } from "./questionnaireOptionAStorage";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("QuestionnaireCoordinatorPanel option_a mode", () => {
  it("uses the standard coordinator questionnaire form even when option_a is requested", () => {
    render(<QuestionnaireCoordinatorPanel />);
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Questionnaire ID")).toBeTruthy();
    expect(screen.getByText("Generate ID")).toBeTruthy();
    expect(screen.queryByText("Show invite link")).toBeNull();
  });

  it("keeps audit proxy setup out of the build actions until publication", () => {
    const onConfigureWorker = vi.fn();
    render(<QuestionnaireCoordinatorPanel onConfigureWorker={onConfigureWorker} />);

    expect(screen.queryByText("Set up proxy")).toBeNull();

    expect(onConfigureWorker).not.toHaveBeenCalled();
  });

  it("does not show the JSON preview controls in the build actions", () => {
    render(<QuestionnaireCoordinatorPanel />);

    expect(screen.queryByRole("button", { name: "Preview JSON" })).toBeNull();
    expect(screen.queryByText("Draft preview")).toBeNull();
  });

  it("generates a new questionnaire id when the coordinator New identity event fires", () => {
    render(<QuestionnaireCoordinatorPanel />);

    const idInput = screen.getByLabelText("Questionnaire ID") as HTMLInputElement;
    const previousId = idInput.value;

    fireEvent(window, new Event("auditable-voting:coordinator-new"));

    expect(idInput.value).toMatch(/^q_[a-f0-9]+$/);
    expect(idInput.value).not.toBe(previousId);
  });

  it("shows locally known organiser questionnaires in the live status selector", async () => {
    const coordinatorNpub = "npub1organiser";
    upsertElectionSummary({
      electionId: "q_first_local",
      title: "First local questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-01T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    upsertElectionSummary({
      electionId: "q_second_local",
      title: "Second local questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-02T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
    });
    upsertElectionSummary({
      electionId: "q_other_organiser",
      title: "Other organiser questionnaire",
      description: "",
      state: "open",
      openedAt: "2026-06-03T10:00:00.000Z",
      closedAt: null,
      coordinatorNpub: "npub1other",
    });

    render(<QuestionnaireCoordinatorPanel view='responses' coordinatorNpub={coordinatorNpub} />);

    const selector = await screen.findByRole("combobox", { name: "Questionnaire" }) as HTMLSelectElement;
    await waitFor(() => {
      const optionText = [...selector.options].map((option) => option.textContent ?? "");
      expect(optionText.some((text) => text.includes("First local questionnaire - q_first_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Second local questionnaire - q_second_local"))).toBe(true);
      expect(optionText.some((text) => text.includes("Other organiser questionnaire"))).toBe(false);
    });
  });
});
