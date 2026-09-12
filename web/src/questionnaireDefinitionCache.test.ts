// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  readCachedQuestionnaireDefinition,
  storeCachedQuestionnaireDefinition,
} from "./questionnaireDefinitionCache";
import { buildNamespacedLocalStorageKey } from "./appStorageNamespace";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";

function makeDefinition(overrides: Partial<QuestionnaireDefinition> = {}): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: "q_cache_2026",
    title: "Term 1 feedback",
    description: "Tell us how term 1 went.",
    createdAt: 1712530000,
    openAt: 1712531000,
    closeAt: 1712539999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinator",
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Did you attend?",
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        multiSelect: false,
        prompt: "Which session?",
        required: false,
        options: [
          { optionId: "o1", label: "Morning" },
          { optionId: "o2", label: "Afternoon" },
        ],
      },
    ],
    ...overrides,
  };
}

function cachedDefinitionsForTests(): Record<string, QuestionnaireDefinition> {
  const raw = window.localStorage.getItem(
    buildNamespacedLocalStorageKey("questionnaire:definitions:v1"),
  );
  return raw ? (JSON.parse(raw) as Record<string, QuestionnaireDefinition>) : {};
}

describe("questionnaireDefinitionCache multilingual canonicalisation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores a definition built with plain strings as English-only localised text", () => {
    storeCachedQuestionnaireDefinition(makeDefinition());

    const stored = cachedDefinitionsForTests().q_cache_2026;
    expect(stored.title).toEqual({ en: "Term 1 feedback" });
    expect(stored.description).toEqual({ en: "Tell us how term 1 went." });
    expect(stored.questions[0].prompt).toEqual({ en: "Did you attend?" });
    expect((stored.questions[1] as { options: { label: unknown }[] }).options.map((option) => option.label))
      .toEqual([{ en: "Morning" }, { en: "Afternoon" }]);
  });

  it("reads a cache entry written by a pre-multi-language build as English-only localised text", () => {
    window.localStorage.setItem(
      buildNamespacedLocalStorageKey("questionnaire:definitions:v1"),
      JSON.stringify({ q_cache_2026: makeDefinition() }),
    );

    const cached = readCachedQuestionnaireDefinition("q_cache_2026");

    expect(cached).not.toBeNull();
    expect(cached?.title).toEqual({ en: "Term 1 feedback" });
    expect(cached?.description).toEqual({ en: "Tell us how term 1 went." });
    expect(cached?.questions[0].prompt).toEqual({ en: "Did you attend?" });
    expect((cached?.questions[1] as { options: { label: unknown }[] }).options[0].label)
      .toEqual({ en: "Morning" });
  });

  it("round-trips a localised definition through the cache preserving every language", () => {
    const definition = makeDefinition({
      title: { en: "Term 1 feedback", fr: "Retour du trimestre 1", ta: "முதல் தவணை கருத்து" },
      description: {
        en: "Tell us how term 1 went.",
        fr: "Dites-nous comment s'est passé le trimestre 1.",
        ta: "முதல் தவணை எப்படி இருந்தது எனக் கூறுங்கள்.",
      },
      questions: [
        {
          questionId: "q1",
          type: "yes_no",
          prompt: { en: "Did you attend?", fr: "Avez-vous participé ?", ta: "நீங்கள் கலந்து கொண்டீர்களா?" },
          required: true,
        },
        {
          questionId: "q2",
          type: "multiple_choice",
          multiSelect: false,
          prompt: { en: "Which session?", fr: "Quelle session ?", ta: "எந்த அமர்வு?" },
          required: false,
          options: [
            { optionId: "o1", label: { en: "Morning", fr: "Matin", ta: "காலை" } },
            { optionId: "o2", label: { en: "Afternoon", fr: "Après-midi", ta: "பிற்பகல்" } },
          ],
        },
      ],
    });

    storeCachedQuestionnaireDefinition(definition);
    const cached = readCachedQuestionnaireDefinition(definition.questionnaireId);

    expect(cached?.title).toEqual(definition.title);
    expect(cached?.description).toEqual(definition.description);
    expect(cached?.questions[0].prompt).toEqual(definition.questions[0].prompt);
    expect(cached?.questions[1].prompt).toEqual(definition.questions[1].prompt);
    expect((cached?.questions[1] as { options: { label: unknown }[] }).options.map((option) => option.label))
      .toEqual([
        { en: "Morning", fr: "Matin", ta: "காலை" },
        { en: "Afternoon", fr: "Après-midi", ta: "பிற்பகல்" },
      ]);
  });

  it("keeps a newer cached definition when an older one is stored again", () => {
    storeCachedQuestionnaireDefinition(makeDefinition({ createdAt: 1712530000 }));
    storeCachedQuestionnaireDefinition(makeDefinition({
      createdAt: 1712500000,
      title: { en: "Older title", fr: "Titre plus ancien" },
    }));

    const cached = readCachedQuestionnaireDefinition("q_cache_2026");
    expect(cached?.createdAt).toBe(1712530000);
    expect(cached?.title).toEqual({ en: "Term 1 feedback" });
  });
});
