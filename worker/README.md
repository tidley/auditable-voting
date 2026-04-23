# Auditable Voting Worker

Optional delegated worker daemon for election-scoped coordinator delegation.

## Runtime model

- outbound relay connections only
- no inbound HTTP server
- no open inbound ports required

## Required environment

```bash
WORKER_NSEC=nsec1...
COORDINATOR_NPUB=npub1...
# Optional override:
# WORKER_RELAYS=wss://strfry.bitsbytom.com,wss://nos.lol
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

GitHub Releases include worker binaries for:

- Linux x64: `auditable-voting-worker-linux-x64.tar.gz`
- Linux arm64 / Raspberry Pi 64-bit: `auditable-voting-worker-linux-arm64.tar.gz`
- Linux armv7 / Raspberry Pi 32-bit: `auditable-voting-worker-linux-armv7.tar.gz`
- Windows x64: `auditable-voting-worker-windows-x64.zip`
- macOS Apple Silicon: `auditable-voting-worker-macos-arm64.tar.gz`

The coordinator Build page can also save an autoconfigured platform-specific launcher script that downloads the correct binary and fills in the current coordinator `npub`, effective relay list, and generated worker `nsec` when present. Raw binary links and direct command-line launch snippets are also available there under `Advanced`.

## Current responsibilities

- announce worker presence/status to the coordinator via NIP-17 DM
- consume delegation/revocation messages from DM and public events
- persist delegation runtime state locally
- consume delegated blind-token requests over private DMs
- issue blind-signature responses on behalf of the coordinator for delegated elections with `Issue blind tokens` enabled
- process public questionnaire submissions for delegated elections
- publish delegated public submission decisions with delegation provenance tags
- optionally auto-publish result summaries when delegated capability is enabled and expected invitee completion is reached
