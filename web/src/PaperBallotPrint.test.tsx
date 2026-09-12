// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import PaperBallotPrint from "./PaperBallotPrint";
import type { PaperBallot } from "./paperBallot";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mock-qr"),
  },
}));

const TEST_NSEC = "nsec1c6gfkn8p0kcjn3dws63hgllgu6pa5q37ag084jzg8g6nnkpztxdq6zs0r2";
const TEST_NPUB = "npub1w7vr0zenyuhtzhzwa7yne4zw3gw0aq8mp30r2f9p99e365lh757q77pvrv";

const sampleBallot: PaperBallot = {
  questionnaireId: "q_test123",
  questionnaireTitle: "Municipal Election 2026",
  questions: [
    { questionId: "q1", prompt: "Do you approve of the budget?", type: "yes_no", required: true },
    { questionId: "q2", prompt: "Any additional comments?", type: "free_text", required: false },
    {
      questionId: "q3",
      prompt: "Choose your preferred candidate:",
      type: "multiple_choice",
      required: true,
      options: [
        { optionId: "opt_a", label: "Alice Johnson" },
        { optionId: "opt_b", label: "Bob Smith" },
      ],
    },
  ],
  voterNsec: TEST_NSEC,
  voterNpub: TEST_NPUB,
  inviteCode: "abc123def456",
  generatedAt: 1000000,
};

afterEach(() => {
  cleanup();
});

describe("PaperBallotPrint", () => {
  it("renders the questionnaire title and ID", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    expect(screen.getByText("Municipal Election 2026")).toBeTruthy();
    expect(screen.getByText(/q_test123/)).toBeTruthy();
  });

  it("displays all question prompts", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    expect(screen.getByText(/Do you approve of the budget/)).toBeTruthy();
    expect(screen.getByText(/Any additional comments/)).toBeTruthy();
    expect(screen.getByText(/Choose your preferred candidate/)).toBeTruthy();
  });

  it("renders a yes/no question with Yes/No checkboxes", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const questionEl = screen.getByText(/Do you approve of the budget/).closest(".ballot-question");
    expect(questionEl).toBeTruthy();
    expect(questionEl?.textContent).toContain("☐ Yes");
    expect(questionEl?.textContent).toContain("☐ No");
  });

  it("renders a free_text question with blank lines", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const questionEl = screen.getByText(/Any additional comments/).closest(".ballot-question");
    expect(questionEl?.querySelector(".ballot-blank-lines")).toBeTruthy();
  });

  it("renders a multiple_choice question with checkboxes for each option", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const questionEl = screen.getByText(/Choose your preferred candidate/).closest(".ballot-question");
    expect(questionEl?.textContent).toContain("☐ Alice Johnson");
    expect(questionEl?.textContent).toContain("☐ Bob Smith");
  });

  it("displays the voter nsec as monospace text", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const nsecEl = screen.getByText(TEST_NSEC);
    expect(nsecEl).toBeTruthy();
    expect(nsecEl.tagName).toBe("CODE");
  });

  it("displays the voter npub as monospace text", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const npubEl = screen.getByText(TEST_NPUB);
    expect(npubEl).toBeTruthy();
    expect(npubEl.tagName).toBe("CODE");
  });

  it("renders a QR code image for the npub", async () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const qrImg = await screen.findByAltText(/QR/);
    expect(qrImg).toBeTruthy();
    expect(qrImg.getAttribute("src")).toBe("data:image/png;base64,mock-qr");
  });

  it("displays the invite code", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    expect(screen.getByText("abc123def456")).toBeTruthy();
  });

  it("displays relay URLs", () => {
    render(<PaperBallotPrint ballot={sampleBallot} />);
    const relayEls = screen.getAllByText(/wss:\/\//);
    expect(relayEls.length).toBeGreaterThan(0);
  });

  it("renders the print-only class on the wrapper", () => {
    const { container } = render(<PaperBallotPrint ballot={sampleBallot} />);
    expect(container.firstElementChild?.classList.contains("ballot-print")).toBe(true);
  });
});