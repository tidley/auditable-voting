import { describe, expect, it } from "vitest";
import { ADMISSION_TTL_MS, OTP_TTL_MS, isOtpExpired } from "./otpService";

describe("admission TTL", () => {
  it("exports a 24-hour admission TTL distinct from the 10-minute interactive TTL", () => {
    expect(ADMISSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(ADMISSION_TTL_MS).not.toBe(OTP_TTL_MS);
  });

  it("treats a code issued 12 hours ago as still valid under the admission TTL", () => {
    const issuedAt = Date.now() - 12 * 60 * 60 * 1000;
    expect(isOtpExpired(issuedAt, ADMISSION_TTL_MS)).toBe(false);
  });

  it("treats a code issued 25 hours ago as expired under the admission TTL", () => {
    const issuedAt = Date.now() - 25 * 60 * 60 * 1000;
    expect(isOtpExpired(issuedAt, ADMISSION_TTL_MS)).toBe(true);
  });
});
