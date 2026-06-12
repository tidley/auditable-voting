import { getEventHash, getPublicKey, nip17, nip19, nip59, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { mapRelayPublishResult, type RelayPublishResult } from "./nostrPublishResult";
import {
  isNip65EnabledForSession,
  publishOwnNip65RelayHints,
  resolveNip65ConversationRelays,
  resolveNip65InboxRelays,
} from "./nip65RelayHints";
import {
  recordRelayCloseReasons,
  rankRelaysByBackoff,
  selectRelaysWithBackoff,
} from "./relayBackoff";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { getSharedNostrPool } from "./sharedNostrPool";
import { normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";

const HELPLINE_DM_PUBLISH_MAX_WAIT_MS = 1500;
const HELPLINE_DM_PUBLISH_STAGGER_MS = 250;
const HELPLINE_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const HELPLINE_DM_READ_RELAYS_MAX = 5;
const HELPLINE_DM_SUBJECT = "Auditable Voting helpline";

export type HelplineDmMessage = {
  id: string;
  dmEventId: string;
  senderNpub: string;
  recipientNpubs: string[];
  peerNpub: string;
  direction: "sent" | "received";
  body: string;
  subject: string | null;
  createdAt: string;
};

export type HelplineDmPublishResult = {
  eventIds: string[];
  message: HelplineDmMessage;
  successes: number;
  failures: number;
  relayResults: Array<RelayPublishResult & { eventId: string }>;
};

function buildDmRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...SIMPLE_DM_RELAYS, ...(relays ?? [])]));
}

function selectDmReadRelays(relays: string[], maxRelays = HELPLINE_DM_READ_RELAYS_MAX) {
  return selectRelaysWithBackoff(normalizeRelaysRust(relays), maxRelays);
}

function decodeNsecSecretKey(nsec: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Identity key must be an nsec.");
  }
  const secretKey = decoded.data as Uint8Array;
  const publicHex = getPublicKey(secretKey);
  return {
    secretKey,
    publicHex,
    npub: nip19.npubEncode(publicHex),
  };
}

function decodeNpubHex(npub: string) {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Recipient must be an npub.");
  }
  return decoded.data as string;
}

function npubFromHex(hex: string) {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return "";
  }
}

async function resolveRecipientInboxRelays(recipientNpub: string, relays?: string[]) {
  if (!isNip65EnabledForSession()) {
    return buildDmRelays(relays);
  }
  return resolveNip65InboxRelays({
    npub: recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
}

async function resolveConversationDmRelays(
  recipientNpub: string,
  senderNpub?: string,
  relays?: string[],
) {
  if (!isNip65EnabledForSession()) {
    return selectDmReadRelays(buildDmRelays(relays));
  }
  const resolved = await resolveNip65ConversationRelays({
    senderNpub,
    recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
  return selectDmReadRelays(resolved);
}

async function publishOwnRelayHintsIfEnabled(input: Parameters<typeof publishOwnNip65RelayHints>[0]) {
  if (!isNip65EnabledForSession()) {
    return null;
  }
  return publishOwnNip65RelayHints(input).catch(() => null);
}

function parseSubject(tags: string[][] | undefined) {
  return tags?.find((tag) => tag[0] === "subject")?.[1]?.trim() || null;
}

function parseRecipientNpubs(tags: string[][] | undefined) {
  return (tags ?? [])
    .filter((tag) => tag[0] === "p" && tag[1])
    .map((tag) => npubFromHex(tag[1]))
    .filter((value) => value.length > 0);
}

function contentLooksLikeInternalAction(content: string) {
  try {
    const parsed = JSON.parse(content) as { action?: unknown; type?: unknown };
    const action = typeof parsed.action === "string" ? parsed.action : "";
    const type = typeof parsed.type === "string" ? parsed.type : "";
    return action.startsWith("simple_") || type.startsWith("optiona_");
  } catch {
    return false;
  }
}

function parseHelplineMessageFromGiftWrap(
  wrappedEvent: NostrEvent,
  actorSecretKey: Uint8Array,
  actorNpub: string,
): HelplineDmMessage | null {
  try {
    const rumor = nip17.unwrapEvent(wrappedEvent, actorSecretKey) as {
      id?: string;
      pubkey?: string;
      created_at?: number;
      kind?: number;
      tags?: string[][];
      content?: string;
    };
    if (rumor.kind !== 14 || typeof rumor.content !== "string") {
      return null;
    }
    const body = rumor.content.trim();
    if (!body || contentLooksLikeInternalAction(body)) {
      return null;
    }
    const senderNpub = rumor.pubkey ? npubFromHex(rumor.pubkey) : "";
    if (!senderNpub) {
      return null;
    }
    const recipientNpubs = parseRecipientNpubs(rumor.tags);
    const direction = senderNpub === actorNpub ? "sent" : "received";
    const peerNpub = direction === "sent"
      ? recipientNpubs.find((value) => value !== actorNpub) ?? recipientNpubs[0] ?? ""
      : senderNpub;
    if (!peerNpub) {
      return null;
    }
    const createdAtSeconds = Number(rumor.created_at ?? wrappedEvent.created_at ?? 0);
    const createdAt = Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
      ? new Date(createdAtSeconds * 1000).toISOString()
      : new Date().toISOString();
    const logicalId = [
      senderNpub,
      recipientNpubs.join(","),
      createdAt,
      body,
    ].join(":");
    return {
      id: rumor.id?.trim() || logicalId,
      dmEventId: wrappedEvent.id,
      senderNpub,
      recipientNpubs,
      peerNpub,
      direction,
      body,
      subject: parseSubject(rumor.tags),
      createdAt,
    };
  } catch {
    return null;
  }
}

function sortMessagesChronologically(messages: HelplineDmMessage[]) {
  return [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) || Number.isFinite(rightTime)) {
      return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
    }
    return left.id.localeCompare(right.id);
  });
}

export function mergeHelplineDmMessages(messages: HelplineDmMessage[]) {
  const byId = new Map<string, HelplineDmMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return sortMessagesChronologically([...byId.values()]);
}

export async function sendHelplineDmMessage(input: {
  senderNsec: string;
  recipientNpub: string;
  message: string;
  subject?: string;
  relays?: string[];
}): Promise<HelplineDmPublishResult> {
  const sender = decodeNsecSecretKey(input.senderNsec);
  const recipientHex = decodeNpubHex(input.recipientNpub);
  const body = input.message.trim();
  if (!body) {
    throw new Error("Message is empty.");
  }
  const dmRelays = await resolveConversationDmRelays(input.recipientNpub, sender.npub, input.relays);
  await publishOwnRelayHintsIfEnabled({
    secretKey: sender.secretKey,
    inboxRelays: dmRelays,
    outboxRelays: dmRelays,
    publishRelays: dmRelays,
    channel: `nip65:${sender.npub}`,
  });
  const createdAtSeconds = Math.ceil(Date.now() / 1000);
  const subject = input.subject?.trim() || HELPLINE_DM_SUBJECT;
  const rumorEvent = {
    kind: 14,
    content: body,
    created_at: createdAtSeconds,
    tags: [
      dmRelays[0] ? ["p", recipientHex, dmRelays[0]] : ["p", recipientHex],
      ["subject", subject],
    ],
    pubkey: sender.publicHex,
  };
  const rumorId = getEventHash(rumorEvent);
  const events = nip59.wrapManyEvents(
    {
      kind: rumorEvent.kind,
      content: rumorEvent.content,
      created_at: rumorEvent.created_at,
      tags: rumorEvent.tags,
    },
    sender.secretKey,
    [recipientHex],
  );
  const pool = getSharedNostrPool();
  const relayResults = await queueNostrPublish(async () => {
    const batches = await Promise.all(events.map(async (event) => {
      const results = await publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: HELPLINE_DM_PUBLISH_MAX_WAIT_MS })[0],
        dmRelays,
        { staggerMs: HELPLINE_DM_PUBLISH_STAGGER_MS },
      );
      return results.map((result, index) => ({
        ...mapRelayPublishResult(result, dmRelays[index]),
        eventId: event.id,
      }));
    }));
    return batches.flat();
  }, {
    channel: `helpline-dm:${sender.npub}:${input.recipientNpub}`,
    minIntervalMs: HELPLINE_DM_MIN_PUBLISH_INTERVAL_MS,
  });

  return {
    eventIds: events.map((event) => event.id),
    message: {
      id: rumorId,
      dmEventId: events.find((event) => event.tags.some((tag) => tag[0] === "p" && tag[1] === sender.publicHex))?.id
        ?? events[0]?.id
        ?? rumorId,
      senderNpub: sender.npub,
      recipientNpubs: [input.recipientNpub],
      peerNpub: input.recipientNpub,
      direction: "sent",
      body,
      subject,
      createdAt: new Date(createdAtSeconds * 1000).toISOString(),
    },
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    relayResults,
  };
}

export async function fetchHelplineDmMessages(input: {
  actorNsec: string;
  relays?: string[];
  limit?: number;
  allowedPeerNpubs?: string[];
}) {
  const actor = decodeNsecSecretKey(input.actorNsec);
  const inboxRelays = await resolveRecipientInboxRelays(actor.npub, input.relays);
  const dmRelays = selectDmReadRelays(inboxRelays);
  const pool = getSharedNostrPool();
  const wrappedEvents = await pool.querySync(dmRelays, {
    kinds: [1059],
    "#p": [actor.publicHex],
    limit: input.limit ?? 300,
  });
  const allowedPeers = new Set((input.allowedPeerNpubs ?? []).map((value) => value.trim()).filter(Boolean));
  const byLogicalId = new Map<string, HelplineDmMessage>();
  for (const wrappedEvent of wrappedEvents) {
    const message = parseHelplineMessageFromGiftWrap(wrappedEvent, actor.secretKey, actor.npub);
    if (!message) {
      continue;
    }
    if (allowedPeers.size > 0 && !allowedPeers.has(message.peerNpub)) {
      continue;
    }
    byLogicalId.set(message.id, message);
  }
  return mergeHelplineDmMessages([...byLogicalId.values()]);
}

export function subscribeHelplineDmMessages(input: {
  actorNsec: string;
  relays?: string[];
  limit?: number;
  allowedPeerNpubs?: string[];
  onMessages: (messages: HelplineDmMessage[]) => void;
  onError?: (error: Error) => void;
}) {
  const actor = decodeNsecSecretKey(input.actorNsec);
  const allowedPeers = new Set((input.allowedPeerNpubs ?? []).map((value) => value.trim()).filter(Boolean));
  const messages = new Map<string, HelplineDmMessage>();
  let closed = false;
  let subscription: { close: () => void } | null = null;

  const publishMessages = () => {
    input.onMessages(mergeHelplineDmMessages([...messages.values()]));
  };

  void fetchHelplineDmMessages(input).then((fetched) => {
    if (closed) {
      return;
    }
    for (const message of fetched) {
      messages.set(message.id, message);
    }
    publishMessages();
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  void resolveRecipientInboxRelays(actor.npub, input.relays).then((inboxRelays) => {
    if (closed) {
      return;
    }
    const dmRelays = selectDmReadRelays(inboxRelays);
    const pool = getSharedNostrPool();
    subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [actor.publicHex],
      limit: input.limit ?? 300,
    }, {
      onevent: (wrappedEvent) => {
        const message = parseHelplineMessageFromGiftWrap(wrappedEvent, actor.secretKey, actor.npub);
        if (!message) {
          return;
        }
        if (allowedPeers.size > 0 && !allowedPeers.has(message.peerNpub)) {
          return;
        }
        messages.set(message.id, message);
        publishMessages();
      },
      onclose: (reasons) => {
        recordRelayCloseReasons(reasons);
      },
    });
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    subscription?.close();
  };
}

export function latestHelplineMessageByPeer(messages: HelplineDmMessage[]) {
  const sortedNewestFirst = sortRecordsByCreatedAtDescRust(messages);
  const byPeer = new Map<string, HelplineDmMessage>();
  for (const message of sortedNewestFirst) {
    if (!byPeer.has(message.peerNpub)) {
      byPeer.set(message.peerNpub, message);
    }
  }
  return byPeer;
}
