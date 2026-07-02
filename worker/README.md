# Auditable Voting Delegate Coordinator

Optional audit proxy runtime for election-scoped coordinator delegation.

## Runtime model

- outbound relay connections only
- no inbound HTTP server
- no open inbound ports required
- configured or delegated relays known to be unreliable are still tried, but failures put them into exponential backoff so preferred relays remain the normal path

## Required environment

```bash
WORKER_NSEC=nsec1...
COORDINATOR_NPUB=npub1...
# Optional override:
# WORKER_RELAYS=wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info,wss://relay.damus.io,wss://relay.primal.net
# WORKER_DM_RELAYS=wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net
```

Optional:

```bash
WORKER_STATE_DIR=/var/lib/auditable-voting-worker
WORKER_HEARTBEAT_SECONDS=30
WORKER_POLL_SECONDS=5
WORKER_DM_RELAYS=wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net
WORKER_PUBLIC_ARCHIVE_RELAYS=wss://nos.lol,wss://relay.primal.net,wss://relay.damus.io
WORKER_PUBLIC_ARCHIVE_INTERVAL_MS=500
WORKER_PUBLIC_ARCHIVE_QUEUE_SIZE=10000
WORKER_BLOSSOM_RESULT_PACK_SERVERS=https://blossom.nostr.build,https://blossom.primal.net,https://cdn.nostrcheck.me
```

`WORKER_PUBLIC_ARCHIVE_RELAYS` is optional. When set, the worker still publishes public responses, decisions, close events, and summaries to the hot worker relays first, then copies those same signed events to the archive relays one relay/event at a time at `WORKER_PUBLIC_ARCHIVE_INTERVAL_MS`. Archive fanout is best-effort and bounded by `WORKER_PUBLIC_ARCHIVE_QUEUE_SIZE`.

`WORKER_BLOSSOM_RESULT_PACK_SERVERS` is optional and defaults to the three HTTPS servers shown above. When delegated result summary publishing is enabled, the worker uploads a gzip-compressed public result pack to at least two Blossom servers, then includes the primary URL, mirror URLs, size, and SHA-256 in the result summary. If fewer than two servers accept the upload, the worker publishes the count summary without a Blossom pack.

## Run

```bash
cargo run --release
```

## Prebuilt binaries

GitHub Releases currently build the audit proxy binary for:

- Linux x64: `auditable-voting-worker-linux-x64.tar.gz`

Linux arm64, Linux armv7, Windows x64, and macOS Apple Silicon release jobs are temporarily disabled to keep release turnaround short; the targets remain documented in the workflow and can be re-enabled easily.

The archive extracts a platform-specific executable with the same stem as the asset:

- Linux x64: `./auditable-voting-worker-linux-x64`

The coordinator Build page can also save an autoconfigured platform-specific launcher script that downloads the correct binary and fills in the current coordinator `npub`, effective public/delegation relay list, private-DM relay list, and generated audit proxy `nsec` when present. Those launcher scripts and direct command-line snippets default helper-side logging to scoped proxy debug logs, set `WORKER_POLL_SECONDS=5` for responsive ballot issuance, default private DMs to `vm-1734.lnvps.cloud` plus `relay.nostr.net`, keep public-only/rate-limited relays out of `WORKER_DM_RELAYS`, and keep dependency relay-frame logs at `info` so encrypted NIP-17 payloads are not printed. Right-click copy-link is supported through a shareable URL that intentionally omits `WORKER_NSEC`. Raw binary links and direct command-line launch snippets are also available there under `Advanced`.

## Current responsibilities

- announce audit proxy presence/status to the coordinator via NIP-17 DM
- consume delegation/revocation messages from DM and public events
- persist audit proxy runtime state locally
- poll recent control-plane gift-wrapped DMs with a 36-hour fixed-lookback replay window so NIP-17 randomised timestamps do not hide delegated blind requests, debug-log short decrypted DM metadata without encrypted payload dumps, and keep requests retryable until the election config arrives
- retry configured and delegated control relays with per-relay backoff instead of permanently dropping older persisted relay hints
- consume audit proxy election-config DMs carrying the blind-signing key, public questionnaire definition pointer, whitelisted voter npubs, and one-use private invite-code hashes
- consume delegated blind-token requests over private DMs, accepting both plain JSON request bundles and gzip+base64url compressed bundle wrappers
- queue parsed blind-token request DMs behind a bounded worker queue and drain them in short batches so relay notifications are not blocked by issuance publishing, while deferred requests remain retryable
- issue blind-signature responses on behalf of the coordinator for delegated elections with `Issue blind tokens` enabled, but only after the matching election config has arrived; unlisted general-link requests stay retryable until the organiser's later whitelist sync authorises them, and large multi-credential issuance bundles are compressed before NIP-17 encryption when that reduces the payload
- redeem private invite codes locally from configured code hashes while voters also copy the same request to the organiser so the organiser UI can show the link as claimed
- process public questionnaire submissions only after the public questionnaire definition and a positive expected participant count are configured, and stop scanning a round once expected accepted completion is reached
- publish delegated public submission decisions with delegation provenance tags
- optionally drip-feed handled public responses, submission decisions, close events, and result summaries to public archive relays without blocking the hot worker relay path
- optionally publish a delegated close-state event and result summary when delegated capabilities are enabled, expected invitee completion is reached using accepted valid responses only, and no delegated blind request is still waiting for authorisation/configuration; final summaries can reference the verified two-mirror Blossom result pack for observer readback recovery
- keep running after currently known delegated work completes so later sessions and late general-invite ballot requests can still be handled; stop with Ctrl-C or terminate the process when you are done with the current proxy identity
