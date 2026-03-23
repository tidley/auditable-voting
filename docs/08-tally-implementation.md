# Tally Implementation Plan

## Overview

Implement the final tally announcement pipeline: the coordinator publishes kind 38003 (Final Result) after an election closes, along with supporting commitment roots (38005, 38006, 38007) and an inclusion proof endpoint so voter dashboards can verify individual votes.

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `max_supply` source | `len(eligible_set)` | One proof per eligible voter — no extra config needed |
| Issuance tree leaves | `SHA256(voter_npub_hex)` | Tracks which npubs claimed proofs without mapping proofs to recipients (preserves privacy) |
| Auto-close | Yes — background timer checks `end_time` from kind 38008 | Election already has a defined end time; manual close also available via `POST /close` |
| Issuance commitment (38005) | Track issued npubs, not proof secrets | Coordinator never sees proof secrets (voter mints directly from mint). Leaves are `SHA256(npub)` for each voter who claimed a proof. |

### Trust Trade-off

Issuance commitments are `SHA256(npub)` while spent commitments are `SHA256(proof_secret)` — different domains. This means the strict subset proof property (`spent ⊆ issued` at the individual proof level) is lost. We retain:
- Verifiable `total_issued <= max_supply` (count of issued npubs)
- Verifiable `total_spent <= total_issued` (count comparison)
- Public proof of exactly which npubs received proofs

---

## Architecture

### Merkle Tree Hierarchy

```
IssuanceCommitmentTree          SpentCommitmentTree          VoteMerkleTree
(leaves = SHA256(npub_hex))     (leaves = SHA256(secret))    (leaves = SHA256(event_id||pubkey||responses||ts))
         |                                |                              |
         v                                v                              v
    kind 38005                      kind 38006                    kind 38003
  (issuance root)                (spent root)              (vote root + results)
         |                                |                              |
         +--------------------------------+------------------------------+
                                          |
                                          v
                                     Voter Dashboard
                                   (results + inclusion proof)
```

### Shared MerkleTree Base Class

`SpentCommitmentTree`, `VoteMerkleTree`, and `IssuanceCommitmentTree` all use the same algorithm. Extract a `MerkleTree` base class:

```python
class MerkleTree:
    def __init__(self):
        self._leaves: list[str] = []        # sorted leaf hashes
        self._layers: list[list[str]] = []   # cached tree layers for proof extraction

    def insert(self, leaf_hash: str) -> None: ...
    def bulk_load(self, leaf_hashes: list[str]) -> None: ...
    def get_root(self) -> str | None: ...
    def get_count(self) -> int: ...
    def get_proof(self, leaf_hash: str) -> dict | None: ...
    def _rebuild_layers(self) -> None: ...
```

Subclasses parameterize leaf encoding:

| Class | Leaf encoding |
|---|---|
| `SpentCommitmentTree` | `SHA256(proof_secret)` (unchanged from current) |
| `IssuanceCommitmentTree` | `SHA256(voter_npub_hex)` |
| `VoteMerkleTree` | `SHA256(event_id \|\| pubkey \|\| canonical_json(responses) \|\| str(timestamp))` |

### Event Publishing Order

On election close, the coordinator publishes in this order:

1. **Kind 38005** — Issuance commitment root (commits to which npubs received proofs)
2. **Kind 38006** — Spent commitment root (commits to which proofs were burned)
3. **Kind 38003** — Final result (includes vote Merkle root, results, both commitment roots, max_supply)

All three reference the same `election_id`.

### Auto-Close Flow

```
Coordinator startup
  |
  +-- recover_state_from_relay() [fetch 38000/02/03/05/06/07/08/09/10/11]
  |
  +-- check: election exists AND end_time < now AND no 38003 published?
  |     |
  |     +-- YES → call close_election()
  |     +-- NO  → skip
  |
  +-- start background asyncio task:
        every 60s: same check
        stop after 38003 is published
```

`POST /close` provides a manual trigger (useful for testing, elections with no end_time, or operator override).

---

## New Event Specs

### Kind 38007 — Election Hard Cap Declaration

Published at election announcement time (alongside kind 38008).

```
kind: 38007
pubkey: <coordinator_npub>
content: {
  "election_id": "<38008_event_id>",
  "max_supply": 4,
  "start_time": 1710000000,
  "end_time": 1710003600
}
tags:
  - ["election", "<election_id>"]
```

`max_supply` is derived from `len(eligible_set)` — one proof per eligible voter.

### Kind 38005 — Issuance Commitment Root

Published at election close.

```
kind: 38005
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "issuance_commitment_root": "<hex>",
  "total_issued": 4
}
tags:
  - ["election", "<election_id>"]
```

Leaves = `SHA256(npub_hex)` for each npub in `issued_set`.

### Kind 38006 — Spent Commitment Root

Published at election close.

```
kind: 38006
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "spent_commitment_root": "<hex>",
  "total_spent": 3
}
tags:
  - ["election", "<election_id>"]
```

Leaves = `SHA256(proof_secret)` from burned proofs (already tracked in `SpentCommitmentTree`).

### Kind 38003 — Final Result

Published last, at election close.

```
kind: 38003
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "total_votes": 3,
  "results": {
    "q1": {"Alice": 2, "Bob": 1},
    "q3": {"mean": 7.5, "median": 7, "count": 3},
    "q4": ["Great work!", "Needs improvement"]
  },
  "merkle_root": "<hex>",
  "total_proofs_burned": 3,
  "issuance_commitment_root": "<hex>",
  "spent_commitment_root": "<hex>",
  "max_supply": 4
}
tags:
  - ["election", "<election_id>"]
```

Response types:
- `choice` (single): per-option counts
- `choice` (multiple): per-option counts (approval voting)
- `scale`: `{mean, median, count}`
- `text`: verbatim array of all responses (not tallied)

---

## New HTTP Endpoints

### `POST /close`

Triggers the tally pipeline manually. Also triggered automatically by the auto-close timer.

Request: no body required.

Response (200):
```json
{
  "status": "closed",
  "event_id": "<38003_event_id>",
  "total_votes": 3,
  "merkle_root": "<hex>"
}
```

Errors:
- 400: election not announced yet
- 400: election end_time has not passed
- 409: election already closed (returns existing 38003 data)

### `GET /result`

Serves the published kind 38003 from the EventStore. Read-only — this is what voter dashboards poll.

Response (200):
```json
{
  "election_id": "<election_id>",
  "total_votes": 3,
  "total_proofs_burned": 3,
  "results": {
    "q1": {"Alice": 2, "Bob": 1},
    "q3": {"mean": 7.5, "median": 7, "count": 3},
    "q4": ["Great work!", "Needs improvement"]
  },
  "merkle_root": "<hex>",
  "issuance_commitment_root": "<hex>",
  "spent_commitment_root": "<hex>",
  "max_supply": 4,
  "closed_at": 1710003600,
  "_trust": {
    "level": "authoritative",
    "note": "This is the final tally. Verify on Nostr relays using kind 38003 from coordinator pubkey.",
    "verify_nostr": {
      "kind": 38003,
      "filter": {"kinds": [38003], "authors": ["<coordinator_hex_pubkey>"], "#e": ["<election_id>"], "limit": 1},
      "relays": ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]
    }
  }
}
```

Response (404): election not closed yet.

### `GET /inclusion_proof?event_id=<hex>`

Returns a Merkle inclusion proof for a specific vote event. Only available after the election is closed (kind 38003 published).

Response (200):
```json
{
  "nostr_event_id": "<hex>",
  "leaf_hash": "<hex>",
  "merkle_path": [
    {"position": "left", "hash": "<hex>"},
    {"position": "right", "hash": "<hex>"}
  ],
  "merkle_root": "<hex>"
}
```

Errors:
- 404: event_id not found in the vote Merkle tree
- 404: election not yet closed

### Updated `GET /tally`

No structural changes. Currently returns an "unofficial" live preview. After 38003 is published, the `_trust.authoritative_tally` section already tells voters to look for kind 38003. No code change needed — voters should use `GET /result` for the final tally.

---

## Implementation Phases

### Phase 1 — Merkle Tree Foundation

Refactor the existing `SpentCommitmentTree` to support inclusion proofs, and add new tree classes.

**New code:**

| Item | Location | Lines (est.) |
|---|---|---|
| `canonical_json(obj) -> str` | Top of coordinator script | ~3 |
| `MerkleTree` class (base) | After `SpentCommitmentTree` | ~80 |
| `VoteMerkleTree` class | After `MerkleTree` | ~30 |
| `IssuanceCommitmentTree` class | After `VoteMerkleTree` | ~20 |
| Refactor `SpentCommitmentTree` to use `MerkleTree` | Replace current impl | ~15 |
| `EventStore.get_accepted_vote_events(election_id)` | New method | ~10 |
| `EventStore.get_final_result(election_id)` | New method | ~5 |

### Phase 2 — Publishing Functions

**New code:**

| Item | Location | Lines (est.) |
|---|---|---|
| `_publish_38007(nostr_client, election_id, max_supply, start_time, end_time)` | After `_publish_38011` | ~15 |
| `_publish_38005(nostr_client, election_id, issuance_tree)` | After `_publish_38007` | ~15 |
| `_publish_38006(nostr_client, election_id, spent_tree)` | After `_publish_38005` | ~15 |
| `_publish_38003(nostr_client, election_id, results, vote_tree, spent_tree, issuance_tree, max_supply)` | After `_publish_38006` | ~25 |

### Phase 3 — Tally Pipeline + Auto-Close

**New code:**

| Item | Location | Lines (est.) |
|---|---|---|
| `close_election(event_store, spent_tree, issuance_tree, nostr_client, eligible_set)` | New function | ~40 |
| `_auto_close_loop(event_store, spent_tree, issuance_tree, nostr_client, eligible_set)` | Async background task | ~25 |
| Enhanced `_compute_results(vote_events, election_config)` | Modify existing, add `election_config` param | ~20 |
| `POST /close` handler | In `make_http_handler` | ~20 |
| `GET /result` handler | In `make_http_handler` | ~25 |

### Phase 4 — Inclusion Proof Endpoint

**New code:**

| Item | Location | Lines (est.) |
|---|---|---|
| `GET /inclusion_proof?event_id=<hex>` handler | In `make_http_handler` | ~25 |

### Phase 5 — State Recovery

**Modified code:**

| Item | Location | Lines (est.) |
|---|---|---|
| Update `CoordinatorHandler.handle()` allowed kinds | Add 38003/38005/38006/38007 | ~2 |
| Update `recover_state_from_relay` fetch filter | Add 38003/38005/38006/38007 | ~2 |
| Rebuild trees from historical events on recovery | In `recover_state_from_relay` | ~15 |

---

## Test Plan

### New file: `tests/test_merkle_trees.py` (unit, no VPS needed)

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_canonical_json_deterministic` | Two calls with same object produce identical string |
| 2 | `test_canonical_json_sorted_keys` | Keys appear in sorted order in output |
| 3 | `test_canonical_json_no_whitespace` | No spaces after `:` or `,` |
| 4 | `test_canonical_json_nested` | Handles nested dicts and arrays correctly |
| 5 | `test_merkle_tree_single_leaf` | Root == leaf hash |
| 6 | `test_merkle_tree_two_leaves` | Root == SHA256(leaf0 \|\| leaf1) |
| 7 | `test_merkle_tree_odd_count` | 3 leaves: last duplicated, root matches manual calculation |
| 8 | `test_merkle_tree_get_proof_valid` | Returns `{leaf_hash, merkle_path, merkle_root}` with correct path length |
| 9 | `test_merkle_tree_get_proof_missing` | Returns `None` for non-existent leaf |
| 10 | `test_merkle_tree_get_proof_verifies` | Walking the path from leaf_hash reproduces merkle_root |
| 11 | `test_merkle_tree_bulk_load` | `bulk_load([a,b,c])` same root as three `insert()` calls |
| 12 | `test_merkle_tree_deduplication` | Inserting same leaf twice doesn't duplicate |
| 13 | `test_merkle_tree_get_count` | Returns unique leaf count |
| 14 | `test_merkle_tree_empty` | `get_root()` returns `None`, `get_count()` returns 0 |
| 15 | `test_vote_merkle_tree_leaf_encoding` | Leaf = SHA256(event_id \|\| pubkey \|\| canonical_json(responses) \|\| timestamp) |
| 16 | `test_vote_merkle_tree_ordering` | Leaves sorted by event_id, not insertion order |
| 17 | `test_issuance_merkle_tree_leaf_encoding` | Leaf = SHA256(npub_hex) |
| 18 | `test_spent_commitment_tree_uses_merkle_tree` | Refactored SpentCommitmentTree still produces correct roots |
| 19 | `test_compute_results_with_text_question` | Text responses collected into verbatim list, not tallied |
| 20 | `test_compute_results_with_mixed_questions` | Choice tallied, numeric has mean/median/count, text verbatim |
| 21 | `test_compute_results_empty_votes` | Empty list returns empty dict |
| 22 | `test_inclusion_proof_handler_returns_404_before_close` | Mock request to /inclusion_proof with no 38003 returns 404 |
| 23 | `test_inclusion_proof_handler_returns_proof_after_close` | Mock request with VoteMerkleTree populated returns 200 with valid proof |

### New file: `tests/test_publish_tally_events.py` (unit, mocked nostr_client)

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_publish_38007_content` | Kind=38007, content has `election_id`, `max_supply`, `start_time`, `end_time`, tag |
| 2 | `test_publish_38005_content` | Kind=38005, content has `issuance_commitment_root`, `total_issued`, tag |
| 3 | `test_publish_38006_content` | Kind=38006, content has `spent_commitment_root`, `total_spent`, tag |
| 4 | `test_publish_38003_content` | Kind=38003, content has all 8 required fields, tag |
| 5 | `test_publish_38003_results_format` | Results dict correct for choice and numeric questions |
| 6 | `test_publish_38003_text_questions_verbatim` | Text question responses appear verbatim, not tallied |
| 7 | `test_close_election_publishes_in_order` | 38005 called before 38006 called before 38003 |
| 8 | `test_close_election_skips_if_already_published` | Pre-populate EventStore with 38003, no new publish calls |
| 9 | `test_close_election_max_supply_from_eligible_set` | `max_supply` in 38003 == `len(eligible_set)` |

### Existing file: `tests/test_coordinator_persistence.py` (unit, no VPS)

| # | Test | What it verifies |
|---|---|---|
| 11 | `test_event_store_stores_38003` | EventStore accepts kind 38003 events |
| 12 | `test_event_store_get_final_result` | Returns most recent 38003, None if missing |
| 13 | `test_event_store_get_accepted_vote_events` | Returns only 38000 events with matching 38002 |

### Existing file: `tests/test_coordinator_e2e.py` (VPS E2E, ordered)

| # | Test | What it verifies |
|---|---|---|
| 19 | `test_announce_election` | Publish kind 38008 via nak. GET /election returns it. Verify kind 38007 also published (max_supply == len(eligible_set)). |
| 20 | `test_auto_close_after_end_time` | Announce election with `end_time` in the past. Wait for auto-close. Verify GET /result returns 38003 data. |
| 21 | `test_close_publishes_commitment_roots` | After close: query relay for 38005 and 38006. Verify roots match GET /result. |
| 22 | `test_close_idempotent` | POST /close twice. Second call returns existing 38003, does not re-publish. |
| 23 | `test_close_before_end_time_rejected` | Announce election with future end_time. POST /close returns 400. |
| 24 | `test_inclusion_proof_before_close` | GET /inclusion_proof returns 404 before election is closed. |
| 25 | `test_inclusion_proof_after_close` | After close: GET /inclusion_proof returns 200 with valid proof. |
| 26 | `test_inclusion_proof_invalid_event_id` | GET /inclusion_proof?event_id=deadbeef returns 404. |
| 27 | `test_inclusion_proof_verifies` | Walk merkle_path from leaf_hash, verify produces merkle_root matching GET /result. |
| 28 | `test_inclusion_proof_survives_restart` | After close + restart: GET /result and GET /inclusion_proof still work. |

### Test Summary

| File | Type | New Tests | Requires VPS |
|---|---|---|---|
| `tests/test_merkle_trees.py` (new) | Unit | 23 | No |
| `tests/test_publish_tally_events.py` (new) | Unit (mocked) | 9 | No |
| `tests/test_coordinator_persistence.py` (existing) | Unit | 3 | No |
| `tests/test_coordinator_e2e.py` (existing) | VPS E2E | 10 | Yes |
| **Total new tests** | | **45** | |

---

## Implementation Order

1. `canonical_json` + `MerkleTree` base class + refactor `SpentCommitmentTree` -> unit tests (1-14, 18)
2. `VoteMerkleTree` + `IssuanceCommitmentTree` -> unit tests (15-17)
3. `EventStore` new methods -> unit tests (persistence 11-13)
4. `_publish_38003/05/06/07` -> unit tests (publish 1-6)
5. Enhanced `_compute_results` -> unit tests (merkle 19-21)
6. `close_election()` + `POST /close` + `GET /result` -> unit tests (publish 7-9) + E2E (19-23)
7. Auto-close loop -> E2E (20)
8. `GET /inclusion_proof` -> E2E (24-27) + unit (merkle 22-23)
9. State recovery updates -> E2E (28)

---

## Files Changed

| File | Type | Description |
|---|---|---|
| `scripts/voting-coordinator-client.py` | Modified | MerkleTree base, tree classes, publish functions, close_election, auto-close, HTTP endpoints, state recovery |
| `tests/test_merkle_trees.py` | New | 23 unit tests for Merkle trees, canonical_json, compute_results |
| `tests/test_publish_tally_events.py` | New | 9 unit tests for publish functions and close_election |
| `tests/test_coordinator_persistence.py` | Modified | 3 new EventStore tests |
| `tests/test_coordinator_e2e.py` | Modified | 10 new E2E tests |

No new dependencies. All implementable with `hashlib`, `json` (stdlib) + existing `nostr_sdk`, `aiohttp`.

---

## Voter Dashboard Integration

After this is implemented, the voter dashboard can:

1. **Fetch results:** `GET /result` -> display results table, totals, commitment roots
2. **Verify individual vote:** voter enters event_id -> `GET /inclusion_proof?event_id=...` -> display proof
3. **Client-side verification:**
   - Hash own vote fields -> compare to `leaf_hash`
   - Walk `merkle_path` -> verify produces `merkle_root`
   - Compare `merkle_root` to `/result`'s `merkle_root`
   - Green checkmark: "Your vote is included in the final tally"
