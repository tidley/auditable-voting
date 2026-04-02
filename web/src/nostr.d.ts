import type { EventTemplate, VerifiedEvent } from "nostr-tools";

export interface WindowNostr {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
}

declare global {
  interface Window {
    nostr?: WindowNostr;
  }
}

export {};
