const DYNAMIC_IMPORT_RELOAD_KEY = "app:auditable-voting:dynamic-import-reload";
const DYNAMIC_IMPORT_RELOAD_WINDOW_MS = 15000;

function getErrorMessage(value: unknown) {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "message" in value) {
    const candidate = (value as { message?: unknown }).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

function isDynamicImportFailure(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("failed to fetch dynamically imported module")
    || normalized.includes("importing a module script failed")
    || normalized.includes("error loading dynamically imported module");
}

function shouldReloadNow(pathname: string) {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const raw = window.sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_KEY);
    if (!raw) {
      return true;
    }
    const parsed = JSON.parse(raw) as { pathname?: string; at?: number } | null;
    if (!parsed?.pathname || typeof parsed.at !== "number") {
      return true;
    }
    if (parsed.pathname !== pathname) {
      return true;
    }
    return (Date.now() - parsed.at) > DYNAMIC_IMPORT_RELOAD_WINDOW_MS;
  } catch {
    return true;
  }
}

function markReload(pathname: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      DYNAMIC_IMPORT_RELOAD_KEY,
      JSON.stringify({ pathname, at: Date.now() }),
    );
  } catch {
    // Ignore storage failures.
  }
}

function recoverDynamicImportFailure() {
  if (typeof window === "undefined") {
    return;
  }
  const pathname = window.location.pathname;
  if (!shouldReloadNow(pathname)) {
    return;
  }
  markReload(pathname);
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("v_reload", String(Date.now()));
  window.location.replace(nextUrl.toString());
}

function handleUnhandledRejection(event: PromiseRejectionEvent) {
  const message = getErrorMessage(event.reason);
  if (!isDynamicImportFailure(message)) {
    return;
  }
  recoverDynamicImportFailure();
}

function handleWindowError(event: ErrorEvent) {
  const message = event.message || getErrorMessage(event.error);
  if (!isDynamicImportFailure(message)) {
    return;
  }
  recoverDynamicImportFailure();
}

export function installDynamicImportRecovery() {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  window.addEventListener("error", handleWindowError);
}

