auditable-voting-worker audit proxy binaries

Included:
- auditable-voting-worker-linux-x64.tar.gz
- auditable-voting-worker-linux-x64.tar.gz.sha256

Usage (Linux x86_64):
1. Verify checksum:
   sha256sum -c auditable-voting-worker-linux-x64.tar.gz.sha256
2. Extract:
   tar -xzf auditable-voting-worker-linux-x64.tar.gz
3. Run:
   WORKER_POLL_SECONDS=5 \
   WORKER_STATE_DIR="./.worker-state" \
   WORKER_NSEC=nsec1... \
   COORDINATOR_NPUB=npub1... \
   ./auditable-voting-worker-linux-x64

   The first launch checks the binary version and exits if it is below 0.1.41. Download a newer release from
   https://github.com/tidley/auditable-voting/releases/latest/download/auditable-voting-worker-linux-x64.tar.gz

   WORKER_RELAYS is optional. If not set, the audit proxy uses the default public/delegation relay set.
   WORKER_DM_RELAYS is optional. If not set, the audit proxy uses private-DM compatible relays only.

   WORKER_POLL_SECONDS controls how quickly the proxy retries stalled subscriptions and publishes fresh state after submission events.

Organiser Audit proxy quick start:
- The proxy page generates a fresh audit proxy account when opened.
- Copy the Quick start command for your platform and run it on the proxy machine.
- That command includes the current organiser npub, the effective relay list, and the generated audit proxy nsec.
- It starts the audit proxy with `RUST_LOG=info,auditable_voting_worker=debug,nostr_relay_pool=info,nostr_sdk=info,nostr=info,tungstenite=info,tokio_tungstenite=info` so blind-request processing shows up in the helper logs by default.
- `.worker-state` is used by default so the proxy can keep operating across sessions; delete it to reset local state for that proxy identity.
- Place the matching executable in the current directory, then run the generated command; it checks the version and starts the local audit proxy binary.
- The organiser page confirms configuration automatically when the proxy heartbeat appears; use Confirm configuration if the proxy is already running.

Other platforms:
- Linux arm64, Linux armv7, Windows x64, and macOS Apple Silicon release jobs are temporarily disabled to keep release turnaround short. The targets remain documented in the workflow and can be re-enabled easily.
- Or build from source in /worker:
  cd worker
  cargo build --release

Audit proxy responsibilities:
- announce audit proxy status to organiser
- receive audit proxy election-config state including the blind-signing key and public questionnaire definition pointer
- process delegated blind-token requests, including compressed bundle wrappers
- issue blind-signature responses for delegated elections, including the public definition hash/event id when available, and compress large issuance bundles before encryption when useful
- verify public submissions and publish delegated decisions
- optionally auto-publish result summary when all expected invitees have responded
