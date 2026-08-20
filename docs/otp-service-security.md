# OTP Service — Security Hardening

## Overview

The OTP service (`web/src/otpService.ts`) provides one-time password generation,
hashing, verification, and expiry checking for the resident OTP admission flow.

This document describes the security measures implemented in the service and
the rationale for each.

## Security measures

### 1. Cryptographically secure OTP generation

`generateOtp()` uses `crypto.getRandomValues()` (Web Crypto API) instead of
`Math.random()`. `Math.random()` is a non-cryptographic PRNG whose output can be
predicted if an attacker can observe enough outputs or infer the internal state.
`crypto.getRandomValues()` draws from the operating system's CSPRNG and is
suitable for security-sensitive tokens.

### 2. Salted hashing

`hashOtp()` generates a 16-byte random salt per OTP and computes
`SHA-256(salt || OTP)`. The stored hash has the format `saltHex:hashHex`.

Salting prevents rainbow-table attacks and ensures that two identical OTPs
produce different stored hashes, so an attacker who compromises the hash
store cannot correlate entries.

### 3. Constant-time comparison

`verifyOtp()` compares the computed hash against the stored hash using a
constant-time comparison function (`constantTimeEqual`). This function
iterates over the full length of both strings regardless of where the first
mismatch occurs, preventing timing attacks that could reveal how many leading
characters of the hash are correct.

### 4. Rate limiting

`verifyOtp()` enforces a maximum of 5 failed verification attempts per stored
hash. After the limit is reached, all subsequent attempts — even with the
correct OTP — are rejected. The counter resets on a successful verification or
when `resetOtpAttempts()` is called.

Rate limiting prevents brute-force attacks where an attacker tries many
OTP values against a known hash.

The attempt tracker uses an in-memory `Map` with a soft cap of 10,000
entries. When the cap is exceeded, the oldest entries are evicted to
prevent unbounded memory growth from adversarial inputs.

## API

| Function | Signature | Description |
|---|---|---|
| `generateOtp` | `() => string` | Returns a 6-digit OTP string using CSPRNG. |
| `hashOtp` | `(otp: string) => Promise<string>` | Returns `saltHex:hashHex` for the given OTP. |
| `verifyOtp` | `(otp: string, storedHash: string) => Promise<boolean>` | Verifies OTP against stored hash with rate limiting. |
| `isOtpExpired` | `(issuedAt: number, ttlMs?: number) => boolean` | Checks if OTP has expired. |
| `resetOtpAttempts` | `(storedHash?: string) => void` | Resets attempt counter for a hash, or all counters. |

## Constants

| Name | Value | Description |
|---|---|---|
| `OTP_TTL_MS` | `600_000` (10 min) | Default OTP time-to-live. |
| `MAX_OTP_ATTEMPTS` | `5` | Max failed attempts before rate limiting. |

## Testing

The test suite (`otpService.test.ts`) covers 18 tests across all functions,
including security-specific tests for CSPRNG usage, salt randomisation,
constant-time comparison, rate limiting, and edge cases.

Run tests:

```bash
cd web && npx vitest run src/otpService.test.ts
```

Run with coverage:

```bash
cd web && npx vitest run src/otpService.test.ts --coverage
```