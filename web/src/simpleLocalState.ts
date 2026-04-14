export type SimpleActorRole = "voter" | "coordinator";

export type SimpleActorKeypair = {
  npub: string;
  nsec: string;
};

export type SimpleActorState = {
  role: SimpleActorRole;
  keypair: SimpleActorKeypair;
  updatedAt: string;
  cache?: unknown;
};

export type SimpleActorBackupBundle = {
  version: 1;
  type: "auditable-voting.simple-backup";
  role: SimpleActorRole;
  exportedAt: string;
  keypair: SimpleActorKeypair;
  cache?: unknown;
};

export type SimpleEncryptedActorBackupBundle = {
  version: 1;
  type: "auditable-voting.simple-backup.encrypted";
  role: SimpleActorRole;
  exportedAt: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
  };
  ciphertext: string;
};

export type SimpleEncryptedActorState = {
  version: 1;
  type: "auditable-voting.simple-state.encrypted";
  role: SimpleActorRole;
  updatedAt: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
  };
  ciphertext: string;
};

const DB_BASE_NAME = "auditable-voting-simple";
const DB_VERSION = 1;
const STORE_NAME = "actor-state";
const memoryState = new Map<string, SimpleActorState>();
const BACKUP_KDF_ITERATIONS = 250_000;
const ACTIVE_STATE_KDF_ITERATIONS = 250_000;
const DEFAULT_STORAGE_NAMESPACE = "default";
const STORAGE_NAMESPACE_PATTERN = /^[a-z0-9_-]{1,64}$/;
let cachedStorageNamespace: string | null = null;
const INDEXEDDB_FAILURE_BASE_BACKOFF_MS = 15_000;
const INDEXEDDB_FAILURE_MAX_BACKOFF_MS = 5 * 60 * 1000;
let indexedDbDisabledUntilMs = 0;
let indexedDbFailureCount = 0;

export class SimpleActorStateLockedError extends Error {
  constructor() {
    super("Local actor state is locked.");
    this.name = "SimpleActorStateLockedError";
  }
}

function getWebCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is required.");
  }

  return globalThis.crypto;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array) {
  return derivePassphraseKey(passphrase, salt, BACKUP_KDF_ITERATIONS);
}

async function deriveActiveStateKey(passphrase: string, salt: Uint8Array) {
  return derivePassphraseKey(passphrase, salt, ACTIVE_STATE_KDF_ITERATIONS);
}

async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
) {
  const cryptoApi = getWebCrypto();
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: salt.slice().buffer,
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function indexedDbAvailableNow() {
  return hasIndexedDb() && Date.now() >= indexedDbDisabledUntilMs;
}

function isIndexedDbLockError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const name = error instanceof Error ? error.name : "";
  const lower = message.toLowerCase();
  const lowerName = name.toLowerCase();
  return lower.includes("lock")
    || lower.includes("lockfile")
    || lower.includes("leveldb")
    || lower.includes("unable to open indexeddb")
    || lower.includes("backing store")
    || lower.includes("indexeddb.open")
    || (lowerName === "unknownerror" && lower.includes("indexeddb"));
}

function recordIndexedDbFailure(error: unknown) {
  if (!isIndexedDbLockError(error)) {
    return;
  }
  indexedDbFailureCount = Math.min(indexedDbFailureCount + 1, 16);
  const backoffMs = Math.min(
    INDEXEDDB_FAILURE_MAX_BACKOFF_MS,
    INDEXEDDB_FAILURE_BASE_BACKOFF_MS * (2 ** Math.max(0, indexedDbFailureCount - 1)),
  );
  indexedDbDisabledUntilMs = Date.now() + backoffMs;
}

function clearIndexedDbFailureBackoff() {
  indexedDbFailureCount = 0;
  indexedDbDisabledUntilMs = 0;
}

function getStorageNamespace() {
  if (cachedStorageNamespace) {
    return cachedStorageNamespace;
  }
  if (typeof window === "undefined") {
    cachedStorageNamespace = DEFAULT_STORAGE_NAMESPACE;
    return cachedStorageNamespace;
  }

  const rawNamespace = new URLSearchParams(window.location.search).get("ns")?.trim().toLowerCase() ?? "";
  if (!rawNamespace || !STORAGE_NAMESPACE_PATTERN.test(rawNamespace)) {
    cachedStorageNamespace = DEFAULT_STORAGE_NAMESPACE;
    return cachedStorageNamespace;
  }
  cachedStorageNamespace = rawNamespace;
  return cachedStorageNamespace;
}

export function getSimpleStorageNamespace() {
  return getStorageNamespace();
}

export function buildSimpleNamespacedLocalStorageKey(key: string) {
  return `app:auditable-voting:${getStorageNamespace()}:${key}`;
}

function getStorageDbName() {
  const namespace = getStorageNamespace();
  return namespace === DEFAULT_STORAGE_NAMESPACE
    ? DB_BASE_NAME
    : `${DB_BASE_NAME}--${namespace}`;
}

function getMemoryStateKey(role: SimpleActorRole) {
  return `${getStorageNamespace()}:${role}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getStorageDbName(), DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = callback(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      database.close();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      database.close();
    };
  });
}

export async function loadSimpleActorState(role: SimpleActorRole): Promise<SimpleActorState | null> {
  return loadSimpleActorStateWithOptions(role);
}

export async function isSimpleActorStateLocked(role: SimpleActorRole): Promise<boolean> {
  if (!indexedDbAvailableNow()) {
    return false;
  }

  try {
    const result = await withStore<SimpleActorState | SimpleEncryptedActorState | undefined>("readonly", (store) => store.get(role));
    clearIndexedDbFailureBackoff();
    return Boolean(result && "type" in result && result.type === "auditable-voting.simple-state.encrypted");
  } catch (error) {
    recordIndexedDbFailure(error);
    return false;
  }
}

export async function loadSimpleActorStateWithOptions(
  role: SimpleActorRole,
  options?: { passphrase?: string },
): Promise<SimpleActorState | null> {
  if (!indexedDbAvailableNow()) {
    return memoryState.get(getMemoryStateKey(role)) ?? null;
  }

  let result: SimpleActorState | SimpleEncryptedActorState | undefined;
  try {
    result = await withStore<SimpleActorState | SimpleEncryptedActorState | undefined>("readonly", (store) => store.get(role));
    clearIndexedDbFailureBackoff();
  } catch (error) {
    recordIndexedDbFailure(error);
    return memoryState.get(getMemoryStateKey(role)) ?? null;
  }
  if (!result) {
    return null;
  }

  if ((result as SimpleEncryptedActorState).type === "auditable-voting.simple-state.encrypted") {
    const encrypted = result as SimpleEncryptedActorState;
    const passphrase = options?.passphrase?.trim();
    if (!passphrase) {
      throw new SimpleActorStateLockedError();
    }
    const key = await deriveActiveStateKey(passphrase, base64ToBytes(encrypted.kdf.salt));
    const decrypted = await getWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(encrypted.cipher.iv),
      },
      key,
      base64ToBytes(encrypted.ciphertext),
    );
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted))) as SimpleActorState;
    return parsed ?? null;
  }

  return result as SimpleActorState;
}

export async function saveSimpleActorState(
  state: SimpleActorState,
  options?: { passphrase?: string },
): Promise<void> {
  if (!indexedDbAvailableNow()) {
    memoryState.set(getMemoryStateKey(state.role), state);
    return;
  }

  if (options?.passphrase?.trim()) {
    const cryptoApi = getWebCrypto();
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const key = await deriveActiveStateKey(options.passphrase.trim(), salt);
    const encrypted = await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(state)),
    );
    const payload: SimpleEncryptedActorState = {
      version: 1,
      type: "auditable-voting.simple-state.encrypted",
      role: state.role,
      updatedAt: state.updatedAt,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: ACTIVE_STATE_KDF_ITERATIONS,
        salt: bytesToBase64(salt),
      },
      cipher: {
        name: "AES-GCM",
        iv: bytesToBase64(iv),
      },
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
    try {
      await withStore("readwrite", (store) => store.put(payload, state.role));
      clearIndexedDbFailureBackoff();
    } catch (error) {
      recordIndexedDbFailure(error);
      memoryState.set(getMemoryStateKey(state.role), state);
    }
    return;
  }

  try {
    await withStore("readwrite", (store) => store.put(state, state.role));
    clearIndexedDbFailureBackoff();
  } catch (error) {
    recordIndexedDbFailure(error);
    memoryState.set(getMemoryStateKey(state.role), state);
  }
}

export async function clearSimpleActorState(role: SimpleActorRole): Promise<void> {
  if (!indexedDbAvailableNow()) {
    memoryState.delete(getMemoryStateKey(role));
    return;
  }

  try {
    await withStore("readwrite", (store) => store.delete(role));
    clearIndexedDbFailureBackoff();
  } catch (error) {
    recordIndexedDbFailure(error);
    memoryState.delete(getMemoryStateKey(role));
  }
}

export async function resetSimpleActorStateForTests(): Promise<void> {
  if (!indexedDbAvailableNow()) {
    memoryState.clear();
    return;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
    clearIndexedDbFailureBackoff();
  } catch (error) {
    recordIndexedDbFailure(error);
    memoryState.clear();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to clear IndexedDB state."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Unable to clear IndexedDB transaction."));
      database.close();
    };
  });
}

export function buildSimpleActorBackupBundle(
  role: SimpleActorRole,
  keypair: SimpleActorKeypair,
  cache?: unknown,
): SimpleActorBackupBundle {
  return {
    version: 1,
    type: "auditable-voting.simple-backup",
    role,
    exportedAt: new Date().toISOString(),
    keypair: {
      npub: keypair.npub,
      nsec: keypair.nsec,
    },
    cache,
  };
}

export function parseSimpleActorBackupBundle(value: string): SimpleActorBackupBundle | null {
  try {
    const parsed = JSON.parse(value) as Partial<SimpleActorBackupBundle>;
    if (
      parsed.version !== 1
      || parsed.type !== "auditable-voting.simple-backup"
      || (parsed.role !== "voter" && parsed.role !== "coordinator")
      || !parsed.keypair
      || typeof parsed.keypair.npub !== "string"
      || typeof parsed.keypair.nsec !== "string"
    ) {
      return null;
    }

    return {
      version: 1,
      type: "auditable-voting.simple-backup",
      role: parsed.role,
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
      keypair: {
        npub: parsed.keypair.npub,
        nsec: parsed.keypair.nsec,
      },
      cache: parsed.cache,
    };
  } catch {
    return null;
  }
}

export async function parseEncryptedSimpleActorBackupBundle(
  value: string,
  passphrase: string,
): Promise<SimpleActorBackupBundle | null> {
  try {
    const parsed = JSON.parse(value) as Partial<SimpleEncryptedActorBackupBundle>;
    if (
      parsed.version !== 1
      || parsed.type !== "auditable-voting.simple-backup.encrypted"
      || (parsed.role !== "voter" && parsed.role !== "coordinator")
      || !parsed.kdf
      || parsed.kdf.name !== "PBKDF2"
      || parsed.kdf.hash !== "SHA-256"
      || typeof parsed.kdf.iterations !== "number"
      || typeof parsed.kdf.salt !== "string"
      || !parsed.cipher
      || parsed.cipher.name !== "AES-GCM"
      || typeof parsed.cipher.iv !== "string"
      || typeof parsed.ciphertext !== "string"
    ) {
      return null;
    }

    const key = await deriveBackupKey(passphrase, base64ToBytes(parsed.kdf.salt));
    const decrypted = await getWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(parsed.cipher.iv),
      },
      key,
      base64ToBytes(parsed.ciphertext),
    );
    return parseSimpleActorBackupBundle(new TextDecoder().decode(new Uint8Array(decrypted)));
  } catch {
    return null;
  }
}

export async function downloadSimpleActorBackup(
  role: SimpleActorRole,
  keypair: SimpleActorKeypair,
  cache?: unknown,
  options?: { passphrase?: string },
) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const bundle = buildSimpleActorBackupBundle(role, keypair, cache);
  let contents = JSON.stringify(bundle, null, 2);
  let filename = `auditable-voting-${role}-backup.json`;

  if (options?.passphrase?.trim()) {
    const passphrase = options.passphrase.trim();
    const cryptoApi = getWebCrypto();
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(passphrase, salt);
    const encrypted = await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(contents),
    );

    const encryptedBundle: SimpleEncryptedActorBackupBundle = {
      version: 1,
      type: "auditable-voting.simple-backup.encrypted",
      role,
      exportedAt: bundle.exportedAt,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: BACKUP_KDF_ITERATIONS,
        salt: bytesToBase64(salt),
      },
      cipher: {
        name: "AES-GCM",
        iv: bytesToBase64(iv),
      },
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
    contents = JSON.stringify(encryptedBundle, null, 2);
    filename = `auditable-voting-${role}-backup.encrypted.json`;
  }

  const blob = new Blob([contents], { type: "application/json" });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}
