# Strato email credential setup

This runbook covers the SMTP credential used by the local email companion for
`@orangesync.tech` delivery. The sending path is Strato's submission server:

```text
smtp.strato.de:465  SSL/TLS
username = full mailbox address
password = mailbox password
```

A catch-all address receives mail but does **not** provide SMTP AUTH
credentials. The username must be a real mailbox, for example
`vote@orangesync.tech`.

> **Current pilot mailbox:** `chandran@orangesync.tech` is a real Strato mailbox
> and the current catch-all for `orangesync.tech`. Set `SMTP_USER` and
> `SMTP_FROM` to that address until a dedicated `vote@orangesync.tech` mailbox is
> created.

Verified with the current pilot mailbox: SMTP AUTH succeeds, and delivered mail
shows `spf=pass`, `dkim=pass` for both `strato-dkim-0002` and
`strato-dkim-0003`, `dmarc=pass` and `arc=pass`.

## Prerequisites

- A real Strato mailbox, or an existing mailbox that may send as the chosen
  `From` address.
- Access to `~/hermes-trust-root` on T14, or another secure secret store.
- The DNS records from `tik-work/ansible/roles/cloudflare_email_dns` applied:
  MX `smtp.rzone.de`, Strato SPF, DKIM CNAMEs and DMARC.

Verify DNS without a token:

```bash
cd ~/tik-work
scripts/verify-email-dns.sh orangesync.tech
```

## Option A — Hermes trust root (recommended)

Store the mailbox password as a SOPS/OpenBao secret. The value is entered at a
hidden prompt; it never appears in argv, shell history or a tracked file.

```bash
cd ~/hermes-trust-root
make secret-put NAME=strato-smtp
```

When prompted:

```text
field name: password
value: <the Strato mailbox password>
```

This writes `~/.hermes/trust-root/sops/strato-smtp.enc.yaml` and seeds the KV
store. The launcher reads the `password` field from that file by default.

If the companion will run on a fleet node rather than T14, add a least-privilege
reader grant:

```bash
make add-secret NAME=strato-smtp NODE=x280
```

`add-secret` stores the value and grants the node; it prompts for the value
again. Grant only the host that runs the companion, never a wildcard.

## Option B — mode-0600 password file

Use this only when the trust root is unavailable.

```bash
install -m 600 /dev/null "$HOME/.hermes/trust-root/strato-smtp.pass"
# Edit the file with a secure editor and enter the password.
# Do not use `echo` or a command that writes the value to shell history.
```

The launcher refuses to read the file unless its mode is `600` or `400`.

## Option C — environment variable

For a one-off foreground test:

```bash
export SMTP_PASS='<mailbox password>'
scripts/run-email-sender-strato.sh
```

This is discouraged for shared shells because the value can leak into process
listings or history.

## Start the companion

From the voting repository:

```bash
cd /home/c08rad0r/repos/auditable-voting-email
scripts/run-email-sender-strato.sh
```

Defaults:

```text
SMTP_HOST=smtp.strato.de
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=vote@orangesync.tech
SMTP_FROM=vote@orangesync.tech
```

Use a different mailbox by exporting `SMTP_USER` and `SMTP_FROM` before starting.

The launcher resolves the password in this order:

1. `SMTP_PASS`
2. `$STRATO_SMTP_SOPS_FILE`, default
   `$HOME/.hermes/trust-root/sops/strato-smtp.enc.yaml`, field `password`
3. `$STRATO_SMTP_PASS_FILE`, default
   `$HOME/.hermes/trust-root/strato-smtp.pass`

It keeps the password in the companion process environment; it is never sent to
the browser.

## Verify authentication without sending

```bash
STRATO_CHECK_ONLY=1 scripts/run-email-sender-strato.sh
```

Expected:

```text
SMTP AUTH OK
```

No message is sent. This proves the secret was read and Strato accepted the
mailbox credentials.

## Send one controlled delivery test

```bash
STRATO_TEST_TO=you@example.com scripts/run-email-sender-strato.sh
```

Expected:

```text
SMTP AUTH OK
TEST MESSAGE SENT to you@example.com
```

This is a plain test message, not an admission email. Check the recipient inbox
and the authentication headers:

- `spf=pass`
- `dkim=pass` with `d=orangesync.tech`
- `dmarc=pass`

Also check spam/junk and run one message through a deliverability checker before
sending to residents.

## Rotate or revoke

Replace the value after a mailbox password change or suspected exposure:

```bash
cd ~/hermes-trust-root
make secret-put NAME=strato-smtp
# field: password -> new value
```

Then restart the companion.

Remove a fleet-node grant that is no longer needed:

```bash
make secret-revoke NODE=x280 SECRET=strato-smtp
```

A local T14 companion reads the SOPS file directly, so it does not need a node
grant.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `530 5.7.0 User not authenticated` | Missing or empty password, or a catch-all/alias was used instead of a real mailbox. |
| `535 ... authentication failed` | Wrong mailbox password, or `SMTP_USER` is not the full address. |
| `SMTPNotSupportedError: STARTTLS ...` | Wrong TLS mode. Use port 465 with `SMTP_SECURE=true`, or port 587 with `SMTP_SECURE=false`. |
| `Could not decrypt ...` | `SOPS_AGE_KEY_FILE` is not pointing at the fleet age key, or the `strato-smtp` secret has not been created. |
| `Refusing to read ... mode 644` | `chmod 600` the password file, or use the trust-root secret. |
| Message accepted but not in the inbox | Check spam/junk, the exact recipient, and Strato's outbound log. Acceptance does not prove inbox placement. |

## Security notes

- Never commit `.env`, a password file, or the SOPS plaintext.
- Prefer a dedicated mailbox such as `vote@orangesync.tech` over a personal one.
- Strato can see recipient addresses and message bodies, including admission
  codes. Record this in the election's data-protection notes.
- The companion is loopback-only; do not expose it to the public internet.
