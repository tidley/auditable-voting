export type { LocalisedText, SupportedLocale } from "./types";
export { isLocalisedText } from "./types";
export { resolveLocalised, detectLocale, isSupportedLocale, LOCALE_STORAGE_KEY, LOCALE_URL_PARAM } from "./resolveLocale";
export { UI_STRINGS, t, type UiStringKey } from "./uiStrings";
export { LanguageProvider, useLocale, useLocaleSafe, useT, useTSafe } from "./LanguageContext";
export { LanguageSwitcher } from "./LanguageSwitcher";
