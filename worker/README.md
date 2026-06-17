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
# WORKER_RELAYS=wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info
```

Optional:

```bash
WORKER_STATE_DIR=/var/lib/auditable-voting-worker
WORKER_HEARTBEAT_SECONDS=30
WORKER_POLL_SECONDS=5
```

## Run

```bash
cargo run --release
```

## Prebuilt binaries

GitHub Releases include audit proxy binaries for:

- Linux x64: `auditable-voting-worker-linux-x64.tar.gz`
- Linux arm64 / Raspberry Pi 64-bit: `auditable-voting-worker-linux-arm64.tar.gz`
- Linux armv7 / Raspberry Pi 32-bit: `auditable-voting-worker-linux-armv7.tar.gz`
- Windows x64: `auditable-voting-worker-windows-x64.zip`
- macOS Apple Silicon: `auditable-voting-worker-macos-arm64.tar.gz`

Each archive extracts a platform-specific executable with the same stem as the asset:

- Linux x64: `./auditable-voting-worker-linux-x64`
- Linux arm64: `./auditable-voting-worker-linux-arm64`
- Linux armv7: `./auditable-voting-worker-linux-armv7`
- Windows x64: `.\auditable-voting-worker-windows-x64.exe`
- macOS Apple Silicon: `./auditable-voting-worker-macos-arm64`

The coordinator Build page can also save an autoconfigured platform-specific launcher script that downloads the correct binary and fills in the current coordinator `npub`, effective relay list, and generated audit proxy `nsec` when present. Those launcher scripts and direct command-line snippets default helper-side logging to scoped proxy debug logs, set `WORKER_POLL_SECONDS=5` for responsive ballot issuance, and keep dependency relay-frame logs at `info` so encrypted NIP-17 payloads are not printed. Right-click copy-link is supported through a shareable URL that intentionally omits `WORKER_NSEC`. Raw binary links and direct command-line launch snippets are also available there under `Advanced`.

## Current responsibilities

- announce audit proxy presence/status to the coordinator via NIP-17 DM
- consume delegation/revocation messages from DM and public events
- persist audit proxy runtime state locally
- poll recent control-plane gift-wrapped DMs with a 36-hour fixed-lookback replay window so NIP-17 randomised timestamps do not hide delegated blind requests, debug-log short decrypted DM metadata without encrypted payload dumps, and keep requests retryable until the election config arrives
- retry configured and delegated control relays with per-relay backoff instead of permanently dropping older persisted relay hints
- consume audit proxy election-config DMs carrying the blind-signing key, questionnaire definition, whitelisted voter npubs, and one-use private invite-code hashes
- consume delegated blind-token requests over private DMs
- issue blind-signature responses on behalf of the coordinator for delegated elections with `Issue blind tokens` enabled, but only after the matching election config has arrived; unlisted general-link requests stay retryable until the organiser's later whitelist sync authorises them
- redeem private invite codes locally from configured code hashes while voters also copy the same request to the organiser so the organiser UI can show the link as claimed
- process public questionnaire submissions for the newest configured delegated election only after the questionnaire definition and a positive expected participant count are configured, and stop scanning a round once expected accepted completion is reached
- publish delegated public submission decisions with delegation provenance tags
- optionally publish a delegated close-state event and result summary when delegated capabilities are enabled, expected invitee completion is reached using accepted valid responses only, and no delegated blind request is still waiting for authorisation/configuration
- keep running after currently known delegated work completes so later sessions and late general-invite ballot requests can still be handled; stop with Ctrl-C or terminate the process when you are done with the current proxy identity
