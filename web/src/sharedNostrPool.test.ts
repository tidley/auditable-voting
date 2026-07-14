import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolMocks = vi.hoisted(() => ({
  options: null as null | { allowConnectingToRelay?: (relay: string) => boolean },
  webSocketImplementation: null as null | typeof WebSocket,
}));

vi.mock("nostr-tools/pool", () => ({
  SimplePool: class MockSimplePool {
    constructor(options: { allowConnectingToRelay?: (relay: string) => boolean }) {
      poolMocks.options = options;
    }

    destroy() {}
  },
  useWebSocketImplementation: (implementation: typeof WebSocket) => {
    poolMocks.webSocketImplementation = implementation;
  },
}));

type Listener = (event?: unknown) => void;

class MockBrowserWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockBrowserWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string | URL) {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send() {}

  close(code = 1000, reason = "") {
    this.readyState = MockBrowserWebSocket.CLOSED;
    this.dispatch("close", { code, reason, wasClean: code === 1000 });
  }

  dispatch(type: string, event?: unknown) {
    if (type === "open") {
      this.readyState = MockBrowserWebSocket.OPEN;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

describe("sharedNostrPool", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    poolMocks.options = null;
    poolMocks.webSocketImplementation = null;
    globalThis.WebSocket = MockBrowserWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("uses central relay health to skip relays in cooldown and reports skipped attempts", async () => {
    const relay = "wss://unhealthy.example/";
    const { recordRelayOutcome, resetRelayHealthForTests } = await import("./relayBackoff");
    const {
      getSharedNostrPool,
      getSharedNostrRelayManagerSnapshot,
      resetSharedNostrPoolForTests,
    } = await import("./sharedNostrPool");

    resetRelayHealthForTests();
    resetSharedNostrPoolForTests();
    getSharedNostrPool();

    expect(poolMocks.options?.allowConnectingToRelay?.(relay)).toBe(true);

    recordRelayOutcome(relay, false, "websocket connection failed");
    recordRelayOutcome(relay, false, "websocket connection failed");

    expect(poolMocks.options?.allowConnectingToRelay?.(relay)).toBe(false);
    expect(getSharedNostrRelayManagerSnapshot().relays).toContainEqual(expect.objectContaining({
      relay,
      skipped: 1,
    }));
  });

  it("tracks WebSocket attempts, successes, active sockets, and clean close", async () => {
    const relay = "wss://healthy.example/";
    const {
      getSharedNostrPool,
      getSharedNostrRelayManagerSnapshot,
      resetSharedNostrPoolForTests,
    } = await import("./sharedNostrPool");

    resetSharedNostrPoolForTests();
    getSharedNostrPool();
    const ManagedWebSocket = poolMocks.webSocketImplementation as typeof WebSocket;

    const socket = new ManagedWebSocket(relay) as unknown as MockBrowserWebSocket;
    expect(getSharedNostrRelayManagerSnapshot()).toMatchObject({
      activeConnectingWebSockets: 1,
      activeOpenWebSockets: 0,
    });

    socket.dispatch("open");
    expect(getSharedNostrRelayManagerSnapshot().relays).toContainEqual(expect.objectContaining({
      relay,
      activeSockets: 1,
      attempts: 1,
      successes: 1,
      failures: 0,
    }));
    expect(getSharedNostrRelayManagerSnapshot()).toMatchObject({
      activeConnectingWebSockets: 0,
      activeOpenWebSockets: 1,
    });

    socket.close(1000, "done");
    expect(getSharedNostrRelayManagerSnapshot()).toMatchObject({
      activeConnectingWebSockets: 0,
      activeOpenWebSockets: 0,
    });
    expect(getSharedNostrRelayManagerSnapshot().relays).toContainEqual(expect.objectContaining({
      relay,
      activeSockets: 0,
      failures: 0,
    }));
  });

  it("records connect timeouts as relay failures without leaving sockets marked connecting", async () => {
    const relay = "wss://timeout.example/";
    const {
      getSharedNostrPool,
      getSharedNostrRelayManagerSnapshot,
      resetSharedNostrPoolForTests,
    } = await import("./sharedNostrPool");

    resetSharedNostrPoolForTests();
    getSharedNostrPool();
    const ManagedWebSocket = poolMocks.webSocketImplementation as typeof WebSocket;

    new ManagedWebSocket(relay);
    vi.advanceTimersByTime(10_000);

    expect(getSharedNostrRelayManagerSnapshot()).toMatchObject({
      activeConnectingWebSockets: 0,
      activeOpenWebSockets: 0,
    });
    expect(getSharedNostrRelayManagerSnapshot().relays).toContainEqual(expect.objectContaining({
      relay,
      attempts: 1,
      failures: 1,
      activeSockets: 0,
    }));
  });
});
