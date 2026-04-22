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
   WORKER_RELAYS=wss://relay1.example,wss://relay2.example \
   ./auditable-voting-worker-linux-x64

Other platforms:
- Build from source in /worker:
  cd worker
  cargo build --release

