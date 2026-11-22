import type { Page } from "@playwright/test";

/**
 * Minimal in-memory Nostr relay for deterministic Playwright runs.
 *
 * The application talks to public relays in production. In this test we
 * intercept every non-loopback WebSocket and serve the same event store to
 * the coordinator and voter pages. That exercises real event serialisation,
 * NIP-17 gift wraps and the runtime queue logic without any public network.
 */
export type RelayEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

type RelayFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
};

type RelayConnection = {
  send: (message: string) => void;
  subscriptions: Map<string, RelayFilter[]>;
};

const REPLACEABLE_KINDS = new Set([0, 3]);
const ADDRESSABLE_MIN = 30_000;
const ADDRESSABLE_MAX = 39_999;

function isReplaceable(kind: number) {
  return REPLACEABLE_KINDS.has(kind) || (kind >= 10_000 && kind < 20_000) || (kind >= ADDRESSABLE_MIN && kind <= ADDRESSABLE_MAX);
}

function replaceableKey(event: RelayEvent): string {
  if (event.kind >= ADDRESSABLE_MIN && event.kind <= ADDRESSABLE_MAX) {
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    return `${event.kind}:${event.pubkey}:${dTag}`;
  }
  return `${event.kind}:${event.pubkey}`;
}

function matchesFilter(event: RelayEvent, filter: RelayFilter): boolean {
  if (filter.ids && filter.ids.length > 0 && !filter.ids.some((id) => event.id === id || event.id.startsWith(id))) {
    return false;
  }
  if (filter.authors && filter.authors.length > 0 && !filter.authors.some((author) => event.pubkey === author || event.pubkey.startsWith(author))) {
    return false;
  }
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false;
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values) || values.length === 0) {
      continue;
    }
    const tagName = key.slice(1);
    const tagValues = values as string[];
    if (!event.tags.some((tag) => tag[0] === tagName && tagValues.includes(tag[1] ?? ""))) {
      return false;
    }
  }
  return true;
}

export class InMemoryNostrRelay {
  private events = new Map<string, RelayEvent>();
  private replaceable = new Map<string, string>();
  private connections = new Set<RelayConnection>();

  private debug(...args: unknown[]) {
    if (process.env.E2E_RELAY_DEBUG === "1") {
      console.log("[relay]", ...args);
    }
  }

  connect(send: (message: string) => void): RelayConnection {
    const connection: RelayConnection = { send, subscriptions: new Map() };
    this.connections.add(connection);
    return connection;
  }

  disconnect(connection: RelayConnection) {
    this.connections.delete(connection);
  }

  receive(connection: RelayConnection, raw: string | Buffer) {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      return;
    }
    const [type, ...rest] = message;
    if (type === "EVENT") {
      this.handleEvent(connection, rest[0] as RelayEvent | undefined);
      return;
    }
    if (type === "REQ") {
      this.handleRequest(connection, String(rest[0] ?? ""), rest.slice(1) as RelayFilter[]);
      return;
    }
    if (type === "CLOSE") {
      connection.subscriptions.delete(String(rest[0] ?? ""));
      return;
    }
    if (type === "AUTH") {
      // No relay authentication is required for the test relay.
    }
  }

  private handleEvent(connection: RelayConnection, event: RelayEvent | undefined) {
    if (!event || typeof event.id !== "string" || typeof event.kind !== "number" || !Array.isArray(event.tags)) {
      return;
    }
    if (isReplaceable(event.kind)) {
      const key = replaceableKey(event);
      const previousId = this.replaceable.get(key);
      if (previousId) {
        const previous = this.events.get(previousId);
        if (previous && previous.created_at > event.created_at) {
          connection.send(JSON.stringify(["OK", event.id, true, ""]));
          return;
        }
        this.events.delete(previousId);
      }
      this.replaceable.set(key, event.id);
    }
    this.events.set(event.id, event);
    connection.send(JSON.stringify(["OK", event.id, true, ""]));
    if (event.kind === 1059) {
      this.debug("giftwrap", event.id.slice(0, 8), "from", event.pubkey.slice(0, 8), "p", event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]?.slice(0, 8)));
    }
    this.broadcast(event);
  }

  private handleRequest(connection: RelayConnection, subscriptionId: string, filters: RelayFilter[]) {
    if (!subscriptionId) {
      return;
    }
    connection.subscriptions.set(subscriptionId, filters);
    if (filters.some((filter) => filter.kinds?.includes(1059))) {
      this.debug("req1059", subscriptionId, filters.map((filter) => filter["#p"]?.map((value) => value.slice(0, 8))));
    }
    let matched = [...this.events.values()]
      .filter((event) => filters.some((filter) => matchesFilter(event, filter)))
      .sort((left, right) => right.created_at - left.created_at);
    const limit = Math.max(0, ...filters.map((filter) => filter.limit ?? 0));
    if (limit > 0) {
      matched = matched.slice(0, limit);
    }
    for (const event of matched) {
      connection.send(JSON.stringify(["EVENT", subscriptionId, event]));
    }
    connection.send(JSON.stringify(["EOSE", subscriptionId]));
  }

  private broadcast(event: RelayEvent) {
    let matches = 0;
    for (const connection of this.connections) {
      for (const [subscriptionId, filters] of connection.subscriptions) {
        if (filters.some((filter) => matchesFilter(event, filter))) {
          matches += 1;
          connection.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
      }
    }
    if (event.kind === 1059) {
      this.debug("broadcast", event.id.slice(0, 8), "matches", matches);
    }
  }

  eventCount() {
    return this.events.size;
  }
}

/**
 * Route all non-loopback WebSockets in the page to the shared relay. The Vite
 * HMR socket stays on loopback and is left alone.
 */
export async function installNostrRelay(page: Page, relay: InMemoryNostrRelay) {
  await page.routeWebSocket(
    (url) => (url.protocol === "ws:" || url.protocol === "wss:")
      && url.hostname !== "localhost"
      && url.hostname !== "127.0.0.1"
      && url.hostname !== "::1",
    (socket) => {
      const connection = relay.connect((message) => socket.send(message));
      socket.onMessage((message) => relay.receive(connection, message));
      socket.onClose(() => relay.disconnect(connection));
    },
  );
}
