/**
 * Supported locales for the auditable-voting app.
 * EN = English (default/fallback), FR = French, TA = Tamil.
 */
export type SupportedLocale = "en" | "fr" | "ta";

/**
 * A piece of text available in multiple languages.
 * `en` is always required; `fr` and `ta` are optional.
 * Missing locales fall back to `en` via `resolveLocalised`.
 */
export interface LocalisedText {
  en: string;
  fr?: string;
  ta?: string;
}

/**
 * Type guard: is this value a LocalisedText object?
 */
export function isLocalisedText(value: unknown): value is LocalisedText {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LocalisedText).en === "string"
  );
}