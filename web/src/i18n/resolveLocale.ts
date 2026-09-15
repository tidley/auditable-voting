import { type LocalisedText, type SupportedLocale, isLocalisedText } from "./types";

/**
 * localStorage key for persisting the user's locale choice.
 */
export const LOCALE_STORAGE_KEY = "av-locale";

/**
 * URL query parameter name for locale override.
 */
export const LOCALE_URL_PARAM = "lang";

/**
 * Ordered list of supported locales for iteration.
 */
const LOCALE_PRIORITY: SupportedLocale[] = ["en", "fr", "ta"];

/**
 * Type guard for SupportedLocale.
 */
export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return value === "en" || value === "fr" || value === "ta";
}

/**
 * Resolve a LocalisedText (or plain string) to a single string for the
 * given locale.  Falls back to `en` when the requested locale is absent
 * or empty.  If `en` itself is missing, falls back to the first available
 * locale value.
 *
 * @param text  - LocalisedText object or a plain string
 * @param locale - Requested locale
 * @returns Resolved string, or "" if no values exist
 */
export function resolveLocalised(
  text: LocalisedText | string,
  locale: SupportedLocale,
): string {
  // Plain strings pass through unchanged.
  if (typeof text === "string") {
    return text;
  }

  // Try the requested locale first.
  const requested = text[locale];
  if (requested && requested.length > 0) {
    return requested;
  }

  // Fallback: en (always required by type, but be defensive).
  const en = text.en;
  if (en && en.length > 0) {
    return en;
  }

  // Last resort: first non-empty value in priority order.
  for (const loc of LOCALE_PRIORITY) {
    const val = text[loc];
    if (val && val.length > 0) {
      return val;
    }
  }

  return "";
}

/**
 * Detect the user's preferred locale by checking, in order:
 * 1. localStorage (`av-locale`)
 * 2. URL query parameter (`?lang=fr`)
 * 3. navigator.language
 * 4. Default: "en"
 *
 * Invalid values at any level are silently skipped.
 */
export function detectLocale(): SupportedLocale {
  if (typeof window === "undefined") {
    return "en";
  }

  // 1. localStorage
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable; continue.
  }

  // 2. URL query param
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get(LOCALE_URL_PARAM);
    if (isSupportedLocale(param)) {
      return param;
    }
  } catch {
    // URL parsing unavailable; continue.
  }

  // 3. navigator.language — match by prefix
  try {
    const navLang = navigator.language?.toLowerCase() ?? "";
    if (navLang.startsWith("fr")) {
      return "fr";
    }
    if (navLang.startsWith("ta")) {
      return "ta";
    }
  } catch {
    // navigator unavailable; continue.
  }

  // 4. Default
  return "en";
}