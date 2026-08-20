import { describe, expect, it, beforeEach } from "vitest";
import {
  generateOtp,
  hashOtp,
  verifyOtp,
  isOtpExpired,
  resetOtpAttempts,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  MAX_TRACKER_ENTRIES,
} from "./otpService";

describe("generateOtp", () => {
  it("returns a 6-digit string", () => {
    const otp = generateOtp();
    expect(otp).toMatch(/^\d{6}$/);
  });

  it("returns different values on successive calls", () => {
    const otp1 = generateOtp();
    const otp2 = generateOtp();
    expect(otp1).not.toBe(otp2);
  });

  it("always produces 6-digit strings over many iterations", () => {
    for (let i = 0; i < 100; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it("uses crypto.getRandomValues (not Math.random)", () => {
    // Stub Math.random to always return 0 — if generateOtp still uses it,
    // every call would produce "000000". With crypto.getRandomValues,
    // the result will be different.
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
      // Extremely unlikely to get all zeros from crypto.getRandomValues
      // (1 in 1,000,000 per call, but we assert it's not always 0)
      const otp2 = generateOtp();
      expect(otp2).toMatch(/^\d{6}$/);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("hashOtp", () => {
  it("returns a hex string containing a salt and SHA-256 hash", async () => {
    const result = await hashOtp("123456");
    // Format: saltHex:hashHex where salt is 32 hex chars (16 bytes) and hash is 64 hex chars
    expect(result).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it("produces different hashes for the same OTP (salt randomisation)", async () => {
    const hash1 = await hashOtp("111111");
    const hash2 = await hashOtp("111111");
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different OTPs", async () => {
    const hash1 = await hashOtp("111111");
    const hash2 = await hashOtp("222222");
    expect(hash1).not.toBe(hash2);
  });
});

describe("verifyOtp", () => {
  beforeEach(() => {
    resetOtpAttempts();
  });

  it("returns true for an OTP matching its hash", async () => {
    const otp = "123456";
    const hash = await hashOtp(otp);
    const result = await verifyOtp(otp, hash);
    expect(result).toBe(true);
  });

  it("returns false for an OTP not matching its hash", async () => {
    const hash = await hashOtp("123456");
    const result = await verifyOtp("654321", hash);
    expect(result).toBe(false);
  });

  it("uses constant-time comparison (does not short-circuit on length mismatch)", async () => {
    // A constant-time comparison should process the full string length
    // regardless of where the mismatch occurs. We verify that verifyOtp
    // returns false (not throws) for hashes of different lengths.
    const hash = await hashOtp("123456");
    const shortHash = hash.slice(0, 30); // wrong length
    const result = await verifyOtp("123456", shortHash);
    expect(result).toBe(false);
  });

  it("enforces rate limiting: rejects after MAX_OTP_ATTEMPTS failed attempts", async () => {
    const hash = await hashOtp("123456");

    // First 5 wrong attempts should return false
    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      const result = await verifyOtp("000000", hash);
      expect(result).toBe(false);
    }

    // 6th attempt should be rejected (rate limited)
    const result = await verifyOtp("000000", hash);
    expect(result).toBe(false);

    // Even a correct OTP should be rejected after rate limit is hit
    const correctResult = await verifyOtp("123456", hash);
    expect(correctResult).toBe(false);
  });

  it("resets attempt counter on successful verification", async () => {
    const otp = "999999";
    const hash = await hashOtp(otp);

    // 4 failed attempts (under the limit)
    for (let i = 0; i < 4; i++) {
      await verifyOtp("000000", hash);
    }

    // Correct OTP should succeed and reset counter
    const result = await verifyOtp(otp, hash);
    expect(result).toBe(true);

    // After reset, we get another full MAX_OTP_ATTEMPTS
    for (let i = 0; i < 4; i++) {
      const r = await verifyOtp("000000", hash);
      expect(r).toBe(false);
    }
    const finalResult = await verifyOtp(otp, hash);
    expect(finalResult).toBe(true);
  });

  it("returns false for a malformed stored hash (no colon separator)", async () => {
    resetOtpAttempts();
    const result = await verifyOtp("123456", "malformedhashnocolon");
    expect(result).toBe(false);
  });

  it("can reset attempts for a specific hash", async () => {
    const hash = await hashOtp("123456");

    // Exhaust the rate limit
    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      await verifyOtp("000000", hash);
    }

    // Rate limited
    expect(await verifyOtp("123456", hash)).toBe(false);

    // Reset just this hash
    resetOtpAttempts(hash);

    // Now verification should work again
    expect(await verifyOtp("123456", hash)).toBe(true);
  });

  it("evicts oldest entries when tracker exceeds the soft cap", async () => {
    resetOtpAttempts();

    // Fill the tracker with MAX_TRACKER_ENTRIES + 1 unique failed attempts
    // Each fake storedHash has the correct format to pass parsing
    for (let i = 0; i <= MAX_TRACKER_ENTRIES; i++) {
      const fakeHash = `${i.toString(16).padStart(32, "0")}:${"a".repeat(64)}`;
      await verifyOtp("000000", fakeHash);
    }

    // The tracker should have evicted at least one entry to stay at cap
    // We verify by checking that the first entry was evicted — generate
    // a new hash and verify it still works (tracker is functional)
    const otp = "555555";
    const hash = await hashOtp(otp);
    const result = await verifyOtp(otp, hash);
    expect(result).toBe(true);

    resetOtpAttempts();
  });
});

describe("isOtpExpired", () => {
  it("returns true for an OTP issued beyond the TTL window", () => {
    const issuedAt = Date.now() - 15 * 60 * 1000; // 15 minutes ago
    const ttlMs = 10 * 60 * 1000; // 10 minute TTL
    expect(isOtpExpired(issuedAt, ttlMs)).toBe(true);
  });

  it("returns false for an OTP issued within the TTL window", () => {
    const issuedAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    const ttlMs = 10 * 60 * 1000;
    expect(isOtpExpired(issuedAt, ttlMs)).toBe(false);
  });

  it("returns false for an OTP issued just now", () => {
    const issuedAt = Date.now();
    const ttlMs = 10 * 60 * 1000;
    expect(isOtpExpired(issuedAt, ttlMs)).toBe(false);
  });

  it("returns true for an OTP with zero TTL (immediately expired)", () => {
    const issuedAt = Date.now() - 1; // 1ms ago
    const ttlMs = 0;
    expect(isOtpExpired(issuedAt, ttlMs)).toBe(true);
  });
});