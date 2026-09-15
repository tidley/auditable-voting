import { useState } from "react";
import { type LocalisedText, type SupportedLocale } from "../i18n/types";
import { localisedFieldValue, withLocalisedField } from "../i18n/localisedText";
import { UiButton, UiTextArea, UiTextField } from "./DesignLayer";

/**
 * A collapsible EN/FR/TA editor for a single `LocalisableText` value.
 *
 * The English field is always visible and keeps the caller's original
 * label/placeholder/aria-label so existing tests and screen readers keep
 * working.  French and Tamil fields are revealed behind a "Translations"
 * toggle and are labelled `<base> (French)` / `<base> (Tamil)`.
 */
export function LocalisedTextTranslations({
  value,
  onChange,
  label,
  ariaLabel,
  placeholder,
  inputClassName,
  textArea = false,
  rows = 3,
  disabled = false,
  invalid = false,
  idPrefix,
}: {
  value: LocalisedText | string;
  onChange: (next: LocalisedText) => void;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  inputClassName?: string;
  textArea?: boolean;
  rows?: number;
  disabled?: boolean;
  invalid?: boolean;
  idPrefix?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const baseLabel = ariaLabel ?? label ?? placeholder ?? "Text";

  const enValue = localisedFieldValue(value, "en");
  const frValue = localisedFieldValue(value, "fr");
  const taValue = localisedFieldValue(value, "ta");

  const setLocaleValue = (locale: SupportedLocale, next: string) => {
    onChange(withLocalisedField(value, locale, next));
  };

  const enField = textArea ? (
    <UiTextArea
      label={label}
      textAreaClassName={inputClassName}
      textAreaProps={{
        id: idPrefix ? `${idPrefix}-en` : undefined,
        "aria-label": ariaLabel,
        "aria-invalid": invalid || undefined,
        rows,
        value: enValue,
        placeholder,
        onChange: (event) => setLocaleValue("en", event.target.value),
      }}
      isDisabled={disabled}
    />
  ) : (
    <UiTextField
      label={label}
      inputClassName={inputClassName}
      inputProps={{
        id: idPrefix ? `${idPrefix}-en` : undefined,
        "aria-label": ariaLabel,
        "aria-invalid": invalid || undefined,
        value: enValue,
        placeholder,
        onChange: (event) => setLocaleValue("en", event.target.value),
      }}
      isDisabled={disabled}
    />
  );

  return (
    <div className='simple-localised-text-editor'>
      {enField}
      <div className='simple-localised-text-translations'>
        <UiButton
          variant='secondary'
          className='simple-voter-secondary simple-localised-text-toggle'
          aria-expanded={expanded}
          onPress={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide translations" : "Translations"}
        </UiButton>
        {expanded ? (
          <div className='simple-localised-text-fields'>
            <UiTextField
              label='French'
              inputClassName={inputClassName}
              inputProps={{
                id: idPrefix ? `${idPrefix}-fr` : undefined,
                "aria-label": `${baseLabel} (French)`,
                value: frValue,
                placeholder: `${placeholder ?? baseLabel} (French)`,
                onChange: (event) => setLocaleValue("fr", event.target.value),
              }}
              isDisabled={disabled}
            />
            <UiTextField
              label='Tamil'
              inputClassName={inputClassName}
              inputProps={{
                id: idPrefix ? `${idPrefix}-ta` : undefined,
                "aria-label": `${baseLabel} (Tamil)`,
                value: taValue,
                placeholder: `${placeholder ?? baseLabel} (Tamil)`,
                onChange: (event) => setLocaleValue("ta", event.target.value),
              }}
              isDisabled={disabled}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
