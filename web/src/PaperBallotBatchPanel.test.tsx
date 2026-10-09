// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PaperBallotBatchPanel from "./PaperBallotBatchPanel";
import { LanguageProvider } from "./i18n/LanguageContext";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mock-qr"),
  },
}));

const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: "blind_token",
  questionnaireId: "q_panel_test",
  title: { en: "Panel Election", fr: "Élection du panel", ta: "குழு தேர்தல்" },
  createdAt: 1000,
  openAt: 1000,
  closeAt: 2000,
  coordinatorPubkey: "abc123",
  coordinatorEncryptionPubkey: "def456",
  responseVisibility: "public",
  eligibilityMode: "open",
  allowMultipleResponsesPerPubkey: false,
  questions: [
    { questionId: "q1", type: "yes_no", prompt: { en: "Do you agree?", fr: "Êtes-vous d'accord ?", ta: "நீங்கள் ஒப்புக்கொள்கிறீர்களா?" }, required: true },
  ],
};

afterEach(() => {
  cleanup();
  document.body
    .querySelectorAll(".simple-paper-ballot-print-only")
    .forEach((node) => node.remove());
});

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("PaperBallotBatchPanel", () => {
  it("explains that no questionnaire is published yet and blocks generation", () => {
    render(<PaperBallotBatchPanel definition={null} />);

    expect(screen.getByText(/Publish a questionnaire before generating paper ballots/)).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: /Generate paper ballots/i }))).toBe(true);
  });

  it("shows the security warning about the printed private key", () => {
    render(<PaperBallotBatchPanel definition={definition} />);

    expect(screen.getByText(/carries a private key \(nsec\)/)).toBeTruthy();
  });

  it("defaults the ballot count to the number of admitted voters", () => {
    render(<PaperBallotBatchPanel definition={definition} admittedVoterCount={4} />);

    const input = screen.getByLabelText(/Number of ballots/i) as HTMLInputElement;
    expect(input.value).toBe("4");
    expect(screen.getByText(/Admitted voters: 4/)).toBeTruthy();
  });

  it("generates one paper ballot per requested voter", async () => {
    const user = userEvent.setup();
    render(<PaperBallotBatchPanel definition={definition} />);

    const input = screen.getByLabelText(/Number of ballots/i);
    fireEvent.change(input, { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: /Generate paper ballots/i }));

    expect(screen.getByText(/Ballots generated: 3/)).toBeTruthy();
    expect(screen.getByText(/Generated ballots/)).toBeTruthy();
    expect(screen.getAllByLabelText(/View ballot \d/)).toHaveLength(3);
  });

  it("prints ballots in the active UI locale", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLocale="fr">
        <PaperBallotBatchPanel definition={definition} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Générer les bulletins papier/i }));

    expect(screen.getByText(/Bulletins générés : 1/)).toBeTruthy();
    // Ballot preview resolves the questionnaire title into French.
    await user.click(screen.getAllByLabelText(/Voir le bulletin 1/)[0]);
    expect(await screen.findByText("Élection du panel")).toBeTruthy();
  });

  it("renders a printable ballot preview for the chosen ballot", async () => {
    const user = userEvent.setup();
    render(<PaperBallotBatchPanel definition={definition} />);

    await user.click(screen.getByRole("button", { name: /Generate paper ballots/i }));
    await user.click(screen.getByLabelText(/View ballot 1/));

    expect(await screen.findByText("Panel Election")).toBeTruthy();
    expect(screen.getByText(/Do you agree\?/)).toBeTruthy();
    expect(screen.getByLabelText(/Hide ballot 1/)).toBeTruthy();
  });

  it("loads the questionnaire definition from the local cache when only an id is given", async () => {
    const user = userEvent.setup();
    storeCachedQuestionnaireDefinition(definition);

    render(<PaperBallotBatchPanel definition={undefined} questionnaireId="q_panel_test" />);

    const generate = screen.getByRole("button", { name: /Generate paper ballots/i });
    expect(isDisabled(generate)).toBe(false);
    await user.click(generate);

    expect(screen.getByText(/Ballots generated: 1/)).toBeTruthy();
  });

  it("refuses a ballot count above the batch cap instead of generating it", async () => {
    const user = userEvent.setup();
    render(<PaperBallotBatchPanel definition={definition} />);

    // The number input clamps to the cap, so drive the state through the input
    // event with an out-of-range value to prove the guard still holds.
    const input = screen.getByLabelText(/Number of ballots/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "501" } });
    expect(input.value).toBe("500");
    await user.click(screen.getByRole("button", { name: /Generate paper ballots/i }));

    expect(screen.getByText(/Ballots generated: 500/)).toBeTruthy();
  });

  it("prints the whole batch from a body-level print root, not the on-screen preview", async () => {
    const user = userEvent.setup();
    let printRootIsBodyChild = false;
    let printRootClasses: string[] = [];
    let printedBallots = 0;
    let printedQrCodes = 0;
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {
      const printRoot = document.querySelector(".simple-paper-ballot-print-only");
      printRootIsBodyChild = printRoot?.parentElement === document.body;
      printRootClasses = Array.from(printRoot?.classList ?? []);
      printedBallots = printRoot?.querySelectorAll(".ballot-print").length ?? 0;
      printedQrCodes = printRoot?.querySelectorAll("img.ballot-qr-image").length ?? 0;
    });

    render(<PaperBallotBatchPanel definition={definition} />);

    const input = screen.getByLabelText(/Number of ballots/i);
    fireEvent.change(input, { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: /Generate paper ballots/i }));
    // No ballot is expanded for preview, so printing must not depend on it.
    expect(screen.queryByLabelText(/Hide ballot 1/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Print all/i }));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    // The batch print root is a direct child of <body> carrying the
    // `.ballot-print` class the print stylesheet keys off, and it goes away
    // again once the print dialog has been handed the document.
    expect(printRootIsBodyChild).toBe(true);
    expect(printRootClasses).toContain("ballot-print");
    expect(printedBallots).toBe(3);
    // Every ballot's npub QR is rendered before the print dialog opens.
    expect(printedQrCodes).toBe(3);
    await waitFor(() =>
      expect(document.querySelectorAll(".simple-paper-ballot-print-only")).toHaveLength(0),
    );

    printSpy.mockRestore();
  });

  it("offers the print action only once a batch exists", async () => {
    const user = userEvent.setup();
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    render(<PaperBallotBatchPanel definition={definition} />);

    expect(screen.queryByRole("button", { name: /Print all/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Generate paper ballots/i }));

    expect(screen.getByRole("button", { name: /Print all/i })).toBeTruthy();
    expect(printSpy).not.toHaveBeenCalled();

    printSpy.mockRestore();
  });
});
