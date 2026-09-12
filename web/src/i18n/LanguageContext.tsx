import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { type SupportedLocale } from "./types";
import { detectLocale, LOCALE_STORAGE_KEY } from "./resolveLocale";
import { t, type UiStringKey } from "./uiStrings";

/**
 * Context value provided by LanguageProvider.
 */
interface LanguageContextValue {
  /** Current locale */
  locale: SupportedLocale;
  /** Change the locale and persist to localStorage */
  setLocale: (locale: SupportedLocale) => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

interface LanguageProviderProps {
  children: ReactNode;
  /** Override initial locale (primarily for testing) */
  initialLocale?: SupportedLocale;
}

/**
 * React context provider that manages the current locale and persists
 * user preferences to localStorage (key: `av-locale`).
 */
export function LanguageProvider({
  children,
  initialLocale,
}: LanguageProviderProps) {
  const [locale, setLocaleState] = useState<SupportedLocale>(
    () => initialLocale ?? detectLocale(),
  );

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable; locale is still set in state.
    }
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access the current language context.
 * Must be used within a `<LanguageProvider>`.
 */
export function useLocale(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLocale must be used within a LanguageProvider");
  }
  return ctx;
}

/**
 * Like `useLocale`, but falls back to `en` (with a no-op setter) when no
 * `LanguageProvider` is present. Useful for components that may be rendered
 * standalone (e.g. in tests) without the provider wrapper.
 */
export function useLocaleSafe(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    return { locale: "en", setLocale: () => undefined };
  }
  return ctx;
}

/**
 * Hook that returns a `t` function bound to the current locale.
 * Usage: `const t = useT(); t("actionSubmit")`.
 * Must be used within a `<LanguageProvider>`.
 */
export function useT(): (key: UiStringKey) => string {
  const { locale } = useLocale();
  return useCallback((key: UiStringKey) => t(key, locale), [locale]);
}

/**
 * Like `useT`, but falls back to `en` when no `LanguageProvider` is present.
 */
export function useTSafe(): (key: UiStringKey) => string {
  const { locale } = useLocaleSafe();
  return useCallback((key: UiStringKey) => t(key, locale), [locale]);
}