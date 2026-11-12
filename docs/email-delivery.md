# Resident invitations and SMTP2GO delivery

## Organiser workflow

1. Publish the questionnaire with **Go live**. In **Guardian**, configure and check a delegated Guardian if requests must be processed while the organiser is away. Otherwise keep the organiser browser open and connected. A configured delegation is not evidence that its worker is currently running.
2. Open **Voters → Invite residents from CSV**. Import one CSV with header `masters_list_number,email,phone,name`. Parsing is all-or-nothing. Use safe positive integer resident numbers, email addresses up to 254 characters and names up to 300 characters. CSV files are limited to 5 MB and 10,000 contacts; saved recovery JSON has a separate 128 MB limit to accommodate link/hash/formatting overhead. Invitation URLs are limited to 8,192 ASCII characters. Uploading does not publish contacts or send email.
3. Generate missing invitations. Each row creates a normal single-use bearer invitation in the existing organiser admission registry. It does not create a separate six-digit demo code. Registration, admission, blind signatures and duplicate ballot checks use the existing protocol.
4. Download the **private email batch** before reloading. It contains email addresses, secret invitation links and any pending contacts whose invitations have not yet been generated. Recovery retains both generated and pending rows; the sender sends only generated invitations. Contact-to-link mappings stay in organiser memory, survive navigation between tabs, and are not automatically persisted by this panel. The hash-based admission registry uses existing organiser persistence/recovery.
5. Choose manual delivery to Reveal/Copy a link, or choose SMTP2GO and run the coordinator CLI below. UI hiding prevents accidental exposure, not access by the organiser. Anyone holding a link can claim access; forwarding transfers that access.
6. Import the CLI's JSON results. For recovery after reload, use the same resident-upload control to import the saved private JSON batch with the original organiser state. Restore existing invitations rather than generating another batch for the same electorate. After some invitations are generated, the upload is locked to prevent accidental replacement.
7. Monitor Participants for requests, redemption and issuance. No contact row records answers or whether a person voted. A resident CSV/email address alone does not prove eligibility: the organiser authorises admission by creating invitations.

## Private coordinator setup

Use Node 20 or later. Install the repository's web dependencies with `npm --prefix web install` (including dev dependencies: Nodemailer is coordinator tooling, not a browser dependency).

The password can be read from `~/.config/auditable-voting/smtp-password`, `SMTP_PASSWORD_FILE`, or a trusted `SMTP_PASSWORD` environment variable. Never use a `VITE_` prefix. Do not pass a password on the command line, put it in a batch, commit it, print it, send it in a Nostr event or set it in the public website. Private files must be regular files, owned by the coordinator user and mode `600`.

The sender pins `mail-eu.smtp2go.com:587`, username `organiser`, From **Auditable Voting <organiser@voting.bitsbytom.com>**, mandatory STARTTLS, certificate validation and TLS 1.2 or later. There is no plaintext fallback. Connection/greeting timeouts are 15 seconds and socket timeout is 30 seconds. SMTP logging is disabled. The From address has no receiving inbox.

Keep batch, ledger and results outside the repository and public/static folders:

```bash
install -d -m 700 "$HOME/.config/auditable-voting/delivery"
# Move the downloaded private-invitations.json into this directory first.
chmod 600 "$HOME/.config/auditable-voting/delivery/private-invitations.json"
```

### Quota baseline

The limit is **250 emails per UTC month**, counting tests and all reserved attempts, including retries, rejected attempts and uncertain sends. Before first use each month, check SMTP2GO's usage and all other senders. Set the baseline to the number already used outside this ledger. There were **two authorised successful manual test sends on 12 November 2026**; use at least `2` for November if those are the only other sends. Do not treat this historical count as a live account-usage query.

```bash
export SMTP_QUOTA_MONTH=2026-11
export SMTP_MONTHLY_BASELINE=2
```

Set the actual month and verified baseline before use. The CLI refuses a stale month. Once a month has been initialised, its baseline cannot silently change. Use one canonical ledger for the whole SMTP account, across questionnaires. Do not run other senders without reserving their usage and reconciling the baseline. The local ledger cannot observe sends made elsewhere; it is not a provider-wide hard cap. Never delete/reset the ledger to regain quota. Reconcile changed external usage under operator control before further sends.

## Validate without sending

From `web/`:

```bash
node scripts/otp-send-email.mjs \
  --batch "$HOME/.config/auditable-voting/delivery/private-invitations.json" \
  --ledger "$HOME/.config/auditable-voting/delivery/ledger.json" \
  --results "$HOME/.config/auditable-voting/delivery/results-001.json"
```

Without `--send`, this only validates the private batch. No SMTP connection, message or quota reservation occurs. Real email links must use HTTPS and contain the matching questionnaire ID and invitation-code hash. Do not send localhost development links.

Add `--send` **only after authorisation for the listed recipients**. This task does not authorise additional live sends. Results paths must be new; the CLI will not overwrite existing evidence. Import `results-001.json` into the website afterwards. A re-run with the same ledger and a new results path does not resend accepted messages. Changed recipient/content under the same invitation ID is a conflict, not a new send.

## Failure and recovery

- Quota is persisted before each attempt. An exclusive lock prevents concurrent senders using the same ledger. Ledger and lock live on persistent storage, not a build/cache mount.
- Only a confirmed transient 4xx failure before SMTP DATA can be retried automatically, once after two seconds. Both attempts reserve quota. Authentication/TLS/permanent failures do not automatically retry. A failure stops the remaining batch; later recipients are not labelled failed or sent.
- A timeout/disconnect during DATA or missing acceptance evidence is **uncertain**. Interrupted reservations also become uncertain. Never automatically resend. Check SMTP2GO activity using recipient/time before any manual reconciliation. The ledger stores fingerprints/statuses, not invitation URLs or SMTP responses.
- A failed invitation is not automatically retried on a later invocation. Review provider evidence and use manual delivery of the same link, or have an operator reconcile a definitively rejected attempt. Do not create new links to bypass duplicate protection.
- After a crash, ensure the old process has stopped before manually removing its exact `.lock` file. A leftover `.next` file means a ledger write was interrupted: preserve it and reconcile; the sender fails closed rather than deleting it. Do not run two ledger copies or restore an older ledger snapshot.
- If the CLI exits before writing results, use the ledger for reconciliation and rerun with a new results path only after the cause is understood. Accepted entries are retained. Output files are operator evidence, not signed delivery receipts; import only your own trusted CLI output.
- Lost organiser memory/keys or a lost private batch requires recovery, not regeneration. Revocation remains in the existing Participants controls; do not email an exported batch after its links were revoked.

## Status meanings

| Status | Evidence |
| --- | --- |
| Generated | Invitation registered for admission; no email implied |
| Accepted by email provider | SMTP accepted the message; no inbox delivery implied |
| Redeemed | Existing admission registry bound the invitation to a claimant |
| Blind credential issued | Existing organiser issuance record exists for that claimant |

Blind credentials remain separate from invitations. Request/issuance messages must never contain the final public token commitment. Browser-local secrets, correct blind signatures and separate anonymous ballot submission remain necessary. IP addresses, timing and identifying answers can still weaken anonymity.

## Verification

Offline sender tests: `npm --prefix web run test:email`. They use injected fake SMTP transports and do not send email. Component tests cover shared import, hidden links, exact batch export and truthful results. Run `npx vitest run src/otpDelivery --maxWorkers=2` from `web/`.

Provider connectivity was separately tested with authorised messages: validated STARTTLS and SMTP authentication passed; one recipient supplied Gmail headers showing SPF, DKIM and DMARC PASS. This is not an end-to-end test of CSV invitation redemption. For that test, obtain recipient approval, generate one real invitation, send it once through this CLI, confirm receipt and mail authentication, open the link on a separate browser, request a credential, and check redemption/issuance without attaching the anonymous response to the contact row.
