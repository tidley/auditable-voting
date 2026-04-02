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

const DB_NAME = "auditable-voting-simple";
const DB_VERSION = 1;
const STORE_NAME = "actor-state";
const memoryState = new Map<string, SimpleActorState>();

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

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
  if (!hasIndexedDb()) {
    return memoryState.get(role) ?? null;
  }

  const result = await withStore<SimpleActorState | undefined>("readonly", (store) => store.get(role));
  return result ?? null;
}

export async function saveSimpleActorState(state: SimpleActorState): Promise<void> {
  if (!hasIndexedDb()) {
    memoryState.set(state.role, state);
    return;
  }

  await withStore("readwrite", (store) => store.put(state, state.role));
}

export async function clearSimpleActorState(role: SimpleActorRole): Promise<void> {
  if (!hasIndexedDb()) {
    memoryState.delete(role);
    return;
  }

  await withStore("readwrite", (store) => store.delete(role));
}

export async function resetSimpleActorStateForTests(): Promise<void> {
  if (!hasIndexedDb()) {
    memoryState.clear();
    return;
  }

  const database = await openDatabase();
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

export function downloadSimpleActorBackup(role: SimpleActorRole, keypair: SimpleActorKeypair, cache?: unknown) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const bundle = buildSimpleActorBackupBundle(role, keypair, cache);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `auditable-voting-${role}-backup.json`;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}
