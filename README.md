# Auditable Voting

Static, browser-first questionnaire voting over Nostr relays.

Auditable Voting lets an organiser publish a questionnaire, invite voters for repeated questionnaire rounds, issue fresh blind ballot credentials per response, accept public blind-token responses, and let observers verify the public result stream. It runs as a static web app, with an optional outbound-only Rust audit proxy for organiser-offline issuance, verification, closing, and result publication.

Live site: [npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol](https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/)

For a non-technical walkthrough, start with the [plain-English demo guide](docs/demo-guide.md). It avoids protocol terms and gives a short action-first flow for publishing a questionnaire, sharing an invite, submitting a response, and checking the result.

## Status

Experimental.

The active product is the client in `web/` plus the optional audit proxy in `worker/`. Public relay behaviour, browser key custody, and live-network convergence remain operational constraints. Do not treat this as production election infrastructure without independent protocol and implementation review.

## Features

- Browser voter, organiser, and observer flows.
- Nostr-first transport using public events and NIP-17 private control traffic.
- Per-questionnaire relay hints published in questionnaire metadata when the organiser uses a non-default relay set.
- Public questionnaire reads are tag-filtered by questionnaire ID, paginated, and serialised; organiser, voter, and observer live questionnaire subscriptions are consolidated to reduce relay-side concurrent `REQ` pressure.
- NIP-17 mailbox recovery pages backwards until the active request, credential, or submission decision is found, or until a short time budget is reached.
- Yes/no, multiple-choice, ranked-choice, and free-text questionnaire questions, including organiser-required encryption for free-text responses.
- Browser-only invite sharing by copied link, native device share actions, General QR links that open Vote directly and request a ballot automatically, personalised links for invited voter npubs, public questionnaire announcements for invited voters, or one-use private code links managed from Voters with notes, share controls, and QR codes.
- Organiser-local invited voter rosters can be reused across later questionnaires; each row can carry an internal note and an auto-ballot checkbox. Applying the roster to a questionnaire green-lights checked voters and publishes one roster-free public questionnaire announcement, while each response still requires a fresh blind credential requested by the voter. After a questionnaire is published, **New round** generates a fresh questionnaire ID from the current setup and publishes directly to invited voters.
- Blind credential issuance for invited participants.
- Public blind-token submissions from ephemeral response keys.
- Organiser and Observer results derived from public submissions and decisions, including proxy-accepted responses, locally verified blind-token proofs, rejection reasons, and organiser-side automatic decryption of encrypted answer details when the local organiser key is available. Public decisions are the normal acceptance signal; private acceptance DMs are only a recovery path for older/private flows.
- Observer-local `nsec` entry for decrypting encrypted response details when the organiser key is deliberately supplied.
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

- `/` - main app shell, defaulting to Observer
- `/vote.html` - voter entry point
- `/dashboard.html` - organiser and auditor dashboard
- `/simple.html` - simplified voter flow
- `/simple-coordinator.html` - simplified organiser flow
- `/demo-guide.html` - plain-English meeting guide
- `/project-explainer.html` - public "How it works" page
- `/technical-details.html` - technical protocol note

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
npm run test:live-delegate-coordinator
npm run test:live-rust-helper
npm run test:live-questionnaire-scale
```

These use public relays and can fail because of relay availability, rate limits, proof-of-work requirements, or propagation delays. `test:live-questionnaire-scale` publishes a 30-round/100-voter synthetic questionnaire transcript by default, so run it only when you intentionally want a live public-relay load probe.

## Audit Proxy

The audit proxy is an optional Rust helper. It uses the delegated organiser role to keep a questionnaire moving when the browser organiser is offline.

For larger live sessions, such as dozens of rounds or around 100 voters, treat the audit proxy/worker as the default issuance and verification path. The browser organiser remains the root authority, but the proxy avoids relying on one open browser tab to process every blind request and public submission.

It can:

- receive delegation and questionnaire config over NIP-17 gift-wraps;
- issue blind credentials to eligible voters, including voters who claim a one-use private invite code;
- verify public blind-token submissions;
- publish accept/reject decisions;
- close the questionnaire after all expected invitees have accepted valid responses;
- publish the result summary;
- exit cleanly once delegated close and summary publication are complete.

Run it locally:

```bash
cd worker
WORKER_NSEC="nsec1..." \
COORDINATOR_NPUB="npub1..." \
WORKER_RELAYS="wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info" \
cargo run
```

Useful optional environment variables:

- `WORKER_STATE_DIR`
- `WORKER_HEARTBEAT_SECONDS`
- `WORKER_POLL_SECONDS`
- `WORKER_RELAYS`

The proxy is outbound-only. It does not require inbound ports or a public server endpoint.

## Protocol Summary

1. The organiser publishes a questionnaire definition, optional non-default relay hints, and public expected-voter count.
2. When an invited-voter roster is applied, the organiser green-lights checked invited voters and publishes one roster-free public questionnaire announcement rather than sending the same questionnaire metadata to every voter.
3. Voters discover the public announcement and request blind credentials over private NIP-17 messages when they answer.
4. The organiser or audit proxy blind-signs requests from eligible voters.
5. Voters submit public blind-token responses from ephemeral response keys.
6. The organiser or audit proxy publishes verification decisions and result summaries. Voter, organiser, and observer recovery prefers those public decisions before falling back to private acceptance DMs.
7. Observers can verify public submissions, decisions, counts, and summaries from relay data.

## Deployment

GitHub Pages is built by `.github/workflows/static.yml`.

For a local Pages-compatible build:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
```

The project can also be published to nsite. The current public nsite gateway is [npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol](https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/).

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

### FIPS-hosted mirror

The static app can also be hosted on a FIPS mesh node. The launcher at
`web/public/fips-host/launch-auditable-voting-fips.sh` builds the latest
upstream FIPS daemon, enables Nostr overlay discovery, advertises the node as a
FIPS endpoint, builds this site, and serves it on the node's `fips0` address.
It can also install an optional audit-proxy service template.

From GitHub Pages:

```bash
curl -L https://tidley.github.io/auditable-voting/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
chmod +x launch-auditable-voting-fips.sh
sudo ./launch-auditable-voting-fips.sh
```

From nsite:

```bash
curl -L https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
chmod +x launch-auditable-voting-fips.sh
sudo ./launch-auditable-voting-fips.sh
```

After startup, other FIPS nodes can reach the mirror at
`http://<fips-node-npub>.fips:8080/`. By default the launcher advertises
`udp:nat` via FIPS' Nostr/STUN handoff flow; set `FIPS_PUBLIC_UDP=1` and
`FIPS_EXTERNAL_ADDR=IP:2121` for a stable public UDP endpoint.

If the machine already runs packaged FIPS, for example a Raspberry Pi with
`ExecStart=/usr/bin/fips --config /etc/fips/fips.yaml`, reuse it without
rebuilding FIPS, requiring npm, or replacing the existing FIPS config, service,
or firewall:

```bash
sudo ./launch-auditable-voting-fips.sh --reuse-running-fips
```

When npm is available the launcher builds Vite and installs the complete
`web/dist/` tree as the web root. Reuse mode downloads the published static
site and recursively completes the referenced Vite assets, including dynamic JS
chunks and WASM files, before replacing the live root. This avoids partial
deployments where imported modules receive HTML fallback responses.

To serve under a path prefix instead of the FIPS site root, build from source
and set `WEB_BASE_PATH`, for example:

```bash
sudo WEB_BASE_PATH=/auditable-voting/ ./launch-auditable-voting-fips.sh
```

## Limitations

- Relay support for filters, retention, and rate limits varies.
- The default relay set is intentionally small: four public questionnaire relays and three NIP-17 inbox relays, with per-questionnaire overrides available when needed.
- Browser-local organiser state and keys must be protected by the user.
- The audit proxy improves liveness but is still delegated by the organiser.
- Public verification depends on observers fetching the relevant relay events.
- Decrypting encrypted observer details requires manually entering the matching organiser `nsec`; the key is not a public audit input.
- The protocol and implementation need external review before strong production claims.

## Documentation

- `docs/project-explainer.md`
- `docs/technical-protocol-note.md`
- `web/public/project-explainer.html`
- `web/public/technical-details.html`
- `docs/questionnaire-blind-token-protocol.md`
- `docs/questionnaire-protocol-decisions.md`
- `presentation/project-overview.html`
