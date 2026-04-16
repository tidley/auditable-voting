// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSignerService, SignerServiceError } from "./signerService";

function clearSigner() {
  const target = globalThis as typeof globalThis & { nostr?: unknown };
  delete target.nostr;
}

describe("signerService", () => {
  afterEach(() => {
    clearSigner();
  });

  it("calls signer methods with owner binding", async () => {
    const target = globalThis as typeof globalThis & { nostr?: unknown };
    target.nostr = {
      marker: "bound-value",
      async getPublicKey(this: { marker?: string }) {
        if (this.marker !== "bound-value") {
          throw new Error("binding lost");
        }
        return "f".repeat(64);
      },
    };

    const signer = createSignerService();
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toHaveLength(64);
  });

  it("waits for nostr:ready and late signer injection", async () => {
    const signer = createSignerService();

    const lateInjection = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const target = globalThis as typeof globalThis & { nostr?: unknown };
      target.nostr = {
        async getPublicKey() {
          return "e".repeat(64);
        },
      };
      window.dispatchEvent(new Event("nostr:ready"));
    })();

    const pubkey = await signer.getPublicKey();
    await lateInjection;
    expect(pubkey).toBe("e".repeat(64));
  });

  it("returns unavailable when no browser signer exists", async () => {
    const signer = createSignerService();
    await expect(signer.getPublicKey()).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(SignerServiceError);
      expect(String(error)).toMatch(/No Nostr signer is available/i);
      return true;
    });
  });
});
