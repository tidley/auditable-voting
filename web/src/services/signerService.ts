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
    signEvent?: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  };
}

export interface SignerService {
  isAvailable(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signEvent<T extends Record<string, unknown>>(event: T): Promise<T & { id?: string; sig?: string; pubkey?: string }>;
}

function readBrowserSigner(): BrowserNostrSigner | null {
  const candidate = (globalThis as typeof globalThis & { nostr?: BrowserNostrSigner }).nostr;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate;
}

async function waitForBrowserSigner(timeoutMs = 2500, intervalMs = 150): Promise<BrowserNostrSigner | null> {
  const hasPublicKeyMethod = (signer: BrowserNostrSigner | null) =>
    Boolean(signer?.getPublicKey || signer?.nip07?.getPublicKey);

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
    if (hasPublicKeyMethod(signer)) {
      return signer;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return hasPublicKeyMethod(readBrowserSigner()) ? readBrowserSigner() : null;
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

function toSignerError(error: unknown, fallback: string): SignerServiceError {
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  const normalized = message.toLowerCase();
  if (normalized.includes("reject") || normalized.includes("denied") || normalized.includes("cancel")) {
    return new SignerServiceError("rejected", message);
  }
  return new SignerServiceError("sign_failed", message);
}

export function createSignerService(): SignerService {
  return {
    async isAvailable() {
      const signer = await waitForBrowserSigner();
      return Boolean(signer?.getPublicKey || signer?.nip07?.getPublicKey);
    },
    async getPublicKey() {
      const signer = await waitForBrowserSigner();
      if (!signer) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      const source = resolveSignerSource(signer);
      const getPublicKey = source.getPublicKey;
      if (!getPublicKey) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      try {
        await enableSignerIfAvailable(signer);
        const pubkey = await getPublicKey.call(source);
        if (!pubkey || typeof pubkey !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid public key.");
        }
        return pubkey;
      } catch (error) {
        throw toSignerError(error, "Failed to get signer public key.");
      }
    },
    async signMessage(message: string) {
      const signer = await waitForBrowserSigner();
      const source = signer ? resolveSignerSource(signer) : null;
      const signMessage = source?.signMessage;
      if (!signMessage) {
        throw new SignerServiceError("unavailable", "This signer does not support message signing.");
      }
      try {
        await enableSignerIfAvailable(signer);
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
      const signer = await waitForBrowserSigner();
      const source = signer ? resolveSignerSource(signer) : null;
      const signEvent = source?.signEvent ?? signer?.nip04?.signEvent;
      if (!signEvent) {
        throw new SignerServiceError("unavailable", "This signer does not support event signing.");
      }
      try {
        await enableSignerIfAvailable(signer);
        const owner = source?.signEvent ? source : signer?.nip04;
        const signed = await signEvent.call(owner, event);
        if (!signed || typeof signed !== "object") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid signed event.");
        }
        return signed;
      } catch (error) {
        throw toSignerError(error, "Failed to sign event.");
      }
    },
  };
}
