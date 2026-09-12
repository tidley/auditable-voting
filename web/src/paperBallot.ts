import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { resolveLocalised, type SupportedLocale } from "./i18n";

export type PaperBallotOption = {
  optionId: string;
  label: string;
};

export type PaperBallotQuestion = {
  questionId: string;
  prompt: string;
  type: string;
  required: boolean;
  options?: PaperBallotOption[];
};

export interface PaperBallot {
  questionnaireId: string;
  questionnaireTitle: string;
  questions: PaperBallotQuestion[];
  voterNsec: string;
  voterNpub: string;
  inviteCode?: string;
  generatedAt: number;
}

/**
 * A paper ballot is printed for one reader, so protocol text is frozen to a
 * single string here.  F1 made `prompt`/`label`/`title` localisable
 * (`LocalisableText`), so they are resolved through `resolveLocalised` for the
 * ballot's locale instead of assuming plain strings; plain strings still pass
 * straight through unchanged, which keeps pre-i18n ballots working.
 */
function formatQuestion(
  question: QuestionnaireDefinition["questions"][number],
  locale: SupportedLocale,
): PaperBallotQuestion {
  const base = {
    questionId: question.questionId,
    prompt: resolveLocalised(question.prompt, locale),
    type: question.type,
    required: question.required,
  };

  if (question.type === "multiple_choice" || question.type === "rank") {
    return {
      ...base,
      options: question.options.map((opt) => ({
        optionId: opt.optionId,
        label: resolveLocalised(opt.label, locale),
      })),
    };
  }

  return base;
}

export function generatePaperBallot(input: {
  definition: QuestionnaireDefinition;
  voterNsec: string;
  inviteCode?: string;
  /** Locale the ballot is printed in. Defaults to English. */
  locale?: SupportedLocale;
}): PaperBallot {
  const voterNpub = deriveNpubFromNsec(input.voterNsec);

  if (!voterNpub) {
    throw new Error("Invalid voter nsec: could not derive npub");
  }

  const locale = input.locale ?? "en";

  return {
    questionnaireId: input.definition.questionnaireId,
    questionnaireTitle: resolveLocalised(input.definition.title, locale),
    questions: input.definition.questions.map((question) => formatQuestion(question, locale)),
    voterNsec: input.voterNsec,
    voterNpub,
    inviteCode: input.inviteCode,
    generatedAt: Date.now(),
  };
}
