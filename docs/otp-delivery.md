# Resident admission — roster, codes and export

## Overview

The coordinator app exposes **Voters → Resident email admission**. It imports or
edits a resident roster, generates the same ten-character single-use codes used
by the paper workflow, and exports a sensitive bundle for delivery.

Codes and contact details stay in the browser. No relay event, public
questionnaire event or anonymous ballot carries a resident's email address, name
or plaintext code. Only the opaque admission hash enters the issuer
configuration.

## Flow

1. Open the published questionnaire's **Voters** tab.
2. In **Resident email admission**, select **Import** and choose a CSV with the
   header `masters_list_number,email,phone,name`:

   ```csv
   masters_list_number,email,phone,name
   101,alice@example.org,5550101,Alice Archer
   102,bob@example.org,,Bob Baker
   ```

   Parsing is all-or-nothing. Any invalid row or duplicate master-list number
   rejects the file with a per-row error list.

3. Review the editable table. **Add row** and **Remove** cover records absent
   from the file. **Export** before generation downloads the resident contact
   CSV.
4. Select **Set defaults** for a 24-hour expiry, or choose a local expiry with
   the date picker. The browser converts it to UTC.
5. Select **Generate admission codes**. Each code is registered as a paper
   admission and the worker-refresh callback runs. Identity fields and the
   expiry lock afterwards.
6. Reveal and copy codes individually. Codes are masked by default.
7. Select **Export** to download the exact-code bundle:
   `masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url`.
   The voter URL has public questionnaire parameters only. It omits
   `request_ballot` and `auto_request` so recipients start at the admission-code
   form.

## Reload and replacement

Plaintext codes are not retained after reload. Issued admissions remain valid.
Do not generate a replacement batch for the same roster: the app cannot find and
revoke the earlier codes, so both batches could be usable. Export before leaving
the page.

## CLI and provider delivery

The old six-digit OTP helper and its delivery preview are retired. The
coordinator-machine email companion and SMTP/cashu delivery are added by the
follow-up companion PR. Until then, treat the exported bundle as the hand-off
format.

## Tests

```bash
cd web
npx vitest run src/otpDelivery/DeliveryPanel.test.tsx src/otpDelivery/csv.test.ts
npx tsc --noEmit
npm run build
```
