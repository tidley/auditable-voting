// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaperBallotCoordinatorPanel from "./PaperBallotCoordinatorPanel";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
const definition = { questionnaireId: "q_paper", title: "Paper", questions: [] } as unknown as QuestionnaireDefinition;

// Test the panel's expiry validation independently of the date picker's segments.
vi.mock('./ui/UiDateTimeField', () => ({ default: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <label>{label}<input value={value} onChange={event => onChange(event.target.value)} /></label> }));

beforeEach(() => {
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:paper-document');
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PaperBallotCoordinatorPanel", () => {
  it("notifies its parent after generating admissions so worker config can sync", async () => {
    const runtime = { addPaperBallotAdmission: vi.fn() };
    const onAdmissionsChanged = vi.fn();
    render(<PaperBallotCoordinatorPanel
      electionId="q_paper"
      definition={definition}
      runtime={runtime as never}
      onAdmissionsChanged={onAdmissionsChanged}
    />);

    fireEvent.change(screen.getByLabelText("Master-list numbers"), { target: { value: "ML-001" } });
    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2030-01-01T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate printable codes" }));

    await waitFor(() => expect(onAdmissionsChanged).toHaveBeenCalledOnce());
    expect(runtime.addPaperBallotAdmission).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Generate printable codes" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("already generated"));
    expect(runtime.addPaperBallotAdmission).toHaveBeenCalledOnce();
  });

  it("shows an expiry error and saves no codes when the expiry has passed", async () => {
    cleanup();
    const runtime = { addPaperBallotAdmission: vi.fn() };
    render(<PaperBallotCoordinatorPanel electionId="q_paper" definition={definition} runtime={runtime as never} />);

    fireEvent.change(screen.getByLabelText("Master-list numbers"), { target: { value: "ML-001" } });
    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2000-01-01T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate printable codes" }));

    expect(await screen.findByText("Code expiry must be in the future.")).toBeTruthy();
    expect(runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
  });

  it('offers a private document in a separate tab and releases its local URL on unmount', async () => {
    const runtime = { addPaperBallotAdmission: vi.fn() };
    const { unmount } = render(<PaperBallotCoordinatorPanel electionId='q_paper' definition={definition} runtime={runtime as never} />);
    fireEvent.change(screen.getByLabelText('Master-list numbers'), { target: { value: 'ML-001' } });
    fireEvent.change(screen.getByLabelText('Code expiry'), { target: { value: '2030-01-01T12:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate printable codes' }));
    const link = await screen.findByRole('link', { name: 'Open printable ballots' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'Download HTML' }).getAttribute('download')).toBe('paper-ballots-q_paper.html');
    expect(document.querySelector('.ballot-print')).toBeNull();
    const revoke = URL.revokeObjectURL;
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:paper-document');
  });
});
