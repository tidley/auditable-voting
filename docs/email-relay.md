# Email relay service

The email relay is a separate coordinator-side service that lets the static app
send resident admission emails through SMTP when the browser cannot reach a
loopback companion — including from GitHub Pages.

It is **not** part of the voting worker. The worker remains a Nostr-only process
for ballot issuance, verification and result publication. The relay can run on
the same host or as a sidecar, but it has its own process and key.

## Architecture

```text
Static app / local app
        |
        | HTTPS + NIP-98 signed request
        v
email-relay  ->  SMTP provider
```

The relay:

- verifies the coordinator's NIP-98 signature;
- checks the coordinator and optional election allowlists;
- rejects replayed or expired requests;
- validates the admission bundle;
- enforces recipient and rate limits;
- writes a per-election ledger and redacted results;
- holds SMTP credentials, never the browser.

## API

### `GET /health`

```json
{
  "service": "auditable-voting-email-relay",
  "version": 1,
  "transports": ["smtp"],
  "maxRecipients": 1000,
  "auth": "nip98"
}
```

No credentials or election identifiers are returned.

### `POST /send`

Body:

```json
{
  "electionId": "q_261113_125444",
  "bundleCsv": "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url\n..."
}
```

Headers:

```text
Content-Type: application/json
Authorization: Nostr <base64 NIP-98 event>
```

The NIP-98 event must:

- be kind `27235`;
- have a valid signature;
- have `u` equal to the relay's public `/send` URL;
- have `method` equal to `POST`;
- have `payload` equal to the SHA-256 of the exact request body;
- have `created_at` within ±60 seconds.

The relay rejects:

- an unknown coordinator npub;
- an election outside `RELAY_ALLOWED_ELECTIONS`, when configured;
- a bundle whose `vote_url` `q` parameter does not match `electionId`;
- a reused NIP-98 event ID;
- more than the configured recipients or rate limits.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_HOST` | Bind address | `127.0.0.1` |
| `RELAY_PORT` | TCP port | `4320` |
| `RELAY_PUBLIC_URL` | Public origin used in NIP-98 `u` checks | loopback Host fallback |
| `RELAY_ALLOWED_COORDINATORS` | Comma-separated npub or hex keys | required |
| `RELAY_ALLOWED_ELECTIONS` | Optional comma-separated election IDs | any from an allowed coordinator |
| `RELAY_ALLOWED_ORIGINS` | Browser origins allowed by CORS | localhost, GitHub Pages, `vote.orangesync.tech` |
| `RELAY_STATE_DIR` | Ledger, results and rate-limit directory | `../.email-relay-state` |
| `RELAY_MAX_RECIPIENTS` | Max recipients per batch | `1000` |
| `RELAY_MAX_RECIPIENTS_PER_DAY` | Per-coordinator daily limit | `500` |
| `RELAY_MAX_BATCHES_PER_HOUR` | Per-coordinator hourly limit | `20` |

SMTP:

```text
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
SMTP_FROM
```

Use a mode-0600 env file, SOPS, or a secret manager. Do not put these values in
the browser bundle.

## Run locally

```bash
cd /home/c08rad0r/repos/auditable-voting-email

RELAY_ALLOWED_COORDINATORS=npub1... \
SMTP_HOST=smtp.example.org \
SMTP_PORT=587 \
SMTP_USER=coordinator@example.org \
SMTP_PASS=... \
SMTP_FROM=coordinator@example.org \
npm --prefix web run email:relay
```

Check:

```bash
curl http://127.0.0.1:4320/health
```

The relay binds to loopback by default. For a public deployment, put it behind
Caddy or another TLS reverse proxy and set `RELAY_PUBLIC_URL` to the public
origin.

## Deployment modes

### Local-only

Keep the existing companion (`scripts/email-sender.mjs`) and use the relay only
for testing. The UI sends to the local companion by default.

### Public HTTPS relay

Run the relay on a host with a public HTTPS origin:

```text
https://mail.example.org  ->  127.0.0.1:4320
```

Set:

```text
RELAY_PUBLIC_URL=https://mail.example.org
RELAY_ALLOWED_ORIGINS=https://tidley.github.io,https://vote.orangesync.tech
RELAY_ALLOWED_COORDINATORS=npub1...
```

The browser signs the request with the coordinator key and posts it to the
relay. CORS allows the static page; NIP-98 is the authentication.

### FIPS-only

FIPS provides an encrypted IPv6 mesh and removes the need for a public IP for
FIPS-connected coordinators. It does **not** replace TLS or NIP-98, and it does
not make GitHub Pages users reach the relay unless their machine is on the mesh
or they use an HTTPS FIPS-reachable name with a trusted certificate.

Set `RELAY_HOST` to the FIPS bind address or put Caddy on the FIPS node. Use the
same allowlists and auth. Only expose the mesh listener to peers you trust.

### Hybrid

Run one relay behind Caddy with:

- a loopback listener for local operators;
- a public HTTPS listener for GitHub Pages;
- optionally a FIPS listener for mesh operators.

All listeners share the same auth, allowlists and per-election ledger.

## State and privacy

```text
RELAY_STATE_DIR/
├── rate-limit.json
└── elections/
    └── <electionId>/
        ├── send-ledger.json
        └── results-<timestamp>-<pid>.csv
```

- The ledger contains fingerprints, status and timestamps, not addresses or
  plaintext codes.
- Results contain master-list number, status, detail and delivery reference.
- Logs contain election ID, coordinator prefix, counts, duration and status.
- The relay necessarily sees recipient addresses and admission codes while
  sending. Use a host and operator you trust, and document that trust boundary.
- Do not expose the relay without TLS, NIP-98 and an allowlist.

## OpenBao (optional)

The relay can read SMTP credentials from environment variables, a mode-0600
file, SOPS, or an optional OpenBao KV v2 path. OpenBao is a secret backend, not
a replacement for the relay or NIP-98. Never expose OpenBao to the browser and
never give the browser an OpenBao token.

A future adapter will use:

```text
OPENBAO_ADDR
OPENBAO_TOKEN_FILE
OPENBAO_SECRET_PATH=secret/data/email/strato
```

with a relay-only policy and a short cache. Until then, use the environment or
SOPS.

## Tests

```bash
node --test scripts/test/email-relay.test.mjs
```

The tests cover NIP-98 verification, payload/URL/method checks, expiry, replay,
coordinator and election allowlists, CORS, per-election ledger paths, rate
limits and redacted responses.

## Security checklist

- [ ] TLS reverse proxy with a valid certificate.
- [ ] `RELAY_PUBLIC_URL` set explicitly.
- [ ] At least one coordinator in `RELAY_ALLOWED_COORDINATORS`.
- [ ] Optional `RELAY_ALLOWED_ELECTIONS` set for a single election.
- [ ] CORS allowlist limited to the deployed app origins.
- [ ] SMTP credentials mode `600` / secret manager.
- [ ] State directory mode `700`, ledger/results `600`.
- [ ] Rate limits sized for the electorate.
- [ ] Monitoring for 401/403/429/409 rates.
- [ ] No relay logs shipped to a third party without review.
