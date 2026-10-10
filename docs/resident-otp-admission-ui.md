# Resident OTP admission — coordinator UI (demo)

## Overview

The coordinator app exposes a **Resident admission** section in the
Participants tab (`web/src/ResidentOtpAdmission.tsx`, mounted in
`SimpleCoordinatorApp.tsx`). It wires two existing services into a minimal
user-facing flow:

- `residentRegister.ts` — CSV parsing with validation and formula-injection
  neutralisation
- `otpService.ts` — secure one-time-code generation, salted hashing,
  verification, expiry

This is a **demo** flow: no email or SMS delivery is attempted. Codes are
displayed to the organiser once, who hands them to residents out of band.

## Flow

1. **Upload** — the organiser uploads a CSV with the header
   `masters_list_number,email,phone,name`. Parsing is all-or-nothing: any
   invalid row rejects the file with a per-row error list.
2. **Generate** — per resident or in one batch. Each code is generated with
   `generateOtp()` (CSPRNG) and its PBKDF2-HMAC-SHA256 record (`hashOtp()`) is
   retained for verification. The plaintext code is displayed in the
   "Issued codes" panel with a copy button and the issue time. Re-generating
   replaces the entry. The derived record is persisted to `localStorage`
   (`otp-admission-roster:<electionId>`) so the resident can redeem their
   code after this tab is closed; only the record is stored, never the
   plaintext code, and nothing is sent to any server.
3. **Verify** — the organiser selects a resident, enters the 6-digit code,
   and submits. The form reports one of: success, incorrect code,
   rate-limited (after `MAX_OTP_ATTEMPTS` failures), expired
   (`ADMISSION_TTL_MS`, 24 hours — admission codes are distributed out of
   band and may sit before the resident enters them), or that no code has
   been issued yet.

## Security properties

- Codes are never sent anywhere; the derived
  `pbkdf2-sha256$iterations$saltHex$digestHex` records used for verification
  are persisted in `localStorage` (never plaintext, never the code itself) so a
  resident can redeem their code hours later. No network is involved. The
  record is a *weak* secret, not an unrecoverable one: six digits is ≈ 20 bits,
  so a copy of that storage can be brute-forced — see
  [docs/otp-service-security.md](otp-service-security.md#the-actual-bound-what-this-does-not-buy).
- The plaintext code remains visible in the Issued codes panel until
  replaced or the roster changes — it is a demo hand-off channel, not a
  delivery channel. Clipboard copy failure is silent (browser denies or
  lacks clipboard access); the code can still be read and transcribed
  manually.
- Verification goes through `verifyOtp()` (constant-time comparison).
  Attempt limiting is per loaded page (an in-memory map cleared by any
  reload), **not** a real rate limit; a record in the pre-fix SHA-256 format
  is rejected as unverifiable rather than reported as a wrong code.
- Expiry is checked with `isOtpExpired()` before verification, so expired
  codes fail closed.
- All CSV text fields pass through the register's formula-injection
  neutralisation before display.

## Testing

`web/src/ResidentOtpAdmission.test.tsx` covers the upload, table rendering,
error display, per-resident and batch generation, clipboard copy, and all
verification outcomes (success / incorrect / rate-limited / expired).
Coverage of the component exceeds 98% statements / 90% branches.

```bash
cd web && npx vitest run src/ResidentOtpAdmission.test.tsx
```

See `docs/otp-service-security.md` for the underlying service design and
`docs/csv-injection-protection.md` for the CSV hardening. For the delivery
channels, selector and results import, see `docs/otp-delivery.md`.
