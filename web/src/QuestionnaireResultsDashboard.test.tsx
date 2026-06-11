// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import QuestionnaireResultsDashboard, {
  type QuestionnaireResultsDashboardResponseDetail,
} from "./QuestionnaireResultsDashboard";

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
  it("filters submitted votes by submission id and submittor identity", async () => {
    const user = userEvent.setup();
    renderDashboard();

    const search = screen.getByLabelText("Filter submitted votes");
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.getByText("submission_beta")).toBeTruthy();

    await user.type(search, "submission_alpha");
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.queryByText("submission_beta")).toBeNull();

    await user.clear(search);
    await user.type(search, "bbbbbbb");
    expect(screen.queryByText("submission_alpha")).toBeNull();
    expect(screen.getByText("submission_beta")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "npub1" + "a".repeat(58));
    expect(screen.getByText("submission_alpha")).toBeTruthy();
    expect(screen.queryByText("submission_beta")).toBeNull();
  });

  it("uses consistent vote-share labels and puts yes first for tied yes/no results", () => {
    render(
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
    expect(screen.getAllByText("0% | 0 votes")).toHaveLength(4);

    const yesLabel = screen.getByText("Yes");
    const noLabel = screen.getByText("No");
    expect(Boolean(yesLabel.compareDocumentPosition(noLabel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });
});
