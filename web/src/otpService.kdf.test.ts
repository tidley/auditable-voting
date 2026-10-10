/**
 * C2 — stored-OTP work factor and legacy-record handling.
 *
 * Review finding (docs claim vs code): the PR documentation said a
 * localStorage compromise cannot recover a resident's code, and
 * `docs/otp-service-security.md` claimed rate limiting bounds brute force.
 * Neither was true of the shipped code: `hashOtp` was a single SHA-256 over
 * salt||code with the salt stored next to the digest, and the attempt tracker
 * is an in-memory Map that any reload resets.
 *
 * These tests pin the fixed bound:
 *  - the stored record carries an explicit, adequate PBKDF2 work factor
 *    (independently re-derivable from the stored fields), and
 *  - a record in the old single-SHA-256 format is NOT silently accepted, so a
 *    stale localStorage entry cannot be used to recover or replay a code.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OTP_KDF_ITERATIONS,
  OTP_KDF_MAX_ITERATIONS,
  OTP_KDF_MIN_ITERATIONS,
  OTP_KDF_SCHEME,
  classifyStoredOtpHash,
  hashOtp,
  verifyOtp,
} from "./otpService";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)?.map((pair) => parseInt(pair, 16)) ?? []);
}

/**
 * Rebuild the pre-fix stored format: a single SHA-256 over salt||code with the
 * salt stored alongside the digest. This is exactly what the shipped
 * implementation produced, so it models a record already sitting in a
 * resident's localStorage when this fix ships.
 */
async function legacySha256Record(code: string, saltHex = "00112233445566778899aabbccddeeff"): Promise<string> {
  const salt = fromHex(saltHex);
  const codeBytes = new TextEncoder().encode(code);
  const combined = new Uint8Array(salt.length + codeBytes.length);
  combined.set(salt, 0);
  combined.set(codeBytes, salt.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return `${saltHex}:${toHex(new Uint8Array(digest))}`;
}

describe("C2 hashOtp work factor", () => {
  it("stores an explicit PBKDF2 work factor at or above the shipped floor", async () => {
    const stored = await hashOtp("424242");
    const parts = stored.split("$");

    expect(parts[0]).toBe(OTP_KDF_SCHEME);
    expect(Number(parts[1])).toBe(OTP_KDF_ITERATIONS);
    expect(Number(parts[1])).toBeGreaterThanOrEqual(OTP_KDF_MIN_ITERATIONS);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(parts).toHaveLength(4);
  });

  it("stores a digest that is a real PBKDF2 derivation at the declared work factor", async () => {
    const stored = await hashOtp("424242");
    const [, iterations, saltHex, digestHex] = stored.split("$");

    // Independently re-derive the digest from the stored fields. A single
    // SHA-256 (the pre-fix construction) cannot reproduce this value.
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("424242"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: fromHex(saltHex),
        iterations: Number(iterations),
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );

    expect(toHex(new Uint8Array(derived))).toBe(digestHex);
  });

  it("costs orders of magnitude more than one bare SHA-256 of the code", async () => {
    const kdfStart = performance.now();
    await hashOtp("424242");
    const kdfMs = performance.now() - kdfStart;

    const bareStart = performance.now();
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("424242"));
    const bareMs = Math.max(performance.now() - bareStart, 0.02);

    // The whole point of C2: a localStorage dump must not be invertible at
    // bare-hash speed. 100x is the conservative floor for any real KDF; the
    // shipped SHA-256 construction sits at ~1x.
    expect(kdfMs / bareMs).toBeGreaterThan(100);
  });

  it("classifies stored records so callers can report the actual bound", async () => {
    expect(classifyStoredOtpHash(await hashOtp("424242"))).toBe("pbkdf2-sha256");
    expect(classifyStoredOtpHash(await legacySha256Record("424242"))).toBe("legacy-sha256");
    expect(classifyStoredOtpHash("not-a-record")).toBe("malformed");
  });
});

describe("C2 legacy record handling", () => {
  it("does not silently verify a correct code against a legacy single-SHA-256 record", async () => {
    const legacy = await legacySha256Record("424242");

    // Sanity: the record really does correspond to the correct code under the
    // old scheme, so a `false` below cannot be explained by a wrong fixture.
    expect(legacy.endsWith(":" + (await sha256Hex("424242", legacy.split(":")[0])))).toBe(true);

    await expect(verifyOtp("424242", legacy)).resolves.toBe(false);
  });

  it("still verifies a current-format record with its own work factor", async () => {
    const stored = await hashOtp("424242");
    await expect(verifyOtp("424242", stored)).resolves.toBe(true);
    await expect(verifyOtp("000000", stored)).resolves.toBe(false);
  });

  it("rejects a record whose declared work factor is below the floor", async () => {
    // A record that claims PBKDF2 but with a work factor an attacker could
    // choose: honouring it would re-open the fast offline guess.
    const salt = "00112233445566778899aabbccddeeff";
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("424242"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: fromHex(salt), iterations: 1, hash: "SHA-256" },
      keyMaterial,
      256,
    );
    const downgraded = `${OTP_KDF_SCHEME}$1$${salt}$${toHex(new Uint8Array(derived))}`;

    await expect(verifyOtp("424242", downgraded)).resolves.toBe(false);
  });

  it("rejects a record declaring an absurd work factor instead of stalling on it", async () => {
    // A well-formed record (so the format check passes) whose declared cost
    // is above the accepted ceiling: the range check must reject it before
    // any derivation, or a hostile record could freeze the tab.
    const salt = "00112233445566778899aabbccddeeff";
    const absurd = `${OTP_KDF_SCHEME}$${OTP_KDF_MAX_ITERATIONS + 1}$${salt}$${"0".repeat(64)}`;
    expect(classifyStoredOtpHash(absurd)).toBe("pbkdf2-sha256");

    const startedAt = performance.now();
    await expect(verifyOtp("424242", absurd)).resolves.toBe(false);
    // Smoke bound only: one PBKDF2 pass at the shipped factor takes an order
    // of magnitude longer than this on any machine.
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("pins the documented bound: the attempt tracker does not survive a reload", async () => {
    // The docs must state this bound honestly, so pin the behaviour: the
    // tracker is a module-level Map, and a fresh page load starts empty.
    const { verifyOtp: verifyInPage, hashOtp: hashInPage } = await import("./otpService");
    const stored = await hashInPage("424242");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyInPage("000000", stored);
    }
    await expect(verifyInPage("000000", stored)).resolves.toBe(false);

    vi.resetModules();
    const { verifyOtp: verifyAfterReload } = await import("./otpService");
    await expect(verifyAfterReload("424242", stored)).resolves.toBe(true);
    expect(stored.split("$")[0]).toBe(OTP_KDF_SCHEME);
  });
});

async function sha256Hex(code: string, saltHex: string): Promise<string> {
  const salt = fromHex(saltHex);
  const codeBytes = new TextEncoder().encode(code);
  const combined = new Uint8Array(salt.length + codeBytes.length);
  combined.set(salt, 0);
  combined.set(codeBytes, salt.length);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", combined)));
}
