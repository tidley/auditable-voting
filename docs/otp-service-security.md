# OTP Service — Security Hardening

## Overview

The OTP service (`web/src/otpService.ts`) provides one-time password generation,
key derivation, verification, and expiry checking for the resident OTP
admission flow.

This document describes the security measures implemented in the service and
the rationale for each — including, in
[The actual bound](#the-actual-bound-what-this-does-not-buy), an explicit
statement of what these measures do **not** buy. A previous revision of this
document claimed that rate limiting bounded brute force against a stored
record. It did not, and it does not: the attempt tracker is per loaded page and
in-memory, and an attacker working from a copy of the stored record is offline
and unaffected by it. That claim has been removed and replaced with the
measured bound.

## Security measures

### 1. Cryptographically secure OTP generation

`generateOtp()` uses `crypto.getRandomValues()` (Web Crypto API) instead of
`Math.random()`. `Math.random()` is a non-cryptographic PRNG whose output can be
predicted if an attacker can observe enough outputs or infer the internal state.
`crypto.getRandomValues()` draws from the operating system's CSPRNG and is
suitable for security-sensitive tokens.

The code space is 10^6 (six decimal digits — `generateOtp()` takes a 32-bit
random value modulo 1,000,000 and zero-pads, so the distribution is uniform),
i.e. **≈ 20 bits of entropy**. That number, not the KDF, is the binding
constraint on the stored record (see below).

### 2. Salted, work-factored key derivation (PBKDF2-HMAC-SHA256)

`hashOtp()` generates a 16-byte random salt per code and derives a 32-byte
digest with **PBKDF2-HMAC-SHA256** at `OTP_KDF_ITERATIONS` = **600,000**
iterations (the OWASP recommendation for PBKDF2-HMAC-SHA256, 2023). The stored
record is:

```
pbkdf2-sha256$600000$<saltHex: 32 hex chars>$<digestHex: 64 hex chars>
```

Salting prevents rainbow-table attacks, ensures that two identical OTPs produce
different stored records, and stops an attacker who compromises the store from
correlating entries.

**Why PBKDF2 and not HKDF.** HKDF is a key *expander*: it is fast by design and
adds no work factor, so it is the wrong primitive for a low-entropy secret that
must resist offline guessing. PBKDF2 is a password-hardening KDF and is built
into `crypto.subtle`, so no dependency was added.

**Why the work factor is stored in the record.** The declared iteration count
travels with the record, so a verification costs what the record says rather
than whatever the current build happens to use. That makes the cost auditable
from the stored bytes alone, and it means raising the write factor later does
not silently reinterpret existing records.

**Why there is no pepper.** A keyed hash (HMAC with a secret key) would not
help in this design: everything is browser-local, so any key would have to be
stored in the same origin the attacker already has. A secret that travels with
the record adds nothing against an offline attacker holding that record.

#### What the fix changed

The pre-fix construction was a **single SHA-256 over `salt || code`** with the
salt stored next to the digest. That is a fast hash — one SHA-256 compression
per guess — so a `localStorage` dump was invertible at bare-hash speed. Records
in that format are **never honoured** by this build: `verifyOtp()` fails closed
on them and callers surface `UNVERIFIABLE_OTP_RECORD_MESSAGE`, directing the
resident to the organiser for a re-issue. There is no silent acceptance of, and
no silent migration from, the weak format.

### 3. Constant-time comparison

`verifyOtp()` compares the derived digest against the stored digest using a
constant-time comparison function (`constantTimeEqual`). This function
iterates over the full length of both strings regardless of where the first
mismatch occurs, preventing timing attacks that could reveal how many leading
characters of the digest are correct.

### 4. Per-page attempt limiting (defence in depth, not a rate limit)

`verifyOtp()` rejects further attempts against a stored record after
`MAX_OTP_ATTEMPTS` (5) failed verifications, so interactive guessing inside one
loaded page is bounded. The counter resets on a successful verification or when
`resetOtpAttempts()` is called.

Stated precisely, this is **not** a rate limit in the usual sense:

- It lives in a module-level in-memory `Map`, so **a reload clears it**, and it
  is not shared between tabs.
- It does not exist in any process that is not running the page — an attacker
  who copied the stored record out of `localStorage` brute-forces it offline
  and never touches this counter.
- It therefore bounds only interactive guessing by someone using the page in
  front of you, which is why the KDF work factor (measure 2) is what actually
  raises the offline cost.

The tracker has a soft cap of 10,000 entries; when exceeded, the oldest entries
are evicted to prevent unbounded memory growth from adversarial inputs.

### 5. Bounded verification cost (fail closed)

Because the work factor is read from the record, a record declaring an absurd
cost could otherwise hang the tab. `verifyOtp()` rejects any record whose
declared iterations fall outside
`[OTP_KDF_MIN_ITERATIONS (100,000), OTP_KDF_MAX_ITERATIONS (10,000,000)]`
before deriving anything. The floor also blocks a *downgraded* record: a
rewritten record claiming a cheaper cost can never be verified.

## The actual bound (what this does *not* buy)

A stored OTP record is a **weak secret**, and the honest summary is: the KDF
raises the per-guess cost of an offline attack, but the 10^6 code space still
makes a stolen roster recoverable by a determined attacker.

Measured on this project's test machine (Node 22.22.1 / OpenSSL,
single-threaded, Intel i7-7600U @ 2.80 GHz, 2 cores / 4 threads):

| Quantity | Measured |
|---|---|
| One PBKDF2-HMAC-SHA256 derivation at 600,000 iterations | 324.9 ms |
| One bare SHA-256 of the same 22-byte input (16-byte salt ‖ 6-digit code) | 0.032 ms |
| Per-guess speed-up of the KDF over the pre-fix construction | ≈ 10,100× |

Both figures are `crypto.subtle` calls in Node 22.22.1 (OpenSSL) on a
**single thread**; the KDF number is the mean of 3 derivations and the bare hash
the mean of 20,000 digests. Browsers use a different PBKDF2 backend and will
differ, and a browser main thread has no such budget to spare — hence the
bounded-cost check in measure 5.

Arithmetic from those measurements (extrapolation, not measured here):

- Exhaustive search of one record's 10^6 codes at 324.9 ms/guess ≈ **3.8 days**
  on one thread of a laptop-class CPU (≈ 3.1 guesses/s).
- The same search on ~1,000 concurrent guesses (a small cluster, or a modern
  many-core server where each core is also faster than this 2017 2-core part)
  ≈ **minutes**.
- On GPU/ASIC hardware the KDF is much weaker than the table above suggests:
  PBKDF2-HMAC-SHA256 costs ~6 × 10^5 SHA-256 compressions per guess, and
  commodity GPUs already do ~10^10 SHA-256/s, which puts a full 10^6-code scan
  in the **~10^2 seconds** range per accelerator. (Published accelerator rates,
  not measured here; this machine's single-thread `subtle.digest` rate of
  ~3.1 × 10^4/s is call-overhead-bound and is *not* a useful proxy.)

Consequences for the threat model:

- A `localStorage` compromise exposes the roster of *all* issued records in that
  browser; each is independently brute-forceable. Treat such a dump as a leak of
  the codes, not as a hash the attacker cannot use.
- Salting does not help against a per-record exhaustive search; it only stops
  precomputation and cross-record correlation.
- The attempt tracker contributes nothing against this attacker.
- The fix is still worth shipping: it removes a fast, trivially invertible
  construction, and the stored bytes now state their own cost. It is a
  ~10,000× per-guess speed bump, not a barrier.

If the code space needs to be the barrier rather than the KDF, the change is a
longer code (e.g. 8–10 characters from a larger alphabet), which is a product
and UX decision (the entry UI, out-of-band hand-off and CSV flows all assume six
digits) and is not part of this fix.

## API

| Function | Signature | Description |
|---|---|---|
| `generateOtp` | `() => string` | Returns a 6-digit OTP string using CSPRNG. |
| `hashOtp` | `(otp: string) => Promise<string>` | Returns `pbkdf2-sha256$iterations$saltHex$digestHex`. |
| `verifyOtp` | `(otp: string, storedHash: string) => Promise<boolean>` | Verifies OTP against a stored record; fails closed on legacy/malformed/out-of-range records. |
| `classifyStoredOtpHash` | `(storedHash: string) => StoredOtpHashFormat` | Classifies a record as `pbkdf2-sha256`, `legacy-sha256` or `malformed` without deriving anything, so callers can explain a failure. |
| `isOtpExpired` | `(issuedAt: number, ttlMs?: number) => boolean` | Checks if OTP has expired. |
| `resetOtpAttempts` | `(storedHash?: string) => void` | Resets attempt counter for a record, or all counters. |

## Constants

| Name | Value | Description |
|---|---|---|
| `OTP_TTL_MS` | `600_000` (10 min) | Default OTP time-to-live for interactive use. |
| `ADMISSION_TTL_MS` | `86_400_000` (24 h) | TTL for admission codes distributed out of band. |
| `MAX_OTP_ATTEMPTS` | `5` | Max failed attempts per page load before the record is rejected. |
| `OTP_KDF_SCHEME` | `"pbkdf2-sha256"` | Scheme marker stored as the first record field. |
| `OTP_KDF_ITERATIONS` | `600_000` | Work factor written into new records. |
| `OTP_KDF_MIN_ITERATIONS` | `100_000` | Floor: records below this are rejected as downgraded. |
| `OTP_KDF_MAX_ITERATIONS` | `10_000_000` | Ceiling: records above this are rejected without derivation. |

## Testing

The test suites cover the service in two files:

- `web/src/otpService.test.ts` — the functional surface (generation, record
  format, salt randomisation, constant-time comparison, attempt limiting,
  expiry).
- `web/src/otpService.kdf.test.ts` — the C2 work-factor contracts: the declared
  work factor is at or above the floor, the digest is a real PBKDF2 derivation
  at the *declared* cost (independently re-derived in the test), the KDF costs
  orders of magnitude more than a bare SHA-256, a legacy single-SHA-256 record
  is not silently accepted, a downgraded record is rejected, a record declaring
  an absurd work factor is rejected without stalling, and the attempt tracker is
  pinned to "does not survive a reload" so the bound documented above stays
  true.

Run tests:

```bash
cd web && npx vitest run src/otpService.test.ts src/otpService.kdf.test.ts
```

Run with coverage:

```bash
cd web && npx vitest run src/otpService.test.ts src/otpService.kdf.test.ts --coverage
```

## Integration with Masterlist Interop CSV Parser

The OTP admission flow can now be driven from either the integer-mode resident
register (`parseResidentCsv`, `masters_list_number` header) or the interop
masterlist roster (`parseMasterlistCsv`, `id,masterlist_no,…` header).
Both parsers live in `web/src/residentRegister.ts` and apply the same
CSV-injection neutralisation to contact fields (see
[docs/csv-injection-protection.md](csv-injection-protection.md#masterlist-interop-mode)).

The masterlist interop mode introduces `masterlistNo` as a string eligibility
key (e.g. `ML001`) — distinct from the integer `mastersListNumber` — and
filters rows by `status=active` only.  Contact fields (email, phone, dob,
country) are neutralised identically so exported rosters are safe to open in
spreadsheet applications.
