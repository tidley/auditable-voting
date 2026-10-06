import { useCallback, useState } from "react";
import { Moon, Sun } from "lucide-react";

export const THEME_STORAGE_KEY = "av-theme";

type Theme = "light" | "dark";

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark";
}

function readInitialTheme(): Theme {
  if (typeof document !== "undefined" && isTheme(document.documentElement.dataset.theme)) {
    return document.documentElement.dataset.theme;
  }
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isTheme(stored)) {
        return stored;
      }
    } catch {
      // Storage unavailable; fall through to the instance default.
    }
  }
  // Light is the instance default. The OS colour-scheme preference is
  // deliberately ignored so every first visit looks the same; only an explicit
  // toggle (persisted above) selects the dark theme.
  return "light";
}

function applyTheme(theme: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persisting is best-effort; the live theme still applies.
    }
  }
}

/**
 * Corner sun/moon control that flips the app between the default light
 * theme and the dark theme. The choice is remembered in localStorage
 * ("av-theme"); first visits start light and do NOT follow the system
 * colour-scheme preference.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "light" ? "dark" : "light";
      applyTheme(next);
      return next;
    });
  }, []);

  const isLight = theme === "light";

  return (
    <button
      type="button"
      className="simple-theme-toggle"
      onClick={toggleTheme}
      aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
      title={isLight ? "Switch to dark theme" : "Switch to light theme"}
    >
      {isLight ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
    </button>
  );
}
