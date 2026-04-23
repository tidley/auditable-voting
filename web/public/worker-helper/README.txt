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

Coordinator Build page launcher downloads:
- The Autoconfigured action on each platform row now saves a single launcher script.
- That launcher script includes the current coordinator npub, the effective relay list, and the generated worker nsec when present.
- On first run it downloads the matching raw binary asset automatically, then starts the worker.
- Right-click copy link works on the Autoconfigured action. The copied shareable URL intentionally omits WORKER_NSEC, so set your own worker secret before running it.
- The Build page `Advanced` block exposes the raw binary/checksum links and direct command-line launch snippet if you want to run the worker manually.

Other platforms:
- Download prebuilt release assets:
  - auditable-voting-worker-linux-arm64.tar.gz
  - auditable-voting-worker-linux-armv7.tar.gz
  - auditable-voting-worker-windows-x64.zip
  - auditable-voting-worker-macos-arm64.tar.gz
- Matching extracted executables use the same platform-specific names:
  - auditable-voting-worker-linux-arm64
  - auditable-voting-worker-linux-armv7
  - auditable-voting-worker-windows-x64.exe
  - auditable-voting-worker-macos-arm64
- Or build from source in /worker:
  cd worker
  cargo build --release

Delegated worker responsibilities:
- announce worker status to coordinator
- receive worker election-config state including the blind-signing key and questionnaire definition
- process delegated blind-token requests
- issue blind-signature responses for delegated elections, including the questionnaire definition when available
- verify public submissions and publish delegated decisions
- optionally auto-publish result summary when all expected invitees have responded
