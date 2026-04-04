import { nip19, SimplePool, type VerifiedEvent } from "nostr-tools";

export const NIP65_RELAY_LIST_KIND = 10002;

export type Nip65RelayHints = {
  npub: string;
  inboxRelays: string[];
  outboxRelays: string[];
  fetchedAt: string;
};

const relayHintsCache = new Map<string, Nip65RelayHints | null>();

function uniqueRelays(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

export function parseNip65RelayHintsEvent(
  event: Pick<VerifiedEvent, "kind" | "pubkey" | "tags" | "created_at">,
  expectedNpub?: string,
): Nip65RelayHints | null {
  if (event.kind !== NIP65_RELAY_LIST_KIND) {
    return null;
  }

  const npub = nip19.npubEncode(event.pubkey);
  if (expectedNpub && npub !== expectedNpub) {
    return null;
  }

  const inboxRelays = new Set<string>();
  const outboxRelays = new Set<string>();

  for (const tag of event.tags) {
    if (tag[0] !== "r") {
      continue;
    }

    const relay = tag[1]?.trim();
    if (!relay) {
      continue;
    }

    const marker = tag[2]?.trim().toLowerCase();
    if (marker === "read") {
      inboxRelays.add(relay);
      continue;
    }

    if (marker === "write") {
      outboxRelays.add(relay);
      continue;
    }

    inboxRelays.add(relay);
    outboxRelays.add(relay);
  }

  return {
    npub,
    inboxRelays: [...inboxRelays],
    outboxRelays: [...outboxRelays],
    fetchedAt: new Date(event.created_at * 1000).toISOString(),
  };
}

function sortByFetchedAtDescending(values: Nip65RelayHints[]) {
  return [...values].sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
}

function getDecodedNpubHex(npub: string) {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Value must be an npub.");
  }

  return decoded.data as string;
}

export function getCachedNip65RelayHints(npub: string): Nip65RelayHints | null {
  return relayHintsCache.get(npub) ?? null;
}

export async function fetchNip65RelayHints(input: {
  npub: string;
  discoveryRelays: string[];
  force?: boolean;
}): Promise<Nip65RelayHints | null> {
  const npub = input.npub.trim();
  if (!npub) {
    return null;
  }

  if (!input.force && relayHintsCache.has(npub)) {
    return relayHintsCache.get(npub) ?? null;
  }

  const discoveryRelays = uniqueRelays(input.discoveryRelays);
  if (discoveryRelays.length === 0) {
    relayHintsCache.set(npub, null);
    return null;
  }

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(discoveryRelays, {
      kinds: [NIP65_RELAY_LIST_KIND],
      authors: [getDecodedNpubHex(npub)],
      limit: 10,
    });
    const parsed = sortByFetchedAtDescending(
      events
        .map((event) => parseNip65RelayHintsEvent(event as VerifiedEvent, npub))
        .filter((entry): entry is Nip65RelayHints => entry !== null),
    );
    const latest = parsed[0] ?? null;
    relayHintsCache.set(npub, latest);
    return latest;
  } finally {
    pool.close(discoveryRelays);
  }
}

export async function primeNip65RelayHints(npubs: string[], discoveryRelays: string[]) {
  const uniqueNpubs = Array.from(new Set(npubs.map((value) => value.trim()).filter((value) => value.length > 0)));
  await Promise.all(uniqueNpubs.map(async (npub) => {
    try {
      await fetchNip65RelayHints({ npub, discoveryRelays });
    } catch {
      return null;
    }
    return null;
  }));
}

export async function resolveNip65InboxRelays(input: {
  npub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = uniqueRelays([...input.fallbackRelays, ...(input.extraRelays ?? [])]);
  const hints = await fetchNip65RelayHints({
    npub: input.npub,
    discoveryRelays: fallbackRelays,
  }).catch(() => null);

  return uniqueRelays([...(hints?.inboxRelays ?? []), ...fallbackRelays]);
}

export async function resolveNip65OutboxRelays(input: {
  npub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = uniqueRelays([...input.fallbackRelays, ...(input.extraRelays ?? [])]);
  const hints = await fetchNip65RelayHints({
    npub: input.npub,
    discoveryRelays: fallbackRelays,
  }).catch(() => null);

  return uniqueRelays([...(hints?.outboxRelays ?? []), ...fallbackRelays]);
}

export async function resolveNip65ConversationRelays(input: {
  senderNpub?: string;
  recipientNpub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = uniqueRelays([...input.fallbackRelays, ...(input.extraRelays ?? [])]);
  const [recipientInboxRelays, senderOutboxRelays] = await Promise.all([
    resolveNip65InboxRelays({
      npub: input.recipientNpub,
      fallbackRelays,
    }),
    input.senderNpub
      ? resolveNip65OutboxRelays({
          npub: input.senderNpub,
          fallbackRelays,
        })
      : Promise.resolve<string[]>([]),
  ]);

  return uniqueRelays([...recipientInboxRelays, ...senderOutboxRelays, ...fallbackRelays]);
}

export function resetNip65RelayHintsForTests() {
  relayHintsCache.clear();
}
