import { SimplePool } from "nostr-tools";

let sharedNostrPool: SimplePool | null = null;

export function getSharedNostrPool() {
  if (!sharedNostrPool) {
    sharedNostrPool = new SimplePool({
      enablePing: true,
      enableReconnect: true,
    });
  }

  return sharedNostrPool;
}

export function resetSharedNostrPoolForTests() {
  sharedNostrPool?.destroy?.();
  sharedNostrPool = null;
}
