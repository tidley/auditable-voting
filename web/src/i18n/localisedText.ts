import { type LocalisedText, type SupportedLocale } from "./types";

/**
 * Helpers for editing `LocalisableText` (string | LocalisedText) values in the
 * coordinator questionnaire builder.  These are deliberately separate from
 * `resolveLocalised` (which falls back to `en`) because the editor must show
 * the *raw* value for each locale so an empty French field stays visibly empty.
 */

/**
 * Normalise a `LocalisableText` (string | LocalisedText) into a `LocalisedText`
 * object.  Plain strings become `{ en: value }`.
 */
export function toLocalisableText(value: LocalisedText | string): LocalisedText {
  if (typeof value === "string") {
    return { en: value };
  }
  return value;
}

/**
 * Return the raw value for a locale WITHOUT falling back to `en`.
 * A plain string is treated as English-only, so `fr`/`ta` return "".
 */
export function localisedFieldValue(
  value: LocalisedText | string,
  locale: SupportedLocale,
): string {
  if (typeof value === "string") {
    return locale === "en" ? value : "";
  }
  return value[locale] ?? "";
}

/**
 * Return a new `LocalisedText` with the given locale set to `nextValue`.
 * Empty optional locales (`fr`/`ta`) are removed to keep the object clean;
 * `en` is always present (even when empty).
 */
export function withLocalisedField(
  value: LocalisedText | string,
  locale: SupportedLocale,
  nextValue: string,
): LocalisedText {
  const base = toLocalisableText(value);
  const next: LocalisedText = { ...base };
  if (locale === "en") {
    next.en = nextValue;
  } else if (nextValue.trim().length > 0) {
    next[locale] = nextValue;
  } else {
    delete next[locale];
  }
  return next;
}

/**
 * Trim every locale value in a `LocalisableText`.  Used when building a
 * definition so trailing whitespace does not leak into the published event.
 *
 * Backward compatible: when only `en` is present (no `fr`/`ta`), the result
 * collapses to a plain string so existing consumers and published events that
 * expect a string keep working unchanged.
 */
export function trimLocalisableText(value: LocalisedText | string): LocalisedText | string {
  const base = toLocalisableText(value);
  const en = base.en.trim();
  const fr = base.fr?.trim();
  const ta = base.ta?.trim();
  if (!fr && !ta) {
    return en;
  }
  const next: LocalisedText = { en };
  if (fr) {
    next.fr = fr;
  }
  if (ta) {
    next.ta = ta;
  }
  return next;
}
