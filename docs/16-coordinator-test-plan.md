# Voting Coordinator Test Plan

> **Note:** The event kind specs in `../auditable-voting/docs/` are outdated. The canonical protocol definitions live in this repo: `docs/04-VOTING_EVENT_INTEROP_NOTES.md` and `docs/03-PROTOCOL_REFERENCE.md`.

## Overview

Tests for `scripts/voting-coordinator-client.py` using pytest. All tests run without a real mint, relay, or gRPC server. The coordinator was rewritten with a stateless architecture (904 lines) -- see `docs/12-COORDINATOR_HTTP_API_PLAN.md` for the full design.

## Refactor: Pure Logic Extraction

`handle_event` (now `CoordinatorHandler.handle`) takes a `nostr_sdk.Event` (Rust FFI object), which is hard to mock. The pure logic layer is:

- `extract_event_data(event)` -- adapter: nostr_sdk Event -> plain dict
- `process_issuance_request(event_data, eligible_set, issued_set, grpc_endpoint, mint_url, nostr_client)` -- validate + approve + publish kind 38011

`CoordinatorHandler.handle()` is a thin wrapper that extracts event data, stores in EventStore, and dispatches to `process_issuance_request()`.

## Dependencies

```
tests/requirements.txt
pytest>=7.0
responses>=0.25.0
```

## File Structure

```
tests/
  conftest.py                          # Module loader, ansible hooks, shared fixtures
  conftest_vps.py                      # VPS connection constants, SSH tunnel, mint reset
  conftest_voter.py                    # Mint URL from env var
  test_coordinator_persistence.py      # load_json_set, normalize_npub, EventStore
  test_coordinator_eligibility.py      # Gate-keeping logic (mocked gRPC/mint)
  test_coordinator_issuance.py         # Mint interaction path (mocked gRPC/mint)
  test_coordinator_integration.py      # End-to-end with responses library
  test_coordinator_integration_vps.py  # Real VPS tests (SSH tunnel, live mint)
  test_coordinator_deploy.py           # Deployment verification (@pytest.mark.vps)
  test_voter_flow.py                   # Voter blinding/minting (@pytest.mark.voter)
  test_merkle_trees.py                 # MerkleTree, VoteMerkleTree, IssuanceCommitmentTree, SpentCommitmentTree
  test_publish_tally_events.py         # close_election, 38003/38005/38006/38007 publishing
```

## Fixtures (`tests/conftest.py`)

| Fixture | Scope | Description |
|---|---|---|
| `eligible_set` | function | `set[str]` of 3 known hex pubkeys |
| `issued_set` | function | Empty `set[str]`, mutated by `process_issuance_request()` |
| `event_data_factory` | function | Callable generating valid event dicts with overridable fields |
| `mock_nostr_client` | function | `MagicMock(spec=Client)` -- replaces old `tmp_issued_path` fixture |

**Removed fixture:** `tmp_issued_path` -- no longer needed since `persist_issued()` was removed and issuance is tracked via kind 38011 events on Nostr.

## Key API Changes (v2 -- Stateless Architecture)

The coordinator was rewritten from 368 to 1357 lines. Key API differences that affect tests:

| Item | Old (v1) | New (v2) |
|---|---|---|
| `process_issuance_request()` 6th param | `issued_path: Path` | `nostr_client: Client` |
| Issuance tracking | `persist_issued()` writes JSON file | Publishes kind 38011 to relays |
| Event handler | `IssuanceHandler` | `CoordinatorHandler` |
| State recovery | N/A | `recover_state_from_relay()` + `EventStore` |
| HTTP API | N/A | `aiohttp` on port 8081 (`/info`, `/election`, `/tally`, `/eligibility`) |

## Test Cases

**49/49 tests passing** across all layers (25 unit + 12 VPS deploy + 7 VPS integration + 5 voter).

### `tests/test_coordinator_persistence.py` -- 10 tests

Pure function tests, no mocking:

| Test | Covers |
|---|---|
| `test_load_json_set_list` | Loads `["npub1...", ...]` format |
| `test_load_json_set_dict` | Loads `{"npubs": [...]}` format |
| `test_load_json_set_missing_file` | Returns empty set |
| `test_load_json_set_bad_format` | Raises ValueError on unexpected JSON |
| `test_normalize_npub_hex` | Already-hex -> lowercased, stripped |
| `test_normalize_npub_bech32` | `npub1...` -> hex via `PublicKey.parse()` (mocked) |
| `test_add_event_stores_by_kind` | `EventStore.add_event()` stores by kind bucket |
| `test_add_event_ignores_unknown_kind` | EventStore ignores kinds not in [38000/38002/38008/38009/38011] |
| `test_add_event_deduplicates_by_id` | EventStore deduplicates by event ID within kind |
| `test_get_issued_pubkeys_filters_by_election` | `EventStore.get_issued_pubkeys()` filters by election tag (normalize_npub mocked) |
| `test_get_issued_pubkeys_deduplicates` | `EventStore.get_issued_pubkeys()` returns unique pubkeys |

**Removed tests** (3): `test_persist_issued_creates_file`, `test_persist_issued_sorted`, `test_persist_issued_creates_dirs` -- `persist_issued()` no longer exists.

### `tests/test_coordinator_eligibility.py` -- 7 tests

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

**Mock detail:** `verify_quote_on_mint` returns `{"state": "unpaid"}` which is `.upper()`'d to `"UNPAID"` by the coordinator at line 308, so the mock return value `"unpaid"` is correct.

### `tests/test_coordinator_issuance.py` -- 4 tests

Mint interaction path:

| Test | Covers |
|---|---|
| `test_quote_not_found_on_mint_skipped` | `verify_quote_on_mint` returns None -> no gRPC call |
| `test_quote_already_paid_skipped` | Quote state `"paid"` -> `.upper()` is `"PAID"`, not `"UNPAID"` -> no gRPC call |
| `test_grpc_approval_success` | Unpaid quote -> gRPC called with correct quote_id -> pubkey in issued_set, kind 38011 published |
| `test_grpc_approval_failure_not_marked_issued` | gRPC RpcError caught -> pubkey NOT added to issued_set, `_publish_38011` NOT called |

### `tests/test_coordinator_integration.py` -- 3 tests

End-to-end with `responses` library mocking mint HTTP:

| Test | Covers |
|---|---|
| `test_full_flow_approves` | Mock mint returns `{"state": "unpaid"}` -> gRPC succeeds -> kind 38011 published |
| `test_full_flow_mint_404` | Mock mint returns 404 -> skipped |
| `test_full_flow_mint_timeout` | Mock mint raises ConnectionError -> skipped |

### `tests/test_coordinator_integration_vps.py` -- 7 tests (VPS marker)

Uses real HTTP + gRPC against the live VPS mint. No mocks for mint/gRPC. `nostr_client` is mocked (the test only exercises the issuance path, not the Nostr publication step).

| Test | Covers |
|---|---|
| `test_verify_quote_on_mint_real` | Create real quote via HTTP -> `verify_quote_on_mint` returns `{"state": "UNPAID"}` |
| `test_verify_nonexistent_quote_returns_none` | `verify_quote_on_mint` with fake quote_id -> returns `None` |
| `test_approve_quote_via_grpc_real` | Create real quote -> `approve_quote_via_grpc` -> HTTP shows `state: "PAID"` |
| `test_approve_nonexistent_quote_fails` | `approve_quote_via_grpc` with fake quote_id -> raises `grpc.RpcError` |
| `test_full_flow` | Real quote -> `process_issuance_request` -> quote becomes PAID, pubkey in issued_set |
| `test_rejects_wrong_mint_url` | Wrong mint URL -> skipped |
| `test_rejects_already_issued` | Pubkey already in issued_set -> skipped, quote stays UNPAID |

### `tests/test_coordinator_deploy.py` -- 12 tests (VPS marker)

Deployment verification -- checks that all VPS services are running and correctly configured. All passing.

### `tests/test_voter_flow.py` -- 5 tests (Voter marker)

| Test | Covers |
|---|---|
| `test_build_blinded_output_returns_valid_json` | `step1_alice` produces valid BlindedMessage with B_ field |
| `test_build_blinded_output_different_secrets` | Two calls produce different secrets |
| `test_poll_timeout_on_unpaid_quote` | `poll_quote_until_paid` returns False after 3s timeout |
| `test_create_quote_response_format` | `create_quote` returns quote_id and amount=1 |
| `test_get_keyset_id_returns_sat_keyset` | `GET /v1/keysets` -> 66-char hex keyset ID (CDK 0.15.1 includes 2-char prefix) |

## Running Tests

```bash
pip install -r tests/requirements.txt

# Unit tests only (fast, no network)
pytest tests/ -v -m "not vps and not voter"

# VPS integration tests (requires SSH access)
pytest tests/ -v -m "vps"

# Voter flow tests (requires internet access to mint)
pytest tests/ -v -m "voter"

# Everything
pytest tests/ -v
```
