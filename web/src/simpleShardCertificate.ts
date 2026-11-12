import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type VerifiedEvent,
} from "nostr-tools";
import { blindCredential, signBlindCredential, finalizeBlindCredential, verifyBlindCredential } from "./wasm/blindCredentials";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { publishOwnNip65RelayHints, resolveNip65OutboxRelays } from "./nip65RelayHints";
import { getSharedNostrPool } from "./sharedNostrPool";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
  SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
} from "./simpleVotingSession";
import { recordRelayCloseReasons, recordRelayOutcome, rankRelaysByBackoff, selectRelaysWithBackoff, withRelayOutcomes } from "./relayBackoff";
import { sha256Hex } from "./tokenIdentity";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

export const SIMPLE_BLIND_KEY_KIND = 38993;
export const SIMPLE_BLIND_SCHEME = "rsabssa-sha384-pss-deterministic-v1";
export const SIMPLE_BLIND_KEY_BITS = 3072;
export const SIMPLE_BLIND_HASH = "SHA-384";
export const SIMPLE_BLIND_SALT_LENGTH = 48;
const SIMPLE_BLIND_DOMAIN_SEPARATOR = "auditable-voting/simple-blind/v2";
const SIMPLE_PUBLIC_READ_RELAYS_MAX = 3;
const SIMPLE_BLIND_KEY_BACKFILL_INTERVAL_MS = 5000;

export type SimpleBlindPublicKey = {
  scheme: typeof SIMPLE_BLIND_SCHEME;
  keyId: string;
  bits: number;
  hash: typeof SIMPLE_BLIND_HASH;
  saltLength: typeof SIMPLE_BLIND_SALT_LENGTH;
  n: string;
  e: string;
};

export type SimpleBlindPrivateKey = SimpleBlindPublicKey & {
  d: string;
  jwk: JsonWebKey;
};

export type SimpleBlindKeyAnnouncement = {
  coordinatorNpub: string;
  votingId: string;
  publicKey: SimpleBlindPublicKey;
  createdAt: string;
  event: VerifiedEvent;
};

export type SimpleBlindIssuanceRequest = {
  requestId: string;
  votingId: string;
  blindedMessage: string;
  createdAt: string;
};

export type SimpleBlindRequestSecret = {
  requestId: string;
  votingId: string;
  tokenMessage: string;
  blindingFactor: string;
  publicKey: SimpleBlindPublicKey;
  createdAt: string;
};

export type SimpleBlindShareResponse = {
  shareId: string;
  requestId: string;
  coordinatorNpub: string;
  blindedSignature: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  createdAt: string;
  keyAnnouncementEvent: VerifiedEvent;
};

export type SimpleShardCertificate = {
  shareId: string;
  requestId: string;
  coordinatorNpub: string;
  votingId: string;
  tokenMessage: string;
  unblindedSignature: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  createdAt: string;
  keyAnnouncementEvent: VerifiedEvent;
};

export type ParsedSimpleShardCertificate = {
  shardId: string;
  requestId: string;
  coordinatorNpub: string;
  votingId: string;
  tokenCommitment: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  createdAt: string;
  publicKey: SimpleBlindPublicKey;
  event: SimpleShardCertificate;
};

export type SimplePublicShardProof = {
  coordinatorNpub: string;
  votingId: string;
  tokenCommitment: string;
  unblindedSignature: string;
  shareIndex: number;
  keyAnnouncementEvent: VerifiedEvent;
};

export type ParsedSimplePublicShardProof = {
  coordinatorNpub: string;
  votingId: string;
  tokenCommitment: string;
  shareIndex: number;
  publicKey: SimpleBlindPublicKey;
  keyAnnouncement: SimpleBlindKeyAnnouncement;
  event: SimplePublicShardProof;
};

type RsaJwk = {
  n?: string;
  e?: string;
  d?: string;
};

type BlindKeySubscriber = {
  id: number;
  votingId?: string;
  onAnnouncement: (announcement: SimpleBlindKeyAnnouncement | null) => void;
  onError?: (error: Error) => void;
};

type BlindKeySubscriptionState = {
  subscribers: Map<number, BlindKeySubscriber>;
  announcements: Map<string, SimpleBlindKeyAnnouncement>;
  subscription: { close: (reason?: string) => Promise<void> | void } | null;
  intervalId: ReturnType<typeof globalThis.setInterval> | null;
  closed: boolean;
};

const blindKeySubscriptions = new Map<string, BlindKeySubscriptionState>();
let nextBlindKeySubscriberId = 1;

function buildPublicRelays(relays?: string[]) {
  return rankRelaysByBackoff(normalizeRelaysRust([...SIMPLE_PUBLIC_RELAYS, ...(relays ?? [])]));
}

function selectPublicReadRelays(relays: string[]) {
  return selectRelaysWithBackoff(relays, SIMPLE_PUBLIC_READ_RELAYS_MAX);
}

function buildBlindKeySubscriptionKey(coordinatorNpub: string, relays?: string[]) {
  return `${coordinatorNpub.trim()}::${buildPublicRelays(relays).join("|")}`;
}

function sortAnnouncementsDescending(values: SimpleBlindKeyAnnouncement[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function latestMatchingBlindKeyAnnouncement(
  announcements: Iterable<SimpleBlindKeyAnnouncement>,
  votingId?: string,
) {
  const matches = [...announcements].filter((announcement) => (
    !votingId || announcement.votingId === votingId
  ));
  return sortAnnouncementsDescending(matches)[0] ?? null;
}

function notifyBlindKeySubscribers(state: BlindKeySubscriptionState) {
  for (const subscriber of state.subscribers.values()) {
    subscriber.onAnnouncement(
      latestMatchingBlindKeyAnnouncement(state.announcements.values(), subscriber.votingId),
    );
  }
}

async function ensureBlindKeySubscription(input: {
  coordinatorNpub: string;
  relays?: string[];
}) {
  const subscriptionKey = buildBlindKeySubscriptionKey(input.coordinatorNpub, input.relays);
  const existing = blindKeySubscriptions.get(subscriptionKey);
  if (existing) {
    return existing;
  }

  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Organiser value must be an npub.");
  }

  const state: BlindKeySubscriptionState = {
    subscribers: new Map(),
    announcements: new Map(),
    subscription: null,
    intervalId: null,
    closed: false,
  };
  blindKeySubscriptions.set(subscriptionKey, state);

  const fallbackRelays = buildPublicRelays(input.relays);
  const pool = getSharedNostrPool();

  void resolveNip65OutboxRelays({
    npub: input.coordinatorNpub,
    fallbackRelays,
  }).then(async (relays) => {
    if (state.closed) {
      return;
    }

    const readRelays = selectPublicReadRelays(relays);
    const refreshFromHistory = async () => {
      const events = await withRelayOutcomes(readRelays, pool.querySync(readRelays, {
        kinds: [SIMPLE_BLIND_KEY_KIND],
        authors: [decoded.data as string],
        limit: 50,
      }));

      for (const event of events) {
        const announcement = parseSimpleBlindKeyAnnouncement(
          event as VerifiedEvent,
          input.coordinatorNpub,
        );
        if (announcement) {
          state.announcements.set(announcement.event.id, announcement);
        }
      }
      notifyBlindKeySubscribers(state);
    };

    await refreshFromHistory();
    state.intervalId = globalThis.setInterval(() => {
      void refreshFromHistory().catch(() => undefined);
    }, SIMPLE_BLIND_KEY_BACKFILL_INTERVAL_MS);

    state.subscription = pool.subscribeMany(readRelays, {
      kinds: [SIMPLE_BLIND_KEY_KIND],
      authors: [decoded.data as string],
      limit: 50,
    }, {
      onevent: (event) => {
        const announcement = parseSimpleBlindKeyAnnouncement(
          event as VerifiedEvent,
          input.coordinatorNpub,
        );
        if (!announcement) {
          return;
        }

        state.announcements.set(announcement.event.id, announcement);
        notifyBlindKeySubscribers(state);
      },
      onclose: (reasons) => {
        if (state.closed) {
          return;
        }

        const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
        if (errors.length > 0) {
          recordRelayCloseReasons(errors);
          for (const subscriber of state.subscribers.values()) {
            subscriber.onError?.(new Error(errors.join("; ")));
          }
        }
      },
      maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
    });
  }).catch((error) => {
    if (state.closed || !(error instanceof Error)) {
      return;
    }

    for (const subscriber of state.subscribers.values()) {
      subscriber.onError?.(error);
    }
  });

  return state;
}

function getWebCrypto(override?: Crypto) {
  if (override) {
    return override;
  }

  if (!globalThis.crypto) {
    throw new Error("WebCrypto is required for blind signing.");
  }

  return globalThis.crypto;
}

function randomUuid(override?: Crypto) {
  return getWebCrypto(override).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8ToBytes(value: string) {
  return new TextEncoder().encode(value);
}

function hexToBytes(hex: string) {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function bigintToHex(value: bigint) {
  return value.toString(16);
}

function hexToBigint(hex: string) {
  return BigInt(`0x${hex}`);
}

function bigintFromBase64Url(value: string) {
  return hexToBigint(bytesToHex(base64UrlToBytes(value)));
}

function hexToBase64Url(value: string) {
  return bytesToBase64Url(hexToBytes(value));
}

function toSimpleBlindMessageBytes(tokenMessage: string) {
  return utf8ToBytes(`${SIMPLE_BLIND_DOMAIN_SEPARATOR}|${tokenMessage}`);
}

function toSimpleBlindPublicJwk(publicKey: SimpleBlindPublicKey): JsonWebKey {
  return {
    kty: "RSA",
    alg: "PS384",
    ext: true,
    key_ops: ["verify"],
    n: hexToBase64Url(publicKey.n),
    e: hexToBase64Url(publicKey.e),
  };
}

export async function generateSimpleBlindKeyPair(bits = SIMPLE_BLIND_KEY_BITS, webCryptoOverride?: Crypto): Promise<SimpleBlindPrivateKey> {
  const webCrypto = getWebCrypto(webCryptoOverride);
  const keyPair = await webCrypto.subtle.generateKey({
    name: "RSA-PSS",
    hash: SIMPLE_BLIND_HASH,
    modulusLength: bits,
    publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["sign", "verify"]);

  const privateJwk = await webCrypto.subtle.exportKey("jwk", keyPair.privateKey) as JsonWebKey & RsaJwk;
  const publicJwk = await webCrypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey & RsaJwk;
  if (!publicJwk.n || !publicJwk.e || !privateJwk.d) {
    throw new Error("Unable to export blind signature key pair.");
  }

  const keyId = await sha256Hex(`${publicJwk.n}:${publicJwk.e}`);
  return {
    scheme: SIMPLE_BLIND_SCHEME,
    keyId: keyId.slice(0, 24),
    bits,
    hash: SIMPLE_BLIND_HASH,
    saltLength: SIMPLE_BLIND_SALT_LENGTH,
    n: bigintToHex(bigintFromBase64Url(publicJwk.n)),
    e: bigintToHex(bigintFromBase64Url(publicJwk.e)),
    d: bigintToHex(bigintFromBase64Url(privateJwk.d)),
    jwk: privateJwk,
  };
}

export function toSimpleBlindPublicKey(privateKey: SimpleBlindPrivateKey): SimpleBlindPublicKey {
  return {
    scheme: SIMPLE_BLIND_SCHEME,
    keyId: privateKey.keyId,
    bits: privateKey.bits,
    hash: privateKey.hash,
    saltLength: privateKey.saltLength,
    n: privateKey.n,
    e: privateKey.e,
  };
}

export async function publishSimpleBlindKeyAnnouncement(input: {
  coordinatorNsec: string;
  votingId: string;
  publicKey: SimpleBlindPublicKey;
  relays?: string[];
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Organiser key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const coordinatorNpub = nip19.npubEncode(getPublicKey(secretKey));
  const relays = await resolveNip65OutboxRelays({
    npub: coordinatorNpub,
    fallbackRelays: buildPublicRelays(input.relays),
  });
  await publishOwnNip65RelayHints({
    secretKey,
    outboxRelays: relays,
    publishRelays: relays,
    channel: `nip65:${coordinatorNpub}`,
  }).catch(() => null);
  const createdAt = new Date().toISOString();
  const event = finalizeEvent({
    kind: SIMPLE_BLIND_KEY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-blind-key"],
      ["voting-id", input.votingId],
      ["key-id", input.publicKey.keyId],
    ],
    content: JSON.stringify({
      voting_id: input.votingId,
      scheme: input.publicKey.scheme,
      key_id: input.publicKey.keyId,
      bits: input.publicKey.bits,
      hash: input.publicKey.hash,
      salt_length: input.publicKey.saltLength,
      n: input.publicKey.n,
      e: input.publicKey.e,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    { channel: "simple-public", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
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
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }
  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
    createdAt,
    event,
  };
}

export function parseSimpleBlindKeyAnnouncement(
  event: VerifiedEvent,
  expectedCoordinatorNpub?: string,
  expectedVotingId?: string,
): SimpleBlindKeyAnnouncement | null {
  if (event.kind !== SIMPLE_BLIND_KEY_KIND || !verifyEvent(event)) {
    return null;
  }

  try {
    const payload = JSON.parse(event.content) as {
      voting_id?: string;
      scheme?: string;
      key_id?: string;
      bits?: number;
      hash?: string;
      salt_length?: number;
      n?: string;
      e?: string;
      created_at?: string;
    };

    if (
      !payload.voting_id
      || payload.voting_id.trim().length === 0
      || payload.scheme !== SIMPLE_BLIND_SCHEME
      || !payload.key_id
      || typeof payload.bits !== "number"
      || payload.hash !== SIMPLE_BLIND_HASH
      || payload.salt_length !== SIMPLE_BLIND_SALT_LENGTH
      || !payload.n
      || !payload.e
    ) {
      return null;
    }

    const coordinatorNpub = nip19.npubEncode(event.pubkey);
    if (expectedCoordinatorNpub && coordinatorNpub !== expectedCoordinatorNpub) {
      return null;
    }
    if (expectedVotingId && payload.voting_id !== expectedVotingId) {
      return null;
    }

    return {
      coordinatorNpub,
      votingId: payload.voting_id,
      publicKey: {
        scheme: SIMPLE_BLIND_SCHEME,
        keyId: payload.key_id,
        bits: payload.bits,
        hash: SIMPLE_BLIND_HASH,
        saltLength: SIMPLE_BLIND_SALT_LENGTH,
        n: payload.n,
        e: payload.e,
      },
      createdAt: new Date(event.created_at * 1000).toISOString(),
      event,
    };
  } catch {
    return null;
  }
}

export async function fetchLatestSimpleBlindKeyAnnouncement(input: {
  coordinatorNpub: string;
  votingId?: string;
  relays?: string[];
}): Promise<SimpleBlindKeyAnnouncement | null> {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Organiser value must be an npub.");
  }

  const relays = await resolveNip65OutboxRelays({
    npub: input.coordinatorNpub,
    fallbackRelays: buildPublicRelays(input.relays),
  });
  const pool = getSharedNostrPool();
  const readRelays = selectPublicReadRelays(relays);
  const events = await withRelayOutcomes(readRelays, pool.querySync(readRelays, {
    kinds: [SIMPLE_BLIND_KEY_KIND],
    authors: [decoded.data as string],
    limit: 20,
  }));
  const parsed = events
    .map((event) =>
      parseSimpleBlindKeyAnnouncement(
        event as VerifiedEvent,
        input.coordinatorNpub,
        input.votingId,
      ),
    )
    .filter((entry): entry is SimpleBlindKeyAnnouncement => entry !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return parsed[0] ?? null;
}

export function subscribeLatestSimpleBlindKeyAnnouncement(input: {
  coordinatorNpub: string;
  votingId?: string;
  relays?: string[];
  onAnnouncement: (announcement: SimpleBlindKeyAnnouncement | null) => void;
  onError?: (error: Error) => void;
}): () => void {
  const subscriptionKey = buildBlindKeySubscriptionKey(input.coordinatorNpub, input.relays);
  const subscriberId = nextBlindKeySubscriberId++;
  let closed = false;

  void ensureBlindKeySubscription({
    coordinatorNpub: input.coordinatorNpub,
    relays: input.relays,
  }).then((state) => {
    if (closed) {
      return;
    }

    state.subscribers.set(subscriberId, {
      id: subscriberId,
      votingId: input.votingId,
      onAnnouncement: input.onAnnouncement,
      onError: input.onError,
    });
    input.onAnnouncement(
      latestMatchingBlindKeyAnnouncement(state.announcements.values(), input.votingId),
    );
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  return () => {
    closed = true;
    const state = blindKeySubscriptions.get(subscriptionKey);
    if (!state) {
      return;
    }

    state.subscribers.delete(subscriberId);
    if (state.subscribers.size > 0) {
      return;
    }

    state.closed = true;
    blindKeySubscriptions.delete(subscriptionKey);
    if (state.intervalId !== null) {
      globalThis.clearInterval(state.intervalId);
    }
    void state.subscription?.close("closed by caller");
  };
}

export function createSimpleBlindIssuanceRequest(input: {
  publicKey: SimpleBlindPublicKey;
  votingId: string;
  tokenMessage?: string;
  webCrypto?: Crypto;
}): Promise<{ request: SimpleBlindIssuanceRequest; secret: SimpleBlindRequestSecret }> {
  return (async () => {
    const tokenMessage = input.tokenMessage?.trim() || `${input.votingId}:${randomUuid(input.webCrypto)}`;
    const { blindedMessage, blindingFactor } = await blindCredential(toSimpleBlindPublicJwk(input.publicKey), toSimpleBlindMessageBytes(tokenMessage));
    const requestId = randomUuid(input.webCrypto);
    const createdAt = new Date().toISOString();

    return {
      request: {
        requestId,
        votingId: input.votingId,
        blindedMessage,
        createdAt,
      },
      secret: {
        requestId,
        votingId: input.votingId,
        tokenMessage,
        blindingFactor,
        publicKey: input.publicKey,
        createdAt,
      },
    };
  })();
}

export async function createSimpleBlindShareResponse(input: {
  privateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: VerifiedEvent;
  coordinatorNpub: string;
  request: SimpleBlindIssuanceRequest;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  webCrypto?: Crypto;
}): Promise<SimpleBlindShareResponse> {
  const blindedSignature = await signBlindCredential(input.privateKey.jwk, input.request.blindedMessage);

  return {
    shareId: randomUuid(input.webCrypto),
    requestId: input.request.requestId,
    coordinatorNpub: input.coordinatorNpub,
    blindedSignature,
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
    createdAt: new Date().toISOString(),
    keyAnnouncementEvent: input.keyAnnouncementEvent,
  };
}

export async function unblindSimpleBlindShare(input: {
  response: SimpleBlindShareResponse;
  secret: SimpleBlindRequestSecret;
}): Promise<SimpleShardCertificate> {
  if (input.response.requestId !== input.secret.requestId) {
    throw new Error("Blind response does not match the request.");
  }

  const keyAnnouncement = parseSimpleBlindKeyAnnouncement(
    input.response.keyAnnouncementEvent,
    input.response.coordinatorNpub,
    input.secret.votingId,
  );
  if (!keyAnnouncement) {
    throw new Error("Blind response key announcement is invalid.");
  }

  if (keyAnnouncement.publicKey.keyId !== input.secret.publicKey.keyId) {
    throw new Error("Blind response used the wrong public key.");
  }

  const unblindedSignature = await finalizeBlindCredential(toSimpleBlindPublicJwk(keyAnnouncement.publicKey), toSimpleBlindMessageBytes(input.secret.tokenMessage), input.response.blindedSignature, input.secret.blindingFactor);

  const share: SimpleShardCertificate = {
    shareId: input.response.shareId,
    requestId: input.response.requestId,
    coordinatorNpub: input.response.coordinatorNpub,
    votingId: input.secret.votingId,
    tokenMessage: input.secret.tokenMessage,
    unblindedSignature,
    shareIndex: input.response.shareIndex,
    thresholdT: input.response.thresholdT,
    thresholdN: input.response.thresholdN,
    createdAt: input.response.createdAt,
    keyAnnouncementEvent: input.response.keyAnnouncementEvent,
  };

  const parsed = await verifySimpleShardCertificate(
    share,
    input.response.coordinatorNpub,
  );
  if (!parsed) {
    throw new Error("Unblinded blind share is invalid.");
  }

  return share;
}

export function parseSimpleShardCertificate(
  share: SimpleShardCertificate,
  expectedCoordinatorNpub?: string,
): ParsedSimpleShardCertificate | null {
  try {
    const keyAnnouncement = parseSimpleBlindKeyAnnouncement(
      share.keyAnnouncementEvent,
      expectedCoordinatorNpub ?? share.coordinatorNpub,
      share.votingId,
    );
    if (!keyAnnouncement) {
      return null;
    }

    if (share.coordinatorNpub !== keyAnnouncement.coordinatorNpub) {
      return null;
    }

    return {
      shardId: share.shareId,
      requestId: share.requestId,
      coordinatorNpub: share.coordinatorNpub,
      votingId: share.votingId,
      tokenCommitment: share.tokenMessage,
      shareIndex: share.shareIndex,
      thresholdT: share.thresholdT,
      thresholdN: share.thresholdN,
      createdAt: share.createdAt,
      publicKey: keyAnnouncement.publicKey,
      event: share,
    };
  } catch {
    return null;
  }
}

export function toSimplePublicShardProof(
  share: SimpleShardCertificate,
): SimplePublicShardProof {
  return {
    coordinatorNpub: share.coordinatorNpub,
    votingId: share.votingId,
    tokenCommitment: share.tokenMessage,
    unblindedSignature: share.unblindedSignature,
    shareIndex: share.shareIndex,
    keyAnnouncementEvent: share.keyAnnouncementEvent,
  };
}

export function parseSimplePublicShardProof(
  proof: SimplePublicShardProof,
  expectedCoordinatorNpub?: string,
): ParsedSimplePublicShardProof | null {
  try {
    const keyAnnouncement = parseSimpleBlindKeyAnnouncement(
      proof.keyAnnouncementEvent,
      expectedCoordinatorNpub ?? proof.coordinatorNpub,
      proof.votingId,
    );
    if (!keyAnnouncement) {
      return null;
    }

    if (proof.coordinatorNpub !== keyAnnouncement.coordinatorNpub) {
      return null;
    }

    return {
      coordinatorNpub: proof.coordinatorNpub,
      votingId: proof.votingId,
      tokenCommitment: proof.tokenCommitment,
      shareIndex: proof.shareIndex,
      publicKey: keyAnnouncement.publicKey,
      keyAnnouncement,
      event: proof,
    };
  } catch {
    return null;
  }
}

export async function verifySimpleShardCertificate(
  share: SimpleShardCertificate,
  expectedCoordinatorNpub?: string,
): Promise<ParsedSimpleShardCertificate | null> {
  const parsed = parseSimpleShardCertificate(share, expectedCoordinatorNpub);
  if (!parsed) {
    return null;
  }

  try {
    const isValid = await verifyBlindCredential(toSimpleBlindPublicJwk(parsed.publicKey), toSimpleBlindMessageBytes(share.tokenMessage), share.unblindedSignature);
    return isValid ? parsed : null;
  } catch {
    return null;
  }
}

export async function verifySimplePublicShardProof(
  proof: SimplePublicShardProof,
  expectedCoordinatorNpub?: string,
): Promise<ParsedSimplePublicShardProof | null> {
  const parsed = parseSimplePublicShardProof(proof, expectedCoordinatorNpub);
  if (!parsed) {
    return null;
  }

  try {
    const isValid = await verifyBlindCredential(toSimpleBlindPublicJwk(parsed.publicKey), toSimpleBlindMessageBytes(proof.tokenCommitment), proof.unblindedSignature);
    return isValid ? parsed : null;
  } catch {
    return null;
  }
}

export type SimpleShardDeriveOptions = {
  /**
   * Minimum number of DISTINCT coordinator signatures required before a
   * combined token may be derived. Defaults to `SIMPLE_MIN_SIGNER_THRESHOLD`
   * (1), the shipped single-coordinator semantics: one valid share from the
   * round's coordinator is enough. Pass `threshold: 2` (or higher) to require
   * that many independent coordinators — the multi-coordinator capability is
   * implemented and tested but not yet enabled by any production caller.
   * `0` opts out of the distinct-coordinator check (legacy escape hatch).
   */
  threshold?: number;
  length?: number;
};

/**
 * Shipped default shard-derive threshold: a single coordinator's valid share
 * is sufficient (`t = 1`), matching upstream/main behaviour for legacy
 * single-coordinator rounds. Multi-coordinator thresholds (`t >= 2`) are
 * supported by the derive layer as an explicit option and are exercised in
 * tests, but are not yet enforced in production.
 */
export const SIMPLE_MIN_SIGNER_THRESHOLD = 1;

export async function deriveTokenIdFromSimpleShardCertificates(
  certificates: SimpleShardCertificate[],
  options: SimpleShardDeriveOptions | number = {},
): Promise<string | null> {
  const { threshold = SIMPLE_MIN_SIGNER_THRESHOLD, length = 20 } =
    typeof options === "number" ? { length: options } : options;
  const validCertificates = certificates
    .map((certificate) => parseSimpleShardCertificate(certificate))
    .filter((certificate): certificate is ParsedSimpleShardCertificate => certificate !== null);
  if (validCertificates.length === 0) {
    return null;
  }

  if (
    !meetsSignerThreshold(
      validCertificates.map((certificate) => certificate.coordinatorNpub),
      threshold,
    )
  ) {
    return null;
  }

  const uniqueTokenMessages = Array.from(new Set(validCertificates.map((certificate) => certificate.tokenCommitment)));
  if (uniqueTokenMessages.length !== 1) {
    return null;
  }

  const shareDescriptor = validCertificates
    .map((certificate) => `${certificate.coordinatorNpub}:${certificate.shardId}:${certificate.publicKey.keyId}`)
    .sort()
    .join("|");
  const tokenId = await sha256Hex(`${uniqueTokenMessages[0]}:${shareDescriptor}`);
  return tokenId.slice(0, length);
}

export async function deriveTokenIdFromSimplePublicShardProofs(
  proofs: SimplePublicShardProof[],
  options: SimpleShardDeriveOptions | number = {},
): Promise<string | null> {
  const { threshold = SIMPLE_MIN_SIGNER_THRESHOLD, length = 20 } =
    typeof options === "number" ? { length: options } : options;
  const validProofs = proofs
    .map((proof) => parseSimplePublicShardProof(proof))
    .filter((proof): proof is ParsedSimplePublicShardProof => proof !== null);
  if (validProofs.length === 0) {
    return null;
  }

  if (
    !meetsSignerThreshold(
      validProofs.map((proof) => proof.coordinatorNpub),
      threshold,
    )
  ) {
    return null;
  }

  const uniqueTokenMessages = Array.from(
    new Set(validProofs.map((proof) => proof.tokenCommitment)),
  );
  if (uniqueTokenMessages.length !== 1) {
    return null;
  }

  const shareDescriptor = validProofs
    .map(
      (proof) =>
        `${proof.coordinatorNpub}:${proof.publicKey.keyId}:${proof.shareIndex}`,
    )
    .sort()
    .join("|");
  const tokenId = await sha256Hex(`${uniqueTokenMessages[0]}:${shareDescriptor}`);
  return tokenId.slice(0, length);
}

/**
 * Returns true when at least `threshold` DISTINCT coordinators have each
 * contributed a valid share. `threshold` defaults to 1 (single-coordinator
 * rounds — the shipped behaviour). An explicit multi-coordinator threshold
 * (e.g. 2) requires that many distinct coordinator identities, so a lone
 * coordinator — or several shares from the same coordinator — cannot satisfy
 * it. `threshold <= 0` disables the check entirely (legacy opt-out).
 */
function meetsSignerThreshold(coordinatorNpubs: string[], threshold: number): boolean {
  if (threshold <= 0) {
    return true;
  }

  const distinctCoordinators = new Set(
    coordinatorNpubs.filter((npub) => npub.trim().length > 0),
  );
  return distinctCoordinators.size >= threshold;
}

export function getShardCertificateCoordinatorNpub(coordinatorNsec: string): string | null {
  try {
    const decoded = nip19.decode(coordinatorNsec.trim());
    if (decoded.type !== "nsec") {
      return null;
    }

    return nip19.npubEncode(getPublicKey(decoded.data as Uint8Array));
  } catch {
    return null;
  }
}
