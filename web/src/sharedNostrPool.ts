import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";

let sharedNostrPool: SimplePool | null = null;
let safeWebSocketConfigured = false;

function configureSafeWebSocketImplementation() {
  if (safeWebSocketConfigured) {
    return;
  }
  safeWebSocketConfigured = true;
  if (typeof WebSocket !== "function") {
    return;
  }

  class SafeWebSocket extends WebSocket {
    send(data: Parameters<WebSocket["send"]>[0]) {
      if (this.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        super.send(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("CLOSING or CLOSED")) {
          return;
        }
        throw error;
      }
    }
  }

  useWebSocketImplementation(SafeWebSocket as unknown as typeof WebSocket);
}

export function getSharedNostrPool() {
  if (!sharedNostrPool) {
    configureSafeWebSocketImplementation();
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
