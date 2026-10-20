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
(`web/scripts/otp-send-email.mjs`, AV-DELIVERY-1b).

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

## Coordinator email sending (AV-DELIVERY-1b)

The browser cannot send: nomail.name / cashu.email authenticates with a
`SameSite=Strict; HttpOnly` session cookie, so a cross-origin tab can never hold
a session. The coordinator therefore runs a small CLI on their own machine:

```bash
cd web
npx tsx scripts/otp-send-email.mjs --csv ~/otp-codes.csv --roster ~/residents.csv \
    --nsec-file ~/.nomail-nsec --mint testnut --election "Pepperville 2026"
```

### Pieces

| Piece | Role |
|---|---|
| `web/src/otpDelivery/nomailClient.ts` | Pure, fetch-injected API client: `challenge()`, `verify(signedEvent)`, `sendQuote()`, `quoteStatus()`, `send({cashuToken \| paidQuoteId})`, `parseError()` → `{reason, hint}`, `createCookieJar()`. No DOM, no globals — the coordinator script injects a real `fetch` + cookie jar, the tests inject stubs. The browser imports nothing from it. |
| `web/src/otpDelivery/sendLedger.ts` | Pure planning/accounting: parse the codes CSV and the results ledger, decide what still needs sending, track the daily cap, summarise a partial batch. |
| `web/scripts/otp-send-email.mjs` | The CLI that wires the two modules to the real network and the filesystem. |

`@cashu/cashu-ts` is a **devDependency**: only the CLI and the ecash rail need
it, and the browser bundle must not carry a Cashu wallet.

### Command reference

```
--csv <path>              codes CSV (required): 1a's name,code export, or the keyed
                          masters_list_number,email,name,code[,issued_at] export
--roster <path>           residents CSV — needed to resolve a name-only codes CSV
--nsec-file <path>        file containing the sender nsec (mode 600)
--results <path>          ledger CSV (default <codes>.results.csv)
--pay-with cashu|lightning  cashu spends ecash, lightning pays one invoice per email
--cashu-token-file <path> pre-funded ecash token (cashuB…)
--mint testnut|<url>      fund ecash from a mint instead of a token file
--election <label>        election name used in the email body
--limit <n>               send at most n emails this run
--mint-wait / --quote-wait  seconds to wait for a funding/quote invoice (default 300)
--ignore-local-cap        start even when the ledger already shows a full day
--dry-run                 print the plan; no network, no payment, no ledger writes
```

Exit codes: `0` every planned recipient sent, `1` partial batch (re-run to
resume), `2` fatal (config, auth, wallet, day cap).

### Flow

1. **Authenticate** — `POST /api/auth/challenge` → nonce → sign a kind-1 event
   (`content = nonce`, `tags = [["challenge", nonce]]`) → `POST /api/auth/verify`
   → the script stores the `__Host-session` cookie in its jar and sends it on
   every later request. The cookie lasts 30 days.
2. **Wallet check** — the ecash rail prints the balance and refuses to start
   when it cannot cover the planned sends (100 sats each).
3. **Plan** — the results ledger is read as the source of truth: recipients with
   an `ok=true` row are skipped, failed rows are retried, a code older than the
   24-hour `ADMISSION_TTL_MS` is regenerated at send time.
4. **Send** — one email per recipient; each attempt is appended to the ledger
   **immediately** (`mastersListNumber,ok,detail,ref,sentAt`, written 0600), so
   a crash or a day-cap stop loses nothing.
5. **Summary** — sent/failed/not-attempted counts, sats spent, how much of the
   day's cap was used, and which recipients are still outstanding.

### Cost and limits

- **100 sats per email** (Cashu token or Lightning quote) — postage is paid to
  the service, not to us.
- **100 emails/day/user** on the service side. The script also tracks the cap
  locally from the ledger and warns at 99/100.
- **Cost math:** 100 voters × 100 sats = **10,000 sats** (≈ one token file for
  the whole register) and the daily cap is exactly 100 → **one full day of
  sends with zero retry headroom**. A failure anywhere in the batch does not
  fail the run: the ledger records it and the batch stops cleanly, so day 2
  re-runs send only the outstanding recipients.
- **Day-2 resume:** re-run the *same* command. Already-sent residents are
  skipped; an outstanding recipient whose code was issued more than 24 h ago
  gets a **freshly generated code** (the old one is past its admission TTL).
  Regenerated codes are written to `<results>.regenerated.csv`
  (`masters_list_number,email,name,code,issued_at`) and **must be registered in
  the coordinator UI before those residents can verify** — the app only knows
  the hashes of codes it generated itself.
- **Invoice expiry mid-batch** — a Lightning quote or mint invoice that is not
  paid within `--quote-wait`/`--mint-wait` seconds stops the run with a clear
  error. The last recipient's row is already in the ledger as a failure, so the
  re-run retries it. Nothing is paid twice: postage is only spent on a send the
  service accepted.

### Deliverability caveat (read before promising the channel)

Automated first-contact email is exactly what spam filters are built to stop:

- `nomail.name` / `cashu.email` sending addresses may sit on disposable-domain
  blocklists, and 100 near-identical messages from one address look like bulk
  mail to a resident's provider. Codes can land in spam or be dropped silently.
- There is **no bounce feedback** — a `200` from `/api/send` means the service
  accepted the message, not that the resident received it.
- Mitigations: send a small pilot (3–5 residents on different providers) and
  confirm receipt before the full run; keep the **manual channel as the
  fallback** (the coordinator reads the code out directly, no deliverability
  risk); announce the email in advance ("look for a message from …"); consider
  sending a day early so a missed code still leaves time for a manual retry.
- The **manual channel remains the recommended path** for a real admission run.
  Email is a convenience, not a guarantee.

### Fund the wallet on testnut (dev only)

```bash
# testnut.cashu.space pays its own invoices, so the script can self-fund:
npx tsx scripts/otp-send-email.mjs --csv codes.csv --roster residents.csv \
    --nsec-file ~/.nomail-nsec --mint testnut --limit 2 --election "smoke test"
```

- `--mint testnut` resolves to `https://testnut.cashu.space` (there is also
  `--mint testnut2` → `nofees.testnut.cashu.space`). The script prints the mint
  invoice; the testnut mint auto-pays it and the run continues.
- `--cashu-token-file <path>` spends ecash you already hold instead (a `cashuB…`
  token from any mint the service accepts).
- `--pay-with lightning` needs no Cashu wallet: it asks the service for one
  invoice per email and polls `GET /api/send/quote/:id/status` until it is paid.
  Slower, but fine for a handful of stragglers.
- Always rehearse with `--dry-run` first: it prints the plan, the cost and the
  day-cap position without touching the network or the ledger.
- `--base-url https://staging.nomail.name` points the client at staging; the
  default is `https://nomail.name`.
- Dev/test only. Real postage is real money, and testnut tokens are worthless —
  never mix the two.

### Handling the sender key

- The nsec is the sender identity (`npub1…@nomail.name`) and the account's
  password. Keep it in a file **outside the repository** (e.g. `~/.nomail-nsec`)
  with `chmod 600`; the script warns when group/other bits are set.
- **Never commit it.** Never paste it into an issue, a transcript or a chat.
- The ledger and the regenerated-codes CSV are written with mode 0600: they
  contain resident email addresses and live admission codes.
- The plaintext name+code CSV from step 4 of the flow is equally sensitive —
  delete it after distribution.
- Anyone with the nsec can spend the account's postage and read its inbox; if
  it leaks, rotate to a new key.

## Cost and limits (summary)

- Email sending costs 100 sats per email (Cashu token or Lightning quote).
- The service caps sending at 100 emails/day/user; the script tracks the cap
  from the ledger and stops cleanly when the service enforces it.
- 100 voters = 10,000 sats = exactly one day of the cap; retries roll to day 2.

## Testing

```bash
cd web && npx vitest run src/otpDelivery/
```

The suite covers channel descriptors, manual render+copy, selector
persistence, results-import parsing, CSV export escaping, the admission TTL,
and the whole email path (`nomailClient.test.ts`, `sendLedger.test.ts`): the
challenge→verify→cookie sequence, `X-Reason`/`X-Hint` parsing, send
success/failure (including the 402 invalid-token and 429 daily-limit paths),
resume-after-failure via the ledger, partial-batch accounting, and the 99/100
day-cap warning. Network access is disabled globally in tests (a throwing
`fetch` stub in `src/test/setup.ts`); any code path that reaches the network
must inject its own fetch stub.

Rehearse the CLI without touching the network:

```bash
cd web && npx tsx scripts/otp-send-email.mjs --csv codes.csv --roster residents.csv --dry-run
```

