import { finalizeEvent, getPublicKey, nip19, type VerifiedEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { getSharedNostrPool } from "./sharedNostrPool";
import {
  buildActorRelaySetRust,
  buildConversationRelaySetRust,
  normalizeRelaysRust,
} from "./wasm/auditableVotingCore";

export const NIP65_RELAY_LIST_KIND = 10002;

export type Nip65RelayHints = {
  npub: string;
  inboxRelays: string[];
  outboxRelays: string[];
  fetchedAt: string;
};

const relayHintsCache = new Map<string, Nip65RelayHints | null>();
const relayHintsInflight = new Map<string, Promise<Nip65RelayHints | null>>();
const publishedRelayHintKeys = new Set<string>();

function isNip65Disabled() {
  const explicitOverride = Reflect.get(globalThis as object, "__AUDITABLE_VOTING_DISABLE_NIP65__");
  if (explicitOverride === true) {
    return true;
  }
  if (explicitOverride === false) {
    return false;
  }

  if (typeof globalThis.location?.search !== "string") {
    return true;
  }

  try {
    const params = new URLSearchParams(globalThis.location.search);
    const value = params.get("nip65")?.trim().toLowerCase();
    if (!value) {
      return true;
    }
    return !(value === "on" || value === "true" || value === "1");
  } catch {
    return true;
  }
}

function uniqueRelays(values: string[]) {
  return normalizeRelaysRust(values);
}

function buildRelayHintCacheKey(
  npub: string,
  inboxRelays: string[],
  outboxRelays: string[],
  publishRelays: string[],
) {
  return [
    npub,
    inboxRelays.join("|"),
    outboxRelays.join("|"),
    publishRelays.join("|"),
  ].join("::");
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
  if (isNip65Disabled()) {
    return null;
  }

  const npub = input.npub.trim();
  if (!npub) {
    return null;
  }

  if (!input.force && relayHintsCache.has(npub)) {
    return relayHintsCache.get(npub) ?? null;
  }

  if (!input.force && relayHintsInflight.has(npub)) {
    return relayHintsInflight.get(npub) ?? null;
  }

  const discoveryRelays = uniqueRelays(input.discoveryRelays);
  if (discoveryRelays.length === 0) {
    relayHintsCache.set(npub, null);
    return null;
  }

  const request = (async () => {
    const pool = getSharedNostrPool();
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
      relayHintsInflight.delete(npub);
    }
  })();

  relayHintsInflight.set(npub, request);
  return request;
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

export async function publishOwnNip65RelayHints(input: {
  secretKey: Uint8Array;
  inboxRelays?: string[];
  outboxRelays?: string[];
  publishRelays: string[];
  channel?: string;
  minIntervalMs?: number;
  force?: boolean;
}) {
  if (isNip65Disabled()) {
    return null;
  }

  const npub = nip19.npubEncode(getPublicKey(input.secretKey));
  const inboxRelays = uniqueRelays(input.inboxRelays ?? []);
  const outboxRelays = uniqueRelays(input.outboxRelays ?? []);
  const publishRelays = buildActorRelaySetRust({
    preferredRelays: [...outboxRelays, ...inboxRelays],
    fallbackRelays: input.publishRelays,
  });

  if (publishRelays.length === 0 || (inboxRelays.length === 0 && outboxRelays.length === 0)) {
    return null;
  }

  const cacheKey = buildRelayHintCacheKey(npub, inboxRelays, outboxRelays, publishRelays);
  if (!input.force && publishedRelayHintKeys.has(cacheKey)) {
    return null;
  }

  const relayTags = Array.from(new Set([...inboxRelays, ...outboxRelays])).map((relay) => {
    const inInbox = inboxRelays.includes(relay);
    const inOutbox = outboxRelays.includes(relay);

    if (inInbox && inOutbox) {
      return ["r", relay];
    }

    return ["r", relay, inInbox ? "read" : "write"];
  });

  const createdAt = new Date().toISOString();
  const event = finalizeEvent({
    kind: NIP65_RELAY_LIST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayTags,
    content: "",
  }, input.secretKey);

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: 1500 })[0],
      publishRelays,
      { staggerMs: 250 },
    ),
    {
      channel: input.channel ?? `nip65:${npub}`,
      minIntervalMs: input.minIntervalMs ?? 1000,
    },
  );

  const successes = results.filter((result) => result.status === "fulfilled").length;
  if (successes > 0) {
    relayHintsCache.set(npub, {
      npub,
      inboxRelays,
      outboxRelays,
      fetchedAt: createdAt,
    });
    publishedRelayHintKeys.add(cacheKey);
  }

  return {
    eventId: event.id,
    successes,
    failures: results.filter((result) => result.status === "rejected").length,
    inboxRelays,
    outboxRelays,
    publishRelays,
  };
}

function getCachedRelayList(
  npub: string,
  kind: "inboxRelays" | "outboxRelays",
) {
  const cached = relayHintsCache.get(npub);
  return cached ? cached[kind] : [];
}

function primeNip65RelayHintsInBackground(npub: string, discoveryRelays: string[]) {
  const normalizedNpub = npub.trim();
  if (!normalizedNpub || relayHintsInflight.has(normalizedNpub)) {
    return;
  }

  void fetchNip65RelayHints({
    npub: normalizedNpub,
    discoveryRelays,
  }).catch(() => null);
}

export async function resolveNip65InboxRelays(input: {
  npub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = buildActorRelaySetRust({
    fallbackRelays: input.fallbackRelays,
    extraRelays: input.extraRelays,
  });
  if (isNip65Disabled()) {
    return fallbackRelays;
  }
  primeNip65RelayHintsInBackground(input.npub, fallbackRelays);
  return buildActorRelaySetRust({
    preferredRelays: getCachedRelayList(input.npub, "inboxRelays"),
    fallbackRelays,
  });
}

export async function resolveNip65OutboxRelays(input: {
  npub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = buildActorRelaySetRust({
    fallbackRelays: input.fallbackRelays,
    extraRelays: input.extraRelays,
  });
  if (isNip65Disabled()) {
    return fallbackRelays;
  }
  primeNip65RelayHintsInBackground(input.npub, fallbackRelays);
  return buildActorRelaySetRust({
    preferredRelays: getCachedRelayList(input.npub, "outboxRelays"),
    fallbackRelays,
  });
}

export async function resolveNip65ConversationRelays(input: {
  senderNpub?: string;
  recipientNpub: string;
  fallbackRelays: string[];
  extraRelays?: string[];
}): Promise<string[]> {
  const fallbackRelays = buildActorRelaySetRust({
    fallbackRelays: input.fallbackRelays,
    extraRelays: input.extraRelays,
  });
  if (isNip65Disabled()) {
    return fallbackRelays;
  }
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

  return buildConversationRelaySetRust({
    recipientInboxRelays,
    senderOutboxRelays,
    fallbackRelays,
  });
}

export function resetNip65RelayHintsForTests() {
  relayHintsCache.clear();
  publishedRelayHintKeys.clear();
}
