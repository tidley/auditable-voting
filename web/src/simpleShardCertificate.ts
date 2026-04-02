import {
  finalizeEvent,
  getPublicKey,
  nip19,
  SimplePool,
  verifyEvent,
  type VerifiedEvent,
} from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
  SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
} from "./simpleVotingSession";
import { sha256Hex } from "./tokenIdentity";

export const SIMPLE_BLIND_KEY_KIND = 38993;
export const SIMPLE_BLIND_SCHEME = "rsa-blind-v1";
export const SIMPLE_BLIND_KEY_BITS = 3072;
const SIMPLE_BLIND_DOMAIN_SEPARATOR = "auditable-voting/simple-blind/v1";

export type SimpleBlindPublicKey = {
  scheme: typeof SIMPLE_BLIND_SCHEME;
  keyId: string;
  bits: number;
  n: string;
  e: string;
};

export type SimpleBlindPrivateKey = SimpleBlindPublicKey & {
  d: string;
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

function buildPublicRelays(relays?: string[]) {
  return Array.from(new Set([...SIMPLE_PUBLIC_RELAYS, ...(relays ?? [])].filter((relay) => relay.trim().length > 0)));
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

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
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

function bigintGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) {
    return 0n;
  }

  let result = 1n;
  let factor = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) {
      result = (result * factor) % modulus;
    }
    power >>= 1n;
    factor = (factor * factor) % modulus;
  }
  return result;
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let t = 0n;
  let nextT = 1n;
  let r = modulus;
  let nextR = value % modulus;

  while (nextR !== 0n) {
    const quotient = r / nextR;
    [t, nextT] = [nextT, t - quotient * nextT];
    [r, nextR] = [nextR, r - quotient * nextR];
  }

  if (r !== 1n) {
    throw new Error("Value is not invertible modulo n.");
  }

  return t < 0n ? t + modulus : t;
}

function randomBigintBelow(maxExclusive: bigint, webCryptoOverride?: Crypto): bigint {
  const byteLength = Math.max(1, Math.ceil(maxExclusive.toString(16).length / 2));
  const webCrypto = getWebCrypto(webCryptoOverride);
  while (true) {
    const bytes = webCrypto.getRandomValues(new Uint8Array(byteLength));
    const candidate = hexToBigint(bytesToHex(bytes));
    if (candidate > 0n && candidate < maxExclusive) {
      return candidate;
    }
  }
}

function hashMessageRepresentative(message: string, modulus: bigint) {
  const hashHex = bytesToHex(
    sha256(utf8ToBytes(`${SIMPLE_BLIND_DOMAIN_SEPARATOR}|${message}`)),
  );
  const representative = (hexToBigint(hashHex) % (modulus - 1n)) + 1n;
  return representative;
}

export async function generateSimpleBlindKeyPair(bits = SIMPLE_BLIND_KEY_BITS, webCryptoOverride?: Crypto): Promise<SimpleBlindPrivateKey> {
  const webCrypto = getWebCrypto(webCryptoOverride);
  const keyPair = await webCrypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: bits,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);

  const privateJwk = await webCrypto.subtle.exportKey("jwk", keyPair.privateKey) as RsaJwk;
  const publicJwk = await webCrypto.subtle.exportKey("jwk", keyPair.publicKey) as RsaJwk;
  if (!publicJwk.n || !publicJwk.e || !privateJwk.d) {
    throw new Error("Unable to export blind signature key pair.");
  }

  const keyId = await sha256Hex(`${publicJwk.n}:${publicJwk.e}`);
  return {
    scheme: SIMPLE_BLIND_SCHEME,
    keyId: keyId.slice(0, 24),
    bits,
    n: bigintToHex(bigintFromBase64Url(publicJwk.n)),
    e: bigintToHex(bigintFromBase64Url(publicJwk.e)),
    d: bigintToHex(bigintFromBase64Url(privateJwk.d)),
  };
}

export function toSimpleBlindPublicKey(privateKey: SimpleBlindPrivateKey): SimpleBlindPublicKey {
  return {
    scheme: SIMPLE_BLIND_SCHEME,
    keyId: privateKey.keyId,
    bits: privateKey.bits,
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
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const relays = buildPublicRelays(input.relays);
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
      n: input.publicKey.n,
      e: input.publicKey.e,
      created_at: createdAt,
    }),
  }, secretKey);

  const pool = new SimplePool();
  try {
    const results = await queueNostrPublish(
      () => publishToRelaysStaggered(
        (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
        relays,
        { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
      ),
      { channel: "simple-public", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
    );
    return {
      eventId: event.id,
      successes: results.filter((result) => result.status === "fulfilled").length,
      failures: results.filter((result) => result.status === "rejected").length,
      createdAt,
      event,
    };
  } finally {
    pool.destroy();
  }
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
        n: payload.n,
        e: payload.e,
      },
      createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
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
    throw new Error("Coordinator value must be an npub.");
  }

  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, {
      kinds: [SIMPLE_BLIND_KEY_KIND],
      authors: [decoded.data as string],
      limit: 20,
    });
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
  } finally {
    pool.close(relays);
  }
}

export function subscribeLatestSimpleBlindKeyAnnouncement(input: {
  coordinatorNpub: string;
  votingId?: string;
  relays?: string[];
  onAnnouncement: (announcement: SimpleBlindKeyAnnouncement | null) => void;
  onError?: (error: Error) => void;
}): () => void {
  const decoded = nip19.decode(input.coordinatorNpub.trim());
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  const relays = buildPublicRelays(input.relays);
  const pool = new SimplePool();
  const announcements = new Map<string, SimpleBlindKeyAnnouncement>();
  let closed = false;

  void fetchLatestSimpleBlindKeyAnnouncement({
    coordinatorNpub: input.coordinatorNpub,
    votingId: input.votingId,
    relays: input.relays,
  }).then((announcement) => {
    if (closed || !announcement) {
      return;
    }

    announcements.set(announcement.event.id, announcement);
    const latest = [...announcements.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    input.onAnnouncement(latest);
  }).catch((error) => {
    if (!closed && error instanceof Error) {
      input.onError?.(error);
    }
  });

  const subscription = pool.subscribeMany(relays, {
    kinds: [SIMPLE_BLIND_KEY_KIND],
    authors: [decoded.data as string],
    limit: 20,
  }, {
    onevent: (event) => {
      const announcement = parseSimpleBlindKeyAnnouncement(
        event as VerifiedEvent,
        input.coordinatorNpub,
        input.votingId,
      );
      if (!announcement) {
        return;
      }

      announcements.set(announcement.event.id, announcement);
      const latest = [...announcements.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      input.onAnnouncement(latest);
    },
    onclose: (reasons) => {
      if (closed) {
        return;
      }

      const errors = reasons.filter((reason) => !reason.startsWith("closed by caller"));
      if (errors.length > 0) {
        input.onError?.(new Error(errors.join("; ")));
      }
    },
    maxWait: SIMPLE_PUBLIC_SUBSCRIPTION_MAX_WAIT_MS,
  });

  return () => {
    closed = true;
    void subscription.close("closed by caller");
    pool.destroy();
  };
}

export function createSimpleBlindIssuanceRequest(input: {
  publicKey: SimpleBlindPublicKey;
  votingId: string;
  tokenMessage?: string;
  webCrypto?: Crypto;
}): Promise<{ request: SimpleBlindIssuanceRequest; secret: SimpleBlindRequestSecret }> {
  return (async () => {
    const modulus = hexToBigint(input.publicKey.n);
    const exponent = hexToBigint(input.publicKey.e);
    const tokenMessage = input.tokenMessage?.trim() || `${input.votingId}:${randomUuid(input.webCrypto)}`;
    const message = hashMessageRepresentative(tokenMessage, modulus);

    let blindingFactor = 0n;
    do {
      blindingFactor = randomBigintBelow(modulus, input.webCrypto);
    } while (bigintGcd(blindingFactor, modulus) !== 1n);

    const blindedMessage = (message * modPow(blindingFactor, exponent, modulus)) % modulus;
    const requestId = randomUuid(input.webCrypto);
    const createdAt = new Date().toISOString();

    return {
      request: {
        requestId,
        votingId: input.votingId,
        blindedMessage: bigintToHex(blindedMessage),
        createdAt,
      },
      secret: {
        requestId,
        votingId: input.votingId,
        tokenMessage,
        blindingFactor: bigintToHex(blindingFactor),
        publicKey: input.publicKey,
        createdAt,
      },
    };
  })();
}

export function createSimpleBlindShareResponse(input: {
  privateKey: SimpleBlindPrivateKey;
  keyAnnouncementEvent: VerifiedEvent;
  coordinatorNpub: string;
  request: SimpleBlindIssuanceRequest;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  webCrypto?: Crypto;
}): SimpleBlindShareResponse {
  const modulus = hexToBigint(input.privateKey.n);
  const exponent = hexToBigint(input.privateKey.d);
  const blindedMessage = hexToBigint(input.request.blindedMessage);
  const blindedSignature = modPow(blindedMessage, exponent, modulus);

  return {
    shareId: randomUuid(input.webCrypto),
    requestId: input.request.requestId,
    coordinatorNpub: input.coordinatorNpub,
    blindedSignature: bigintToHex(blindedSignature),
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
    createdAt: new Date().toISOString(),
    keyAnnouncementEvent: input.keyAnnouncementEvent,
  };
}

export function unblindSimpleBlindShare(input: {
  response: SimpleBlindShareResponse;
  secret: SimpleBlindRequestSecret;
}): SimpleShardCertificate {
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

  const modulus = hexToBigint(keyAnnouncement.publicKey.n);
  const blindedSignature = hexToBigint(input.response.blindedSignature);
  const blindingFactor = hexToBigint(input.secret.blindingFactor);
  const inverse = modInverse(blindingFactor, modulus);
  const unblindedSignature = (blindedSignature * inverse) % modulus;

  const share: SimpleShardCertificate = {
    shareId: input.response.shareId,
    requestId: input.response.requestId,
    coordinatorNpub: input.response.coordinatorNpub,
    votingId: input.secret.votingId,
    tokenMessage: input.secret.tokenMessage,
    unblindedSignature: bigintToHex(unblindedSignature),
    shareIndex: input.response.shareIndex,
    thresholdT: input.response.thresholdT,
    thresholdN: input.response.thresholdN,
    createdAt: input.response.createdAt,
    keyAnnouncementEvent: input.response.keyAnnouncementEvent,
  };

  const parsed = parseSimpleShardCertificate(share, input.response.coordinatorNpub);
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

    const modulus = hexToBigint(keyAnnouncement.publicKey.n);
    const exponent = hexToBigint(keyAnnouncement.publicKey.e);
    const signature = hexToBigint(share.unblindedSignature);
    const representative = hashMessageRepresentative(share.tokenMessage, modulus);
    const recovered = modPow(signature, exponent, modulus);
    if (recovered !== representative) {
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

    const modulus = hexToBigint(keyAnnouncement.publicKey.n);
    const exponent = hexToBigint(keyAnnouncement.publicKey.e);
    const signature = hexToBigint(proof.unblindedSignature);
    const representative = hashMessageRepresentative(proof.tokenCommitment, modulus);
    const recovered = modPow(signature, exponent, modulus);
    if (recovered !== representative) {
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

export async function deriveTokenIdFromSimpleShardCertificates(
  certificates: SimpleShardCertificate[],
  length = 20,
): Promise<string | null> {
  const validCertificates = certificates
    .map((certificate) => parseSimpleShardCertificate(certificate))
    .filter((certificate): certificate is ParsedSimpleShardCertificate => certificate !== null);
  if (validCertificates.length === 0) {
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
  length = 20,
): Promise<string | null> {
  const validProofs = proofs
    .map((proof) => parseSimplePublicShardProof(proof))
    .filter((proof): proof is ParsedSimplePublicShardProof => proof !== null);
  if (validProofs.length === 0) {
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
