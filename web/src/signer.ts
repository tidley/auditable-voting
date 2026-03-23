import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { decodeNsec } from "./nostrIdentity";
import type { WindowNostr } from "./nostr.d";

export type SignerMode = "raw" | "nip07";

export interface NostrSigner {
  mode: SignerMode;
  getPublicKey(): Promise<string>;
  getNpub(): Promise<string>;
  signEvent(template: EventTemplate): Promise<VerifiedEvent>;
  disconnect?(): void;
}

export function createRawSigner(nsec: string): NostrSigner {
  const secretKey = decodeNsec(nsec);

  if (!secretKey) {
    throw new Error("Invalid nsec: cannot decode to secret key.");
  }

  return {
    mode: "raw",
    async getPublicKey() {
      return getPublicKey(secretKey);
    },
    async getNpub() {
      return nip19.npubEncode(getPublicKey(secretKey));
    },
    async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
      return finalizeEvent(template, secretKey);
    }
  };
}

export function createNip07Signer(): NostrSigner {
  const nostr = window.nostr as WindowNostr | undefined;

  if (!nostr || typeof nostr.getPublicKey !== "function" || typeof nostr.signEvent !== "function") {
    throw new Error("No NIP-07 browser extension detected. Install Alby, nos2x, or NostrKey.");
  }

  return {
    mode: "nip07",
    async getPublicKey() {
      return nostr.getPublicKey();
    },
    async getNpub() {
      const hexPubkey = await nostr.getPublicKey();
      return nip19.npubEncode(hexPubkey);
    },
    async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
      const result = await nostr.signEvent(template);
      if (!result || !result.id || !result.pubkey || !result.sig) {
        throw new Error("NIP-07 extension returned an incomplete signed event.");
      }
      return result as VerifiedEvent;
    }
  };
}

export function detectSigner(): { mode: SignerMode; signer: NostrSigner | null } {
  const nostr = window.nostr;
  if (
    typeof window !== "undefined" && nostr &&
    typeof (nostr as WindowNostr).getPublicKey === "function" &&
    typeof (nostr as WindowNostr).signEvent === "function"
  ) {
    try {
      const signer = createNip07Signer();
      return { mode: "nip07", signer };
    } catch {
      return { mode: "raw", signer: null };
    }
  }
  return { mode: "raw", signer: null };
}

export function startSignerDetection(
  onDetected: (result: { mode: SignerMode; signer: NostrSigner | null }) => void,
  intervalMs: number = 500,
  maxAttempts: number = 20
): () => void {
  let attempts = 0;

  const timer = setInterval(() => {
    attempts++;

    const nostr = window.nostr;
    if (
      typeof window !== "undefined" && nostr &&
      typeof (nostr as WindowNostr).getPublicKey === "function" &&
      typeof (nostr as WindowNostr).signEvent === "function"
    ) {
      try {
        const signer = createNip07Signer();
        onDetected({ mode: "nip07", signer });
        clearInterval(timer);
        return;
      } catch {
        // Extension injected but not ready yet, retry
      }
    }

    if (attempts >= maxAttempts) {
      clearInterval(timer);
      onDetected({ mode: "raw", signer: null });
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
