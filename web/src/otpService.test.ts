import { describe, expect, it } from "vitest";
import { generateOtp, hashOtp, verifyOtp, isOtpExpired } from "./otpService";

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
});

describe("hashOtp", () => {
  it("returns a hex string of 64 characters (SHA-256)", async () => {
    const hash = await hashOtp("123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different OTPs", async () => {
    const hash1 = await hashOtp("111111");
    const hash2 = await hashOtp("222222");
    expect(hash1).not.toBe(hash2);
  });

  it("is deterministic for the same input", async () => {
    const hash1 = await hashOtp("000000");
    const hash2 = await hashOtp("000000");
    expect(hash1).toBe(hash2);
  });
});

describe("verifyOtp", () => {
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