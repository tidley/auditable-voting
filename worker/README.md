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
WORKER_RELAYS=wss://relay1.example,wss://relay2.example
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
- Windows x64: `auditable-voting-worker-windows-x64.zip`
- macOS Intel: `auditable-voting-worker-macos-x64.tar.gz`
- macOS Apple Silicon: `auditable-voting-worker-macos-arm64.tar.gz`

## Current responsibilities

- announce worker presence/status to the coordinator via NIP-17 DM
- consume delegation/revocation messages from DM and public events
- persist delegation runtime state locally
- process public questionnaire submissions for delegated elections
- publish delegated public submission decisions with delegation provenance tags
