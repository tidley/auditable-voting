// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import QuestionnaireResultsDashboard, {
  type QuestionnaireResultsDashboardResponseDetail,
} from "./QuestionnaireResultsDashboard";
import { deriveIdentityWords } from "./identityWords";

afterEach(() => {
  cleanup();
});

const responseDetails: QuestionnaireResultsDashboardResponseDetail[] = [
  {
    event: {
      id: "event-alpha",
      created_at: 1_774_000_000,
    },
    accepted: true,
    response: {
      responseId: "submission_alpha",
      authorPubkey: "npub1" + "a".repeat(58),
      submittedAt: 1_774_000_000,
      tokenNullifier: "nullifier-alpha",
      answers: [],
    },
  },
  {
    event: {
      id: "event-beta",
      created_at: 1_774_000_100,
    },
    accepted: true,
    response: {
      responseId: "submission_beta",
      authorPubkey: "npub1" + "b".repeat(58),
      submittedAt: 1_774_000_100,
      tokenNullifier: "nullifier-beta",
      answers: [],
    },
  },
];

function renderDashboard() {
  render(
    <QuestionnaireResultsDashboard
      questionnaire={{
        questionnaireId: "q_filter_test",
        title: "Filter test",
        questions: [],
      }}
      questionSummaries={[]}
      responseDetails={responseDetails}
      displayValidCount={responseDetails.length}
      coordinatorText="Organiser test"
      publishedAtLabel="Not published"
    />,
  );
}

describe("QuestionnaireResultsDashboard", () => {
  it("uses the UI framework disclosure for result dropdown toggles", async () => {
    const user = userEvent.setup();
    renderDashboard();

    const resultsToggle = screen.getByRole("button", { name: "Results" });
    expect(resultsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(resultsToggle.closest(".simple-auditor-dropdown")?.classList.contains("is-open")).toBe(true);

    await user.click(resultsToggle);

    expect(resultsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(resultsToggle.closest(".simple-auditor-dropdown")?.classList.contains("is-closed")).toBe(true);
  });

  it("filters submitted votes by submission id and submittor identity", async () => {
    const user = userEvent.setup();
    renderDashboard();
    const alphaIdentityWords = deriveIdentityWords(responseDetails[0].response.authorPubkey);

    const search = screen.getByLabelText("Filter submitted votes");
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.getByText("submission_beta")).toBeTruthy();
    expect(screen.getByText(alphaIdentityWords)).toBeTruthy();

    await user.type(search, "submission_alpha");
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.queryByText("submission_beta")).toBeNull();

    await user.clear(search);
    await user.type(search, "bbb-bbb");
    expect(screen.queryByText("submission_alpha")).toBeNull();
    expect(screen.getByText("submission_beta")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "npub1" + "a".repeat(58));
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.queryByText("submission_beta")).toBeNull();

    await user.clear(search);
    await user.type(search, alphaIdentityWords);
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.queryByText("submission_beta")).toBeNull();
  });

  it("uses consistent vote-share labels and puts yes first for tied yes/no results", () => {
    const { container } = render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_result_format",
          title: "Result format",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "What do you think?",
              required: true,
            },
            {
              questionId: "q2",
              type: "multiple_choice",
              prompt: "Choose some",
              required: true,
              multiSelect: false,
              options: [
                { optionId: "a", label: "Option 1" },
                { optionId: "b", label: "Option 2" },
              ],
            },
          ],
        }}
        questionSummaries={[
          {
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 0,
            noCount: 0,
          },
          {
            questionId: "q2",
            answerType: "multiple_choice",
            optionCounts: {
              a: 0,
              b: 0,
            },
          },
        ]}
        responseDetails={[]}
        displayValidCount={0}
        coordinatorText="Organiser test"
        publishedAtLabel="Not published"
      />,
    );

    expect(screen.queryByText("0% · 0 votes")).toBeNull();
    expect(screen.getAllByText("0% (0)")).toHaveLength(4);

    const optionLabels = [...container.querySelectorAll<HTMLSpanElement>(".simple-auditor-option-bar-label > span")];
    const yesLabel = optionLabels.find((label) => label.textContent === "Yes");
    const noLabel = optionLabels.find((label) => label.textContent === "No");
    expect(yesLabel).toBeTruthy();
    expect(noLabel).toBeTruthy();
    expect(Boolean(yesLabel?.compareDocumentPosition(noLabel!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("filters result cards instantly by question and option text", async () => {
    const user = userEvent.setup();
    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_result_filter",
          title: "Result filter",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Prefer tea?",
              required: true,
            },
            {
              questionId: "q2",
              type: "multiple_choice",
              prompt: "Pick fruit",
              required: true,
              multiSelect: false,
              options: [
                { optionId: "apple", label: "Apple" },
                { optionId: "banana", label: "Banana" },
              ],
            },
          ],
        }}
        questionSummaries={[
          {
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 1,
            noCount: 0,
          },
          {
            questionId: "q2",
            answerType: "multiple_choice",
            optionCounts: {
              apple: 0,
              banana: 1,
            },
          },
        ]}
        responseDetails={[]}
        displayValidCount={1}
        coordinatorText="Organiser test"
        publishedAtLabel="Not published"
      />,
    );

    const search = screen.getByLabelText("Filter results");
    expect(screen.getByText("Prefer tea?")).toBeTruthy();
    expect(screen.getByText("Pick fruit")).toBeTruthy();

    await user.type(search, "banana");
    expect(screen.queryByText("Prefer tea?")).toBeNull();
    expect(screen.getByText("Pick fruit")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "tea");
    expect(screen.getByText("Prefer tea?")).toBeTruthy();
    expect(screen.queryByText("Pick fruit")).toBeNull();
  });

  it("shows session live status in the title bar without a separate tile", () => {
    const { container } = render(
      <QuestionnaireResultsDashboard
        variant='session'
        questionnaire={{
          questionnaireId: "q_session_status",
          title: "Session status",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Ready?",
              required: true,
            },
          ],
        }}
        questionSummaries={[
          {
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 2,
            noCount: 0,
          },
        ]}
        responseDetails={[]}
        displayValidCount={2}
        displayInvalidCount={1}
        publishedTotalsAvailable
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.queryByText("Live status")).toBeNull();
    expect(screen.getByLabelText("Live status").textContent).toContain("2/3 accepted (67%)");
    expect(screen.getByText("Q1")).toBeTruthy();
    expect(screen.getByText("Single choice")).toBeTruthy();
    expect(container.querySelector(".simple-session-live-status")).toBeTruthy();
    expect(container.querySelector(".simple-session-live-card")).toBeNull();
  });

  it("shows the published accepted total without a duplicate loaded-response note", () => {
    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_large_round",
          title: "Large round",
          questions: [],
        }}
        questionSummaries={[]}
        responseDetails={responseDetails}
        displayValidCount={1200}
        displayInvalidCount={0}
        loadedValidCount={400}
        loadedInvalidCount={0}
        publishedTotalsAvailable
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.getByLabelText("Questionnaire result summary").textContent).toContain("Responses");
    expect(screen.getByText("1200/1200 accepted (100%)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Loaded: 400 (33%)");
    expect(document.body.textContent).not.toContain("Accepted: 400 (100%)");
  });

  it("stacks live pending votes on top of finalised result bars", () => {
    const { container } = render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_live_layers",
          title: "Live layers",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Ready?",
              required: true,
            },
          ],
        }}
        questionSummaries={[
          {
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 1,
            noCount: 0,
          },
        ]}
        responseDetails={[
          {
            event: { id: "event-final", created_at: 1_774_000_000 },
            accepted: true,
            includedInLatestPublish: true,
            response: {
              responseId: "submission_final",
              authorPubkey: "npub1" + "c".repeat(58),
              submittedAt: 1_774_000_000,
              tokenNullifier: "nullifier-final",
              answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
            },
          },
        ]}
        provisionalResponseDetails={[
          {
            event: { id: "event-live", created_at: 1_774_000_100 },
            accepted: true,
            response: {
              responseId: "submission_live",
              authorPubkey: "npub1" + "d".repeat(58),
              submittedAt: 1_774_000_100,
              answers: [{ questionId: "q1", answerType: "yes_no", value: false }],
            },
          },
        ]}
        displayValidCount={1}
        displayInvalidCount={0}
        loadedValidCount={1}
        loadedInvalidCount={0}
        publishedTotalsAvailable
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.getByText("50% (1) · 1 live")).toBeTruthy();
    expect(container.querySelector(".simple-auditor-results-progress-live")).toBeTruthy();
    const optionLabels = [...container.querySelectorAll<HTMLSpanElement>(".simple-auditor-option-bar-label > span")];
    const yesLabel = optionLabels.find((label) => label.textContent === "Yes");
    const noLabel = optionLabels.find((label) => label.textContent === "No");
    expect(yesLabel).toBeTruthy();
    expect(noLabel).toBeTruthy();
    expect(Boolean(yesLabel?.compareDocumentPosition(noLabel!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("shows submitted public responses as published before a final result summary", () => {
    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_submitted",
          title: "Submitted",
          questions: [{ questionId: "q1", type: "yes_no", prompt: "Ready?", required: true }],
        }}
        questionSummaries={[]}
        responseDetails={[
          {
            event: { id: "event-submitted", created_at: 1_774_000_000 },
            accepted: true,
            response: {
              responseId: "submission_submitted",
              authorPubkey: "npub1" + "f".repeat(58),
              submittedAt: 1_774_000_000,
              tokenNullifier: "nullifier-submitted",
              answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
            },
          },
        ]}
        displayValidCount={1}
        displayInvalidCount={0}
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.getByText("100% (1)")).toBeTruthy();
  });

  it("shows provisional per-question votes before final submissions exist", () => {
    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_provisional_only",
          title: "Provisional only",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Ready?",
              required: true,
            },
          ],
        }}
        questionSummaries={[]}
        responseDetails={[]}
        provisionalResponseDetails={[
          {
            event: { id: "event-provisional", created_at: 1_774_000_000 },
            accepted: true,
            includedInLatestPublish: false,
            response: {
              responseId: "provisional_one",
              authorPubkey: "npub1" + "e".repeat(58),
              submittedAt: 1_774_000_000,
              answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
            },
          },
        ]}
        displayValidCount={0}
        displayInvalidCount={0}
        loadedValidCount={0}
        loadedInvalidCount={0}
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.getAllByText("Ready?").length).toBeGreaterThan(0);
    expect(screen.getByText("100% (1) · 1 live")).toBeTruthy();
  });

  it("replaces provisional votes from the same anonymous author", () => {
    const authorPubkey = "npub1" + "i".repeat(58);
    const { container } = render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_provisional_replace_author",
          title: "Provisional replace",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Ready?",
              required: true,
            },
          ],
        }}
        questionSummaries={[]}
        responseDetails={[]}
        provisionalResponseDetails={[
          {
            event: { id: "event-provisional-old", created_at: 1_774_000_000 },
            accepted: true,
            includedInLatestPublish: false,
            response: {
              responseId: "provisional_old",
              authorPubkey,
              submittedAt: 1_774_000_000,
              answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
            },
          },
          {
            event: { id: "event-provisional-new", created_at: 1_774_000_050 },
            accepted: true,
            includedInLatestPublish: false,
            response: {
              responseId: "provisional_new",
              authorPubkey,
              submittedAt: 1_774_000_050,
              answers: [{ questionId: "q1", answerType: "yes_no", value: false }],
            },
          },
        ]}
        displayValidCount={0}
        displayInvalidCount={0}
        loadedValidCount={0}
        loadedInvalidCount={0}
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(container.textContent).toMatch(/No[\s\S]*100% \(1\) · 1 live/);
    expect(container.textContent).toMatch(/Yes[\s\S]*0% \(0\)/);
    expect(container.textContent).not.toContain("2 live");
  });

  it("does not double count provisional votes once a final submission is loaded", () => {
    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_provisional_replaced",
          title: "Provisional replaced",
          questions: [
            {
              questionId: "q1",
              type: "yes_no",
              prompt: "Ready?",
              required: true,
            },
          ],
        }}
        questionSummaries={[
          {
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 1,
            noCount: 0,
          },
        ]}
        responseDetails={[
          {
            event: { id: "event-final", created_at: 1_774_000_100 },
            accepted: true,
            includedInLatestPublish: true,
            response: {
              responseId: "submission_final",
              authorPubkey: "npub1" + "f".repeat(58),
              submittedAt: 1_774_000_100,
              tokenNullifier: "nullifier-final",
              answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
            },
          },
        ]}
        provisionalResponseDetails={[
          {
            event: { id: "event-provisional", created_at: 1_774_000_000 },
            accepted: true,
            includedInLatestPublish: false,
            response: {
              responseId: "provisional_one",
              authorPubkey: "npub1" + "g".repeat(58),
              submittedAt: 1_774_000_000,
              answers: [{ questionId: "q1", answerType: "yes_no", value: false }],
            },
          },
          {
            event: { id: "event-provisional-two", created_at: 1_774_000_050 },
            accepted: true,
            includedInLatestPublish: false,
            response: {
              responseId: "provisional_two",
              authorPubkey: "npub1" + "h".repeat(58),
              submittedAt: 1_774_000_050,
              answers: [{ questionId: "q1", answerType: "yes_no", value: false }],
            },
          },
        ]}
        displayValidCount={1}
        displayInvalidCount={0}
        loadedValidCount={1}
        loadedInvalidCount={0}
        publishedTotalsAvailable
        coordinatorText="Organiser test"
        publishedAtLabel="Published"
      />,
    );

    expect(screen.getAllByText("Ready?").length).toBeGreaterThan(0);
    expect(screen.getByText("1 response")).toBeTruthy();
    expect(document.body.textContent).not.toContain("live");
    expect(document.body.textContent).not.toContain("2/2 accepted");
  });

  it("shows submitted votes 100 at a time while filtering across every loaded response", async () => {
    const user = userEvent.setup();
    const manyResponses = Array.from({ length: 105 }, (_, index) => makeResponseDetail(104 - index));

    render(
      <QuestionnaireResultsDashboard
        questionnaire={{
          questionnaireId: "q_many_votes",
          title: "Many votes",
          questions: [],
        }}
        questionSummaries={[]}
        responseDetails={manyResponses}
        displayValidCount={manyResponses.length}
        coordinatorText="Organiser test"
        publishedAtLabel="Not published"
      />,
    );

    expect(screen.getByText(/Showing 1-100 of 105/)).toBeTruthy();
    expect(screen.getByText("000-000")).toBeTruthy();
    expect(screen.getByText("099-099")).toBeTruthy();
    expect(screen.queryByText("100-100")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next submitted votes" }));
    expect(screen.getByText(/Showing 101-105 of 105/)).toBeTruthy();
    expect(screen.getByText("100-100")).toBeTruthy();
    expect(screen.queryByText("000-000")).toBeNull();

    const search = screen.getByLabelText("Filter submitted votes");
    await user.type(search, "submission_104");

    expect(screen.getByText(/Showing 1-1 of 1/)).toBeTruthy();
    expect(screen.getByText("104-104")).toBeTruthy();
    expect(screen.getByText("submission_104")).toBeTruthy();
  });
});

function makeResponseDetail(index: number): QuestionnaireResultsDashboardResponseDetail {
  const id = String(index).padStart(3, "0");
  return {
    event: {
      id: `event_${id}`,
      created_at: 1_774_000_000 + index,
    },
    accepted: true,
    response: {
      responseId: `submission_${id}`,
      authorPubkey: `npub1${id}${"x".repeat(52)}${id}`,
      submittedAt: 1_774_000_000 + index,
      tokenNullifier: `nullifier_${id}`,
      answers: [],
    },
  };
}
