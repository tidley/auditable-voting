// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PaperBallotCoordinatorPanel from "./PaperBallotCoordinatorPanel";

describe("PaperBallotCoordinatorPanel", () => {
  it("notifies its parent after generating admissions so worker config can sync", async () => {
    const runtime = { addPaperBallotAdmission: vi.fn() };
    const onAdmissionsChanged = vi.fn();
    render(<PaperBallotCoordinatorPanel
      electionId="q_paper"
      runtime={runtime as never}
      onAdmissionsChanged={onAdmissionsChanged}
    />);

    fireEvent.change(screen.getByLabelText("Master-list numbers"), { target: { value: "ML-001" } });
    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2030-01-01T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate printable codes" }));

    await waitFor(() => expect(onAdmissionsChanged).toHaveBeenCalledOnce());
    expect(runtime.addPaperBallotAdmission).toHaveBeenCalledOnce();
  });

  it("shows an expiry error and saves no codes when the expiry has passed", async () => {
    cleanup();
    const runtime = { addPaperBallotAdmission: vi.fn() };
    render(<PaperBallotCoordinatorPanel electionId="q_paper" runtime={runtime as never} />);

    fireEvent.change(screen.getByLabelText("Master-list numbers"), { target: { value: "ML-001" } });
    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2000-01-01T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate printable codes" }));

    expect(await screen.findByText("Code expiry must be in the future.")).toBeTruthy();
    expect(runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
  });
});
