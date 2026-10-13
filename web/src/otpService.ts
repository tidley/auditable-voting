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
 * Scheme marker stored as the first field of every OTP record.
 */
export const OTP_KDF_SCHEME = "pbkdf2-sha256";

/**
 * Work factor (PBKDF2 iteration count) used when writing a new record, and
 * carried inside the record itself so the cost of verifying a record does not
 * silently change when this file changes.
 *
 * The pre-fix construction was a single SHA-256 over `salt || code`, which is
 * a *fast* hash: an attacker holding a dump of `localStorage` could test every
 * possible code at bare-hash speed. PBKDF2-HMAC-SHA256 is the standard
 * password-hardening KDF (HKDF is deliberately *not* used here: it is a key
 * expander, not a work-factor KDF). 600,000 iterations is the OWASP
 * recommendation for PBKDF2-HMAC-SHA256 (2023), i.e. a per-guess cost roughly
 * three to four orders of magnitude above one SHA-256 of the same input.
 *
 * See `docs/otp-service-security.md` for the bound this does — and does not —
 * buy, measured on real hardware.
 */
export const OTP_KDF_ITERATIONS = 600_000;

/**
 * Lowest declared work factor `verifyOtp` will honour.
 *
 * A record declaring fewer iterations than this is rejected outright, so a
 * record that has been rewritten to a cheaper cost (a downgrade) can never be
 * verified. It is deliberately *below* `OTP_KDF_ITERATIONS` so that raising
 * the write factor later does not invalidate records already accepted.
 */
export const OTP_KDF_MIN_ITERATIONS = 100_000;

/**
 * Highest declared work factor `verifyOtp` will honour.
 *
 * The stored record carries its own cost, so an unbounded value would let a
 * hostile record (or a botched migration) freeze the tab for hours on a single
 * verification. Raise this alongside `OTP_KDF_ITERATIONS` if the write factor
 * ever approaches it.
 */
export const OTP_KDF_MAX_ITERATIONS = 10_000_000;

/**
 * In-memory attempt tracker for rate limiting.
 * Maps stored OTP record → number of failed verification attempts.
 *
 * Scope, stated honestly: this is a per-loaded-page-guess limiter. It is a
 * module-level `Map`, so it is destroyed by a reload and is not shared across
 * tabs, and it is irrelevant to an attacker working offline from a copy of the
 * stored record (the threat C2 addresses). It bounds interactive guessing
 * inside one page session and nothing more — see
 * `docs/otp-service-security.md`.
 *
 * Entries are cleaned up once they hit MAX_OTP_ATTEMPTS (the record is
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
 * Derive the stored digest for a code/salt pair with PBKDF2-HMAC-SHA256.
 *
 * @param otp - The plaintext code (the PBKDF2 password input).
 * @param salt - The per-record salt.
 * @param iterations - The work factor to apply.
 * @returns The 32-byte derived digest as lowercase hex.
 */
async function deriveOtpDigest(
  otp: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(otp),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return toHex(new Uint8Array(derived));
}

/**
 * The format of a stored OTP record.
 *
 * - `pbkdf2-sha256` — the current slow-KDF record (`scheme$iterations$salt$digest`).
 * - `legacy-sha256` — the pre-fix single-SHA-256 record (`saltHex:hashHex`),
 *   which is fast enough to brute-force offline and is therefore never honoured.
 * - `malformed` — anything else; also never honoured.
 */
export type StoredOtpHashFormat = "pbkdf2-sha256" | "legacy-sha256" | "malformed";

/**
 * Classify a stored OTP record without doing any key derivation.
 *
 * Callers use this to tell the user *why* verification failed: a
 * `legacy-sha256` or `malformed` record can never be verified by this build, so
 * reporting "incorrect code" would be misleading.
 */
export function classifyStoredOtpHash(storedHash: string): StoredOtpHashFormat {
  const parts = storedHash.split("$");
  if (parts.length === 4 && parts[0] === OTP_KDF_SCHEME) {
    const iterations = Number(parts[1]);
    const wellFormed = Number.isInteger(iterations)
      && iterations > 0
      && /^[0-9a-f]{32}$/i.test(parts[2])
      && /^[0-9a-f]{64}$/i.test(parts[3]);
    return wellFormed ? "pbkdf2-sha256" : "malformed";
  }
  if (parts.length === 1 && /^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(storedHash)) {
    return "legacy-sha256";
  }
  return "malformed";
}

/**
 * Status copy for a stored record this build refuses to verify (the pre-fix
 * format, or a damaged record). Verification fails closed, so the resident is
 * sent to the organiser for a new code instead of being told their (possibly
 * correct) code was wrong.
 */
export const UNVERIFIABLE_OTP_RECORD_MESSAGE =
  "This code cannot be verified in this browser — it was stored in an older or unreadable format. Ask your organiser for a new code.";

/**
 * Parse a current-format stored record into its parts.
 * Returns `null` for the legacy format, malformed records, and work factors
 * outside the accepted range — every one of which must fail closed.
 */
function parseStoredOtpHash(
  storedHash: string,
): { iterations: number; salt: Uint8Array<ArrayBuffer>; digestHex: string } | null {
  if (classifyStoredOtpHash(storedHash) !== "pbkdf2-sha256") {
    return null;
  }
  const [, iterationsField, saltHex, digestHex] = storedHash.split("$");
  const iterations = Number(iterationsField);
  if (iterations < OTP_KDF_MIN_ITERATIONS || iterations > OTP_KDF_MAX_ITERATIONS) {
    return null;
  }
  const salt = new Uint8Array(
    saltHex.match(/.{2}/g)?.map((hex) => parseInt(hex, 16)) ?? [],
  );
  return { iterations, salt, digestHex };
}

/**
 * Hash an OTP with a random salt using PBKDF2-HMAC-SHA256 via `crypto.subtle`.
 *
 * The salt is 16 random bytes generated per call and the work factor is
 * `OTP_KDF_ITERATIONS`. The returned record has the format
 * `pbkdf2-sha256$iterations$saltHex$digestHex`
 * (10 chars : 6-7 digits : 32 hex chars : 64 hex chars) — the declared work
 * factor is part of the record, so `verifyOtp` re-derives the digest at the
 * cost the record itself states rather than at whatever this build now uses.
 *
 * Salting prevents rainbow-table attacks and ensures that two identical OTPs
 * produce different stored records, so an attacker who compromises the store
 * cannot correlate entries. Salting does *not* make a 6-digit code
 * unrecoverable — see `docs/otp-service-security.md` for the actual bound.
 *
 * @param otp - The plaintext OTP code to hash.
 * @returns A string in `scheme$iterations$saltHex$digestHex` format.
 */
export async function hashOtp(otp: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);

  const digestHex = await deriveOtpDigest(otp, salt, OTP_KDF_ITERATIONS);
  return `${OTP_KDF_SCHEME}$${OTP_KDF_ITERATIONS}$${toHex(salt)}$${digestHex}`;
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
 * Verify an OTP against a stored record.
 *
 * Parses the record's declared scheme, salt and work factor, re-derives the
 * digest with PBKDF2-HMAC-SHA256 at the declared cost, and compares using
 * constant-time comparison to prevent timing attacks.
 *
 * Fails closed: a record in the pre-fix single-SHA-256 format, a malformed
 * record, and a record declaring a work factor outside
 * `[OTP_KDF_MIN_ITERATIONS, OTP_KDF_MAX_ITERATIONS]` are all rejected without
 * any derivation. An existing weak record is therefore never silently
 * accepted — callers should use `classifyStoredOtpHash` to explain why and
 * point the resident at the organiser for a re-issue.
 *
 * Rate limiting: after MAX_OTP_ATTEMPTS failed verifications against
 * the same stored record, all subsequent attempts (even with the
 * correct OTP) are rejected. The counter resets on a successful
 * verification or an explicit call to resetOtpAttempts. The tracker is
 * in-memory and per page load (see `attemptTracker`).
 *
 * @param otp - The plaintext OTP code to verify.
 * @param storedHash - The stored `scheme$iterations$saltHex$digestHex` record.
 * @returns true if the OTP matches and rate limit has not been exceeded.
 */
export async function verifyOtp(otp: string, storedHash: string): Promise<boolean> {
  // Check rate limiting before doing any work
  const attempts = attemptTracker.get(storedHash) ?? 0;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    return false;
  }

  // Parse the record. Anything this build refuses to verify (the pre-fix
  // format, malformed input, an out-of-range work factor) fails closed
  // without consuming an attempt: it can never succeed, so counting it
  // would only lock out a legitimate resident.
  const parsed = parseStoredOtpHash(storedHash);
  if (!parsed) {
    return false;
  }

  const actualHashHex = await deriveOtpDigest(otp, parsed.salt, parsed.iterations);

  // Constant-time comparison
  const isMatch = constantTimeEqual(actualHashHex, parsed.digestHex);

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