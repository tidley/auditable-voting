// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLocalised,
  detectLocale,
  type LocalisedText,
  type SupportedLocale,
} from "./index";

// ─── resolveLocalised ────────────────────────────────────────────────

describe("resolveLocalised", () => {
  it("returns the requested locale when present", () => {
    const text: LocalisedText = { en: "Hello", fr: "Bonjour", ta: "வணக்கம்" };
    expect(resolveLocalised(text, "fr")).toBe("Bonjour");
    expect(resolveLocalised(text, "ta")).toBe("வணக்கம்");
  });

  it("falls back to en when the requested locale is missing", () => {
    const text: LocalisedText = { en: "Hello" };
    expect(resolveLocalised(text, "fr")).toBe("Hello");
    expect(resolveLocalised(text, "ta")).toBe("Hello");
  });

  it("falls back to en when fr is present but ta is missing", () => {
    const text: LocalisedText = { en: "Hello", fr: "Bonjour" };
    expect(resolveLocalised(text, "ta")).toBe("Hello");
  });

  it("falls back to en when the requested locale value is empty string", () => {
    const text: LocalisedText = { en: "Hello", fr: "" };
    expect(resolveLocalised(text, "fr")).toBe("Hello");
  });

  it("accepts a plain string and returns it unchanged", () => {
    expect(resolveLocalised("Hello", "en")).toBe("Hello");
    expect(resolveLocalised("Hello", "fr")).toBe("Hello");
  });

  it("falls back to first available locale if en is somehow missing", () => {
    const text = { fr: "Bonjour" } as unknown as LocalisedText;
    // Should not return undefined; picks fr since en is absent
    const result = resolveLocalised(text, "en");
    expect(result).toBe("Bonjour");
  });

  it("returns a placeholder for a completely empty LocalisedText", () => {
    const text = {} as unknown as LocalisedText;
    const result = resolveLocalised(text, "en");
    expect(result).toBe("");
  });
});

// ─── detectLocale ────────────────────────────────────────────────────

describe("detectLocale", () => {
  const originalNavLanguage = navigator.language;
  const originalLocationHref = window.location.href;

  function setNavLanguage(lang: string): void {
    Object.defineProperty(navigator, "language", {
      value: lang,
      configurable: true,
    });
  }

  function setUrl(search: string): void {
    Object.defineProperty(window, "location", {
      value: new URL(`https://example.com/${search}`),
      configurable: true,
      writable: true,
    });
  }

  function clearStorage(): void {
    window.localStorage.clear();
  }

  afterEach(() => {
    // Restore
    Object.defineProperty(navigator, "language", {
      value: originalNavLanguage,
      configurable: true,
    });
    Object.defineProperty(window, "location", {
      value: new URL(originalLocationHref),
      configurable: true,
      writable: true,
    });
    clearStorage();
  });

  it("returns locale from localStorage when present", () => {
    setNavLanguage("en-US");
    setUrl("");
    window.localStorage.setItem("av-locale", "fr");
    expect(detectLocale()).toBe("fr");
  });

  it("returns locale from URL query param ?lang=ta", () => {
    setNavLanguage("en-US");
    clearStorage();
    setUrl("?lang=ta");
    expect(detectLocale()).toBe("ta");
  });

  it("returns locale from URL query param ?lang=fr", () => {
    setNavLanguage("en-US");
    clearStorage();
    setUrl("?lang=fr");
    expect(detectLocale()).toBe("fr");
  });

  it("falls back to nav.language for fr", () => {
    clearStorage();
    setUrl("");
    setNavLanguage("fr-FR");
    expect(detectLocale()).toBe("fr");
  });

  it("falls back to nav.language for ta", () => {
    clearStorage();
    setUrl("");
    setNavLanguage("ta-IN");
    expect(detectLocale()).toBe("ta");
  });

  it("defaults to en for unknown nav.language", () => {
    clearStorage();
    setUrl("");
    setNavLanguage("de-DE");
    expect(detectLocale()).toBe("en");
  });

  it("defaults to en when nothing is available", () => {
    clearStorage();
    setUrl("");
    setNavLanguage("en-US");
    expect(detectLocale()).toBe("en");
  });

  it("ignores invalid localStorage value", () => {
    setNavLanguage("en-US");
    setUrl("");
    window.localStorage.setItem("av-locale", "de");
    expect(detectLocale()).toBe("en");
  });

  it("ignores invalid URL query param", () => {
    setNavLanguage("en-US");
    clearStorage();
    setUrl("?lang=de");
    expect(detectLocale()).toBe("en");
  });

  it("localStorage takes priority over URL param", () => {
    setNavLanguage("en-US");
    window.localStorage.setItem("av-locale", "ta");
    setUrl("?lang=fr");
    expect(detectLocale()).toBe("ta");
  });
});

// ─── type re-exports ────────────────────────────────────────────────

describe("type exports", () => {
  it("SupportedLocale should be one of en|fr|ta", () => {
    const locales: SupportedLocale[] = ["en", "fr", "ta"];
    expect(locales).toHaveLength(3);
  });
});