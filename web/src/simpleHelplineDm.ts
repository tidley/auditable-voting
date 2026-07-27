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
  recordRelayOutcome,
  rankRelaysByBackoff,
  selectRelaysWithBackoff,
  withRelayOutcomes,
} from "./relayBackoff";
import { parseInviteFromUrl } from "./questionnaireInvite";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { getSharedNostrPool } from "./sharedNostrPool";
import { normalizeRelaysRust, sortRecordsByCreatedAtDescRust } from "./wasm/auditableVotingCore";

const HELPLINE_DM_PUBLISH_MAX_WAIT_MS = 5000;
const HELPLINE_DM_PUBLISH_STAGGER_MS = 250;
const HELPLINE_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const HELPLINE_DM_RETRY_DELAY_MS = 5_000;
const HELPLINE_DM_SUBJECT = "Auditable Voting helpline";
const HELPLINE_DM_SENT_CACHE_PREFIX = "auditableVoting.helpline.sent.v1:";
const HELPLINE_DM_SENT_CACHE_LIMIT = 100;

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

export function selectHelplineDmReadRelays(relays: string[]) {
  const normalizedRelays = normalizeRelaysRust(relays);
  // Messages are written to every conversation relay. Read every healthy relay so a
  // message is not hidden merely because it landed outside an arbitrary read subset.
  return selectRelaysWithBackoff(normalizedRelays, normalizedRelays.length);
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
    return selectHelplineDmReadRelays(buildDmRelays(relays));
  }
  const resolved = await resolveNip65ConversationRelays({
    senderNpub,
    recipientNpub,
    fallbackRelays: buildDmRelays(relays),
  });
  return selectHelplineDmReadRelays(resolved);
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

export function contentIsQuestionnaireInviteLinkOnly(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(/^<?(https?:\/\/[^\s<>]+)>?$/i);
  if (!match?.[1]) {
    return false;
  }
  try {
    const url = new URL(match[1]);
    const params = url.searchParams;
    const role = params.get("role")?.trim().toLowerCase() ?? "";
    const hasQuestionnaireId = Boolean(
      (params.get("q") ?? "").trim()
      || (params.get("election_id") ?? "").trim()
      || (params.get("questionnaire") ?? "").trim(),
    );
    if (role === "voter" && hasQuestionnaireId) {
      return true;
    }
    return Boolean(parseInviteFromUrl(url).electionId && role === "voter");
  } catch {
    return false;
  }
}

function parseHelplineMessageFromGiftWrap(
  wrappedEvent: NostrEvent,
  actorSecretKey: Uint8Array,
  actorNpub: string,
  options?: { hideReceivedQuestionnaireInviteLinks?: boolean },
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
    if (options?.hideReceivedQuestionnaireInviteLinks && direction === "received" && contentIsQuestionnaireInviteLinkOnly(body)) {
      return null;
    }
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

function sentCacheKey(actorNpub: string) {
  return `${HELPLINE_DM_SENT_CACHE_PREFIX}${actorNpub}`;
}

function readSentMessageCache(actorNpub: string) {
  if (typeof localStorage === "undefined") {
    return [] as HelplineDmMessage[];
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(sentCacheKey(actorNpub)) ?? "[]") as HelplineDmMessage[];
    return Array.isArray(parsed)
      ? parsed.filter((message) => message?.direction === "sent" && message.senderNpub === actorNpub && Boolean(message.id))
      : [];
  } catch {
    return [] as HelplineDmMessage[];
  }
}

function writeSentMessageCache(actorNpub: string, messages: HelplineDmMessage[]) {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const sent = mergeHelplineDmMessages(messages)
      .filter((message) => message.direction === "sent" && message.senderNpub === actorNpub)
      .slice(-HELPLINE_DM_SENT_CACHE_LIMIT);
    localStorage.setItem(sentCacheKey(actorNpub), JSON.stringify(sent));
  } catch {
    // Message persistence is a UI convenience; relay delivery remains authoritative.
  }
}

function rememberSentMessage(message: HelplineDmMessage) {
  writeSentMessageCache(message.senderNpub, [...readSentMessageCache(message.senderNpub), message]);
}

function mergeWithSentMessageCache(actorNpub: string, messages: HelplineDmMessage[]) {
  return mergeHelplineDmMessages([...messages, ...readSentMessageCache(actorNpub)]);
}

export function mergeHelplineDmMessages(messages: HelplineDmMessage[]) {
  const byId = new Map<string, HelplineDmMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return sortMessagesChronologically([...byId.values()]);
}

type HelplineDmActor = ReturnType<typeof decodeNsecSecretKey>;

type HelplineDmFeedListener = {
  allowedPeers: Set<string>;
  onMessages: (messages: HelplineDmMessage[]) => void;
  onError?: (error: Error) => void;
};

type HelplineDmFeed = {
  key: string;
  actor: HelplineDmActor;
  relays?: string[];
  limit: number;
  hideReceivedQuestionnaireInviteLinks: boolean;
  messages: Map<string, HelplineDmMessage>;
  listeners: Set<HelplineDmFeedListener>;
  started: boolean;
  historyLoaded: boolean;
  closed: boolean;
  subscription: { close: () => void } | null;
  retryTimer: ReturnType<typeof globalThis.setTimeout> | null;
};

const helplineDmFeeds = new Map<string, HelplineDmFeed>();

function allowedPeerSet(values?: string[]) {
  return new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function helplineDmFeedKey(input: {
  actorNpub: string;
  relays?: string[];
  limit: number;
  hideReceivedQuestionnaireInviteLinks: boolean;
}) {
  return [
    input.actorNpub,
    normalizeRelaysRust(input.relays ?? []).join("|"),
    String(input.limit),
    input.hideReceivedQuestionnaireInviteLinks ? "hide-invite-links" : "all-messages",
  ].join("::");
}

function messagesForListener(feed: HelplineDmFeed, listener: HelplineDmFeedListener) {
  const messages = mergeWithSentMessageCache(feed.actor.npub, [...feed.messages.values()]).filter((message) => {
    if (listener.allowedPeers.size === 0) {
      return true;
    }
    return listener.allowedPeers.has(message.peerNpub);
  });
  return mergeHelplineDmMessages(messages);
}

function publishFeedMessages(feed: HelplineDmFeed) {
  for (const listener of feed.listeners) {
    listener.onMessages(messagesForListener(feed, listener));
  }
}

function publishFeedError(feed: HelplineDmFeed, error: Error) {
  for (const listener of feed.listeners) {
    listener.onError?.(error);
  }
}

function rememberFeedMessage(feed: HelplineDmFeed, message: HelplineDmMessage) {
  const isNewMessage = !feed.messages.has(message.id);
  feed.messages.set(message.id, message);
  return isNewMessage;
}

function closeFeedIfUnused(feed: HelplineDmFeed) {
  if (feed.listeners.size > 0) {
    return;
  }
  feed.closed = true;
  feed.subscription?.close();
  if (feed.retryTimer) {
    globalThis.clearTimeout(feed.retryTimer);
    feed.retryTimer = null;
  }
  helplineDmFeeds.delete(feed.key);
}

function retryHelplineDmFeed(feed: HelplineDmFeed) {
  if (feed.closed || feed.retryTimer || feed.listeners.size === 0) {
    return;
  }
  feed.retryTimer = globalThis.setTimeout(() => {
    feed.retryTimer = null;
    feed.started = false;
    startHelplineDmFeed(feed);
  }, HELPLINE_DM_RETRY_DELAY_MS);
}

async function fetchHelplineDmMessagesFromRelays(input: {
  actor: HelplineDmActor;
  dmRelays: string[];
  limit?: number;
  allowedPeerNpubs?: string[];
  hideReceivedQuestionnaireInviteLinks?: boolean;
}) {
  const pool = getSharedNostrPool();
  const wrappedEvents = await withRelayOutcomes(input.dmRelays, pool.querySync(input.dmRelays, {
    kinds: [1059],
    "#p": [input.actor.publicHex],
    limit: input.limit ?? 300,
  }));
  const allowedPeers = allowedPeerSet(input.allowedPeerNpubs);
  const byLogicalId = new Map<string, HelplineDmMessage>();
  for (const wrappedEvent of wrappedEvents) {
    const message = parseHelplineMessageFromGiftWrap(wrappedEvent, input.actor.secretKey, input.actor.npub, {
      hideReceivedQuestionnaireInviteLinks: input.hideReceivedQuestionnaireInviteLinks,
    });
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

function startHelplineDmFeed(feed: HelplineDmFeed) {
  if (feed.started) {
    return;
  }
  feed.started = true;

  void resolveRecipientInboxRelays(feed.actor.npub, feed.relays).then(async (inboxRelays) => {
    if (feed.closed) {
      return;
    }
    const dmRelays = selectHelplineDmReadRelays(inboxRelays);
    const pool = getSharedNostrPool();
    feed.subscription = pool.subscribeMany(dmRelays, {
      kinds: [1059],
      "#p": [feed.actor.publicHex],
      since: Math.floor(Date.now() / 1000),
    }, {
      onevent: (wrappedEvent) => {
        const message = parseHelplineMessageFromGiftWrap(wrappedEvent, feed.actor.secretKey, feed.actor.npub, {
          hideReceivedQuestionnaireInviteLinks: feed.hideReceivedQuestionnaireInviteLinks,
        });
        if (!message) {
          return;
        }
        if (rememberFeedMessage(feed, message)) {
          publishFeedMessages(feed);
        }
      },
      onclose: (reasons) => {
        recordRelayCloseReasons(reasons);
        feed.subscription = null;
        feed.started = false;
        retryHelplineDmFeed(feed);
      },
    });

    try {
      const fetched = await fetchHelplineDmMessagesFromRelays({
        actor: feed.actor,
        dmRelays,
        limit: feed.limit,
        hideReceivedQuestionnaireInviteLinks: feed.hideReceivedQuestionnaireInviteLinks,
      });
      if (feed.closed) {
        return;
      }
      for (const message of fetched) {
        feed.messages.set(message.id, message);
      }
      for (const message of readSentMessageCache(feed.actor.npub)) {
        feed.messages.set(message.id, message);
      }
      feed.historyLoaded = true;
      publishFeedMessages(feed);
    } catch (error) {
      if (!feed.closed && error instanceof Error) {
        publishFeedError(feed, error);
      }
    }
  }).catch((error) => {
    if (!feed.closed && error instanceof Error) {
      publishFeedError(feed, error);
      feed.started = false;
      retryHelplineDmFeed(feed);
    }
  });
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
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }
  const message: HelplineDmMessage = {
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
  };
  rememberSentMessage(message);

  return {
    eventIds: events.map((event) => event.id),
    message,
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
  hideReceivedQuestionnaireInviteLinks?: boolean;
}) {
  const actor = decodeNsecSecretKey(input.actorNsec);
  const inboxRelays = await resolveRecipientInboxRelays(actor.npub, input.relays);
  const dmRelays = selectHelplineDmReadRelays(inboxRelays);
  const messages = await fetchHelplineDmMessagesFromRelays({
    actor,
    dmRelays,
    limit: input.limit,
    allowedPeerNpubs: input.allowedPeerNpubs,
    hideReceivedQuestionnaireInviteLinks: input.hideReceivedQuestionnaireInviteLinks,
  });
  const allowedPeers = allowedPeerSet(input.allowedPeerNpubs);
  return mergeWithSentMessageCache(actor.npub, messages)
    .filter((message) => allowedPeers.size === 0 || allowedPeers.has(message.peerNpub));
}

export function subscribeHelplineDmMessages(input: {
  actorNsec: string;
  relays?: string[];
  limit?: number;
  allowedPeerNpubs?: string[];
  hideReceivedQuestionnaireInviteLinks?: boolean;
  onMessages: (messages: HelplineDmMessage[]) => void;
  onError?: (error: Error) => void;
}) {
  const actor = decodeNsecSecretKey(input.actorNsec);
  const limit = input.limit ?? 300;
  const key = helplineDmFeedKey({
    actorNpub: actor.npub,
    relays: input.relays,
    limit,
    hideReceivedQuestionnaireInviteLinks: Boolean(input.hideReceivedQuestionnaireInviteLinks),
  });
  let feed = helplineDmFeeds.get(key);
  if (!feed) {
    feed = {
      key,
      actor,
      relays: input.relays,
      limit,
      hideReceivedQuestionnaireInviteLinks: Boolean(input.hideReceivedQuestionnaireInviteLinks),
      messages: new Map(),
      listeners: new Set(),
      started: false,
      historyLoaded: false,
      closed: false,
      subscription: null,
      retryTimer: null,
    };
    helplineDmFeeds.set(key, feed);
  }

  const listener: HelplineDmFeedListener = {
    allowedPeers: allowedPeerSet(input.allowedPeerNpubs),
    onMessages: input.onMessages,
    onError: input.onError,
  };
  feed.listeners.add(listener);

  if (feed.historyLoaded || feed.messages.size > 0) {
    listener.onMessages(messagesForListener(feed, listener));
  }

  startHelplineDmFeed(feed);

  return () => {
    feed.listeners.delete(listener);
    closeFeedIfUnused(feed);
  };
}

export function resetHelplineDmMessageFeedsForTests() {
  for (const feed of helplineDmFeeds.values()) {
    feed.closed = true;
    feed.subscription?.close();
    if (feed.retryTimer) {
      globalThis.clearTimeout(feed.retryTimer);
    }
  }
  helplineDmFeeds.clear();
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
