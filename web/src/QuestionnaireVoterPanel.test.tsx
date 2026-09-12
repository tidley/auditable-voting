// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE,
} from "./questionnaireProtocolConstants";
import type { QuestionnaireResponsePayload } from "./questionnaireProtocol";

const questionnaireNostrMocks = vi.hoisted(() => ({
  queryQuestionnaireEvents: vi.fn(),
  fetchQuestionnaireEventsWithFallback: vi.fn(),
  subscribeQuestionnaireEventKinds: vi.fn(),
  publishEncryptedQuestionnaireResponse: vi.fn(),
}));

vi.mock("./questionnaireNostr", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireNostr")>("./questionnaireNostr");
  return {
    ...actual,
    queryQuestionnaireEvents: questionnaireNostrMocks.queryQuestionnaireEvents,
    fetchQuestionnaireEventsWithFallback: questionnaireNostrMocks.fetchQuestionnaireEventsWithFallback,
    subscribeQuestionnaireEventKinds: questionnaireNostrMocks.subscribeQuestionnaireEventKinds,
    publishEncryptedQuestionnaireResponse: questionnaireNostrMocks.publishEncryptedQuestionnaireResponse,
  };
});

import QuestionnaireVoterPanel from "./QuestionnaireVoterPanel";

const QUESTIONNAIRE_ID = "conditional-test-q";

function buildDefinition() {
  return {
    schemaVersion: 1 as const,
    eventType: "questionnaire_definition" as const,
    responseMode: "blind_token" as const,
    questionnaireId: QUESTIONNAIRE_ID,
    title: "Conditional test",
    description: "Conditional rendering demo",
    createdAt: 1712530000,
    openAt: 1712533600,
    closeAt: 1712619999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinatorenc",
    responseVisibility: "private" as const,
    eligibilityMode: "open" as const,
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no" as const,
        prompt: "Primary question?",
        required: true,
      },
      {
        questionId: "q2",
        type: "yes_no" as const,
        prompt: "Follow-up question?",
        required: false,
        showIf: {
          dependsOnQuestionId: "q1",
          requiredAnswer: { answerType: "yes_no" as const, value: true },
        },
      },
    ],
  };
}

function buildDefinitionEvent() {
  return {
    id: "def-1",
    kind: IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION,
    pubkey: "npub1coordinator",
    created_at: 1712530000,
    tags: [["q", QUESTIONNAIRE_ID]],
    content: JSON.stringify(buildDefinition()),
    sig: "",
  };
}

function buildStateEvent() {
  return {
    id: "state-1",
    kind: IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE,
    pubkey: "npub1coordinator",
    created_at: 1712534000,
    tags: [["q", QUESTIONNAIRE_ID]],
    content: JSON.stringify({
      eventType: "questionnaire_state",
      schemaVersion: 1,
      questionnaireId: QUESTIONNAIRE_ID,
      state: "open",
      createdAt: 1712534000,
      coordinatorPubkey: "npub1coordinator",
    }),
    sig: "",
  };
}

function questionCard(promptText: string): HTMLElement {
  const heading = screen.getByText(new RegExp(promptText));
  const card = heading.closest("article");
  if (!card) {
    throw new Error(`No article card found for prompt "${promptText}"`);
  }
  return card;
}

beforeEach(() => {
  // Force the legacy (non-Option-A) questionnaire rendering path.
  (globalThis as typeof globalThis & { __AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__?: boolean })
    .__AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__ = true;

  questionnaireNostrMocks.queryQuestionnaireEvents.mockResolvedValue([]);
  questionnaireNostrMocks.subscribeQuestionnaireEventKinds.mockReturnValue(() => undefined);
  questionnaireNostrMocks.fetchQuestionnaireEventsWithFallback.mockImplementation(async (input) => {
    if (input.kind === IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION) {
      return {
        events: [buildDefinitionEvent()],
        diagnostics: { mode: "filtered" as const, filteredCount: 1, kindOnlyCount: 0 },
      };
    }
    if (input.kind === IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE) {
      return {
        events: [buildStateEvent()],
        diagnostics: { mode: "filtered" as const, filteredCount: 1, kindOnlyCount: 0 },
      };
    }
    return {
      events: [],
      diagnostics: { mode: "filtered" as const, filteredCount: 0, kindOnlyCount: 0 },
    };
  });
  questionnaireNostrMocks.publishEncryptedQuestionnaireResponse.mockResolvedValue({
    eventId: "mock-response-event",
    event: { id: "mock-response-event", kind: 6422, created_at: 1712535000, tags: [] },
    relayResults: [{ relay: "wss://relay.nostr.net", success: true }],
    successes: 1,
    failures: 0,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
  delete (globalThis as typeof globalThis & { __AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__?: boolean })
    .__AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__;
});

describe("QuestionnaireVoterPanel conditional rendering", () => {
  it("hides Q2 when Q1 is unanswered", async () => {
    render(<QuestionnaireVoterPanel announcedQuestionnaireIds={[QUESTIONNAIRE_ID]} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary question/)).toBeTruthy();
    });

    expect(screen.queryByText(/Follow-up question/)).toBeNull();
  });

  it("shows Q2 when Q1 is answered Yes", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireVoterPanel announcedQuestionnaireIds={[QUESTIONNAIRE_ID]} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary question/)).toBeTruthy();
    });

    await user.click(within(questionCard("Primary question")).getByRole("button", { name: "Yes" }));

    await waitFor(() => {
      expect(screen.getByText(/Follow-up question/)).toBeTruthy();
    });
  });

  it("hides Q2 when Q1 is answered No", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireVoterPanel announcedQuestionnaireIds={[QUESTIONNAIRE_ID]} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary question/)).toBeTruthy();
    });

    await user.click(within(questionCard("Primary question")).getByRole("button", { name: "No" }));

    expect(screen.queryByText(/Follow-up question/)).toBeNull();
  });

  it("toggles Q2 visibility in real-time as Q1 changes", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireVoterPanel announcedQuestionnaireIds={[QUESTIONNAIRE_ID]} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary question/)).toBeTruthy();
    });

    const q1Card = questionCard("Primary question");
    const yesButton = within(q1Card).getByRole("button", { name: "Yes" });
    const noButton = within(q1Card).getByRole("button", { name: "No" });

    // Yes → Q2 appears
    await user.click(yesButton);
    await waitFor(() => {
      expect(screen.getByText(/Follow-up question/)).toBeTruthy();
    });

    // No → Q2 disappears
    await user.click(noButton);
    await waitFor(() => {
      expect(screen.queryByText(/Follow-up question/)).toBeNull();
    });

    // Yes again → Q2 reappears
    await user.click(yesButton);
    await waitFor(() => {
      expect(screen.getByText(/Follow-up question/)).toBeTruthy();
    });
  });

  it("excludes a hidden question's answer from the submission payload", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireVoterPanel announcedQuestionnaireIds={[QUESTIONNAIRE_ID]} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary question/)).toBeTruthy();
    });

    const q1Card = questionCard("Primary question");

    // Answer Q1 = Yes so Q2 becomes visible, then answer Q2.
    await user.click(within(q1Card).getByRole("button", { name: "Yes" }));
    await waitFor(() => {
      expect(screen.getByText(/Follow-up question/)).toBeTruthy();
    });
    await user.click(within(questionCard("Follow-up question")).getByRole("button", { name: "Yes" }));

    // Toggle Q1 back to No so Q2 is hidden again (its answer remains in local state).
    await user.click(within(q1Card).getByRole("button", { name: "No" }));
    await waitFor(() => {
      expect(screen.queryByText(/Follow-up question/)).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "Submit response" }));

    await waitFor(() => {
      expect(questionnaireNostrMocks.publishEncryptedQuestionnaireResponse).toHaveBeenCalled();
    });

    const publishedPayload = questionnaireNostrMocks.publishEncryptedQuestionnaireResponse.mock.calls[0][0]
      .payload as QuestionnaireResponsePayload;
    const answerQuestionIds = publishedPayload.answers.map((answer) => answer.questionId);

    expect(answerQuestionIds).toContain("q1");
    expect(answerQuestionIds).not.toContain("q2");
  });
});
