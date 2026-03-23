# Integration Test Plan

## Overview

Three layers of tests orchestrated by a single `pytest tests/ -v` command. Unit tests run instantly with no setup. VPS and voter integration tests auto-trigger idempotent Ansible setup. All results persist to `test-results/latest.json`.

## Architecture

```
pytest tests/ -v
  |
  +-- conftest.py :: pytest_collection_finish
  |   +-- Any @pytest.mark.vps or @pytest.mark.voter tests collected?
  |   +-- yes -> ansible-playbook setup-pytest.yml (idempotent, local venv)
  |   +-- yes -> ansible-playbook run-integration-tests.yml --tags setup
  |            (idempotent, VPS mint ready + iptables 3338/8086/10547/8080)
  |
  +-- Unit tests (no marks)
  |   +-- Run immediately, no setup, no network
  |
  +-- VPS tests (@pytest.mark.vps)
  |   +-- conftest_vps.py :: ssh_tunnel (session-scoped)
  |   |   +-- ssh -L 18086:127.0.0.1:8086 root@23.182.128.64 -N
  |   +-- conftest_vps.py :: fresh_mint (autouse, per-test)
  |   |   +-- SSH -> docker compose down -> rm data -> docker compose up -> poll health
  |   +-- Tests: localhost:18086 (gRPC) + http://23.182.128.64:3338 (HTTP)
  |
  +-- Voter tests (@pytest.mark.voter)
  |   +-- Tests: http://23.182.128.64:3338 over public internet
  |
  +-- conftest.py :: pytest_sessionfinish
      +-- Persist test-results/latest.json
```

## Test Layers

| Layer | Marker | Runs on | What it tests | Network |
|---|---|---|---|---|
| Unit | (none) | Local | Pure logic, mocked HTTP/gRPC/Nostr | None |
| Coordinator (VPS) | `@pytest.mark.vps` | Local, via SSH tunnel | Real HTTP + gRPC against live mint, mocked Nostr | SSH tunnel for gRPC, public HTTP |
| E2E Coordinator (VPS) | `@pytest.mark.vps` | Local, via public relay | Real Nostr events, real coordinator daemon, HTTP API, burn, restart | Public relay + public HTTP |
| Voter (local) | `@pytest.mark.voter` | Local | Voter-to-mint HTTP flow over internet | Public internet |

## Selective Execution

```bash
# Everything (unit + VPS + voter)
pytest tests/ -v

# Unit tests only (fast, no network, no VPS, no ansible)
pytest tests/ -v -m "not vps and not voter"

# VPS integration tests only
pytest tests/ -v -m "vps"

# Voter flow tests only
pytest tests/ -v -m "voter"
```

Unit-only runs skip all ansible and network calls entirely.

## Ansible Idempotency

### `setup-pytest.yml` (local venv)

| Task | Idempotency |
|---|---|
| Create venv | `creates: .venv/bin/activate` -- skips if exists |
| pip install | pip is naturally idempotent -- skips if satisfied |

### `run-integration-tests.yml --tags setup` (VPS mint)

| Task | Tag | Idempotency |
|---|---|---|
| Check mint1 container running | setup | `docker ps` filter -- skip if running |
| Start mint1 if not running | setup | conditional on check above |
| Open iptables port 3338 | setup | `iptables -C INPUT` check -- skip if present |
| Install Python deps on VPS | setup | pip idempotent |

Per-test mint reset is intentionally NOT idempotent -- it runs every test.

### Smart Ansible Triggering

`pytest_collection_finish` checks if any VPS or voter tests are collected before running ansible:

```python
def pytest_collection_finish(session):
    has_remote_tests = any(
        item.get_closest_marker("vps") or item.get_closest_marker("voter")
        for item in session.items
    )
    if not has_remote_tests:
        return
    subprocess.run(["ansible-playbook", "playbooks/setup-pytest.yml"], check=True)
    subprocess.run([
        "ansible-playbook", "playbooks/run-integration-tests.yml", "--tags", "setup"
    ], check=True)
```

## Mint State Isolation

Per-test reset for VPS tests. Each test gets a clean mint database.

### Reset mechanism (via SSH)

1. `docker compose down` in `/opt/tollgate/mints-local/mint1/`
2. Delete all files except `docker-compose.yml` and `mnemonic.txt`
3. `docker compose up -d`
4. Poll `http://23.182.128.64:3338/v1/info` until HTTP 200

**Overhead:** ~3s per test (container restart + health poll).

**What is preserved between resets:**
- `mnemonic.txt` -- mint always derives the same keys, tests don't need to re-discover keysets
- `docker-compose.yml` -- container config never changes

**What is wiped:**
- SQLite database(s) -- quotes, proofs, keysets, all issuance state

## SSH Tunnel (gRPC access)

gRPC port 8086 is accessible on the public IP but an SSH tunnel is used for reliable local access:

```python
@pytest.fixture(scope="session")
def ssh_tunnel():
    proc = subprocess.Popen([
        "ssh", "-o", "StrictHostKeyChecking=no",
        "-L", "18086:127.0.0.1:8086", "-N", "root@23.182.128.64"
    ])
    time.sleep(2)
    yield
    proc.terminate()
    proc.wait()
```

Tests connect to `localhost:18086` for gRPC, `http://23.182.128.64:3338` for HTTP.

## Conftest Structure

| File | Scope | Purpose |
|---|---|---|
| `tests/conftest.py` | All tests | Session hooks (ansible setup/teardown), module loader, shared fixtures |
| `tests/conftest_vps.py` | VPS tests | SSH tunnel, per-test mint reset, fresh quote, endpoints |
| `tests/conftest_voter.py` | Voter tests | Mint URL config (env var or default) |

## VPS-Side: Coordinator Integration Tests

### `tests/test_coordinator_integration_vps.py` (3 tests, `@pytest.mark.vps`)

Uses real HTTP + gRPC against the live VPS mint. No mocks for mint/gRPC. `nostr_client` is mocked (tests exercise the issuance path, not Nostr publication). Each test gets a fresh mint via the `fresh_mint` autouse fixture.

| Test | What it covers |
|---|---|
| `test_verify_quote_on_mint_real` | Create real quote via HTTP -> `verify_quote_on_mint` returns `{"state": "UNPAID"}` |
| `test_verify_nonexistent_quote_returns_none` | `verify_quote_on_mint` with fake quote_id -> returns `None` |
| `test_approve_quote_via_grpc_real` | Create real quote -> `approve_quote_via_grpc` -> HTTP shows `state: "PAID"` |
| `test_approve_nonexistent_quote_fails` | `approve_quote_via_grpc` with fake quote_id -> raises `grpc.RpcError` |
| `test_full_flow` | Real quote -> `process_issuance_request` -> quote becomes PAID, pubkey in issued_set |
| `test_rejects_wrong_mint_url` | Real quote on mint1 -> `process_issuance_request` with wrong mint URL -> skipped |
| `test_rejects_already_issued` | Pubkey already in issued_set -> skipped, quote stays UNPAID |

### `tests/test_coordinator_deploy.py` (12 tests, `@pytest.mark.vps`)

Deployment verification -- checks that all VPS services are running and correctly configured.

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
| `test_mint_info_contains_coordinator_npub` | /v1/info description has coordinator npub |

## Local-Side: Voter Integration Tests

### `tests/test_voter_flow.py` (5 tests, `@pytest.mark.voter`)

Simulates the voter-to-mint HTTP path over the public internet. Does not require the coordinator to be running.

| Test | What it covers |
|---|---|
| `test_build_blinded_output_returns_valid_json` | `step1_alice` produces valid BlindedMessage with B_ field |
| `test_build_blinded_output_different_secrets` | Two calls produce different secrets |
| `test_poll_timeout_on_unpaid_quote` | `poll_quote_until_paid` returns False after 3s timeout |
| `test_create_quote_response_format` | `create_quote` returns quote_id and amount=1 |
| `test_get_keyset_id_returns_sat_keyset` | `GET /v1/keysets` -> 66-char hex keyset ID (CDK 0.15.1 includes 2-char prefix) |

Voter tests cannot do per-test mint reset (no SSH/Docker access pattern in voter scope). They rely on creating fresh quotes which are naturally isolated. Quote TTL (~2h) cleans up stale quotes automatically.

Mint URL: configurable via env var `MINT_URL`, default `http://23.182.128.64:3338`.

## File Summary

| File | Type | Purpose |
|---|---|---|
| `playbooks/run-integration-tests.yml` | Ansible | Tagged setup/teardown, idempotent VPS mint preparation |
| `playbooks/deploy-coordinator.yml` | Ansible | Full coordinator deployment to VPS |
| `pytest.ini` | Config | Marker definitions for vps/voter |
| `tests/conftest.py` | Conftest | Session hooks, module loader, shared fixtures |
| `tests/conftest_vps.py` | Conftest | SSH tunnel, per-test mint reset, fresh quote, endpoints |
| `tests/conftest_voter.py` | Conftest | Mint URL config from env var |
| `tests/test_coordinator_persistence.py` | Unit | 10 tests: load_json_set, normalize_npub, EventStore |
| `tests/test_coordinator_eligibility.py` | Unit | 7 tests: gate-keeping logic |
| `tests/test_coordinator_issuance.py` | Unit | 4 tests: mint interaction path |
| `tests/test_coordinator_integration.py` | Unit | 3 tests: end-to-end with responses lib |
| `tests/test_coordinator_integration_vps.py` | VPS | 7 tests: real HTTP + gRPC, mocked Nostr |
| `tests/test_coordinator_deploy.py` | VPS | 12 tests: deployment verification |
| `tests/test_coordinator_e2e.py` | VPS | 9 tests: real Nostr E2E pipeline, HTTP API, burn, state recovery — **all passing** |
| `tests/test_voter_flow.py` | Voter | 5 tests: voter-to-mint flow |
| `tests/test_merkle_trees.py` | Unit | MerkleTree, VoteMerkleTree, IssuanceCommitmentTree, SpentCommitmentTree, canonical_json |
| `tests/test_publish_tally_events.py` | Unit | close_election, 38003/38005/38006/38007 publishing |

## Mock Coverage Gap

### What's NEVER tested for real

| Component | Status |
|---|---|
| Mint HTTP + gRPC | Well covered (unit + integration) |
| Deployment infrastructure | Well covered (12 integration tests) |
| Cashu blinding/minting | Covered (5 tests, 3 integration) |
| ~~Nostr event publishing~~ (kind 38010, 38011, 38002) | ~~Always mocked~~ **Covered** by E2E tests (publish via nak relay from VPS) |
| ~~Coordinator daemon end-to-end~~ (voter publishes 38010 → coordinator receives → approves → voter polls → mints) | **Covered** by `test_e2e_issuance_pipeline` |
| Proof burning / DM handling (`handle_proof_dm`) | **Covered** by `test_proof_burning_via_dm` (DM published, coordinator processes) |
| State recovery on restart (`recover_state_from_relay`) | **Covered** by `test_state_recovery_after_restart` |
| HTTP API (`/info`, `/election`, `/tally`, `/eligibility`) | **Covered** by E2E tests 1-4 |

### Remaining Gaps

| Component | Status |
|---|---|
| Multi-relay delivery (events propagated across damus/nos.lol/primal) | Not tested — E2E uses local nak only |
| Full vote flow (kind 38000 vote → kind 38002 acceptance → tally update) | Not tested — no election announced (kind 38008) yet |
| Burn proof verification (coordinator verifies proof against mint before accepting) | Partially tested — DM sent but no election announced so acceptance receipt not verified |
| Merkle tree inclusion proofs (`get_proof()`) | Unit tested in `test_merkle_trees.py`, not tested end-to-end |
| `close_election()` + kinds 38003/38005/38006/38007 publishing | Unit tested in `test_publish_tally_events.py`, not tested end-to-end |

---

## Test Results (2026-03-20)

### E2E Test Run — 9/9 PASSING

```
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_http_info_returns_coordinator_metadata PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_http_election_returns_404_or_valid PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_http_tally_returns_404_or_valid PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_http_eligibility_returns_404_or_valid PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_e2e_issuance_pipeline PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_non_eligible_voter_rejected PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_already_issued_voter_rejected PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_proof_burning_via_dm PASSED
tests/test_coordinator_e2e.py::TestCoordinatorE2E::test_state_recovery_after_restart PASSED
```

Total: 58 tests across all layers (25 unit + 12 deploy + 7 VPS integration + 9 E2E + 5 voter), all passing.
