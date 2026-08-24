# OTP delivery — channels, selector and results import

## Overview

The coordinator app hands one-time codes to residents through a small
delivery abstraction (`web/src/otpDelivery/`). A **channel** is a pure module
that reports whether it is available and, when it is, sends a code to a
recipient. The app lets the coordinator pick a channel per election, generate
codes, export them for out-of-band distribution, and import a results CSV to
see which residents were reached.

Batch sending does **not** happen in the browser tab. The manual channel shows
codes in the app; the email channel is a thin browser descriptor that points
the coordinator at a separate script that runs on the coordinator machine
(`scripts/otp-send-email.mjs`, AV-DELIVERY-1b).

## Channel comparison

| Channel | Availability | How codes reach residents | Notes |
|---|---|---|---|
| `manual` | Always | Shown once in the app, copied or transcribed by the coordinator | Default fallback; no network, no cost, no deliverability risk |
| `email-nomail` | Not in the browser | Coordinator-machine script sends via nomail.name / cashu.email | SameSite=Strict cookie blocks cross-origin browser auth; costs 100 sats/email; 100 emails/day/user cap |
| `sms` | Not yet | Future Felix service | API not public; do not build against guesses |

## Manual fallback is the recommendation

For a real admission run, the **manual channel is the recommended fallback**.
Automated email deliverability is unproven: the nomail service's sending
domains may sit on disposable-email blocklists, so a resident's provider could
silently drop the code. Manual distribution has no such risk — the coordinator
hands the code to the resident directly. Use an automated channel only when
you have verified deliverability for the specific electorate, and always keep
the manual path available as a fallback.

## Flow

1. **Choose a channel** — the selector is stored per election in
   `localStorage` (`otp-delivery-channel:<electionId>`), so each election
   remembers its own choice. The manual channel is the default.
2. **Upload residents** — a CSV with the header
   `masters_list_number,email,phone,name`. Parsing is all-or-nothing and
   reuses the resident register's validation and formula-injection
   neutralisation.
3. **Generate codes** — per resident or in one batch. Each code is generated
   with `generateOtp()` (CSPRNG) and its salted SHA-256 hash is retained for
   verification. Codes are shown once with a copy button.
4. **Export name+code CSV** — for out-of-band distribution. The export side
   escapes quotes, commas and newlines properly (the formula-injection
   neutralisation is import-side only and does not protect a naive exporter
   from corrupting names that contain commas or quotes).
5. **Import results CSV** — the coordinator batch script writes a results CSV
   with columns `mastersListNumber,ok,detail,ref`; importing it populates the
   delivery status table.

## Security notes

- The plaintext name+code CSV is **sensitive** — delete it after distribution.
- Codes and hashes live in component state only; nothing is sent to any
  server from the browser.
- The email channel ships **no auth or send code** in the browser bundle —
  that would be dead, security-sensitive code. It is a descriptor only.
- Admission codes use a 24-hour TTL (`ADMISSION_TTL_MS`) because they are
  distributed out of band and may sit before the resident enters them. The
  10-minute interactive TTL is unchanged for in-app verification.

## Cost and limits (TODO for AV-DELIVERY-1b)

- Email sending costs 100 sats per email (Cashu token or Lightning quote).
- The service caps sending at 100 emails/day/user.
- Cost math and invoice-expiry guidance will be completed in AV-DELIVERY-1b.

## Testing

```bash
cd web && npx vitest run src/otpDelivery/
```

The suite covers channel descriptors, manual render+copy, selector
persistence, results-import parsing, CSV export escaping, and the admission
TTL. Network access is disabled globally in tests (a throwing `fetch` stub in
`src/test/setup.ts`); any code path that reaches the network must inject its
own fetch stub.
