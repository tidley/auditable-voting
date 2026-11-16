# Resident email admission — coordinator UI

## Overview

**Voters → Resident email admission** replaces the former browser-local six-digit
OTP demo. The component is `web/src/otpDelivery/DeliveryPanel.tsx`, mounted by
`SimpleCoordinatorApp.tsx` for the selected questionnaire with its definition,
issuer runtime and public voter URL.

It generates the same paper-compatible admission credentials used by the paper
workflow, and exports a sensitive bundle for out-of-band delivery. Sending from
the coordinator machine is added by the loopback companion follow-up; this page
covers the roster, generation, masking and export surface.

## Flow

1. Select **Import** and choose one CSV with
   `masters_list_number,email,phone,name`. `parseResidentCsv` rejects the whole
   file if a row is invalid or a number is duplicated, and neutralises
   spreadsheet-formula cells.
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
   `masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url`.
   All CSV cells are properly escaped. The voter URL has public questionnaire
   parameters only, never code, email or name fields. Links deliberately omit
   ordinary auto-request parameters so recipients start from the admission-code
   form.

## Privacy and retention

- UI state carries the open plaintext batch only long enough to review/export.
- Reloading discards the plaintext batch but does not revoke the issued opaque
  admission hashes. Do not generate a replacement batch for the same roster.
- The admission entry bound for issuance contains an opaque combined
  election/number/code hash, expiry and lifecycle state, not contact details or
  a plaintext roster mapping.
- The browser does not handle sender credentials or payment tokens.
- The exported bundle is sensitive: it contains contact details and plaintext
  codes. Delete it after delivery and never commit it.
- A clipboard-permission failure tells the coordinator to copy the revealed code
  manually rather than leaving an unexplained unchanged button.

## Verification

```bash
cd web
npx vitest run src/otpDelivery/DeliveryPanel.test.tsx src/otpDelivery/csv.test.ts
npx tsc --noEmit
npm run build
```

Existing admission runtime and worker tests cover issuer-side registration and
redemption. Run a controlled paper/export rehearsal before treating the flow as
ready for a resident deployment.
