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
   `generateOtp()` (CSPRNG) and its salted SHA-256 hash (`hashOtp()`) is
   retained for verification. The plaintext code is displayed in the
   "Issued codes" panel with a copy button and the issue time, and is
   never re-derivable from the stored hash. Re-generating replaces the
   entry. Note: codes and hashes live in component state only — switching
   coordinator tabs or uploading a new roster discards them; the section
   holds them in browser memory for its mounted lifetime and sends nothing
   to any server.
3. **Verify** — the organiser selects a resident, enters the 6-digit code,
   and submits. The form reports one of: success, incorrect code,
   rate-limited (after `MAX_OTP_ATTEMPTS` failures), expired
   (`ADMISSION_TTL_MS`, 24 hours — admission codes are distributed out of
   band and may sit before the resident enters them), or that no code has
   been issued yet.

## Security properties

- Codes are never sent anywhere; the salted `saltHex:hashHex` values used
  for verification are held in browser memory only while the section is
  mounted (no persistence, no network).
- The plaintext code remains visible in the Issued codes panel until
  replaced or the roster changes — it is a demo hand-off channel, not a
  delivery channel. Clipboard copy failure is silent (browser denies or
  lacks clipboard access); the code can still be read and transcribed
  manually.
- Verification goes through `verifyOtp()` (constant-time comparison,
  per-hash rate limiting).
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
