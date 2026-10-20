import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { questionnaireDefinitionEventHash, questionnaireDefinitionHash } from "./questionnaireDefinitionReference";
import { canonicaliseQuestionnaireDefinitionText, type QuestionnaireDefinition } from "./questionnaireProtocol";
import { resolveLocalised, translatedText } from "./i18n/resolveLocale";

// The global WASM test stub is not SHA-256; use the platform implementation.
vi.mock("./wasm/auditableVotingCore", async (importOriginal) => ({
  ...await importOriginal<typeof import("./wasm/auditableVotingCore")>(),
  sha256HexRust: (text: string) => createHash("sha256").update(text).digest("hex"),
}));

// Already in sorted-key order; shared verbatim with the worker parity test.
const legacy = '{"description":"","questions":[{"options":[{"label":"One"}],"prompt":"Proceed?"}],"title":"Legacy"}';
const translated = '{"description":"","questions":[{"options":[{"label":"One"}],"prompt":"Proceed?"}],"title":"Legacy","translations":{"title":{"en":"Legacy","fr":"Ancien","ta":"பழைய"}}}';

describe("definition wire compatibility", () => {
  it("retains inline editor translations when restoring a draft", () => {
    const text = { en: "English", fr: "Français", ta: "தமிழ்" };
    expect(translatedText(text, undefined)).toEqual(text);
  });

  it("uses the English base for malformed optional wire translations", () => {
    expect(resolveLocalised(translatedText("English", { en: "Wrong base", fr: { length: 1 }, ta: ["bad"] }), "fr")).toBe("English");
  });

  it.each([legacy, translated])("hashes the supplied JSON without rewriting text: %s", (raw) => {
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(questionnaireDefinitionEventHash(raw)).toBe(expected);
    expect(questionnaireDefinitionHash(JSON.parse(raw) as QuestionnaireDefinition)).toBe(expected);
  });

  it("publishes English base strings with separate signed translations", () => {
    const draft = { title: { en: "Vote", fr: "Voter" }, questions: [
      { prompt: { en: "Proceed?", ta: "தொடரவா?" }, options: [{ label: { en: "One", fr: "Un" } }] },
    ] };
    expect(canonicaliseQuestionnaireDefinitionText(draft)).toEqual({
      title: "Vote", translations: { title: { en: "Vote", fr: "Voter" } },
      questions: [{ prompt: "Proceed?", translations: { prompt: { en: "Proceed?", ta: "தொடரவா?" } },
        options: [{ label: "One", translations: { label: { en: "One", fr: "Un" } } }] }],
    });
  });

  it.each([null, [], 42, { en: "English", fr: { length: 1 } }, { en: "English", fr: ["bad"] }])(
    "never returns an object for malformed optional locale data: %j", (value) => {
      expect(resolveLocalised(value as never, "fr")).toBe(value && !Array.isArray(value) && typeof value === "object" ? "English" : "");
    },
  );
});
