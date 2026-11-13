# Resident email admission runbook

## Scope and trust boundary

The coordinator can import resident contacts, issue the existing ten-character
single-use admission codes used by paper access, and deliver those exact codes by
email. This is a delivery integration, not a second OTP protocol.

The hosted/static page cannot hold email credentials. The intended coordinator
flow uses a loopback-only local companion:

1. Start it with `npm --prefix web run email:sender`.
2. Open the local coordinator URL it prints.
3. Use **Send emails** in **Resident email admission**.

The companion serves the app and sender API on the same `127.0.0.1` origin.
SMTP or cashu.email credentials remain in the companion process. The public
GitHub Pages build keeps a sensitive CSV **Export** fallback and the standalone
CLI remains available.

The email provider can see each recipient address and message. No contact list
is uploaded to Nostr. Real email delivery and provider-specific deliverability
still need a controlled-inbox test; printed/manual distribution remains the
fallback.

## Start the local sender

Install/build first, or let the npm script build automatically. Copy
`.env.example` to `.env` (ignored by Git) and fill only the transport you will
use:

```bash
npm --prefix web run email:sender
```

The launcher loads the optional repository-root `.env`. You can also export the
same variables explicitly in the terminal that starts it. For example, SMTP:

```bash
export SMTP_HOST='smtp.example.org'
export SMTP_PORT='587'
export SMTP_USER='coordinator@example.org'
export SMTP_PASS='replace-with-an-app-password'
export SMTP_FROM='coordinator@example.org'
npm --prefix web run email:sender
```

The companion binds only to loopback by default and prints a URL such as
`http://127.0.0.1:4319/dashboard.html?role=coordinator`. The UI detects the
available transport; no password or sender key is sent to the browser.

Use that local URL as the coordinator origin from the start of the election.
Browser keys, the questionnaire draft and local participant state are scoped to
the origin. The hosted GitHub Pages app does not share storage with
`127.0.0.1`; to move an existing run, use its encrypted **Backup** download and
**Restore** it in the local app. During development, the Vite dev server proxies
`/__email` to the companion, so an existing localhost dev session can keep its
state while sending.

For cashu.email, set `NOMAIN_NSEC` and provide one unused 100-sat token per
pending recipient via `CASHU_TOKENS_FILE` (one per line) or one
`CASHU_TOKEN` for a single-recipient test. Optional settings are listed in
`.env.example`.

The local-sender health endpoint exposes only the configured transport names,
not addresses, hosts or credentials. Requests from non-loopback hosts/origins
are rejected, JSON bodies are size-limited, and one batch can be in flight at a
time.

### Troubleshooting delivery

- **“Local sender not connected”** — start the companion and use the local URL it
  prints. The public GitHub Pages origin cannot call a separate local process.
- **“no SMTP or cashu.email credentials configured”** — stop the companion, set
  the variables in `.env` or the environment, and restart it.
- **`Failed` in Delivery** — read the safe reason in the table. Authentication and
  connection failures stop the batch; a hard recipient rejection is recorded per
  row.
- **Provider accepted but no inbox message** — check spam/junk and the exact
  recipient, then inspect the provider's outbound log. Acceptance only proves the
  provider took the message, not inbox placement. Do not blindly resend; the
  status may be unknown.
- **A downloaded bundle was lost after reload** — do not silently generate a
  second batch. Earlier admissions may still be valid; follow the election's
  revocation/recovery procedure.

## Prepare admissions

1. Open the matching published questionnaire in Organiser. Its issuer runtime and
   public voter link must be available; keep the browser or delegated worker
   online to issue credentials.
2. In **Voters**, expand **Resident email admission**.
3. Select **Import** and choose one all-or-nothing resident CSV (there is one
   import control, not separate roster/results uploads):

   ```csv
   masters_list_number,email,phone,name
   101,alice@example.org,5550101,Alice Archer
   102,bob@example.org,5550102,Bob Baker
   ```

   Master-list numbers must be unique positive integers. Every row needs a valid
   email address. `phone` and `name` are optional. The parser neutralises text
   cells that could be interpreted as spreadsheet formulae.

4. Review or edit the imported roster directly in the table. **Add row** and
   **Remove** cover any records not present in the file. **Export** at this
   stage downloads the resident contact CSV.
5. Select **Set defaults** to apply a future expiry of 24 hours from now, or use
   the date picker to choose another local expiry.
6. Select **Generate admission codes**. The app generates ten-character
   Crockford codes using `createPaperBallotAdmissionSheet()` and registers their
   election/number/code admission hashes with the existing issuer runtime and
   worker configuration. Roster identity fields lock after generation. Codes
   remain masked until **Reveal** is selected for an individual resident.
   **Copy** attempts a clipboard copy and reports if browser clipboard access is
   unavailable.
7. With the local companion connected, choose **SMTP mailbox** or
   **cashu.email** and select **Send emails**. The companion sends one message
   per resident and the **Delivery** column updates automatically. Each email
   includes the questionnaire title, public voter link, master-list number,
   formatted code, human-readable UTC expiry and numbered redemption steps.
8. If direct sending is unavailable, select **Export** to download the sensitive
   bundle and use the CLI fallback below. Its columns are:

   ```csv
   masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url
   ```

   The link contains the normal public questionnaire parameters, never an
   admission code or private invite bearer code. The CSV itself contains
   plaintext codes and contact details: store it securely, do not commit it, and
   delete it after use.
9. Delivery results imported through the same **Import** control also update the
   visible **Delivery** column by master-list number. Results carry no codes or
   email addresses.

Plaintext batch codes are not retained after reload. Issued admission hashes and
expiry/redemption state remain valid. The app cannot reconstruct a plaintext
batch, or automatically revoke/reissue it by roster number. Do not generate a
replacement batch merely because an export was lost: previously generated
admissions can remain active. Follow the election's explicit revocation/recovery
procedure or start a new questionnaire instead.

## Recipient email

The companion sends one recipient-specific text and HTML message. Its content is
equivalent to:

```text
Subject: Voting access code for <questionnaire title>

Hello <resident name>,

You are invited to take part in "<questionnaire title>".

1. Open this link on your device:
   <public voter link>
2. Select "Use admission code".
3. Enter:
   Master-list number: <number>
   Admission code: <ABCDE-12345>
4. Request your ballot and wait until it is received before answering.

This code expires at <readable date and time> UTC.
It is single-use and only grants access. It is not included in your anonymous ballot.
Do not forward this email.

If the code has expired or does not work, contact the organiser using the
contact details you were given separately.
```

The HTML alternative makes the voter link clickable, shows a plain fallback URL,
formats the code in a monospaced block and escapes all names/title text. The
admission code is never placed in the URL.

## CLI fallback

The local UI uses the same delivery code as `scripts/otp-send-email.mjs`. Use the
CLI when direct sending is unavailable or when an operator needs a manual
dry-run/resume.

```bash
node scripts/otp-send-email.mjs \
  --transport smtp \
  --csv resident-admission-emails-QUESTIONNAIRE.csv \
  --ledger admission-send-ledger.json \
  --results admission-results.csv \
  --dry-run
```

A dry run validates every row and email body but writes no send ledger and labels
its results **dry-run (not sent)**. It must not be used as delivery evidence.

For SMTP live sending, export `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`, then run without `--dry-run` and with
`--transport smtp`. The sender opens one message per recipient; recipients are
never combined into a `Bcc` list.

For cashu.email live sending, set `NOMAIN_NSEC` and supply one unused 100-sat
token per pending recipient via `CASHU_TOKENS_FILE`, then use
`--transport cashu`. A single-recipient test can use `CASHU_TOKEN`. The service
charges 100 sats per email and may impose a daily cap. See the current provider
documentation for service availability, receipts and privacy terms.

Each email contains the recipient name when available (otherwise “Resident”),
master-list number, formatted code, human-readable UTC expiry, public voter link
and numbered instructions. The sender rejects malformed bundles, expired codes,
code-bearing URLs, duplicate residents and mismatched bundle scopes before
sending. It authenticates/preflights once per run and stops on authentication,
payment or uncertain-transport failures rather than claiming successful delivery.
Already successful ledger entries are skipped. Only hashes of attempted payment
tokens are retained so a partial-send resume does not reuse earlier tokens.

If delivery is **unknown**, verify through the provider/recipient before trying
again. `--retry-unknown` is an explicit operator decision, not automatic
protection against a duplicate email. If a resident may already have redeemed a
code, do not generate or send a replacement merely to solve a delivery problem.

## Delivery results and privacy

Import `admission-results.csv` through the same **Import** action. Results are
matched by master-list number and update the roster's **Delivery** column; the
CSV contains `mastersListNumber,ok,detail,ref`, not codes, email addresses, payment tokens,
session cookies or sender secrets. The resumable ledger is likewise redacted.
Provider-visible recipient/message data is inherently not private from the email
provider; console/network logs, error-reporting systems and the user's own MTA
must still be reviewed before a real cohort is contacted.

The voter opens the link on their own device, enters the master-list number and
admission code, and waits for a fresh blind ballot credential. The existing
issuer checks election, expiry, admission state and voter binding. Code, contact
and master-list details do not enter the anonymous ballot. Organiser/receiver
state may link admission to the requesting voter identity, but acceptance and
ballot answers must remain separate from the resident contact record.

### Test recipient checklist

Use fictional roster data and controlled inboxes:

- wrong number/code is rejected without admitting the voter;
- correct code on a separate browser/device receives a blind credential;
- wrong code followed by correct retry does not create a second credential;
- an expired code is refused;
- a redeemed code cannot admit a different voter;
- public questionnaire responses and result packs contain no email/name,
  master-list number or admission code;
- sent emails, result CSVs and ledgers contain no unexpected contact leakage;
- after a simulated interruption resume skips delivered recipients and does not
  reuse spent payment tokens.

## Tests

No production secrets or real delivery are needed for the offline suites:

```bash
node --test scripts/test/otp-send-email.test.mjs scripts/test/email-sender.test.mjs
cd web
npx vitest run src/otpDelivery/DeliveryPanel.test.tsx src/otpDelivery/csv.test.ts
npx playwright test e2e/delivery-smoke.spec.ts e2e/ballot-print-smoke.spec.ts
```

The sender suite includes injected SMTP and mocked cashu.email transports,
exact-code guidance, resume/partial-failure behaviour and redaction checks. The
companion suite verifies loopback Host/Origin rejection, health-output redaction,
static serving, validated same-origin send batches and safe error responses.
Component/browser harnesses verify code generation, the single Import/edit/export
table and the Send UI against a mocked loopback response; they are not relay
redemption tests. A real controlled-inbox batch and separate-device redemption
remain manual acceptance steps.

The opt-in provider smoke remains separate and never runs on pull requests:
`.github/workflows/email-smoke.yml` contains its schedule, credentials boundary
and single-send safeguards.

To send exactly one real test through the same admission-email path, set
`LIVE_ALLOW=1`, `TEST_TRANSPORT=smtp` or `cashu`, `TEST_RECIPIENT`, and that
transport's credentials, then run:

```bash
node --test scripts/test/live-email-delivery.test.mjs
```

The provider accepting the message is not proof of inbox delivery. Confirm the
message, code and link in a controlled mailbox before onboarding residents.
