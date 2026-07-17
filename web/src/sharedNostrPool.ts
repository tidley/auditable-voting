import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import {
  relayCanAttempt,
  recordRelayOutcome,
} from "./relayBackoff";

let sharedNostrPool: SimplePool | null = null;
let safeWebSocketConfigured = false;
const RELAY_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
let activeConnectingWebSockets = 0;
let activeOpenWebSockets = 0;
const relaySocketCounts = new Map<string, number>();
const relayConnectionAttempts = new Map<string, number>();
const relayConnectionSuccesses = new Map<string, number>();
const relayConnectionFailures = new Map<string, number>();
const relayConnectionSkipped = new Map<string, number>();

function normalizeRelayUrl(input: unknown) {
  try {
    return new URL(String(input)).toString();
  } catch {
    return String(input ?? "").trim();
  }
}

function decrementRelaySocketCount(relay: string) {
  const current = relaySocketCounts.get(relay) ?? 0;
  if (current <= 1) {
    relaySocketCounts.delete(relay);
    return;
  }
  relaySocketCounts.set(relay, current - 1);
}

function incrementCounter(map: Map<string, number>, relay: string) {
  map.set(relay, (map.get(relay) ?? 0) + 1);
}

function getRelayManagerSnapshot() {
  const relays = new Set([
    ...relaySocketCounts.keys(),
    ...relayConnectionAttempts.keys(),
    ...relayConnectionSuccesses.keys(),
    ...relayConnectionFailures.keys(),
    ...relayConnectionSkipped.keys(),
  ]);
  return {
    activeConnectingWebSockets,
    activeOpenWebSockets,
    relays: [...relays].sort().map((relay) => ({
      relay,
      activeSockets: relaySocketCounts.get(relay) ?? 0,
      attempts: relayConnectionAttempts.get(relay) ?? 0,
      successes: relayConnectionSuccesses.get(relay) ?? 0,
      failures: relayConnectionFailures.get(relay) ?? 0,
      skipped: relayConnectionSkipped.get(relay) ?? 0,
    })),
  };
}

function configureSafeWebSocketImplementation() {
  if (safeWebSocketConfigured) {
    return;
  }
  safeWebSocketConfigured = true;
  if (typeof WebSocket !== "function") {
    return;
  }

  class SafeWebSocket extends WebSocket {
    private readonly relayUrl: string;
    private connectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    private countedConnecting = false;
    private countedOpen = false;
    private localRejectReason: string | null = null;
    private closedCleanlyByGuard = false;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.relayUrl = normalizeRelayUrl(url);
      incrementCounter(relayConnectionAttempts, this.relayUrl);
      const existingRelaySockets = relaySocketCounts.get(this.relayUrl) ?? 0;
      relaySocketCounts.set(this.relayUrl, existingRelaySockets + 1);
      activeConnectingWebSockets += 1;
      this.countedConnecting = true;

      this.addEventListener("open", () => {
        this.clearConnectTimer();
        this.finishConnecting();
        activeOpenWebSockets += 1;
        this.countedOpen = true;
        incrementCounter(relayConnectionSuccesses, this.relayUrl);
        recordRelayOutcome(this.relayUrl, true);
      });

      this.addEventListener("error", () => {
        if (!this.localRejectReason) {
          incrementCounter(relayConnectionFailures, this.relayUrl);
          recordRelayOutcome(this.relayUrl, false, "websocket error");
        }
      });

      this.addEventListener("close", (event) => {
        this.clearConnectTimer();
        this.finishConnecting();
        if (this.countedOpen) {
          activeOpenWebSockets = Math.max(0, activeOpenWebSockets - 1);
          this.countedOpen = false;
        }
        decrementRelaySocketCount(this.relayUrl);
        if (this.localRejectReason) {
          return;
        }
        if (!this.closedCleanlyByGuard && !event.wasClean && event.code !== 1000) {
          incrementCounter(relayConnectionFailures, this.relayUrl);
          recordRelayOutcome(this.relayUrl, false, event.reason || `websocket closed with code ${event.code}`);
        }
      });

      this.connectTimer = globalThis.setTimeout(() => {
        if (this.readyState === WebSocket.CONNECTING) {
          incrementCounter(relayConnectionFailures, this.relayUrl);
          recordRelayOutcome(this.relayUrl, false, `relay connection timed out after ${RELAY_WEBSOCKET_CONNECT_TIMEOUT_MS}ms`);
          this.localRejectReason = "relay connection timed out";
          this.closeFromGuard();
        }
      }, RELAY_WEBSOCKET_CONNECT_TIMEOUT_MS);
    }

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

    private closeFromGuard() {
      this.closedCleanlyByGuard = true;
      this.clearConnectTimer();
      this.finishConnecting();
      try {
        this.close(1000, this.localRejectReason ?? "closed by relay guard");
      } catch {
        // Ignore close races from browser WebSocket implementations.
      }
    }

    private clearConnectTimer() {
      if (this.connectTimer) {
        globalThis.clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
    }

    private finishConnecting() {
      if (!this.countedConnecting) {
        return;
      }
      activeConnectingWebSockets = Math.max(0, activeConnectingWebSockets - 1);
      this.countedConnecting = false;
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
    sharedNostrPool.allowConnectingToRelay = (relay) => {
      const relayUrl = normalizeRelayUrl(relay);
      if (!relayCanAttempt(relayUrl)) {
        incrementCounter(relayConnectionSkipped, relayUrl);
        return false;
      }
      return true;
    };
  }

  return sharedNostrPool;
}

export function getSharedNostrRelayManagerSnapshot() {
  return getRelayManagerSnapshot();
}

export function resetSharedNostrPoolForTests() {
  sharedNostrPool?.destroy?.();
  sharedNostrPool = null;
  activeConnectingWebSockets = 0;
  activeOpenWebSockets = 0;
  relaySocketCounts.clear();
  relayConnectionAttempts.clear();
  relayConnectionSuccesses.clear();
  relayConnectionFailures.clear();
  relayConnectionSkipped.clear();
}
