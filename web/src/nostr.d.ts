import type { EventTemplate, VerifiedEvent } from "nostr-tools";

export interface WindowNostr {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: WindowNostr;
  }
}

export {};
