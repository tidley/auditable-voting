# Email admission deployment and use

This guide is for an operator running the auditable-voting client with resident
email admission. It covers deployment, SMTP credentials, DNS, the local email
companion, the coordinator workflow, public-link limitations, ballot-credential
issuance and troubleshooting.

The shorter coordinator runbook is [otp-delivery.md](otp-delivery.md), including
the Strato-specific settings.

## What the feature does

The coordinator imports a resident roster, generates the same ten-character,
single-use admission codes used for paper ballots, and emails one message per
resident.

Each message contains:

- the questionnaire title and voter link;
- the master-list number;
- the formatted admission code;
- the expiry in UTC;
- numbered redemption instructions;
- warnings that the code is single-use, is not part of the anonymous ballot,
  and must not be forwarded.

The code is never placed in the URL. The emailed link deliberately omits
`request_ballot` and `auto_request`, so the recipient starts at the admission-code
form.

## Architecture

There are two parts:

1. the static auditable-voting client;
2. a loopback-only email companion on the coordinator's machine.

The browser never receives SMTP credentials. The companion holds them in its
process environment and calls the provider. The static site alone cannot send
email; **Export** remains the fallback.

The companion serves the local app and exposes a same-origin `/__email` API on
`127.0.0.1:4319`. It rejects non-loopback hosts and origins.

## Before you start

You need:

- Node.js 22 and npm;
- a published questionnaire;
- a real mailbox at your email provider;
- the mailbox SMTP password;
- DNS control for SPF, DKIM and DMARC;
- optionally, MX records for replies and bounces;
- a public voter URL if recipients are not on the same machine;
- either the coordinator browser kept open or a running delegated Guardian
  worker for ballot-credential issuance.

A catch-all address receives mail but does **not** provide SMTP authentication.
Use a real mailbox.

## Install

```bash
git clone https://github.com/tidley/auditable-voting.git
cd auditable-voting
# Use main once the resident-email PRs are merged, or the PR branch under review.
npm --prefix web install
```

Use the branch or pull request that contains the email admission work. The plain
static build does not include the local companion.

## Configure SMTP credentials

Credentials go in the repository-root `.env`, which is gitignored:

```bash
cp .env.example .env
chmod 600 .env
```

### Strato

```dotenv
SMTP_HOST=smtp.strato.de
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=vote@theirdomain.example
SMTP_PASS=the-mailbox-password
SMTP_FROM=vote@theirdomain.example
```

### Any other SMTP provider

```dotenv
SMTP_HOST=smtp.provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=coordinator@theirdomain.example
SMTP_PASS=the-password
SMTP_FROM=coordinator@theirdomain.example
```

Rules:

- `SMTP_USER` is normally the full mailbox address.
- `SMTP_FROM` must match the authenticated mailbox, or the provider may reject
  the message.
- Use port 465 with `SMTP_SECURE=true`, or port 587 with `SMTP_SECURE=false`.
- Never commit `.env`, paste the password into chat, or put credentials in
  `web/`.
- Keep the file mode at `600`.

The same variables can be exported directly in the terminal that starts the
companion instead of using `.env`.

### Optional secret-manager storage

If you use a secret manager or the Hermes trust root, keep the same variables
there and expose them only to the companion process. There is no need to put the
password in `.env`.

## Configure DNS

The provider must authorise your domain.

### Strato

| Type | Name | Value |
|---|---|---|
| MX | `theirdomain.example` | `smtp.rzone.de` priority 5 |
| TXT | `theirdomain.example` | `v=spf1 include:_spf.strato.com ~all` |
| CNAME | `strato-dkim-0002._domainkey.theirdomain.example` | `strato-dkim-0002._domainkey.rzone.de` |
| CNAME | `strato-dkim-0003._domainkey.theirdomain.example` | `strato-dkim-0003._domainkey.rzone.de` |
| TXT | `_dmarc.theirdomain.example` | `v=DMARC1; p=none; pct=100` |

The old `mx01/mx02.strato.de` names are not valid inbound targets.

### Other providers

Use the provider's current SPF include, DKIM records and return-path/bounce
instructions. Add a DMARC record, starting at `p=none`:

```text
_dmarc.theirdomain.example  TXT  "v=DMARC1; p=none; pct=100"
```

Do not publish multiple SPF records. Merge includes into one record.

Verify:

```bash
dig +short MX theirdomain.example
dig +short TXT theirdomain.example
dig +short CNAME strato-dkim-0002._domainkey.theirdomain.example
dig +short CNAME strato-dkim-0003._domainkey.theirdomain.example
dig +short TXT _dmarc.theirdomain.example
```

## Start the companion

Build and start the companion:

```bash
npm --prefix web run email:sender
```

It prints a local URL such as:

```text
http://127.0.0.1:4319/dashboard.html?role=coordinator
```

Open that URL. The UI detects the configured transport and enables
**Send emails**. Credentials remain in the companion process.

To run the companion and the Vite development server together, with the sender
started first:

```bash
npm --prefix web run email:dev
```

Then use the Vite URL, usually:

```text
http://127.0.0.1:5174/dashboard.html?role=coordinator
```

Check health:

```bash
curl http://127.0.0.1:4319/__email/health
```

Expected:

```json
{"service":"auditable-voting-email-sender","version":1,"transports":["smtp"],"maxRecipients":1000}
```

## Use the coordinator flow

1. Open the coordinator app from the **local companion or Vite origin**.
2. Publish/open the questionnaire.
3. Go to **Voters → Resident email admission**.
4. Select **Import** and upload one CSV:

   ```csv
   masters_list_number,email,phone,name
   101,alice@example.org,5550101,Alice Archer
   102,bob@example.org,,Bob Baker
   ```

   The header is required. Import is all-or-nothing.
5. Optionally edit rows or add rows. Use **Set defaults** for an expiry.
6. Select **Generate admission codes**.
7. Review masked codes. **Reveal** and **Copy** are deliberate per-resident
   actions.
8. Choose **SMTP mailbox** as the sender.
9. Select **Send emails**.
10. Watch the **Delivery** column. It reports sent, skipped, failed or
    not-attempted states.
11. Export the sensitive bundle before reloading. Plaintext codes are not
    retained after reload.

The companion writes a redacted results CSV and a questionnaire-scoped ledger.
The ledger prevents duplicate sends. Use a **new master-list number** for a
separate test, or deliberately clear the sender state.

## Sending a bundle exported from a hosted page

The hosted static app cannot reach `127.0.0.1`. If codes were generated there,
do not reload that page before exporting.

1. Select **Export** to download the admission bundle.
2. Open the local coordinator origin.
3. Select **Import** and choose the exported bundle. The UI loads the exact
   registered codes and enables **Send emails** without registering replacement
   codes.
4. Send. If the local page already holds a generated batch, reload before
   importing the bundle.

The bundle import is delivery-only. It does not call the admission issuer and
does not create new credentials.

## Recipient flow

1. Open the email and the voter link in a private window or a separate device.
2. Enter the master-list number and admission code.
3. Request the ballot.
4. Complete the questionnaire and submit.

The ballot credential is issued by the organiser browser or a delegated Guardian
worker. Email delivery and ballot issuance are separate:

- **Browser only:** keep the coordinator tab open while voters request ballots.
- **Guardian:** run a worker with the matching key and working relays, and confirm
  its heartbeat in the Guardian screen.

If the voter sees **Waiting for ballot credential**, the issuer is offline,
delegated to a different key, or not reachable on the relay set. It is not an
email-delivery failure.

## Public voter links

The emailed voter link is built from the **coordinator page origin**. This has an
important consequence:

- If the coordinator runs at `http://127.0.0.1:5174` or `http://127.0.0.1:4319`,
  the email link is localhost and only works on that machine.
- For remote residents, the coordinator must be served from a public origin, or
  the deployment needs an explicit public voter base URL. The current flow
  follows the coordinator origin; there is no separate public-base-URL field yet.
- The public static app (for example `https://vote.orangesync.tech`) can be the
  voter target, but the coordinator must generate a matching public link.
- The email link always omits `request_ballot`/`auto_request`, so the recipient
  starts at the admission-code form.

For a same-machine pilot, a localhost link is acceptable. For a real election,
plan the public URL before importing residents.

## Verify delivery

Send one controlled message first:

1. Use a new master-list number and an address you control.
2. Send via **SMTP mailbox**.
3. Check the inbox and spam folder.
4. Inspect the received headers for:

   ```text
   spf=pass
   dkim=pass
   dmarc=pass
   ```

5. Check the message content:
   - correct recipient and questionnaire title;
   - master-list number and formatted code;
   - readable UTC expiry;
   - clickable link and fallback URL;
   - no code in the link;
   - no `request_ballot`/`auto_request`;
   - warning that the code is single-use.

The companion's results CSV records the master-list number, status, safe detail
and delivery reference. It does not store the recipient address or the code.

## Troubleshooting

### “Local sender not connected”

The app origin cannot reach the loopback companion. The public static site
cannot call `127.0.0.1:4319`. Use the companion URL or the Vite URL, and keep the
companion running.

### `502 Bad Gateway` on Send emails

The Vite proxy could not reach the companion, or the companion reported a
transport failure. Check:

```bash
curl http://127.0.0.1:4319/__email/health
curl http://127.0.0.1:5174/__email/health
```

Start with `npm --prefix web run email:dev`, or restart the companion and retry.
A single transient 502 can occur just after a companion restart. The ledger is
read per batch, so a row still marked **Not sent** can be retried safely.

The companion distinguishes these cases:

- `400` — invalid bundle, missing recipient field or bad admission code;
- `409` — ledger conflict, or a previous send is pending/unknown;
- `502` — SMTP/cashu transport or proxy failure.

The UI displays the returned error. If the message mentions a ledger conflict,
do not clear the ledger blindly: confirm the recipient and resend intent first,
or use a fresh master-list number for a new test.

### The email was sent but did not arrive

- Check the **Email** column for the row. That is the actual recipient.
- Check spam/junk and the provider's outbound log.
- Check the results CSV and ledger for the master-list number and delivery
  reference.
- A different roster row may have been the one sent; the companion does not
  rewrite recipients.

### “Already sent”

The ledger has a successful entry for that bundle and master-list number. Do not
blindly resend. Use a new master-list number for a new test, or follow the
election's revocation/recovery procedure.

### SMTP authentication failures

- `530 5.7.0 User not authenticated`: missing/invalid credential or a catch-all
  alias instead of a real mailbox.
- `535 ... authentication failed`: wrong password, or `SMTP_USER` is not the full
  address.
- `STARTTLS`/TLS errors: use port 465 with `SMTP_SECURE=true`, or port 587 with
  `SMTP_SECURE=false`.
- Provider rejects the sender: `SMTP_FROM` must match the authenticated mailbox.

### Codes disappeared after reload

Plaintext codes are intentionally not retained. Export the sensitive bundle
before leaving the page. Do not silently generate a second batch; earlier codes
may still be valid.

### Voter stuck on “Waiting for ballot credential”

This is an issuer problem, not email delivery:

- the coordinator delegated to a worker key that is not running;
- the worker is not reachable on the configured relays;
- the organiser tab is closed in Browser-only mode.

Check the Guardian heartbeat, worker logs and relay set. Use a fresh admission
code and a fresh voter session after fixing the issuer. The old pending request
may be addressed to the old key.

### Rate limits

Standard mailboxes throttle. Warm up with a small pilot, monitor provider
responses and avoid large simultaneous batches. Use a transactional provider for
higher volume.

## Security and privacy

- The companion is loopback-only. Do not expose it to the internet.
- Credentials stay in the companion process, never in the browser.
- `.env` must be mode `600` and never committed.
- The email provider sees recipient addresses and admission codes. Choose a
  provider/region with suitable terms, and document retention.
- Exported bundles, result CSVs and ledgers are sensitive. Store and delete them
  according to the election procedure.
- Browser state is origin-scoped. Use a stable coordinator origin, or use the
  encrypted backup/restore flow.
- Do not reuse admission codes across rounds. Reimport the current contact list
  and generate fresh codes for each round.
- Rotate the mailbox password if it is exposed.

## Deployment checklist

- [ ] Use the branch or PR containing the email admission feature.
- [ ] Install dependencies and build the app.
- [ ] Create a real mailbox and obtain SMTP credentials.
- [ ] Put credentials in `.env` with mode `600`, or use the trust-root launcher.
- [ ] Publish SPF, DKIM and DMARC; add MX if replies/bounces are needed.
- [ ] Verify DNS records with `dig` or the provider's tools.
- [ ] Start the companion and confirm `/__email/health`.
- [ ] Decide the coordinator origin and public voter URL.
- [ ] Publish the questionnaire.
- [ ] Import a controlled resident and generate a code.
- [ ] Send one test and check inbox, spam, SPF, DKIM and DMARC.
- [ ] Confirm the voter link opens the admission-code form.
- [ ] Confirm the ballot issuer (browser or Guardian) is online.
- [ ] Run a 2–3 resident pilot before the full roster.
- [ ] Document consent, retention and the paper/manual fallback.
- [ ] Delete temporary credentials, tokens and exported bundles after use.
