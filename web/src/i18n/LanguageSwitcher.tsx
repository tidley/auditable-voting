import { UiSelect } from "../ui/DesignLayer";
import { useLocale } from "./LanguageContext";
import { type SupportedLocale } from "./types";
import { t } from "./uiStrings";

/**
 * Locale options for the dropdown.
 */
const LOCALE_OPTIONS: Array<{ value: SupportedLocale; labelKey: "languageEnglish" | "languageFrench" | "languageTamil" }> = [
  { value: "en", labelKey: "languageEnglish" },
  { value: "fr", labelKey: "languageFrench" },
  { value: "ta", labelKey: "languageTamil" },
];

/**
 * Language switcher dropdown component.
 * Uses UiSelect from the design layer for consistent styling.
 */
export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();

  return (
    <UiSelect
      value={locale}
      onChange={(e) => setLocale(e.target.value as SupportedLocale)}
      aria-label={t("languageLabel", locale)}
      selectClassName="av-language-switcher"
    >
      {LOCALE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {t(opt.labelKey, locale)}
        </option>
      ))}
    </UiSelect>
  );
}