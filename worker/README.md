# Auditable Voting Delegate Coordinator

Optional audit proxy runtime for election-scoped coordinator delegation.

## Runtime model

- outbound relay connections only
- no inbound HTTP server
- no open inbound ports required

## Required environment

```bash
WORKER_NSEC=nsec1...
COORDINATOR_NPUB=npub1...
# Optional override:
# WORKER_RELAYS=wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info,wss://relay.nos.social,wss://relay.momostr.pink,wss://relay.azzamo.net
```

Optional:

```bash
WORKER_STATE_DIR=/var/lib/auditable-voting-worker
WORKER_HEARTBEAT_SECONDS=30
WORKER_POLL_SECONDS=15
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

The coordinator Build page can also save an autoconfigured platform-specific launcher script that downloads the correct binary and fills in the current coordinator `npub`, effective relay list, and generated audit proxy `nsec` when present. Those launcher scripts and direct command-line snippets default helper-side logging to `RUST_LOG=debug`. Right-click copy-link is supported through a shareable URL that intentionally omits `WORKER_NSEC`. Raw binary links and direct command-line launch snippets are also available there under `Advanced`.

## Current responsibilities

- announce audit proxy presence/status to the coordinator via NIP-17 DM
- consume delegation/revocation messages from DM and public events
- persist audit proxy runtime state locally
- poll recent control-plane gift-wrapped DMs with a 36-hour fixed-lookback replay window so NIP-17 randomised timestamps do not hide delegated blind requests, and keep requests retryable until the election config arrives
- consume audit proxy election-config DMs carrying the blind-signing key and questionnaire definition
- consume delegated blind-token requests over private DMs
- issue blind-signature responses on behalf of the coordinator for delegated elections with `Issue blind tokens` enabled, including the questionnaire definition when available so voters can render ballots offline
- process public questionnaire submissions for delegated elections
- publish delegated public submission decisions with delegation provenance tags
- optionally auto-publish result summaries when delegated capability is enabled and expected invitee completion is reached
