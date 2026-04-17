import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip17, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import type { BlindBallotIssuance, BlindBallotRequest } from "./questionnaireOptionA";
import type { SignerService } from "./services/signerService";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

const OPTION_A_BLIND_DM_RELAYS_MAX = 3;
const OPTION_A_BLIND_DM_READ_RELAYS_MAX = 3;
const OPTION_A_BLIND_DM_MAX_WAIT_MS = 1500;
const OPTION_A_BLIND_DM_STAGGER_MS = 250;
const OPTION_A_BLIND_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
const KIND_SEAL = 13;
const KIND_RUMOR_MESSAGE = 14;
const KIND_GIFT_WRAP = 1059;

type BlindRequestDmEnvelope = {
  type: "optiona_blind_request_dm";
  schemaVersion: 1;
  request: BlindBallotRequest;
  sentAt: string;
};

type BlindIssuanceDmEnvelope = {
  type: "optiona_blind_issuance_dm";
  schemaVersion: 1;
  issuance: BlindBallotIssuance;
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
  return relays.slice(0, Math.min(OPTION_A_BLIND_DM_READ_RELAYS_MAX, relays.length));
}

function selectPublishRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_BLIND_DM_RELAYS_MAX, relays.length));
}

function parseBlindRequestDmContent(content: string): BlindBallotRequest | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindRequestDmEnvelope> | BlindBallotRequest;
    const request = (parsed as BlindRequestDmEnvelope).type === "optiona_blind_request_dm"
      ? (parsed as BlindRequestDmEnvelope).request
      : parsed as BlindBallotRequest;
    if (
      request?.type !== "blind_ballot_request"
      || request.schemaVersion !== 1
      || typeof request.electionId !== "string"
      || typeof request.requestId !== "string"
      || typeof request.invitedNpub !== "string"
    ) {
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

function parseBlindIssuanceDmContent(content: string): BlindBallotIssuance | null {
  try {
    const parsed = JSON.parse(content) as Partial<BlindIssuanceDmEnvelope> | BlindBallotIssuance;
    const issuance = (parsed as BlindIssuanceDmEnvelope).type === "optiona_blind_issuance_dm"
      ? (parsed as BlindIssuanceDmEnvelope).issuance
      : parsed as BlindBallotIssuance;
    if (
      issuance?.type !== "blind_ballot_response"
      || issuance.schemaVersion !== 1
      || typeof issuance.electionId !== "string"
      || typeof issuance.requestId !== "string"
      || typeof issuance.invitedNpub !== "string"
    ) {
      return null;
    }
    return issuance;
  } catch {
    return null;
  }
}

function createRumor(input: {
  senderHex: string;
  envelope: BlindRequestDmEnvelope | BlindIssuanceDmEnvelope;
}) {
  const rumor = {
    kind: KIND_RUMOR_MESSAGE,
    created_at: Math.round(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(input.envelope),
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

async function publishEnvelope(input: {
  signer: SignerService;
  recipientNpub: string;
  envelope: BlindRequestDmEnvelope | BlindIssuanceDmEnvelope;
  fallbackNsec?: string;
  relays?: string[];
  channel: string;
}) {
  const recipientHex = toHexPubkey(input.recipientNpub);
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
        const rumor = createRumor({ senderHex, envelope: input.envelope });
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
      const rumor = createRumor({ senderHex, envelope: input.envelope });
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
    throw lastError instanceof Error ? lastError : new Error("Could not sign Option A blind DM.");
  }

  const giftWrapSecret = generateSecretKey();
  const giftWrapConversationKey = nip44.v2.utils.getConversationKey(giftWrapSecret, recipientHex);
  const wrappedSeal = nip44.v2.encrypt(JSON.stringify(signedSeal), giftWrapConversationKey);
  const giftWrapEvent = finalizeEvent({
    kind: KIND_GIFT_WRAP,
    created_at: randomNow(),
    tags: [["p", recipientHex]],
    content: wrappedSeal,
  }, giftWrapSecret);

  const relays = selectPublishRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], giftWrapEvent, { maxWait: OPTION_A_BLIND_DM_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: OPTION_A_BLIND_DM_STAGGER_MS },
    ),
    {
      channel: input.channel,
      minIntervalMs: OPTION_A_BLIND_DM_MIN_PUBLISH_INTERVAL_MS,
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

export async function publishOptionABlindRequestDm(input: {
  signer: SignerService;
  recipientNpub: string;
  request: BlindBallotRequest;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-request:${input.request.electionId}:${input.request.requestId}`,
    envelope: {
      type: "optiona_blind_request_dm",
      schemaVersion: 1,
      request: input.request,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function publishOptionABlindIssuanceDm(input: {
  signer: SignerService;
  recipientNpub: string;
  issuance: BlindBallotIssuance;
  fallbackNsec?: string;
  relays?: string[];
}) {
  return publishEnvelope({
    signer: input.signer,
    recipientNpub: input.recipientNpub,
    fallbackNsec: input.fallbackNsec,
    relays: input.relays,
    channel: `optiona-blind-issuance:${input.issuance.electionId}:${input.issuance.requestId}`,
    envelope: {
      type: "optiona_blind_issuance_dm",
      schemaVersion: 1,
      issuance: input.issuance,
      sentAt: new Date().toISOString(),
    },
  });
}

export async function fetchOptionABlindRequestDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindBallotRequest[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindBallotRequest>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
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
      const rumor = JSON.parse(rumorPayload) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const request = parseBlindRequestDmContent(rumor.content);
      if (!request) {
        continue;
      }
      if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, request);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindRequestDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindBallotRequest>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const request = parseBlindRequestDmContent(rumor.content);
      if (!request) {
        continue;
      }
      if (input.electionId?.trim() && request.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${request.electionId}:${request.requestId}:${request.invitedNpub}`;
      if (!unique.has(key)) {
        unique.set(key, request);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindIssuanceDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as BlindBallotIssuance[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindBallotIssuance>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
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
      const rumor = JSON.parse(rumorPayload) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const issuance = parseBlindIssuanceDmContent(rumor.content);
      if (!issuance) {
        continue;
      }
      if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, issuance);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

export async function fetchOptionABlindIssuanceDmsWithNsec(input: {
  nsec: string;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  const secretKey = decodeNsecSecretKey(input.nsec);
  const recipientHex = getPublicKey(secretKey);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 100),
  });

  const unique = new Map<string, BlindBallotIssuance>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    try {
      const rumor = nip17.unwrapEvent(event as never, secretKey) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const issuance = parseBlindIssuanceDmContent(rumor.content);
      if (!issuance) {
        continue;
      }
      if (input.electionId?.trim() && issuance.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${issuance.electionId}:${issuance.requestId}:${issuance.issuanceId}`;
      if (!unique.has(key)) {
        unique.set(key, issuance);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}
