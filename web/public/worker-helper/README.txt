auditable-voting-worker helper binaries

Included:
- auditable-voting-worker-linux-x64.tar.gz
- auditable-voting-worker-linux-x64.tar.gz.sha256

Usage (Linux x86_64):
1. Verify checksum:
   sha256sum -c auditable-voting-worker-linux-x64.tar.gz.sha256
2. Extract:
   tar -xzf auditable-voting-worker-linux-x64.tar.gz
3. Run:
   WORKER_NSEC=nsec1... \
   COORDINATOR_NPUB=npub1... \
   ./auditable-voting-worker-linux-x64

   WORKER_RELAYS is optional. If not set, the worker uses the default client relay set.

Other platforms:
- Download prebuilt release assets:
  - auditable-voting-worker-linux-arm64.tar.gz
  - auditable-voting-worker-linux-armv7.tar.gz
  - auditable-voting-worker-windows-x64.zip
  - auditable-voting-worker-macos-arm64.tar.gz
- Or build from source in /worker:
  cd worker
  cargo build --release

Delegated worker responsibilities:
- announce worker status to coordinator
- process delegated blind-token requests
- issue blind-signature responses for delegated elections
- verify public submissions and publish delegated decisions
- optionally auto-publish result summary when all expected invitees have responded
