// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { UI_STRINGS, t, type UiStringKey } from "./uiStrings";
import { type SupportedLocale } from "./types";

const ALL_LOCALES: SupportedLocale[] = ["en", "fr", "ta"];

describe("UI_STRINGS", () => {
  it("is a non-empty record", () => {
    expect(Object.keys(UI_STRINGS).length).toBeGreaterThan(0);
  });

  it("every key has a non-empty `en` value", () => {
    for (const [key, entry] of Object.entries(UI_STRINGS)) {
      expect(entry.en, `key "${key}" is missing an English value`).toBeTruthy();
      expect(entry.en.trim().length, `key "${key}" has an empty English value`).toBeGreaterThan(0);
    }
  });

  it("every key has a non-empty `fr` value", () => {
    for (const [key, entry] of Object.entries(UI_STRINGS)) {
      expect(entry.fr, `key "${key}" is missing a French value`).toBeTruthy();
      expect(entry.fr!.trim().length, `key "${key}" has an empty French value`).toBeGreaterThan(0);
    }
  });

  it("every key has a non-empty `ta` value", () => {
    for (const [key, entry] of Object.entries(UI_STRINGS)) {
      expect(entry.ta, `key "${key}" is missing a Tamil value`).toBeTruthy();
      expect(entry.ta!.trim().length, `key "${key}" has an empty Tamil value`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate keys (object literal guarantees uniqueness)", () => {
    const keys = Object.keys(UI_STRINGS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the required categories", () => {
    const keys = Object.keys(UI_STRINGS);
    // Role labels
    expect(keys).toContain("roleVoter");
    expect(keys).toContain("roleOrganiser");
    expect(keys).toContain("roleObserver");
    // Tab labels
    expect(keys).toContain("tabFindOrganiser");
    expect(keys).toContain("tabVote");
    expect(keys).toContain("tabMessages");
    expect(keys).toContain("tabSettings");
    // Action buttons
    expect(keys).toContain("actionSubmit");
    expect(keys).toContain("actionCancel");
    expect(keys).toContain("actionPublish");
    // Question types
    expect(keys).toContain("questionTypeYesNo");
    expect(keys).toContain("questionTypeMultipleChoice");
    expect(keys).toContain("questionTypeRank");
    expect(keys).toContain("questionTypeFreeText");
    // Status messages
    expect(keys).toContain("statusComplete");
    expect(keys).toContain("statusPending");
    expect(keys).toContain("statusOptional");
  });
});

describe("t()", () => {
  it("resolves a key for each locale", () => {
    expect(t("roleVoter", "en")).toBe("Voter");
    expect(t("roleVoter", "fr")).toBe("Électeur");
    expect(t("roleVoter", "ta")).toBe("வாக்காளர்");
  });

  it("returns the key itself for an unknown key (graceful degradation)", () => {
    const unknown = "doesNotExist" as UiStringKey;
    expect(t(unknown, "en")).toBe("doesNotExist");
  });

  it("resolves every key for every locale without throwing", () => {
    for (const key of Object.keys(UI_STRINGS) as UiStringKey[]) {
      for (const locale of ALL_LOCALES) {
        const result = t(key, locale);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }
    }
  });
});
