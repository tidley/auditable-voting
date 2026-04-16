export type SignerErrorCode = "unavailable" | "rejected" | "wrong_account" | "sign_failed";

export class SignerServiceError extends Error {
  constructor(public readonly code: SignerErrorCode, message: string) {
    super(message);
    this.name = "SignerServiceError";
  }
}

export interface BrowserNostrSigner {
  getPublicKey?: () => Promise<string>;
  signEvent?: <T extends Record<string, unknown>>(event: T) => Promise<T & { id?: string; sig?: string; pubkey?: string }>;
  signMessage?: (message: string) => Promise<string>;
  nip07?: {
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
      const signer = readBrowserSigner();
      return Boolean(signer?.getPublicKey || signer?.nip07?.getPublicKey);
    },
    async getPublicKey() {
      const signer = readBrowserSigner();
      const getPublicKey = signer?.getPublicKey ?? signer?.nip07?.getPublicKey;
      if (!getPublicKey) {
        throw new SignerServiceError("unavailable", "No Nostr signer is available in this browser.");
      }
      try {
        const pubkey = await getPublicKey();
        if (!pubkey || typeof pubkey !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid public key.");
        }
        return pubkey;
      } catch (error) {
        throw toSignerError(error, "Failed to get signer public key.");
      }
    },
    async signMessage(message: string) {
      const signer = readBrowserSigner();
      const signMessage = signer?.signMessage ?? signer?.nip07?.signMessage;
      if (!signMessage) {
        throw new SignerServiceError("unavailable", "This signer does not support message signing.");
      }
      try {
        const signature = await signMessage(message);
        if (!signature || typeof signature !== "string") {
          throw new SignerServiceError("sign_failed", "Signer returned an invalid signature.");
        }
        return signature;
      } catch (error) {
        throw toSignerError(error, "Failed to sign message.");
      }
    },
    async signEvent<T extends Record<string, unknown>>(event: T) {
      const signer = readBrowserSigner();
      const signEvent = signer?.signEvent ?? signer?.nip07?.signEvent ?? signer?.nip04?.signEvent;
      if (!signEvent) {
        throw new SignerServiceError("unavailable", "This signer does not support event signing.");
      }
      try {
        const signed = await signEvent(event);
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
