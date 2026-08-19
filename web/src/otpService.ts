/**
 * OTP TTL in milliseconds (10 minutes).
 */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * Generate a 6-digit OTP code, returned as a string to preserve leading zeros.
 */
export function generateOtp(): string {
  const value = Math.floor(Math.random() * 1_000_000);
  return value.toString().padStart(6, "0");
}

/**
 * Hash an OTP using SHA-256 via crypto.subtle (Web Crypto API).
 * Returns the hex-encoded hash string.
 */
export async function hashOtp(otp: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify an OTP against an expected SHA-256 hash.
 */
export async function verifyOtp(otp: string, expectedHash: string): Promise<boolean> {
  const hash = await hashOtp(otp);
  return hash === expectedHash;
}

/**
 * Check if an OTP has expired based on its issue timestamp and TTL in milliseconds.
 *
 * @param issuedAt - Unix timestamp (ms) when the OTP was issued.
 * @param ttlMs - Time-to-live in milliseconds (default: OTP_TTL_MS).
 */
export function isOtpExpired(issuedAt: number, ttlMs: number = OTP_TTL_MS): boolean {
  return Date.now() > issuedAt + ttlMs;
}