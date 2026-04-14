import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { isValidNpub } from "./nostrIdentity";

describe("nostrIdentity", () => {
  it("accepts valid npub and rejects malformed bech32 input", () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));

    expect(isValidNpub(npub)).toBe(true);
    expect(isValidNpub("npub1bad")).toBe(false);
    expect(isValidNpub("abc")).toBe(false);
  });
});
