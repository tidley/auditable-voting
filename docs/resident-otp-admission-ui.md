# Resident email admission — coordinator UI

## Overview

**Voters → Resident email admission** replaces the former browser-local six-digit
OTP demo. The component is `web/src/otpDelivery/DeliveryPanel.tsx`, mounted by
`SimpleCoordinatorApp.tsx` for the selected questionnaire with its definition,
issuer runtime, public voter URL and worker-sync callback.

It is a real paper-compatible admission generator and email hand-off surface.
For in-UI sending, the coordinator starts the loopback companion with
`npm --prefix web run email:sender`, then uses the local URL it prints. The
companion serves the app and sender API on the same loopback origin, keeping
SMTP or cashu.email credentials out of the browser. Use that local origin from
the start of the election: browser keys and stored questionnaire state do not
transfer automatically from GitHub Pages. An existing run can be moved with the
encrypted **Backup**/**Restore** controls. The hosted static page keeps the
sensitive CSV export/CLI fallback. This page is not itself evidence of real
provider delivery; see [`docs/otp-delivery.md`](otp-delivery.md).

## Flow

1. Select **Import** and choose one CSV with
   `masters_list_number,email,phone,name`. `parseResidentCsv` rejects the whole
   file if a row is invalid or a number is duplicated, and neutralises
   spreadsheet-formula cells. There is only one file control: the same
   **Import** action also detects `mastersListNumber,ok,detail,ref` delivery
   results and updates the table's **Delivery** column.
2. Review or edit imported records in the table. **Add row** and **Remove**
   cover records absent from the file. **Export** before generation downloads
   the resident contact CSV; after generation it downloads the sensitive
   exact-code bundle.
3. Select **Set defaults** to apply a 24-hour future expiry, or use the date
   picker to choose another local expiry. The browser converts it to an ISO UTC
   timestamp.
4. Generate admissions in one batch. `createPaperBallotAdmissionSheet()` creates
   the same ten-character codes as the paper workflow. Every admission is added
   to the coordinator runtime and triggers the existing worker-refresh callback.
   Roster identity fields and the expiry lock after generation so a registered
   admission cannot silently acquire a different number.
5. Review masked codes. The individual **Reveal** action shows one resident's
   formatted code and enables **Copy**; **Hide** masks it again. Masking reduces
   casual exposure, not what the coordinator is technically able to see.
6. Export the sensitive bundle before reloading. Fields are
   `masters_list_number,email,phone,name,code,expires_at,vote_url`. All CSV cells
   are properly escaped. The voter URL has public questionnaire parameters only,
   never code, email or name fields.
7. With the local companion connected, select **SMTP mailbox** or
   **cashu.email** and click **Send emails**. The companion sends one message per
   resident, including the questionnaire title, public voter link, master-list
   number, formatted code, readable UTC expiry and numbered redemption steps. The
   **Delivery** column updates from the response.
8. If the companion is unavailable, **Export** the sensitive bundle and use the
   CLI fallback. Results imported through the same **Import** control carry
   status only, not contact details or codes.

## Privacy and retention

- UI state carries the open plaintext batch only long enough to review/export.
- Reloading discards the plaintext batch but does not revoke the issued opaque
  admission hashes. Do not generate a replacement batch for the same roster.
- The admission entry bound for issuance contains an opaque combined
  election/number/code hash, expiry and lifecycle state, not contact details or
  a plaintext roster mapping.
- The browser does not handle sender payment tokens, sender private keys or the
  provider's session cookie.
- Email addresses are necessarily exposed to the email provider by the local
  sending process. Public relay events and anonymous ballots must not carry them.
- A clipboard-permission failure tells the coordinator to copy the revealed code
  manually rather than leaving an unexplained unchanged button.

## Verification

```bash
node --test scripts/test/otp-send-email.test.mjs scripts/test/email-sender.test.mjs
cd web
npx vitest run src/otpDelivery/DeliveryPanel.test.tsx src/otpDelivery/csv.test.ts
npx playwright test e2e/delivery-smoke.spec.ts
```

The Playwright page is a local component integration harness with production CSS
and code generation, not a relay or real-email smoke. The Node suites cover
SMTP/cashu transports and the local companion's loopback security. Existing
admission runtime and worker tests cover issuer-side registration/redemption. Run
real controlled-inbox and separate-device checks before treating the flow as
ready for a resident deployment.
