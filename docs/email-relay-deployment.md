# Email relay deployment

This guide deploys the authenticated email relay for resident admission
delivery. The relay is separate from the voting worker; the worker stays
Nostr-only.

The relay is useful when the app is served from GitHub Pages or another origin
that cannot reach a loopback companion.

## Prerequisites

- Node.js 22 on the relay host.
- The repository at `/opt/tollgate/auditable-voting`.
- Web dependencies installed (`npm --prefix web ci`).
- An SMTP mailbox and credentials.
- A DNS name and TLS reverse proxy (Caddy is used below).
- The coordinator npub(s) allowed to use the relay.
- Optional: OpenBao with a KV v2 secret path.

## 1. Install the repository

```bash
sudo useradd --system --home /opt/tollgate --shell /usr/sbin/nologin tollgate || true
sudo install -d -o tollgate -g tollgate /opt/tollgate
sudo -u tollgate git clone https://github.com/tidley/auditable-voting.git /opt/tollgate/auditable-voting
sudo -u tollgate npm --prefix /opt/tollgate/auditable-voting/web ci
```

The relay imports `nostr-tools` and `nodemailer` from `web/node_modules`.

## 2. Configure the relay

```bash
sudo install -d -m 700 -o root -g root /etc/tollgate
sudo install -m 600 deploy/email-relay/email-relay.env.example /etc/tollgate/email-relay.env
sudoedit /etc/tollgate/email-relay.env
```

Required values:

```text
RELAY_PUBLIC_URL=https://mail.example.org
RELAY_ALLOWED_COORDINATORS=npub1...
SMTP_HOST=...
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...
```

Set `RELAY_ALLOWED_ORIGINS` to the app origins, for example:

```text
RELAY_ALLOWED_ORIGINS=https://tidley.github.io,https://vote.orangesync.tech
```

If the app is served from a different domain, add it. CORS is not
authentication; NIP-98 is.

## 3. Install the systemd unit

```bash
sudo install -m 644 deploy/email-relay/email-relay.service /etc/systemd/system/tollgate-email-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now tollgate-email-relay
sudo systemctl status tollgate-email-relay
```

The unit creates `/var/lib/tollgate-email-relay` and runs as `tollgate`.

## 4. Put Caddy in front

Copy `deploy/email-relay/Caddyfile.example` into the Caddy configuration and
replace `mail.example.org`.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check:

```bash
curl https://mail.example.org/health
```

Expected:

```json
{
  "service": "auditable-voting-email-relay",
  "version": 1,
  "transports": ["smtp"],
  "maxRecipients": 1000,
  "auth": "nip98"
}
```

## 5. Configure the app

In **Voters → Resident email admission → Remote email relay (optional)**, enter:

```text
https://mail.example.org
```

The app probes `/health`, requires a coordinator signer, and signs `POST /send`
with NIP-98.

Leave the field empty to use the local companion or the export/import path.

## OpenBao

Create a KV v2 secret at `secret/email/strato`:

```json
{
  "host": "smtp.example.org",
  "port": "465",
  "secure": "true",
  "username": "coordinator@example.org",
  "password": "...",
  "from": "coordinator@example.org"
}
```

Policy:

```hcl
path "secret/data/email/strato" {
  capabilities = ["read"]
}
```

Token file:

```bash
sudo install -m 600 /dev/null /etc/tollgate/openbao-token
sudoedit /etc/tollgate/openbao-token
```

Environment:

```text
OPENBAO_ADDR=https://openbao.example.org
OPENBAO_TOKEN_FILE=/etc/tollgate/openbao-token
OPENBAO_SECRET_PATH=secret/data/email/strato
OPENBAO_CACHE_SECONDS=60
```

When `OPENBAO_ADDR` is set, the relay reads the secret before each batch
(cached) and fails closed if OpenBao is unreachable or the secret is malformed.
Do not expose OpenBao to the browser.

Use an AppRole or another least-privilege token method in production; a static
token file is the minimum supported path.

## FIPS deployment

FIPS provides encrypted IPv6 reachability without a public IP for nodes on the
mesh. It is not an authentication mechanism and does not replace TLS or NIP-98.

### Option A: relay only on FIPS

- Bind the relay to the FIPS address or keep it on loopback behind Caddy on the
  FIPS node.
- Use a real DNS name and a certificate obtained by DNS-01, or a private CA
  installed on coordinator devices.
- Make the name resolve to the FIPS address via `/etc/fips/hosts` or the FIPS
  DNS resolver.
- Only FIPS-connected coordinator browsers can reach it.

```text
RELAY_HOST=fd00::1234
RELAY_PUBLIC_URL=https://mail.internal.example
```

### Option B: hybrid

Run one relay behind Caddy with both a public listener and a FIPS listener. The
same NIP-98 auth, allowlists and per-election ledger apply.

FIPS caveats:

- the browser must run FIPS or use a FIPS gateway;
- a `.fips` name does not have a publicly trusted certificate;
- use a real domain with DNS-01, or install a private CA;
- FIPS is still under active development; treat it as a pilot/private path.

## Privacy and monitoring

The relay sees recipient addresses and plaintext admission codes while sending.
Document that trust boundary with the operator.

Logs contain:

```text
electionId, coordinator prefix, recipient count, sent/skipped/failed,
status, duration
```

They do not contain addresses, codes or SMTP credentials.

Monitor:

- `401` / `403` — auth or allowlist rejects;
- `409` — replay, in-flight or ledger conflict;
- `429` — rate limit;
- `502` — SMTP/OpenBao/upstream failure.

## State

```text
/var/lib/tollgate-email-relay/
├── rate-limit.json
└── elections/
    └── <electionId>/
        ├── send-ledger.json
        └── results-*.csv
```

Back up the election ledger if you need to resume after a host loss. The ledger
contains fingerprints and status, not plaintext codes or addresses.

## Upgrade

```bash
sudo -u tollgate git -C /opt/tollgate/auditable-voting pull --ff-only
sudo -u tollgate npm --prefix /opt/tollgate/auditable-voting/web ci
sudo systemctl restart tollgate-email-relay
```

## Security checklist

- [ ] TLS with a valid certificate.
- [ ] `RELAY_PUBLIC_URL` set explicitly.
- [ ] Coordinator allowlist non-empty.
- [ ] Optional election allowlist set for a single election.
- [ ] CORS origins limited to deployed app origins.
- [ ] Env file mode `600`.
- [ ] OpenBao token file mode `600`/`400`.
- [ ] State directory owned by `tollgate`, mode `700`.
- [ ] Rate limits sized for the electorate.
- [ ] Alerting on 401/403/429/502 rates.
- [ ] Logs reviewed for accidental recipient data.
