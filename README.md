# Auditable Voting

Static, browser-first questionnaire voting over Nostr relays.

Auditable Voting lets a coordinator publish a questionnaire, invite known voters, issue blind ballot credentials, accept public blind-token responses, and let observers verify the public result stream. It runs as a static web app, with an optional outbound-only Rust audit proxy for coordinator-offline issuance, verification, closing, and result publication.

## Status

Experimental.

The active product is the client in `web/` plus the optional audit proxy in `worker/`. Public relay behaviour, browser key custody, and live-network convergence remain operational constraints. Do not treat this as production election infrastructure without independent protocol and implementation review.

## Features

- Browser voter, coordinator, and observer flows.
- Nostr-first transport using public events and NIP-17 private control traffic.
- Blind credential issuance for allowlisted participants.
- Public blind-token submissions from ephemeral response keys.
- Live observer results derived from public submissions and decisions.
- Optional audit proxy that can issue credentials, verify submissions, publish decisions, close completed questionnaires, and publish result summaries.
- Static deployment to GitHub Pages or nsite.

## Repository Layout

```text
auditable-voting/
|-- web/          Static browser app
|-- worker/       Optional Rust audit proxy
|-- docs/         Protocol and project notes
|-- presentation/ Project overview deck
`-- README.md
```

Key web routes:

- `/` - main app shell
- `/vote.html` - voter entry point
- `/dashboard.html` - coordinator and auditor dashboard
- `/simple.html` - simplified voter flow
- `/simple-coordinator.html` - simplified coordinator flow
- `/project-explainer.html` - browser-readable project explainer

## Quick Start

Install dependencies:

```bash
npm --prefix web install
```

Run the web app locally:

```bash
npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Build the static site:

```bash
npm --prefix web run build
```

If rebuilding the WebAssembly blind-signature package directly, install the Rust Wasm target first:

```bash
rustup target add wasm32-unknown-unknown
```

## Tests

```bash
cd web
npm test
npm run test:relay-load
npm run test:rust
npm run verify:simple-blind-shares
npx tsc --noEmit
npm run build
```

Worker tests:

```bash
cargo test --manifest-path worker/Cargo.toml
```

Optional live relay smoke tests:

```bash
cd web
npm run test:live-audit-proxy
npm run test:live-rust-helper
```

These use public relays and can fail because of relay availability, rate limits, or propagation delays.

## Audit Proxy

The audit proxy is an optional Rust helper. It uses the delegated coordinator role to keep a questionnaire moving when the browser coordinator is offline.

It can:

- receive delegation and questionnaire config over NIP-17 gift-wraps;
- issue blind credentials to eligible voters;
- verify public blind-token submissions;
- publish accept/reject decisions;
- close the questionnaire after all expected invitees have accepted valid responses;
- publish the result summary.

Run it locally:

```bash
cd worker
WORKER_NSEC="nsec1..." \
COORDINATOR_NPUB="npub1..." \
WORKER_RELAYS="wss://relay.nostr.net,wss://nos.lol" \
cargo run
```

Useful optional environment variables:

- `WORKER_STATE_DIR`
- `WORKER_HEARTBEAT_SECONDS`
- `WORKER_POLL_SECONDS`
- `WORKER_RELAYS`

The proxy is outbound-only. It does not require inbound ports or a public server endpoint.

## Protocol Summary

1. The coordinator publishes a questionnaire definition and public expected-voter count.
2. Voters request blind credentials over private NIP-17 messages.
3. The coordinator or audit proxy blind-signs requests from eligible voters.
4. Voters submit public blind-token responses from ephemeral response keys.
5. The coordinator or audit proxy publishes verification decisions and result summaries.
6. Observers can verify public submissions, decisions, counts, and summaries from relay data.

## Deployment

GitHub Pages is built by `.github/workflows/static.yml`.

For a local Pages-compatible build:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
```

The project can also be published to nsite. The current public nsite gateway is:

```text
https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/
```

Publish with `nsyte`:

```bash
npm --prefix web run build
set -a && source .secrets/nsite.env && set +a
nsyte deploy web/dist \
  --sec "$NSEC" \
  --publish-server-list \
  --publish-relay-list \
  --publish-profile \
  --skip-secrets-scan \
  --non-interactive \
  --force \
  --verbose
```

`.secrets/nsite.env` should define `NSEC` and `NPUB`. Do not commit it.

## Limitations

- Relay support for filters, retention, and rate limits varies.
- Browser-local coordinator state and keys must be protected by the user.
- The audit proxy improves liveness but is still delegated by the coordinator.
- Public verification depends on observers fetching the relevant relay events.
- The protocol and implementation need external review before strong production claims.

## Documentation

- `docs/project-explainer.md`
- `web/public/project-explainer.html`
- `docs/questionnaire-blind-token-protocol.md`
- `docs/questionnaire-protocol-decisions.md`
- `presentation/project-overview.html`
