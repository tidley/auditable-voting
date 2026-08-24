/**
 * OTP TTL in milliseconds (10 minutes).
 */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * TTL in milliseconds for admission codes distributed out of band (24 hours).
 *
 * Admission codes are handed to residents outside the interactive flow and
 * may sit for a while before the resident enters them, so they need a longer
 * life than the 10-minute interactive TTL. The 10-minute default is
 * unchanged for interactive use.
 */
export const ADMISSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of failed verification attempts per OTP hash before
 * the hash is permanently rejected (rate limiting).
 */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Size of the random salt in bytes (16 bytes = 128 bits).
 */
const SALT_BYTES = 16;

/**
 * In-memory attempt tracker for rate limiting.
 * Maps OTP hash → number of failed verification attempts.
 *
 * Entries are cleaned up once they hit MAX_OTP_ATTEMPTS (the hash is
 * permanently rejected at that point, so retaining the entry serves
 * no purpose and would leak memory).
 */
const attemptTracker = new Map<string, number>();

/**
 * Soft cap on the attempt tracker size. When exceeded, the oldest
 * entries are evicted to prevent unbounded memory growth from
 * adversarial inputs.
 */
export const MAX_TRACKER_ENTRIES = 10_000;

/**
 * Reset the attempt counter for a specific OTP hash, or clear all
 * counters when no argument is given.
 *
 * @param storedHash - The salted hash to reset, or omit to clear all.
 */
export function resetOtpAttempts(storedHash?: string): void {
  if (storedHash !== undefined) {
    attemptTracker.delete(storedHash);
  } else {
    attemptTracker.clear();
  }
}

/**
 * Convert a Uint8Array to a hex string.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a 6-digit OTP code using cryptographically secure randomness.
 * Returns the code as a string to preserve leading zeros.
 *
 * Uses crypto.getRandomValues instead of Math.random to ensure
 * the OTP cannot be predicted by attackers who can observe the
 * PRNG state.
 */
export function generateOtp(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const value = buffer[0] % 1_000_000;
  return value.toString().padStart(6, "0");
}

/**
 * Hash an OTP with a random salt using SHA-256 via crypto.subtle.
 *
 * The salt is 16 random bytes generated per call. The hash is computed
 * over salt concatenated with the OTP. The returned string has the format
 * `saltHex:hashHex` (32 hex chars : 64 hex chars).
 *
 * Salting prevents rainbow-table attacks and ensures that two
 * identical OTPs produce different stored hashes.
 *
 * @param otp - The plaintext OTP code to hash.
 * @returns A string in `saltHex:hashHex` format.
 */
export async function hashOtp(otp: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);

  const encoder = new TextEncoder();
  const otpBytes = encoder.encode(otp);
  const combined = new Uint8Array(salt.length + otpBytes.length);
  combined.set(salt, 0);
  combined.set(otpBytes, salt.length);

  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);
  const hashHex = toHex(new Uint8Array(hashBuffer));
  const saltHex = toHex(salt);
  return `${saltHex}:${hashHex}`;
}

/**
 * Compare two strings in constant time to prevent timing attacks.
 *
 * Iterates over the full length of both strings regardless of where
 * the first mismatch occurs, so an attacker cannot learn how many
 * leading characters are correct by measuring response time.
 *
 * @returns true if the strings are equal, false otherwise.
 */
function constantTimeEqual(a: string, b: string): boolean {
  // Always iterate over the longer string to avoid leaking length info
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ

  for (let i = 0; i < maxLen; i++) {
    const aChar = a.charCodeAt(i) || 0;
    const bChar = b.charCodeAt(i) || 0;
    result |= aChar ^ bChar;
  }

  return result === 0;
}

/**
 * Verify an OTP against a stored salted hash.
 *
 * Extracts the salt from the stored hash, recomputes the SHA-256
 * of salt||otp, and compares using constant-time comparison to
 * prevent timing attacks.
 *
 * Rate limiting: after MAX_OTP_ATTEMPTS failed verifications against
 * the same stored hash, all subsequent attempts (even with the
 * correct OTP) are rejected. The counter resets on a successful
 * verification or an explicit call to resetOtpAttempts.
 *
 * @param otp - The plaintext OTP code to verify.
 * @param storedHash - The stored `saltHex:hashHex` string to verify against.
 * @returns true if the OTP matches and rate limit has not been exceeded.
 */
export async function verifyOtp(otp: string, storedHash: string): Promise<boolean> {
  // Check rate limiting before doing any work
  const attempts = attemptTracker.get(storedHash) ?? 0;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    return false;
  }

  // Parse salt and expected hash from the stored value
  const colonIndex = storedHash.indexOf(":");
  if (colonIndex === -1) {
    // Malformed stored hash — treat as invalid
    return false;
  }
  const saltHex = storedHash.slice(0, colonIndex);
  const expectedHashHex = storedHash.slice(colonIndex + 1);

  // Recompute the hash with the extracted salt
  const encoder = new TextEncoder();
  const saltBytes = new Uint8Array(
    saltHex.match(/.{2}/g)?.map((hex) => parseInt(hex, 16)) ?? [],
  );
  const otpBytes = encoder.encode(otp);
  const combined = new Uint8Array(saltBytes.length + otpBytes.length);
  combined.set(saltBytes, 0);
  combined.set(otpBytes, saltBytes.length);

  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);
  const actualHashHex = toHex(new Uint8Array(hashBuffer));

  // Constant-time comparison
  const isMatch = constantTimeEqual(actualHashHex, expectedHashHex);

  if (isMatch) {
    // Successful verification — reset the attempt counter
    attemptTracker.delete(storedHash);
    return true;
  } else {
    // Failed attempt — increment the counter
    attemptTracker.set(storedHash, attempts + 1);

    // Evict oldest entries if tracker exceeds the soft cap to prevent
    // unbounded memory growth from adversarial inputs
    if (attemptTracker.size > MAX_TRACKER_ENTRIES) {
      const firstKey = attemptTracker.keys().next().value;
      if (firstKey !== undefined) {
        attemptTracker.delete(firstKey);
      }
    }

    return false;
  }
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