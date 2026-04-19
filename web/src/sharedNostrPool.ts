import { SimplePool } from "nostr-tools";

let sharedNostrPool: SimplePool | null = null;

export function getSharedNostrPool() {
  if (!sharedNostrPool) {
    sharedNostrPool = new SimplePool({
      enablePing: false,
      enableReconnect: false,
    });
  }

  return sharedNostrPool;
}

export function resetSharedNostrPoolForTests() {
  sharedNostrPool?.destroy?.();
  sharedNostrPool = null;
}
