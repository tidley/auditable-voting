import { generateSecretKey, getPublicKey as getPublicKeyFromSecret } from "nostr-tools";

export type SignerErrorCode = "unavailable" | "rejected" | "wrong_account" | "sign_failed";

export class SignerServiceError extends Error {
  constructor(public readonly code: SignerErrorCode, message: string) {
    super(message);
    this.name = "SignerServiceError";
  }
}

export interface BrowserNostrSigner {
  enable?: () => Promise<unknown>;
  getPublicKey?: () => Promise<string>;
  signEvent?: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  signMessage?: (message: string) => Promise<string>;
  nip07?: {
    enable?: () => Promise<unknown>;
    getPublicKey?: () => Promise<string>;
    signEvent?: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
    signMessage?: (message: string) => Promise<string>;
  };
  nip04?: {
    encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
    signEvent?: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  };
  nip44?: {
    encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

export interface SignerService {
  isAvailable(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signEvent<T extends Record<string, unknown>>(event: T): Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  nip04Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
}

type NostrConnectSignerLike = {
  getPublicKey: () => Promise<string>;
  signEvent: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  signMessage?: (message: string) => Promise<string>;
  nip04Encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
  nip04Decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
  nip44Encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
  nip44Decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
  close?: () => Promise<void>;
};

const AMBER_CONNECT_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://offchain.pub",
];

const AMBER_CONNECT_PERMISSIONS = [
  "get_public_key",
  "sign_event:13",
  "sign_event:1059",
  "nip04_encrypt",
  "nip04_decrypt",
  "nip44_encrypt",
  "nip44_decrypt",
];

export type AmberConnectBundle = {
  nostrConnectUri: string;
  nsecBunkerUri: string;
};

let cachedAmberSigner: NostrConnectSignerLike | null = null;
let amberConnectPromise: Promise<NostrConnectSignerLike> | null = null;
let amberLastExternalLaunchAtMs = 0;
const AMBER_EXTERNAL_LAUNCH_COOLDOWN_MS = 30_000;
let cachedSignerPublicKey: string | null = null;
let cachedSignerPublicKeyAtMs = 0;
let signerPublicKeyInflight: Promise<string> | null = null;
const SIGNER_PUBLIC_KEY_CACHE_TTL_MS = 60_000;

function isAndroidBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android/i.test(navigator.userAgent || "");
}

function openExternalUri(uri: string) {
  if (!uri || typeof document === "undefined") {
    return false;
  }
  try {
    const link = document.createElement("a");
    link.href = uri;
    link.rel = "noreferrer noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } catch {
    try {
      if (typeof window !== "undefined") {
        window.location.href = uri;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

function createRandomSecret() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `${globalThis.crypto.randomUUID()}-${Date.now()}`;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readBrowserSigner(): BrowserNostrSigner | null {
  const candidate = (globalThis as typeof globalThis & { nostr?: BrowserNostrSigner }).nostr;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate;
}

function toNsecBunkerUri(nostrConnectUri: string) {
  return nostrConnectUri.startsWith("nostrconnect://")
    ? `bunker://${nostrConnectUri.slice("nostrconnect://".length)}`
    : nostrConnectUri;
}

async function buildAmberConnectBundle(): Promise<AmberConnectBundle & { localSecretKey: Uint8Array }> {
  const { createNostrConnectURI } = await import("nostr-tools/nip46");
  const localSecretKey = generateSecretKey();
  const clientPubkey = getPublicKeyFromSecret(localSecretKey);
  const nostrConnectUri = createNostrConnectURI({
    clientPubkey,
    relays: AMBER_CONNECT_RELAYS,
    secret: createRandomSecret(),
    name: "auditable-voting",
    url: typeof window === "undefined" ? "https://tidley.github.io" : window.location.origin,
    perms: AMBER_CONNECT_PERMISSIONS,
  });
  return {
    localSecretKey,
    nostrConnectUri,
    nsecBunkerUri: toNsecBunkerUri(nostrConnectUri),
  };
}

export async function createAmberConnectBundle(): Promise<AmberConnectBundle> {
  const bundle = await buildAmberConnectBundle();
  return {
    nostrConnectUri: bundle.nostrConnectUri,
    nsecBunkerUri: bundle.nsecBunkerUri,
  };
}

async function connectAmberSigner(): Promise<NostrConnectSignerLike> {
  if (cachedAmberSigner) {
    return cachedAmberSigner;
  }
  if (amberConnectPromise) {
    return amberConnectPromise;
  }
  amberConnectPromise = (async () => {
    const { BunkerSigner } = await import("nostr-tools/nip46");
    const { localSecretKey, nostrConnectUri } = await buildAmberConnectBundle();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(nostrConnectUri).catch(() => {});
    }
    const now = Date.now();
    if (now - amberLastExternalLaunchAtMs >= AMBER_EXTERNAL_LAUNCH_COOLDOWN_MS) {
      openExternalUri(nostrConnectUri);
      amberLastExternalLaunchAtMs = now;
    }
    const signer = await BunkerSigner.fromURI(localSecretKey, nostrConnectUri, {}, 180000);
    cachedAmberSigner = signer as unknown as NostrConnectSignerLike;
    return cachedAmberSigner;
  })();
  try {
    return await amberConnectPromise;
  } finally {
    amberConnectPromise = null;
  }
}

async function waitForBrowserSigner(timeoutMs = 2500, intervalMs = 150): Promise<BrowserNostrSigner | null> {
  const hasSignerSurface = (signer: BrowserNostrSigner | null) =>
    Boolean(
      signer
      && (
        signer.getPublicKey
        || signer.nip07?.getPublicKey
        || signer.enable
        || signer.nip07?.enable
        || signer.signEvent
        || signer.nip07?.signEvent
      ),
    );

  const waitForReadyEvent = async () => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const onReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const timer = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, Math.min(1200, timeoutMs));
      window.addEventListener("nostr:ready", onReady, { once: true });
      globalThis.setTimeout(() => {
        globalThis.clearTimeout(timer);
        window.removeEventListener("nostr:ready", onReady);
      }, Math.min(1300, timeoutMs + 100));
    });
  };

  await waitForReadyEvent();
  const startedAt = Date.now();
  while ((Date.now() - startedAt) <= timeoutMs) {
    const signer = readBrowserSigner();
    if (hasSignerSurface(signer)) {
      return signer;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return hasSignerSurface(readBrowserSigner()) ? readBrowserSigner() : null;
}

async function enableSignerIfAvailable(signer: BrowserNostrSigner) {
  const source = signer.nip07?.enable ? signer.nip07 : signer;
  const enable = source.enable;
  if (!enable) {
    return;
  }
  try {
    await enable.call(source);
  } catch (error) {
    throw toSignerError(error, "Signer permission request failed.");
  }
}

function resolveSignerSource(signer: BrowserNostrSigner): BrowserNostrSigner {
  if (signer.nip07?.getPublicKey || signer.nip07?.signEvent || signer.nip07?.signMessage) {
    return signer.nip07;
  }
  return signer;
}

async function derivePubkeyFromSignEvent(signer: BrowserNostrSigner): Promise<string | null> {
  const source = resolveSignerSource(signer);
  const signEvent = source.signEvent ?? signer.nip04?.signEvent;
  if (!signEvent) {
    return null;
  }
  const owner = source.signEvent ? source : signer.nip04;
  const signed = await signEvent.call(owner, {
    kind: 13,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "",
  });
  if (!signed || typeof signed !== "object" || typeof signed.pubkey !== "string" || !signed.pubkey.trim()) {
    return null;
  }
  return signed.pubkey;
}

function toSignerError(error: unknown, fallback: string): SignerServiceError {
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  const normalized = message.toLowerCase();
  if (normalized.includes("reject") || normalized.includes("denied") || normalized.includes("cancel")) {
    return new SignerServiceError("rejected", message);
  }
  return new SignerServiceError("sign_failed", message);
}

export function createSignerService(): SignerService {
  const waitForPublicKeyMethod = async (signer: BrowserNostrSigner, timeoutMs = 1200, intervalMs = 100) => {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) <= timeoutMs) {
      const source = resolveSignerSource(signer);
      const getPublicKey = source.getPublicKey;
      if (getPublicKey) {
        return { source, getPublicKey };
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
    }
    const source = resolveSignerSource(signer);
    return { source, getPublicKey: source.getPublicKey };
  };

  const getSigner = async (): Promise<BrowserNostrSigner | NostrConnectSignerLike | null> => {
    const signer = await waitForBrowserSigner();
    if (!isAndroidBrowser()) {
      return signer;
    }
    if (signer) {
      return signer;
    }
    try {
      return await connectAmberSigner();
    } catch {
      return signer;
    }
  };

  return {
    async isAvailable() {
      const signer = await waitForBrowserSigner();
      return Boolean(
        signer && (
          (signer as BrowserNostrSigner).getPublicKey
          || (signer as BrowserNostrSigner).nip07?.getPublicKey
          || (signer as BrowserNostrSigner).enable
          || (signer as BrowserNostrSigner).nip07?.enable
        ),
      );
    },
    async getPublicKey() {
      const now = Date.now();
      if (cachedSignerPublicKey && now - cachedSignerPublicKeyAtMs <= SIGNER_PUBLIC_KEY_CACHE_TTL_MS) {
        return cachedSignerPublicKey;
      }
      if (signerPublicKeyInflight) {
        return signerPublicKeyInflight;
      }
      signerPublicKeyInflight = (async () => {
        const signer = await getSigner();
        if (!signer) {
          throw new SignerServiceError(
            "unavailable",
            "No Nostr signer is available in this browser. On Android, install/open Amber and approve the nostrconnect request.",
          );
        }
        try {
          await enableSignerIfAvailable(signer as BrowserNostrSigner);
          const browserLikeSigner = signer as BrowserNostrSigner;
          const { source, getPublicKey } = await waitForPublicKeyMethod(browserLikeSigner);
          const hasSignEventFallback = Boolean(source.signEvent || browserLikeSigner.nip04?.signEvent);
          if (!getPublicKey && !hasSignEventFallback) {
            throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
          }
          let pubkey = "";
          if (getPublicKey) {
            pubkey = await getPublicKey.call(source);
          } else {
            const fallbackPubkey = await derivePubkeyFromSignEvent(browserLikeSigner);
            if (fallbackPubkey) {
              pubkey = fallbackPubkey;
            }
          }
          if (!pubkey || typeof pubkey !== "string") {
            throw new SignerServiceError("sign_failed", "Signer returned an invalid public key.");
          }
          cachedSignerPublicKey = pubkey;
          cachedSignerPublicKeyAtMs = Date.now();
          return pubkey;
        } catch (error) {
          throw toSignerError(error, "Failed to get signer public key.");
        }
      })();
      try {
        return await signerPublicKeyInflight;
      } finally {
        signerPublicKeyInflight = null;
      }
    },
    async signMessage(message: string) {
      const signer = await getSigner();
      const source = signer ? resolveSignerSource(signer) : null;
      const signMessage = source?.signMessage;
      if (!signMessage) {
        throw new SignerServiceError("unavailable", "This signer does not support message signing.");
      }
      try {
        await enableSignerIfAvailable(signer as BrowserNostrSigner);
        const signature = await signMessage.call(source, message);
        if (!signature || typeof signature !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid signature.");
        }
        return signature;
      } catch (error) {
        throw toSignerError(error, "Failed to sign message.");
      }
    },
    async signEvent<T extends Record<string, unknown>>(event: T) {
      const signer = await getSigner();
      const source = signer ? resolveSignerSource(signer) : null;
      const browserLikeSigner = signer as BrowserNostrSigner | null;
      const signEvent = source?.signEvent ?? browserLikeSigner?.nip04?.signEvent;
      if (!signEvent) {
        throw new SignerServiceError("unavailable", "This signer does not support event signing.");
      }
      try {
        await enableSignerIfAvailable(signer as BrowserNostrSigner);
        const owner = source?.signEvent ? source : browserLikeSigner?.nip04;
        const signed = await signEvent.call(owner, event);
        if (!signed || typeof signed !== "object") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid signed event.");
        }
        return signed as T & { id?: string; sig?: string; pubkey?: string };
      } catch (error) {
        throw toSignerError(error, "Failed to sign event.");
      }
    },
    async nip04Encrypt(pubkey: string, plaintext: string) {
      const signer = await getSigner();
      if (!signer) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      const browserLikeSigner = signer as BrowserNostrSigner;
      const source = resolveSignerSource(browserLikeSigner);
      const nip04Encrypt = (
        (signer as NostrConnectSignerLike).nip04Encrypt
        ?? browserLikeSigner.nip04?.encrypt
        ?? (source as BrowserNostrSigner).nip04?.encrypt
      );
      if (!nip04Encrypt) {
        throw new SignerServiceError("unavailable", "This signer does not support NIP-04 encryption.");
      }
      try {
        await enableSignerIfAvailable(browserLikeSigner);
        const ciphertext = await nip04Encrypt.call(signer, pubkey, plaintext);
        if (!ciphertext || typeof ciphertext !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid NIP-04 ciphertext.");
        }
        return ciphertext;
      } catch (error) {
        throw toSignerError(error, "Failed to encrypt NIP-04 payload.");
      }
    },
    async nip04Decrypt(pubkey: string, ciphertext: string) {
      const signer = await getSigner();
      if (!signer) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      const browserLikeSigner = signer as BrowserNostrSigner;
      const source = resolveSignerSource(browserLikeSigner);
      const nip04Decrypt = (
        (signer as NostrConnectSignerLike).nip04Decrypt
        ?? browserLikeSigner.nip04?.decrypt
        ?? (source as BrowserNostrSigner).nip04?.decrypt
      );
      if (!nip04Decrypt) {
        throw new SignerServiceError("unavailable", "This signer does not support NIP-04 decryption.");
      }
      try {
        await enableSignerIfAvailable(browserLikeSigner);
        const plaintext = await nip04Decrypt.call(signer, pubkey, ciphertext);
        if (typeof plaintext !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid NIP-04 plaintext.");
        }
        return plaintext;
      } catch (error) {
        throw toSignerError(error, "Failed to decrypt NIP-04 payload.");
      }
    },
    async nip44Encrypt(pubkey: string, plaintext: string) {
      const signer = await getSigner();
      if (!signer) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      const browserLikeSigner = signer as BrowserNostrSigner;
      const source = resolveSignerSource(browserLikeSigner);
      const nip44Encrypt = (
        (signer as NostrConnectSignerLike).nip44Encrypt
        ?? browserLikeSigner.nip44?.encrypt
        ?? (source as BrowserNostrSigner).nip44?.encrypt
      );
      if (!nip44Encrypt) {
        throw new SignerServiceError("unavailable", "This signer does not support NIP-44 encryption.");
      }
      try {
        await enableSignerIfAvailable(browserLikeSigner);
        const ciphertext = await nip44Encrypt.call(signer, pubkey, plaintext);
        if (!ciphertext || typeof ciphertext !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid NIP-44 ciphertext.");
        }
        return ciphertext;
      } catch (error) {
        throw toSignerError(error, "Failed to encrypt NIP-44 payload.");
      }
    },
    async nip44Decrypt(pubkey: string, ciphertext: string) {
      const signer = await getSigner();
      if (!signer) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      const browserLikeSigner = signer as BrowserNostrSigner;
      const source = resolveSignerSource(browserLikeSigner);
      const nip44Decrypt = (
        (signer as NostrConnectSignerLike).nip44Decrypt
        ?? browserLikeSigner.nip44?.decrypt
        ?? (source as BrowserNostrSigner).nip44?.decrypt
      );
      if (!nip44Decrypt) {
        throw new SignerServiceError("unavailable", "This signer does not support NIP-44 decryption.");
      }
      try {
        await enableSignerIfAvailable(browserLikeSigner);
        const plaintext = await nip44Decrypt.call(signer, pubkey, ciphertext);
        if (typeof plaintext !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid NIP-44 plaintext.");
        }
        return plaintext;
      } catch (error) {
        throw toSignerError(error, "Failed to decrypt NIP-44 payload.");
      }
    },
  };
}
