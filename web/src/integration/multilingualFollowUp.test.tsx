// @vitest-environment jsdom
/**
 * Cross-feature integration: F1 multi-language × F2 follow-up/conditional questions.
 *
 * These tests deliberately exercise the *seams* between the two features rather
 * than either one alone:
 *
 *   - a questionnaire whose prompts, options and title are `LocalisableText`
 *     (F1) and whose later questions are gated behind `showIf` conditions (F2);
 *   - the condition evaluator and the visible-answer builder reading answers
 *     that were produced from a French-language rendering;
 *   - the deterministic definition hash staying stable when an English-only
 *     definition is upgraded to the multilingual shape (so i18n does not change
 *     a published questionnaire's identity);
 *   - a paper ballot (F3) printed in French from the same multilingual +
 *     conditional definition, because the ballot is the paper half of the same
 *     election;
 *   - the shared answer controls rendering French prompts and revealing the
 *     conditional question only once its dependency is answered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  QuestionnaireAnswerFieldsProps,
} from "../QuestionnaireAnswerFields";
import QuestionnaireAnswerFields, {
  buildVisibleResponseAnswers,
  visibleQuestions,
  type QuestionnaireAnswerState,
} from "../QuestionnaireAnswerFields";
import { shouldShowQuestion } from "../questionConditionEvaluator";
import { LanguageProvider } from "../i18n/LanguageContext";
import { resolveLocalised } from "../i18n/resolveLocale";
import {
  canonicaliseQuestionnaireDefinitionText,
  type QuestionnaireDefinition,
} from "../questionnaireProtocol";
import { questionnaireDefinitionHash } from "../questionnaireDefinitionReference";
import { generatePaperBallot } from "../paperBallot";
import { generateVoterKeypair } from "../paperBallotBatch";

const QUESTIONNAIRE_ID = "q_multilingual_followup";

/**
 * A French-first questionnaire: every visible string carries en/fr/ta, and the
 * follow-up questions are conditional on the answers to earlier ones.
 *
 *   q1 (yes_no)          - always shown
 *   q2 (multiple_choice) - shown only when q1 === true
 *   q3 (free_text)       - shown only when q2 selected "yes_opt"
 */
function buildDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: "blind_token",
    questionnaireId: QUESTIONNAIRE_ID,
    title: {
      en: "Residents' assembly",
      fr: "Assemblée des résidents",
      ta: "குடியிருப்பாளர் கூட்டம்",
    },
    description: {
      en: "Annual budget vote",
      fr: "Vote annuel sur le budget",
    },
    createdAt: 1_725_000_000,
    openAt: 1_725_000_000,
    closeAt: 1_725_086_400,
    coordinatorPubkey: "npub1organiser",
    coordinatorEncryptionPubkey: "npub1organiser",
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: {
          en: "Approve the budget?",
          fr: "Approuvez-vous le budget ?",
          ta: "நிதிநிலையை ஏற்கிறீர்களா?",
        },
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        multiSelect: false,
        prompt: {
          en: "Which budget line concerns you?",
          fr: "Quelle ligne budgétaire vous concerne ?",
          ta: "எந்த நிதிவரி உங்களைப் பாதிக்கிறது?",
        },
        required: true,
        showIf: {
          dependsOnQuestionId: "q1",
          requiredAnswer: { answerType: "yes_no", value: true },
        },
        options: [
          {
            optionId: "yes_opt",
            label: { en: "Repairs", fr: "Réparations", ta: "பழுதுபார்ப்பு" },
          },
          {
            optionId: "no_opt",
            label: { en: "Insurance", fr: "Assurance", ta: "காப்பீடு" },
          },
        ],
      },
      {
        questionId: "q3",
        type: "free_text",
        prompt: {
          en: "Tell us more about the repairs",
          fr: "Dites-nous en plus sur les réparations",
          ta: "பழுதுபார்ப்பு பற்றி மேலும் கூறுங்கள்",
        },
        required: true,
        maxLength: 400,
        showIf: {
          dependsOnQuestionId: "q2",
          requiredAnswer: {
            answerType: "multiple_choice",
            selectedOptionIds: ["yes_opt"],
          },
        },
      },
    ],
  };
}

/** The same definition with every text field as a plain English string. */
function buildEnglishOnlyDefinition(): QuestionnaireDefinition {
  const localised = buildDefinition();
  return {
    ...localised,
    title: "Residents' assembly",
    description: "Annual budget vote",
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Approve the budget?",
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        multiSelect: false,
        prompt: "Which budget line concerns you?",
        required: true,
        showIf: {
          dependsOnQuestionId: "q1",
          requiredAnswer: { answerType: "yes_no", value: true },
        },
        options: [
          { optionId: "yes_opt", label: "Repairs" },
          { optionId: "no_opt", label: "Insurance" },
        ],
      },
      {
        questionId: "q3",
        type: "free_text",
        prompt: "Tell us more about the repairs",
        required: true,
        maxLength: 400,
        showIf: {
          dependsOnQuestionId: "q2",
          requiredAnswer: {
            answerType: "multiple_choice",
            selectedOptionIds: ["yes_opt"],
          },
        },
      },
    ],
  };
}

/** A driver that holds the local answer state exactly like the voter panels do. */
function AnswerHarness({
  definition,
  locale,
}: {
  definition: QuestionnaireDefinition;
  locale: "en" | "fr" | "ta";
}) {
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const props: QuestionnaireAnswerFieldsProps = {
    definition,
    answerState,
    locale,
    onYesNoAnswer: (questionId, value) =>
      setAnswerState((current) => ({ ...current, [questionId]: value })),
    onMultipleChoiceAnswer: (questionId, optionId) =>
      setAnswerState((current) => ({ ...current, [questionId]: [optionId] })),
    onAddRankedAnswer: () => undefined,
    onRemoveRankedAnswer: () => undefined,
    onMoveRankedAnswer: () => undefined,
    onFreeTextAnswer: (questionId, value) =>
      setAnswerState((current) => ({ ...current, [questionId]: value })),
  };
  return <QuestionnaireAnswerFields {...props} />;
}

afterEach(() => {
  cleanup();
});

describe("multilingual definition resolves for each locale (F1)", () => {
  const definition = buildDefinition();

  it("resolves French and Tamil text for the title and prompts", () => {
    expect(resolveLocalised(definition.title, "fr")).toBe("Assemblée des résidents");
    expect(resolveLocalised(definition.title, "ta")).toBe("குடியிருப்பாளர் கூட்டம்");
    expect(resolveLocalised(definition.questions[1].prompt, "fr")).toBe(
      "Quelle ligne budgétaire vous concerne ?",
    );
    expect(resolveLocalised(definition.questions[0].prompt, "ta")).toBe(
      "நிதிநிலையை ஏற்கிறீர்களா?",
    );
  });

  it("resolves localised option labels and English fallback", () => {
    const options = definition.questions[1].type === "multiple_choice"
      ? definition.questions[1].options
      : [];

    expect(resolveLocalised(options[0].label, "fr")).toBe("Réparations");
    expect(resolveLocalised(options[1].label, "ta")).toBe("காப்பீடு");
    // No Tamil translation on the description → English fallback.
    expect(resolveLocalised(definition.description ?? "", "ta")).toBe("Annual budget vote");
  });
});

describe("multilingual definitions keep their protocol identity (F1)", () => {
  it("canonicalises plain strings to the multilingual shape without adding locales", () => {
    const canonical = canonicaliseQuestionnaireDefinitionText(buildEnglishOnlyDefinition());

    expect(canonical.title).toEqual({ en: "Residents' assembly" });
    expect(canonical.questions[0].prompt).toEqual({ en: "Approve the budget?" });
  });

  it("hashes a plain-string definition the same as its {\"en\"} equivalent", () => {
    // Upgrading every text field to LocalisedText must not change the
    // definition hash, or every published questionnaire would look "new".
    expect(questionnaireDefinitionHash(buildEnglishOnlyDefinition())).toBe(
      questionnaireDefinitionHash(canonicaliseQuestionnaireDefinitionText(buildEnglishOnlyDefinition())),
    );
  });

  it("keeps every locale and the showIf rule through a definition round trip", () => {
    const canonical = canonicaliseQuestionnaireDefinitionText(buildDefinition());

    expect(canonical).toEqual(buildDefinition());
    expect((canonical.questions[1] as { showIf?: unknown }).showIf).toEqual({
      dependsOnQuestionId: "q1",
      requiredAnswer: { answerType: "yes_no", value: true },
    });
  });
});

describe("conditional visibility evaluated against localised questions (F1 × F2)", () => {
  const definition = buildDefinition();

  it("hides the follow-up until its dependency is answered", () => {
    expect(shouldShowQuestion(definition.questions[1], new Map())).toBe(false);
    expect(shouldShowQuestion(definition.questions[2], new Map())).toBe(false);
  });

  it("shows the follow-up only for the required answer", () => {
    const answeredNo = new Map([
      ["q1", { questionId: "q1", answerType: "yes_no" as const, value: false }],
    ]);
    const answeredYes = new Map([
      ["q1", { questionId: "q1", answerType: "yes_no" as const, value: true }],
    ]);

    expect(shouldShowQuestion(definition.questions[1], answeredNo)).toBe(false);
    expect(shouldShowQuestion(definition.questions[1], answeredYes)).toBe(true);
  });

  it("chains a second conditional level on a multiple-choice answer", () => {
    const answered = new Map([
      ["q1", { questionId: "q1", answerType: "yes_no" as const, value: true }],
      [
        "q2",
        {
          questionId: "q2",
          answerType: "multiple_choice" as const,
          selectedOptionIds: ["yes_opt"],
        },
      ],
    ]);

    expect(shouldShowQuestion(definition.questions[2], answered)).toBe(true);
  });

  it("excludes a question hidden by its own showIf rule even when answered", () => {
    // The voter answered q2, then changed q1 back to No.  Each question's
    // visibility is decided by its OWN showIf rule (F2 design — no transitive
    // cascading): q2's condition now fails so it is dropped from the payload
    // even though it was answered, while q3's condition (on q2's answer) still
    // holds so q3 stays visible.
    const answerState: QuestionnaireAnswerState = {
      q1: false,
      q2: ["yes_opt"],
      q3: "Entré puis caché",
    };

    const visibleIds = visibleQuestions(definition, answerState).map((question) => question.questionId);
    expect(visibleIds).toEqual(["q1", "q3"]);

    const answers = buildVisibleResponseAnswers(definition, answerState);
    expect(answers).toEqual([
      { questionId: "q1", answerType: "yes_no", value: false },
      { questionId: "q3", answerType: "free_text", text: "Entré puis caché" },
    ]);
  });

  it("includes the conditional chain once it is visible", () => {
    const answerState: QuestionnaireAnswerState = {
      q1: true,
      q2: ["yes_opt"],
      q3: "Les ascenseurs",
    };

    const answers = buildVisibleResponseAnswers(definition, answerState);
    expect(answers).toEqual([
      { questionId: "q1", answerType: "yes_no", value: true },
      { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["yes_opt"] },
      { questionId: "q3", answerType: "free_text", text: "Les ascenseurs" },
    ]);
  });
});

describe("paper ballot printed from a multilingual + conditional definition (F1 × F2 × F3)", () => {
  it("resolves French text for every printed question", () => {
    const { nsec } = generateVoterKeypair();
    const ballot = generatePaperBallot({
      definition: buildDefinition(),
      voterNsec: nsec,
      locale: "fr",
    });

    expect(ballot.questionnaireTitle).toBe("Assemblée des résidents");
    expect(ballot.questions.map((question) => question.prompt)).toEqual([
      "Approuvez-vous le budget ?",
      "Quelle ligne budgétaire vous concerne ?",
      "Dites-nous en plus sur les réparations",
    ]);
    expect(ballot.questions[1].options?.map((option) => option.label)).toEqual([
      "Réparations",
      "Assurance",
    ]);
  });

  it("prints every question, including the conditional ones, so the paper form is complete", () => {
    const { nsec } = generateVoterKeypair();
    const ballot = generatePaperBallot({
      definition: buildDefinition(),
      voterNsec: nsec,
      locale: "en",
    });

    // A paper form cannot hide questions behind runtime conditions: every
    // question is listed and the voter is told which ones apply.
    expect(ballot.questions).toHaveLength(3);
  });
});

describe("answer controls render French prompts with conditional gating (F1 × F2)", () => {
  it("renders French prompts, keeps the follow-up hidden, then reveals it", () => {
    render(
      <LanguageProvider initialLocale='fr'>
        <AnswerHarness definition={buildDefinition()} locale='fr' />
      </LanguageProvider>,
    );

    // Q1 is always visible, in French.
    expect(screen.getByText(/Approuvez-vous le budget \?/)).toBeTruthy();
    // The English source text must not leak through.
    expect(screen.queryByText(/Approve the budget\?/)).toBeNull();
    // Q2/Q3 start hidden.
    expect(screen.queryByText(/Quelle ligne budgétaire/)).toBeNull();
    expect(screen.queryByText(/Dites-nous en plus/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Yes$/ }));

    // Q2 appears in French once its dependency is satisfied.
    expect(screen.getByText(/Quelle ligne budgétaire/)).toBeTruthy();
    expect(screen.getByLabelText(/Réparations/)).toBeTruthy();
    expect(screen.queryByText(/Dites-nous en plus/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/Réparations/));

    // Q3 appears in French once the second-level condition is met.
    expect(screen.getByText(/Dites-nous en plus sur les réparations/)).toBeTruthy();
  });

  it("switching the locale re-renders the same conditional flow in English", () => {
    const { rerender } = render(
      <LanguageProvider initialLocale='fr'>
        <AnswerHarness definition={buildDefinition()} locale='fr' />
      </LanguageProvider>,
    );

    expect(screen.getByText(/Approuvez-vous le budget \?/)).toBeTruthy();

    rerender(
      <LanguageProvider initialLocale='en'>
        <AnswerHarness definition={buildDefinition()} locale='en' />
      </LanguageProvider>,
    );

    expect(screen.getByText(/Approve the budget\?/)).toBeTruthy();
    expect(screen.queryByText(/Approuvez-vous le budget \?/)).toBeNull();
  });
});
