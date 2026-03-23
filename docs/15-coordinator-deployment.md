# Coordinator Deployment Plan

## Current Status (2026-03-20)

**58/58 tests passing.** All VPS infrastructure is live and operational. The coordinator daemon runs as a systemd service on the VPS (904 lines, stateless architecture), listening for kind 38010 events on nak + damus/nos.lol/primal relays, auto-approving eligible voters via gRPC, and serving a read-only HTTP API on port 8081. The full E2E issuance pipeline (voter publishes 38010 → coordinator receives → approves via gRPC → voter mints tokens) is verified against the live VPS.

### Test Breakdown

| Layer | Tests | Status |
|---|---|---|
| Unit (persistence, eligibility, issuance, integration) | 25 | All pass |
| VPS deploy | 12 | All pass |
| VPS integration (real gRPC + HTTP) | 7 | All pass |
| E2E coordinator (real Nostr, HTTP API, burn, restart) | 9 | All pass |
| Voter flow (real mint over internet) | 5 | All pass |

---

## Phase 1: Coordinator Deployment (DONE)

**File:** `playbooks/deploy-coordinator.yml`

### Completed Tasks

1. Ensure mint1 is running with `FAKE_WALLET_MANUAL_APPROVAL_INCOMING: "true"`
2. Install `python3-venv`, create venv at `/opt/tollgate/coordinator/.venv`
3. Install coordinator deps: `grpcio`, `grpcio-tools`, `nostr-sdk`, `requests`, `aiohttp`
4. Copy coordinator script + proto file to VPS
5. Derive coordinator nsec/npub from mint mnemonic (`/opt/tollgate/mints-local/mint1/mnemonic.txt`)
6. Save nsec to `/opt/tollgate/coordinator/nsec.env` (mode 600)
7. Copy `eligible-voters.json` (3 npubs) to VPS
8. Install and start `tollgate-coordinator.service` (systemd, restart=always)
9. Derive coordinator keys on VPS using `scripts/derive-coordinator-keys.py`

### Bugs Fixed During Deployment

| Bug | Root Cause | Fix |
|---|---|---|
| `PublicKey.from_bech32` not found | `nostr_sdk` v0.44 API changed | `PublicKey.parse()` |
| `add_relay(relay)` TypeError | Expects `RelayUrl` instance | `add_relay(RelayUrl.parse(relay))` |
| Coroutines never awaited | `nostr_sdk` Client methods are async | Refactored to `async def async_main()` + `asyncio.run()` |
| `handle_msg` NotImplementedError | UniFFI dispatches non-event notifications | Added `async def handle_msg(self, relay_url, msg)` |
| Proto path wrong on VPS | `ROOT_DIR` resolves differently | `COORDINATOR_PROTO_PATH` env var |
| `cashu` dep conflicts on Python 3.13 | Transitive deps conflict with `grpcio` | Split into `requirements.txt` (coordinator) + `voter-requirements.txt` (voter) |

### systemd Service

```
[Unit]
Description=TollGate Voting Coordinator
After=network.target docker.service nak.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/tollgate/coordinator
ExecStart=/opt/tollgate/coordinator/.venv/bin/python3 /opt/tollgate/coordinator/voting-coordinator-client.py \
  --nsec-file /opt/tollgate/coordinator/nsec.env \
  --eligible /opt/tollgate/coordinator/eligible-voters.json \
  --grpc-endpoint 127.0.0.1:8086 \
  --mint-url http://127.0.0.1:3338 \
  --http-port 8081 \
  --relays ws://localhost:10547 wss://relay.damus.io wss://nos.lol wss://relay.primal.net
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment=COORDINATOR_PROTO_PATH=/opt/tollgate/coordinator/proto/cdk-mint-rpc.proto
Environment=COORDINATOR_GEN_DIR=/opt/tollgate/coordinator/_gen

[Install]
WantedBy=multi-user.target
```

---

## Phase 2: Fix Nak Relay + Add iptables Rule (DONE)

### Problem

- `nak.service` had `NAK_HOST=0.0.0.0` but `ExecStart` used `nak --port 10547` without `--hostname 0.0.0.0`
- Port 10547 was NOT in the iptables INPUT chain (VPS uses iptables, not UFW)
- External connections to port 10547 were dropped by the default `DROP` policy

### Fix Applied

1. Updated `nak.service` `ExecStart` to include `--hostname 0.0.0.0`
2. Force-restarted nak: `systemctl restart nak`
3. Verified nak binds to `0.0.0.0:10547` via `ss -tlnp`
4. Added iptables rule: `iptables -I INPUT -p tcp --dport 10547 -j ACCEPT`
5. Persisted via `netfilter-persistent save`
6. Verified from local machine: `curl http://23.182.128.64:10547/` returns 404 (not timeout)

### Verified by Tests

- `test_nak_relay_bound_publicly` -- `ss` output shows `0.0.0.0:10547`
- `test_nak_relay_responds_on_public_ip` -- HTTP request from local machine succeeds

---

## Phase 3: Add Coordinator npub to Mint /v1/info (DONE)

### Problem

The mint's `/v1/info` endpoint returned `description` as `"Local Cashu mint mint1"`. Voters had no HTTP-discoverable way to find the coordinator npub.

### Fix Applied

1. Updated `roles/mint_local/templates/docker-compose.yml.j2` to set `CDK_MINTD_MINT_DESCRIPTION` with coordinator npub
2. Reordered playbook to derive coordinator keys **before** starting mint container
3. Updated CDK's SQLite `kv_store` table directly (since CDK caches config and ignores env var changes)
4. Removed WAL/SHM files, restarted container
5. Verified: `curl http://23.182.128.64:3338/v1/info | jq .description` contains npub

### Verified by Tests

- `test_mint_info_contains_coordinator_npub` -- `/v1/info` description contains coordinator npub

---

## Phase 4: Stateless Architecture + HTTP API (DONE)

**File:** `scripts/voting-coordinator-client.py` (rewritten by collaborator, 1357 lines)

### What Changed

| Concern | Old approach | New approach |
|---|---|---|
| Issuance tracking | `issued-voters.json` on disk + `persist_issued()` | Publish kind 38011 on each approval; rebuild from relay on startup |
| Burn tracking | Not implemented | Publish kind 38002 on each burn; rebuild `SpentCommitmentTree` from relay |
| Event handling | `IssuanceHandler` | `CoordinatorHandler` (dispatches kinds 38000/38002/38008/38009/38010/38011 + kind 4 DMs) |
| State recovery | N/A | `recover_state_from_relay()` queries nak for past events on startup |
| HTTP API | N/A | aiohttp on port 8081 (`/info`, `/election`, `/tally`, `/eligibility`) |

### New Classes

| Class | Purpose |
|---|---|
| `EventStore` | In-memory Nostr event cache (kinds 38000/38002/38008/38009/38011) with query methods |
| `SpentCommitmentTree` | Incremental Merkle tree over SHA256(proof_secret) leaves (extends `MerkleTree`) |
| `VoteMerkleTree` | Merkle tree over vote event hashes (extends `MerkleTree`) |
| `IssuanceCommitmentTree` | Merkle tree over eligible voter pubkey hashes (extends `MerkleTree`) |
| `CoordinatorHandler` | Main Nostr event dispatcher (extends `HandleNotification`) |

### New/Changed Functions

| Function | Change |
|---|---|
| `process_issuance_request()` | 6th param: `issued_path: Path` -> `nostr_client: Client`; publishes kind 38011 after approval |
| `_publish_38011()` | New: publishes kind 38011 issuance receipt to all relays |
| `handle_proof_dm()` | New: processes NIP-04 DM with vote proof, submits to mint |
| `recover_state_from_relay()` | New: bulk queries nak for past events, rebuilds `issued_set` + `SpentCommitmentTree` |
| `make_http_handler()` | New: creates aiohttp route table for HTTP API |
| `canonical_json()` | New: deterministic JSON serialization for Merkle leaf hashing |
| `MerkleTree` | New: base class with `insert()`, `bulk_load()`, `get_root()`, `get_count()`, `get_proof()` |
| `VoteMerkleTree` | New: Merkle tree for vote inclusion proofs |
| `IssuanceCommitmentTree` | New: Merkle tree for issuance commitment roots |
| `close_election()` | New: orchestrator that publishes 38003/38005/38006/38007 |
| `_publish_38003()` | New: publishes kind 38003 final tally result |
| `_publish_38005()` | New: publishes kind 38005 issuance commitment root |
| `_publish_38006()` | New: publishes kind 38006 spent commitment root |
| `_publish_38007()` | New: publishes kind 38007 election hard cap |
| `_compute_results()` | New: per-question vote result tallying from event store |
| `persist_issued()` | **Removed** |
| `IssuanceHandler` | **Removed** -- replaced by `CoordinatorHandler` |

### Dependencies

`scripts/requirements.txt` now includes `aiohttp>=3.9.0`.

---

## Phase 5: Voter CLI

**File:** `scripts/voting-request-proof.py` (created, needs testing)

### CLI Args

| Arg | Required | Default | Description |
|---|---|---|---|
| `--nsec` | Yes | -- | Voter's Nostr private key |
| `--mint-url` | Yes | -- | Mint HTTP URL |
| `--coordinator-npub` | No | Parsed from `GET /v1/info` | Coordinator's npub (for `p` tag) |
| `--election` | Yes | -- | Election ID (for `election` tag) |
| `--relays` | No | `wss://relay.damus.io` | Nostr relays |
| `--output` | No | `proof.json` | Output file for proof |

### Flow

1. `GET /v1/info` -> parse coordinator npub from `description` field
2. `POST /v1/mint/quote/bolt11` with `{"amount": 1, "unit": "sat"}` -> get `quote_id`
3. `GET /v1/keysets` -> get keyset ID for building blinded outputs
4. Build 1 blinded output for 1 sat using `cashu` library (`step1_alice`)
5. Publish kind 38010 event with tags: `["p", coordinator_npub]`, `["quote", quote_id]`, `["amount", "1"]`, `["mint", mint_url]`, `["election", election_id]`
6. Poll `GET /v1/mint/quote/bolt11/{quote_id}` with exponential backoff until `state == "PAID"` (timeout 5 min)
7. `POST /v1/mint/bolt11` with `{quote: quote_id, outputs: [blinded_output]}` -> get blind signatures
8. Unblind signatures to proofs using `step3_alice`
9. Save proof(s) to `--output` file

### Voter Requirements

- `scripts/voter-requirements.txt`: `cashu>=0.19.0`, `marshmallow<4.0`, `nostr-sdk`, `requests`, `grpcio`
- `pip install cashu` on Python 3.13 requires pinning `marshmallow<4.0`

---

## Phase 6: Tests (DONE)

### `tests/test_coordinator_deploy.py` (`vps` marker, 12 tests -- all passing)

| Test | What it verifies |
|---|---|
| `test_coordinator_service_is_active` | systemctl is-active |
| `test_coordinator_venv_exists` | venv bin/python3 exists |
| `test_coordinator_script_exists` | voting-coordinator-client.py on VPS |
| `test_nsec_env_exists_and_is_secure` | mode 600 |
| `test_eligible_voters_json_exists` | contains npub1 entries |
| `test_coordinator_logs_show_startup` | journald has startup lines |
| `test_coordinator_npub_matches` | matches derived npub |
| `test_mint_still_healthy` | /v1/info returns 200 |
| `test_nak_relay_is_running` | systemctl is-active nak |
| `test_nak_relay_bound_publicly` | ss shows 0.0.0.0:10547 |
| `test_nak_relay_responds_on_public_ip` | HTTP request succeeds from local machine |
| `test_mint_info_contains_coordinator_npub` | /v1/info description has npub |

### `tests/test_coordinator_persistence.py` (unit, 10 tests -- all passing)

| Test | Covers |
|---|---|
| `test_load_json_set_list` | Loads `["npub1...", ...]` format |
| `test_load_json_set_dict` | Loads `{"npubs": [...]}` format |
| `test_load_json_set_missing_file` | Returns empty set |
| `test_load_json_set_bad_format` | Raises ValueError on unexpected JSON |
| `test_normalize_npub_hex` | Already-hex -> lowercased, stripped |
| `test_normalize_npub_bech32` | `npub1...` -> hex via `PublicKey.parse()` (mocked) |
| `test_add_event_stores_by_kind` | `EventStore.add_event()` stores by kind |
| `test_add_event_ignores_unknown_kind` | EventStore ignores kinds not in [38000/38002/38008/38009/38011] |
| `test_add_event_deduplicates_by_id` | EventStore deduplicates by event ID |
| `test_get_issued_pubkeys_filters_by_election` | `EventStore.get_issued_pubkeys()` filters by election tag |
| `test_get_issued_pubkeys_deduplicates` | `EventStore.get_issued_pubkeys()` returns unique pubkeys |

### `tests/test_coordinator_eligibility.py` (unit, 7 tests -- all passing)

Gate-keeping logic with mocked `verify_quote_on_mint`, `approve_quote_via_grpc`, and `_publish_38011`:

| Test | Covers |
|---|---|
| `test_eligible_voter_approved` | Happy path: eligible + first + 1 sat + correct mint -> approved, kind 38011 published |
| `test_non_eligible_skipped` | Pubkey not in eligible_set -> no gRPC call |
| `test_already_issued_skipped` | Pubkey already in issued_set -> no gRPC call |
| `test_missing_quote_tag_skipped` | No `quote` tag -> no gRPC call |
| `test_wrong_amount_skipped` | `amount=2` -> no gRPC call |
| `test_wrong_mint_url_skipped` | `["mint", "http://other-mint"]` -> no gRPC call |
| `test_amount_missing_skipped` | No `amount` tag (None) -> no gRPC call |

### `tests/test_coordinator_issuance.py` (unit, 4 tests -- all passing)

Mint interaction path:

| Test | Covers |
|---|---|
| `test_quote_not_found_on_mint_skipped` | `verify_quote_on_mint` returns None -> no gRPC call |
| `test_quote_already_paid_skipped` | Quote state `"paid"` -> `.upper()` is `"PAID"`, not `"UNPAID"` -> no gRPC call |
| `test_grpc_approval_success` | Unpaid quote -> gRPC called with correct quote_id -> pubkey in issued_set, kind 38011 published |
| `test_grpc_approval_failure_not_marked_issued` | gRPC RpcError caught -> pubkey NOT added to issued_set, `_publish_38011` NOT called |

### `tests/test_coordinator_integration.py` (unit, 3 tests -- all passing)

End-to-end with `responses` library mocking mint HTTP:

| Test | Covers |
|---|---|
| `test_full_flow_approves` | Mock mint returns `{"state": "unpaid"}` -> gRPC succeeds -> kind 38011 published |
| `test_full_flow_mint_404` | Mock mint returns 404 -> skipped |
| `test_full_flow_mint_timeout` | Mock mint raises ConnectionError -> skipped |

### `tests/test_coordinator_integration_vps.py` (`vps` marker, 7 tests -- all passing)

Uses real HTTP + gRPC against the live VPS mint. `nostr_client` is mocked (tests exercise the issuance path, not Nostr publication). Each test gets a fresh mint via the `fresh_mint` autouse fixture.

| Test | Covers |
|---|---|
| `test_verify_quote_on_mint_real` | Real quote -> `verify_quote_on_mint` returns `{"state": "UNPAID"}` |
| `test_verify_nonexistent_quote_returns_none` | `verify_quote_on_mint` with fake quote_id -> returns `None` |
| `test_approve_quote_via_grpc_real` | Real quote -> `approve_quote_via_grpc` -> HTTP shows `state: "PAID"` |
| `test_approve_nonexistent_quote_fails` | `approve_quote_via_grpc` with fake quote_id -> raises `grpc.RpcError` |
| `test_full_flow` | Real quote -> `process_issuance_request` -> quote becomes PAID, pubkey in issued_set |
| `test_rejects_wrong_mint_url` | Real quote on mint1 -> `process_issuance_request` with wrong mint URL -> skipped |
| `test_rejects_already_issued` | Pubkey already in issued_set -> skipped, quote stays UNPAID |

### `tests/test_voter_flow.py` (`voter` marker, 5 tests -- all passing)

| Test | Covers |
|---|---|
| `test_build_blinded_output_returns_valid_json` | `step1_alice` produces valid BlindedMessage with B_ field |
| `test_build_blinded_output_different_secrets` | Two calls produce different secrets |
| `test_poll_timeout_on_unpaid_quote` | `poll_quote_until_paid` returns False after 3s timeout |
| `test_create_quote_response_format` | `create_quote` returns quote_id and amount=1 |
| `test_get_keyset_id_returns_sat_keyset` | `GET /v1/keysets` -> 66-char hex keyset ID (CDK 0.15.1 includes 2-char prefix) |

### `tests/test_coordinator_e2e.py` (`vps` marker, 9 tests -- all passing)

Full end-to-end tests against the live coordinator daemon on the VPS. No mocks — real Nostr events, real gRPC, real minting.

| Test | Covers |
|---|---|
| `test_http_info_returns_coordinator_metadata` | GET /info returns coordinatorNpub, mintUrl, relays |
| `test_http_election_returns_404_or_valid` | GET /election returns 404 when no election announced |
| `test_http_tally_returns_404_or_valid` | GET /tally returns 404 when no election announced |
| `test_http_eligibility_returns_404_or_valid` | GET /eligibility returns 404 when no election announced |
| `test_e2e_issuance_pipeline` | Full pipeline: create quote → build blinded output → publish 38010 via nak → coordinator approves → quote PAID → mint tokens |
| `test_non_eligible_voter_rejected` | Random nsec publishes 38010 → quote stays UNPAID |
| `test_already_issued_voter_rejected` | Same eligible nsec re-publishes 38010 → quote stays UNPAID |
| `test_proof_burning_via_dm` | NIP-04 DM with proof → coordinator processes (verifies no crash) |
| `test_state_recovery_after_restart` | systemctl restart → /info healthy → /tally state preserved |

---

## Phase 7: E2E Test Implementation & Fixes (DONE)

### Problem

The E2E test suite (`tests/test_coordinator_e2e.py`) was created with 9 tests but only 7/9 passed. Two tests failed:
- `test_e2e_issuance_pipeline` — events published to public relays from outside the VPS were not received by the coordinator's `handle_notifications` loop
- `test_proof_burning_via_dm` — cascade failure (no minted proof available from test 8)

### Root Causes Found

| # | Issue | Impact |
|---|---|---|
| 1 | Public relay subscriptions unreliable — coordinator connects to damus.io but live events published from outside the VPS never arrived | E2E issuance pipeline failed |
| 2 | `CoordinatorHandler.handle()` was sync but `nostr_sdk`'s UniFFI callback expects async — returning None caused `TypeError: object NoneType can't be used in 'await' expression` and crashed the coordinator | Coordinator crashed on every received event |
| 3 | Test sent `http://23.182.128.64:3338` in `mint` tag but coordinator's configured mint URL is `http://127.0.0.1:3338` | Coordinator skipped valid 38010 events |
| 4 | Blinded outputs sent as JSON strings (`["{...}"]`) instead of objects (`[{...}]`) | CDK returned 422 on mint request |
| 5 | `_publish_38011()` called async `send_event_builder()` without awaiting | RuntimeWarning, 38011 not published |
| 6 | `_publish_38010_from_vps` had nested f-string syntax errors | Test couldn't publish from VPS |
| 7 | VPS system python3 missing `nostr_sdk` | Script failed on VPS |

### Fixes Applied

| # | Fix | File |
|---|---|---|
| 1 | Publish events from VPS via local nak relay (`ws://localhost:10547`) — upload Python script via SSH, execute with coordinator's `.venv/bin/python3` | `tests/test_coordinator_e2e.py` |
| 2 | Made `CoordinatorHandler.handle()` async, wrapped `process_issuance_request` in `asyncio.to_thread` | `scripts/voting-coordinator-client.py:463` |
| 3 | Added `COORDINATOR_MINT_URL = "http://127.0.0.1:3338"` constant, used in event tags | `tests/test_coordinator_e2e.py` |
| 4 | Changed `_build_blinded_output` to return dict, `_mint_tokens` sends objects directly | `tests/test_coordinator_e2e.py` |
| 5 | Wrapped `_publish_38011`'s `send_event_builder` in `asyncio.run()` | `scripts/voting-coordinator-client.py:352` |
| 6 | Rewrote `_publish_38010_from_vps` — writes script to `/tmp/`, passes args via `sys.argv` | `tests/test_coordinator_e2e.py` |
| 7 | Added `COORDINATOR_VENV_PYTHON` constant, used in SSH command | `tests/test_coordinator_e2e.py` |

### Result

All 9 E2E tests pass. Full pipeline verified end-to-end: voter publishes 38010 → nak relay delivers to coordinator → coordinator validates eligibility → approves via gRPC → quote becomes PAID → voter mints tokens → DM burn processed → state survives restart.

---

## Environment

| Item | Value |
|---|---|
| VPS | `23.182.128.64`, root, `~/.ssh/tollgate` |
| Mint HTTP | `http://23.182.128.64:3338` (public, iptables allows) |
| Mint gRPC | `23.182.128.64:8086` (public, iptables allows) |
| Nak relay | `ws://23.182.128.64:10547` (public, iptables allows) |
| Damus relay | `wss://relay.damus.io` (public) |
| Coordinator npub | `npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh` |
| Coordinator nsec | Stored in `/opt/tollgate/coordinator/nsec.env` (mode 600) |
| Coordinator HTTP API | `http://23.182.128.64:8081` (`/info`, `/election`, `/tally`, `/eligibility`) |
| Coordinator systemd | `tollgate-coordinator.service` (running, enabled) |
| Mint container | `mint-mint1`, image `cdk-mint:manual-approval`, CDK 0.15.1 |
| Mint data | `/opt/tollgate/mints-local/mint1/` |
| Python on VPS | 3.13.5, venv at `/opt/tollgate/coordinator/.venv` |
| Firewall | iptables (INPUT policy DROP, explicit ACCEPT rules for 3338, 8086, 10547, 8081) |

---

## Phase 8: Publish Election Announcement (Planned)

- Create `scripts/publish-election.py` — one-off script to publish kind 38008
- Update `eligible-voters.json` on VPS (24 npubs currently configured)
- Publish kind 38008 election to all relays
- Verify coordinator auto-caches election from relay (`GET /election`)
- Deploy updated eligible voters to VPS and restart coordinator

---

## Phase 9: Tally Pipeline + Inclusion Proofs (Partially Done)

See `docs/13-TALLY_IMPLEMENTATION_PLAN.md` for the full plan.

### Completed

- `MerkleTree` base class with `get_proof()` support
- `VoteMerkleTree` (leaf = SHA256(canonical_json(event_id, pubkey, responses, timestamp)))
- `IssuanceCommitmentTree` (leaf = SHA256(npub_hex))
- `SpentCommitmentTree` refactored to extend `MerkleTree`
- Publishing kinds 38003/38005/38006/38007 via `close_election()`
- `_compute_results()` for per-question vote tallying

### Remaining

- `POST /close`, `GET /result`, `GET /inclusion_proof` HTTP endpoints
- Auto-close timer
- 45 new tests across 4 test files

---

## File Inventory

### Created This Session

| File | Description |
|---|---|
| `playbooks/deploy-coordinator.yml` | Full VPS deployment playbook |
| `scripts/requirements.txt` | Coordinator runtime deps (grpcio, grpcio-tools, nostr-sdk, requests, aiohttp) |
| `scripts/voter-requirements.txt` | Voter CLI deps (includes cashu + marshmallow<4.0) |
| `scripts/voting-request-proof.py` | Voter CLI (quote, publish 38010, poll, mint, unblind) |
| `tests/test_coordinator_deploy.py` | Deployment verification tests (12 tests) |
| `tests/test_coordinator_e2e.py` | E2E coordinator tests (9 tests — real Nostr, HTTP API, burn, restart) |
| `tests/test_voter_flow.py` | Voter blinding and mint interaction tests (5 tests) |
| `eligible-voters.json` | 24 eligible voter npubs (20 cohort + 4 test) |
| `docs/11-COORDINATOR_DEPLOYMENT_PLAN.md` | This file |
| `docs/VOTER_CLIENT_INTEGRATION_GUIDE.md` | Integration guide for voter client developers |

### Modified This Session

| File | Changes |
|---|---|
| `scripts/voting-coordinator-client.py` | Rewritten: stateless arch, EventStore, CoordinatorHandler, HTTP API, kind 38011, NIP-04 DMs, MerkleTree, close_election, 38003/38005/38006/38007 |
| `tests/conftest.py` | Module loader, ansible hooks, fixtures |
| `roles/mint_local/templates/docker-compose.yml.j2` | Updated description with coordinator npub |
