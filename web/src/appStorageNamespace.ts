const DEFAULT_STORAGE_NAMESPACE = "default";
const STORAGE_NAMESPACE_PATTERN = /^[a-z0-9_-]{1,64}$/;
let cachedStorageNamespace: string | null = null;

export function getAppStorageNamespace() {
  if (cachedStorageNamespace) {
    return cachedStorageNamespace;
  }
  if (typeof window === "undefined") {
    cachedStorageNamespace = DEFAULT_STORAGE_NAMESPACE;
    return cachedStorageNamespace;
  }

  const rawNamespace = new URLSearchParams(window.location.search).get("ns")?.trim().toLowerCase() ?? "";
  cachedStorageNamespace = rawNamespace && STORAGE_NAMESPACE_PATTERN.test(rawNamespace)
    ? rawNamespace
    : DEFAULT_STORAGE_NAMESPACE;
  return cachedStorageNamespace;
}

export function buildNamespacedLocalStorageKey(key: string) {
  return `app:auditable-voting:${getAppStorageNamespace()}:${key}`;
}
