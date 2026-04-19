import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip17, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import type { ElectionInviteMessage } from "./questionnaireOptionA";
import type { SignerService } from "./services/signerService";
import { parseInviteFromUrl } from "./questionnaireInvite";

const OPTION_A_INVITE_DM_RELAYS_MAX = 12;
const OPTION_A_INVITE_DM_READ_RELAYS_MAX = 3;
const OPTION_A_INVITE_DM_MAX_WAIT_MS = 1500;
const OPTION_A_INVITE_DM_STAGGER_MS = 250;
const OPTION_A_INVITE_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;
const KIND_SEAL = 13;
const KIND_RUMOR_MESSAGE = 14;
const KIND_GIFT_WRAP = 1059;
const KIND_NIP17_RELAY_LIST = 10050;
const INVITE_PAYLOAD_TAG = "optiona_invite_payload";

type InviteDmEnvelope = {
  type: "optiona_invite_dm";
  schemaVersion: 1;
  invite: ElectionInviteMessage;
  sentAt: string;
};

function toHexPubkey(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return value;
}

function decodeNsecSecretKey(nsec: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Expected nsec.");
  }
  return decoded.data as Uint8Array;
}

function randomNow() {
  const now = Math.round(Date.now() / 1000);
  return Math.round(now - (Math.random() * TWO_DAYS_SECONDS));
}

function toNpub(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    return value;
  }
  return nip19.npubEncode(value);
}

function buildRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_DM_RELAYS]);
}

function selectReadRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_INVITE_DM_READ_RELAYS_MAX, relays.length));
}

function selectPublishRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_INVITE_DM_RELAYS_MAX, relays.length));
}

function parseNip17RelayListEvent(event: { kind?: number; tags?: string[][] }) {
  if (event.kind !== KIND_NIP17_RELAY_LIST || !Array.isArray(event.tags)) {
    return [] as string[];
  }
  return event.tags
    .filter((tag) => tag[0] === "relay" || tag[0] === "r")
    .map((tag) => tag[1]?.trim() ?? "")
    .filter((relay) => relay.startsWith("ws://") || relay.startsWith("wss://"));
}

async function fetchRecipientNip17Relays(input: {
  recipientHex: string;
  discoveryRelays: string[];
}) {
  try {
    const pool = getSharedNostrPool();
    const events = await pool.querySync(input.discoveryRelays, {
      kinds: [KIND_NIP17_RELAY_LIST],
      authors: [input.recipientHex],
      limit: 5,
    });
    return normalizeRelaysRust(
      [...events]
        .sort((left, right) => Number(right.created_at ?? 0) - Number(left.created_at ?? 0))
        .flatMap((event) => parseNip17RelayListEvent(event)),
    );
  } catch {
    return [] as string[];
  }
}

function parseInviteDmContent(content: string, tags?: string[][]): ElectionInviteMessage | null {
  const trimmed = content.trim();
  const urlMatch = trimmed.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      const { invite } = parseInviteFromUrl(url.search);
      if (invite) {
        return invite;
      }
    } catch {
      // Fall through to JSON parsing for legacy payloads.
    }
  }

  const tagPayload = Array.isArray(tags)
    ? tags.find((tag) => tag[0] === INVITE_PAYLOAD_TAG)?.[1]
    : null;
  if (typeof tagPayload === "string" && tagPayload.trim().length > 0) {
    try {
      const decoded = decodeURIComponent(tagPayload);
      const parsed = JSON.parse(decoded) as Partial<InviteDmEnvelope> | ElectionInviteMessage;
      const invite = (parsed as InviteDmEnvelope).type === "optiona_invite_dm"
        ? (parsed as InviteDmEnvelope).invite
        : parsed as ElectionInviteMessage;
      if (
        invite?.type === "election_invite"
        && invite.schemaVersion === 1
        && typeof invite.electionId === "string"
        && typeof invite.invitedNpub === "string"
        && typeof invite.coordinatorNpub === "string"
      ) {
        return invite;
      }
    } catch {
      // Fall through to legacy JSON parsing.
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<InviteDmEnvelope> | ElectionInviteMessage;
    const invite = (parsed as InviteDmEnvelope).type === "optiona_invite_dm"
      ? (parsed as InviteDmEnvelope).invite
      : parsed as ElectionInviteMessage;
    if (
      invite?.type !== "election_invite"
      || invite.schemaVersion !== 1
      || typeof invite.electionId !== "string"
      || typeof invite.invitedNpub !== "string"
      || typeof invite.coordinatorNpub !== "string"
    ) {
      return null;
    }
    return invite;
  } catch {
    return null;
  }
}

function createRumor(input: {
  senderHex: string;
  recipientHex: string;
  relayUrl?: string;
  envelope: InviteDmEnvelope;
}) {
  const messageContent = input.envelope.invite.voteUrl.trim() || JSON.stringify(input.envelope);
  const encodedEnvelope = encodeURIComponent(JSON.stringify(input.envelope));
  const rumor = {
    kind: KIND_RUMOR_MESSAGE,
    created_at: Math.round(Date.now() / 1000),
    tags: [
      input.relayUrl ? ["p", input.recipientHex, input.relayUrl] : ["p", input.recipientHex],
      ["alt", "Direct message"],
      ["subject", "Auditable Voting invite"],
      [INVITE_PAYLOAD_TAG, encodedEnvelope],
    ],
    content: messageContent,
    pubkey: input.senderHex,
  };
  return {
    ...rumor,
    id: getEventHash(rumor),
  };
}

function parseGiftWrapPayload(payload: string): NostrEvent | null {
  try {
    const parsed = JSON.parse(payload) as NostrEvent;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.kind !== KIND_SEAL
      || typeof parsed.pubkey !== "string"
      || typeof parsed.content !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function publishOptionAInviteDm(input: {
  signer: SignerService;
  invite: ElectionInviteMessage;
  fallbackNsec?: string;
  relays?: string[];
}) {
  const recipientHex = toHexPubkey(input.invite.invitedNpub);
  const fallbackRelays = buildRelays(input.relays);
  const recipientRelays = await fetchRecipientNip17Relays({
    recipientHex,
    discoveryRelays: selectPublishRelays(fallbackRelays),
  });
  const relays = selectPublishRelays(normalizeRelaysRust([...recipientRelays, ...fallbackRelays]));
  const envelope: InviteDmEnvelope = {
    type: "optiona_invite_dm",
    schemaVersion: 1,
    invite: input.invite,
    sentAt: new Date().toISOString(),
  };
  let senderHex = "";
  let signedSeal: NostrEvent | null = null;
  const fallbackSecret = input.fallbackNsec?.trim() ? decodeNsecSecretKey(input.fallbackNsec) : null;
  const trySignerFirst = !fallbackSecret;
  const signerAttempts: Array<"signer" | "fallback"> = trySignerFirst ? ["signer", "fallback"] : ["fallback", "signer"];
  let lastError: unknown = null;

  for (const attempt of signerAttempts) {
    try {
      if (attempt === "fallback") {
        if (!fallbackSecret) {
          continue;
        }
        senderHex = getPublicKey(fallbackSecret);
        const rumor = createRumor({ senderHex, recipientHex, relayUrl: relays[0], envelope });
        const sealConversationKey = nip44.v2.utils.getConversationKey(fallbackSecret, recipientHex);
        const sealCiphertext = nip44.v2.encrypt(JSON.stringify(rumor), sealConversationKey);
        signedSeal = finalizeEvent({
          kind: KIND_SEAL,
          created_at: randomNow(),
          tags: [],
          content: sealCiphertext,
        }, fallbackSecret);
        break;
      }

      if (!input.signer.nip44Encrypt) {
        throw new Error("Signer does not support NIP-44 encryption.");
      }
      const senderRaw = await input.signer.getPublicKey();
      senderHex = toHexPubkey(senderRaw);
      const rumor = createRumor({ senderHex, recipientHex, relayUrl: relays[0], envelope });
      const sealCiphertext = await input.signer.nip44Encrypt(recipientHex, JSON.stringify(rumor));
      const signed = await input.signer.signEvent({
        kind: KIND_SEAL,
        created_at: randomNow(),
        tags: [],
        content: sealCiphertext,
      });
      signedSeal = signed as unknown as NostrEvent;
      break;
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (!senderHex || !signedSeal) {
    throw lastError instanceof Error ? lastError : new Error("Could not sign Option A invite DM.");
  }

  const giftWrapSecret = generateSecretKey();
  const giftWrapConversationKey = nip44.v2.utils.getConversationKey(giftWrapSecret, recipientHex);
  const wrappedSeal = nip44.v2.encrypt(JSON.stringify(signedSeal), giftWrapConversationKey);
  const giftWrapEvent = finalizeEvent({
    kind: KIND_GIFT_WRAP,
    created_at: randomNow(),
    tags: [["p", recipientHex], ["expiration", String(Math.round(Date.now() / 1000) + ONE_DAY_SECONDS)]],
    content: wrappedSeal,
  }, giftWrapSecret);

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], giftWrapEvent, { maxWait: OPTION_A_INVITE_DM_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: OPTION_A_INVITE_DM_STAGGER_MS },
    ),
    {
      channel: `optiona-invite-dm:${toNpub(senderHex)}:${input.invite.invitedNpub}`,
      minIntervalMs: OPTION_A_INVITE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );

  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true as const }
      : {
          relay: relays[index],
          success: false as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  return {
    eventId: giftWrapEvent.id,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    relayResults,
  };
}

export async function fetchOptionAInviteDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as ElectionInviteMessage[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 50),
  });

  const unique = new Map<string, ElectionInviteMessage>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  let signerPermissionError: string | null = null;
  for (const event of sorted) {
    const wrapPubkey = typeof event.pubkey === "string" ? event.pubkey : "";
    if (!wrapPubkey || typeof event.content !== "string" || !event.content.trim()) {
      continue;
    }
    try {
      const sealPayload = await input.signer.nip44Decrypt(wrapPubkey, event.content);
      const sealEvent = parseGiftWrapPayload(sealPayload);
      if (!sealEvent) {
        continue;
      }
      const rumorPayload = await input.signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
      const rumor = JSON.parse(rumorPayload) as { content?: string; tags?: string[][] };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const invite = parseInviteDmContent(rumor.content, rumor.tags);
      if (!invite) {
        continue;
      }
      if (invite.invitedNpub !== recipientNpub) {
        continue;
      }
      if (input.electionId?.trim() && invite.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${invite.electionId}:${invite.coordinatorNpub}`;
      if (!unique.has(key)) {
        unique.set(key, invite);
      }
    } catch (error) {
      if (!signerPermissionError && error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("permission")
          || message.includes("rejected")
          || message.includes("denied")
          || message.includes("nip-44")
          || message.includes("nip44")
        ) {
          signerPermissionError = error.message;
        }
      }
      continue;
    }
  }
  if (unique.size === 0 && signerPermissionError) {
    throw new Error(`Could not read invite DMs: ${signerPermissionError}`);
  }
  return [...unique.values()];
}

export async function fetchOptionAInviteDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const recipientNpub = toNpub(recipientHex);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 50),
  });

  const unique = new Map<string, ElectionInviteMessage>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string; tags?: string[][] };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const invite = parseInviteDmContent(rumor.content, rumor.tags);
      if (!invite) {
        continue;
      }
      if (invite.invitedNpub !== recipientNpub) {
        continue;
      }
      if (input.electionId?.trim() && invite.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${invite.electionId}:${invite.coordinatorNpub}`;
      if (!unique.has(key)) {
        unique.set(key, invite);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}
