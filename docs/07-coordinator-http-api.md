# Coordinator HTTP API + Stateless Architecture Plan

## Overview

Add HTTP convenience endpoints to the coordinator daemon so the voter client collaborator can query election state without running a full Nostr client. The HTTP API serves discovery and preview data; all authoritative trust anchors remain on Nostr as signed events.

This plan also transitions the coordinator to a fully stateless architecture -- all operational state is stored on the local nak relay as Nostr events, recovered on restart.

**Status: IMPLEMENTED** (2026-03-20). The coordinator script was rewritten to 904 lines with all features below. **58/58 tests passing** across all layers. See `13-TALLY_IMPLEMENTATION_PLAN.md` for the next phase (kind 38003, inclusion proofs, auto-close).

---

## Architecture: Stateless Coordinator

### Design Principle

The coordinator stores no persistent local state files. Instead, it publishes every state transition to Nostr and reconstructs its full state on startup by querying the local nak relay (`ws://localhost:10547`).

| Concern | Old approach | New approach |
|---|---|---|
| Issuance tracking (who got proofs) | `issued-voters.json` on disk | Publish kind 38011 on each approval; rebuild `issued_set` from relay on startup |
| Burn tracking (which proofs burned) | Not implemented | Publish kind 38002 on each burn; rebuild `SpentCommitmentTree` from relay on startup |
| Vote events (for /tally) | Not tracked | Mirror kind 38000 from relay into in-memory event store |
| Election config | Not tracked | Mirror kind 38008 from relay |
| Eligibility set | `eligible-voters.json` (input config) | Keep as input file; also mirrored from kind 38009 if published by coordinator |

Only `eligible-voters.json` remains as a local file -- it's configuration input, not operational state.

### Relays

Updated relay list:

| Relay | URL | Purpose |
|---|---|---|
| Local nak | `ws://localhost:10547` | State storage, event mirroring, primary subscription |
| Damus | `wss://relay.damus.io` | Public broadcast |
| nos.lol | `wss://nos.lol` | Public broadcast |
| Primal | `wss://relay.primal.net` | Public broadcast |

All events are published to all four relays. The local nak relay is the coordinator's database.

---

## Event Flow

### Issuance Phase (voter's real npub)

```
Voter (real npub)
  |
  +-- publish kind 38010 (quote_id, amount, election_id)
  |   tags: ["p", "<coordinator_npub>"], ["quote", ...], ["amount", "1"], ["mint", ...], ["election", ...]
  |
  +-- to relay --> Coordinator receives 38010
                      |
                      +-- check: pubkey in eligible_set?
                      +-- check: pubkey in issued_set? (from kind 38011 events on nak)
                      +-- check: amount == "1"?
                      +-- check: mint URL matches?
                      +-- check: quote exists on mint and is UNPAID?
                      |
                      +-- gRPC: UpdateNut04Quote(quote_id, state="PAID")
                      |
                      +-- publish kind 38011 (issuance approval receipt) --> all relays
```

### Voting + Burn Phase (voter's ephemeral npub)

```
Voter (ephemeral npub)
  |
  +-- publish kind 38000 (vote event, public)
  |   tags: ["election", "<election_id>"]
  |
  +-- encrypted NIP-04 DM --> Coordinator (full Cashu proof + vote_event_id)
                      |
                      +-- submit proof to mint via POST /v1/melt/bolt11
                      |
                      +-- mint responds: burned successfully
                      |   |
                      |   +-- compute commitment = SHA256(proof_secret)
                      |   +-- update SpentCommitmentTree (in memory)
                      |   +-- publish kind 38002 (acceptance receipt) --> all relays
                      |   +-- log success
                      |
                      +-- mint responds: rejected (already spent, invalid, etc.)
                          |
                          +-- log rejection (no Nostr event published)
```

---

## New Event Kind: 38011 -- Issuance Approval Receipt

Published by the coordinator each time it approves a kind 38010 issuance request. Replaces `issued-voters.json`.

```
kind: 38011
pubkey: <coordinator_npub>
content: {
  "election_id": "<38008_event_id>",
  "approved_npub": "<voter_hex_pubkey>",
  "quote_id": "<quote_id>",
  "amount": 1,
  "mint_url": "<mint_url>"
}
tags:
  - ["election", "<election_id>"]
  - ["p", "<voter_npub>"]
  - ["quote", "<quote_id>"]
```

On restart, the coordinator queries the local nak relay for all kind 38011 events tagged with the current election to rebuild `issued_set`.

---

## Updated Kind 38002 -- Vote Acceptance Receipt

Already defined in `03-PROTOCOL_REFERENCE.md`. Updated spec for coordinator-published version:

```
kind: 38002
pubkey: <coordinator_npub>
content: {
  "election_id": "<38008_event_id>",
  "vote_event_id": "<38000_event_id>",
  "proof_commitment": "<SHA256(proof_secret)>",
  "spent_count": 38
}
tags:
  - ["election", "<election_id>"]
  - ["e", "<vote_event_id>"]
  - ["commitment", "<SHA256(proof_secret)>"]
```

- `proof_commitment` -- SHA256 of the burned proof's secret. Used for spent commitment Merkle tree.
- `spent_count` -- running total of burned proofs for this election. Allows anyone to verify completeness.

---

## Startup State Recovery

On restart, the coordinator performs a single bulk query to the local nak relay:

```
Query nak relay for: kinds [38000, 38002, 38008, 38009, 38011]
Filter: election tag or author pubkey
```

Recovery steps:

1. **From 38011 events** -> rebuild `issued_set` (set of approved hex pubkeys)
2. **From 38002 events** -> rebuild `SpentCommitmentTree` (insert each `proof_commitment`)
3. **From 38000 events** -> populate vote event cache (for `/tally`)
4. **From 38008 events** -> election config (for `/election`)
5. **From 38009 events** -> eligibility set (for `/eligibility`)
6. Subscribe to live events for all five kinds
7. Ready. No local state files needed.

---

## HTTP Endpoints

All endpoints are served by an `aiohttp.web` server running in the same asyncio event loop as the Nostr listener. New CLI arg: `--http-port` (default `8080`, bound `0.0.0.0`). **Note:** Port 8080 conflicts with a docker-proxy on the VPS, so the coordinator runs on port 8081.

### `GET /info`

Static metadata. No relay query needed. Always returns 200.

```json
{
  "coordinatorNpub": "npub1...",
  "mintUrl": "http://127.0.0.1:3338",
  "mintPublicKey": "<hex_from_v1_info>",
  "relays": [
    "ws://localhost:10547",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net"
  ],
  "electionId": "<38008_event_id or null>",
  "_trust": {
    "level": "informational",
    "note": "Operational metadata. Verify coordinator identity on Nostr."
  }
}
```

### `GET /election`

Returns the coordinator's kind 38008 election announcement from the event store. Returns 404 if no election has been announced.

```json
{
  "election_id": "<38008_event_id>",
  "event_id": "<38008_event_id>",
  "title": "Community Governance Poll 2026",
  "description": "Annual governance election",
  "questions": [
    {
      "id": "q1",
      "type": "choice",
      "prompt": "Who should fill the open board seat?",
      "options": ["Alice", "Bob", "Carol"],
      "select": "single"
    }
  ],
  "start_time": 1710000000,
  "end_time": 1710003600,
  "mint_urls": ["http://mint-a.mints.23.182.128.64.sslip.io"],
  "created_at": 1710000000,
  "_trust": {
    "level": "cache",
    "warning": "This is a cached copy of the coordinator's kind 38008 Nostr event. It is NOT signed in this HTTP response. A compromised coordinator could serve a different election definition here.",
    "verify_nostr": {
      "kind": 38008,
      "filter": {
        "kinds": [38008],
        "authors": ["<coordinator_hex_pubkey>"],
        "limit": 1
      },
      "relays": [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net"
      ]
    }
  }
}
```

### `GET /tally`

Computed live from kind 38000 (published votes) and kind 38002 (acceptance receipts). Returns 404 if no election is active.

```json
{
  "election_id": "<38008_event_id>",
  "status": "in_progress",
  "total_published_votes": 42,
  "total_accepted_votes": 38,
  "spent_commitment_root": "<current merkle root of SHA256(proof_secret) leaves>",
  "results": {
    "q1": {"Alice": 25, "Bob": 17}
  },
  "_trust": {
    "level": "unofficial",
    "warning": "total_published_votes counts ALL kind 38000 events tagged with this election. total_accepted_votes counts only votes with a matching kind 38002 acceptance receipt from the coordinator (meaning the proof was successfully burned). Neither count is final or authoritative.",
    "authoritative_tally": {
      "note": "The final authoritative tally will be published as a signed Nostr event (kind 38003) by the coordinator after the election closes. It will include a Merkle root over accepted votes, an issuance commitment root (kind 38005), and a spent commitment root (kind 38006) for cryptographic verification.",
      "kind": 38003,
      "filter": {
        "kinds": [38003],
        "#e": ["<election_id>"]
      },
      "relays": [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net"
      ]
    }
  }
}
```

**Tally computation logic:**

- `total_published_votes` = count of kind 38000 events with `["election", "<election_id>"]`
- `total_accepted_votes` = count of kind 38000 events where a corresponding kind 38002 exists with `["e", "<vote_event_id>"]`
- `spent_commitment_root` = current Merkle root of the `SpentCommitmentTree` (built from all 38002 `proof_commitment` values)
- `results` = per-question counts computed from **accepted** votes only
- `status` = `"in_progress"` if current time < end_time, `"closed"` otherwise

If no kind 38002 events exist yet (no proofs burned), `total_accepted_votes` is `null`, `spent_commitment_root` is `null`, and `results` are computed from all published votes with an additional warning.

### `GET /eligibility`

Returns the coordinator's kind 38009 eligibility set commitment from the event store. Returns 404 if no eligibility set has been published.

```json
{
  "election_id": "<election_id>",
  "eligible_count": 3,
  "eligible_npubs": ["npub1...", "npub1...", "npub1..."],
  "eligible_root": null,
  "_trust": {
    "level": "cache",
    "warning": "This is a cached copy of the coordinator's kind 38009 Nostr event. Verify on Nostr relays.",
    "verify_nostr": {
      "kind": 38009,
      "filter": {
        "kinds": [38009],
        "#e": ["<election_id>"]
      },
      "relays": [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net"
      ]
    }
  }
}
```

---

## Nostr-Only (No HTTP Equivalent)

These data types are intentionally NOT exposed over HTTP because they are trust anchors. Serving them over HTTP would allow a compromised coordinator to deceive voters.

| Data | Event Kind | Actor | Why Nostr-only |
|---|---|---|---|
| Final tally + vote Merkle root | 38003 | Coordinator | Core trust anchor -- must be a signed event voters verify independently |
| Merkle inclusion proofs | -- | Coordinator | Computed from signed event data, returned by coordinator directly |
| Issuance commitment root | 38005 | Coordinator | Prevents coordinator from inflating eligibility -- must be signed + timestamped |
| Spent commitment root (final) | 38006 | Coordinator | Prevents phantom votes -- must be signed + timestamped |
| Election hard cap | 38007 | Coordinator | Immutable supply constraint -- must be signed |

---

## Trust Model Summary

| HTTP endpoint | Trust level | What it means |
|---|---|---|
| `GET /info` | Informational | Operational convenience. Not a trust claim. |
| `GET /election` | Cache | Unverified copy of a Nostr event. Verify on relays. |
| `GET /tally` | Unofficial | Live preview. Counts published/accepted votes but is NOT the final result. |
| `GET /eligibility` | Cache | Unverified copy of a Nostr event. Verify on relays. |

**Rule:** If a response could be used to deceive a voter about the election outcome, it should be Nostr-only.

---

## Proof Submission via Encrypted DM (NIP-04)

The voter client collaborator needs to send the full Cashu proof to the coordinator via NIP-04 encrypted DM.

**Recipient:** coordinator's npub (from `GET /info`)

**DM content (JSON string):**

```json
{
  "vote_event_id": "<kind 38000 event ID>",
  "proof": "<serialized Cashu proof>"
}
```

The coordinator:
1. Decrypts the DM
2. Extracts `vote_event_id` and `proof`
3. Verifies the kind 38000 event exists on the relay
4. Submits the proof to the mint: `POST {mint_url}/v1/melt/bolt11`
5. If burned: publishes kind 38002, updates Merkle tree
6. If rejected: logs and drops (no Nostr event)

**No response DM is sent back.** The voter discovers acceptance by checking `/tally` or watching for kind 38002 events from the coordinator's npub.

---

## Implementation Steps

### Step 1: Relay list update -- DONE

Added `wss://nos.lol` and `wss://relay.primal.net` across the codebase.

Files updated:
- `scripts/voting-coordinator-client.py` -- default `--relays` arg
- `scripts/voting-request-proof.py` -- default `--relays` arg
- `playbooks/update-coordinator-keep-existing-election.yml` -- systemd ExecStart, summary output

### Step 2: New dependency -- DONE

Added `aiohttp>=3.9.0` to `scripts/requirements.txt`.

### Step 3: Define kind 38011 in protocol docs -- DONE

Kind 38011 (Issuance Approval Receipt) is documented above and in `docs/03-PROTOCOL_REFERENCE.md`.

### Step 4: EventStore class -- DONE

Added to `voting-coordinator-client.py`:

- `EventStore` -- in-memory mirror of nak relay (kinds 38000, 38002, 38008, 38009, 38011)
- Query methods: `get_events()`, `get_election()`, `get_vote_events()`, `get_accepted_event_ids()`, `get_eligibility()`, `get_issued_pubkeys()`
- Deduplication by event ID within each kind bucket

### Step 5: SpentCommitmentTree class -- DONE

Added to `voting-coordinator-client.py`:

- Incremental Merkle tree
- Leaf = `SHA256(proof_secret)` (the `proof_commitment` from kind 38002)
- Leaves sorted lexicographically
- Internal node = `SHA256(left || right)`
- If odd number of nodes, duplicate last node
- Methods: `insert()`, `bulk_load()`, `get_root()`, `get_count()`

### Step 6: Issuance changes -- DONE

Modified `process_issuance_request()`:

- 6th param changed from `issued_path: Path` to `nostr_client: Client`
- Removed `persist_issued()` calls
- After gRPC approval: publish kind 38011 to all relays via `_publish_38011()`
- Startup: rebuild `issued_set` from kind 38011 events on nak relay via `recover_state_from_relay()`

### Step 7: Burn flow -- DONE

Added new handler for encrypted NIP-04 DMs:

1. `CoordinatorHandler.handle()` dispatches kind 4 events to `_handle_dm_async()`
2. Decrypts DM via `signer.nip04_decrypt()`
3. Parses JSON: `{vote_event_id, proof}`
4. Calls `handle_proof_dm()` which submits proof to mint: `POST {mint_url}/v1/melt/bolt11`
5. On success:
   - Compute `proof_commitment = SHA256(proof_secret)`
   - Insert into `SpentCommitmentTree`
   - Publish kind 38002 to all relays
6. On failure:
   - Log rejection reason
   - No Nostr event published

### Step 8: HTTP API routes -- DONE

Added `aiohttp.web` server with routes via `make_http_handler()`:

- `GET /info` -- static metadata
- `GET /election` -- from EventStore
- `GET /tally` -- computed from 38000 + 38002 cross-reference + SpentCommitmentTree root
- `GET /eligibility` -- from EventStore

All responses include `_trust` field with warnings and Nostr verification instructions.

### Step 9: Wire up run_coordinator() -- DONE

The main async loop uses `asyncio.gather()`:

```python
await asyncio.gather(
    web_runner,           # aiohttp HTTP server
    nostr_listener(),     # kind 38010 subscription + issuance handling
)
```

### Step 10: Playbook changes -- DONE

Updated `playbooks/update-coordinator-keep-existing-election.yml`:

- Added `--http-port 8081` to systemd ExecStart (8080 conflicts with docker-proxy on VPS)
- Updated `--relays` with new relay list (nak + damus + nos.lol + primal)
- Uses iptables (not UFW) for firewall rules
- Added `--hostname 0.0.0.0` to nak service
- Updated summary output to include coordinator API URL

### Step 11: Doc updates -- DONE

- `docs/03-PROTOCOL_REFERENCE.md` -- add kind 38011 to event registry, update kind 38002 spec
- `docs/VOTER_CLIENT_INTEGRATION_GUIDE.md` -- add HTTP API endpoints section, update relays, add NIP-04 DM proof submission spec
- `docs/11-COORDINATOR_DEPLOYMENT_PLAN.md` -- reflect stateless design, new relay list, HTTP API
- `docs/08-VOTING_COORDINATOR_TEST_PLAN.md` -- update test plan for new API
- `docs/09-VOTING_INTEGRATION_TEST_PLAN.md` -- update integration test descriptions

### Step 12: Test updates -- DONE

**49/49 tests passing.** All tests updated to match the new coordinator API:

- Replaced `tmp_issued_path` fixture with `mock_nostr_client` fixture in conftest.py
- Replaced `persist_issued` mocks with `_publish_38011` mocks
- Replaced `issued_path` arg with `nostr_client` arg in `process_issuance_request()` calls
- Removed file-existence assertions
- Replaced `TestPersistIssued` (3 tests) with `TestEventStore` (4 tests)
- Fixed `test_get_keyset_id_returns_sat_keyset` assertion (64 -> 66 chars)

Test breakdown: 25 unit + 12 VPS deploy + 7 VPS integration + 5 voter = 49 total.

See `docs/08-VOTING_COORDINATOR_TEST_PLAN.md` for full test inventory.

### Step 13: Tally pipeline (MerkleTree, close_election, 38003/38005/38006/38007) -- DONE

Added tally infrastructure to the coordinator script (904 -> 1357 lines):

- `MerkleTree` base class with `get_proof()` support — all tree types now share a common implementation
- `VoteMerkleTree` — leaf = `SHA256(canonical_json(event_id, pubkey, responses, timestamp))`
- `IssuanceCommitmentTree` — leaf = `SHA256(npub_hex)`
- `SpentCommitmentTree` refactored to extend `MerkleTree`
- `canonical_json()` — deterministic JSON serialization for Merkle leaf hashing
- `_compute_results()` — per-question vote result tallying from EventStore
- `close_election()` — orchestrator that publishes 38003/38005/38006/38007 to all relays
- `_publish_38003()` — publishes kind 38003 final tally result with vote counts, commitment roots
- `_publish_38005()` — publishes kind 38005 issuance commitment root
- `_publish_38006()` — publishes kind 38006 spent commitment root
- `_publish_38007()` — publishes kind 38007 election hard cap

### Remaining (Step 14)

- `POST /close` HTTP endpoint to trigger `close_election()`
- `GET /result` HTTP endpoint to serve final tally from kind 38003
- `GET /inclusion_proof` HTTP endpoint for individual vote Merkle proofs
- Auto-close timer (trigger `close_election()` at `end_time`)

---

## Voter Client Integration Reference

For the collaborator building the voter Nostr client:

### Relays

```
wss://relay.damus.io
wss://nos.lol
wss://relay.primal.net
```

### Coordinator HTTP API

```
GET http://<vps_ip>:8081/info
GET http://<vps_ip>:8081/election
GET http://<vps_ip>:8081/tally
GET http://<vps_ip>:8081/eligibility
GET http://<vps_ip>:8081/result              -- (planned, see 13-TALLY_IMPLEMENTATION_PLAN.md)
GET http://<vps_ip>:8081/inclusion_proof    -- (planned, see 13-TALLY_IMPLEMENTATION_PLAN.md)
POST http://<vps_ip>:8081/close              -- (planned, see 13-TALLY_IMPLEMENTATION_PLAN.md)
```

### Mint HTTP API (direct, unchanged)

```
POST http://<vps_ip>:3338/v1/mint/quote/bolt11     -- create mint quote
GET  http://<vps_ip>:3338/v1/mint/quote/bolt11/<id> -- check quote status
GET  http://<vps_ip>:3338/v1/keys                   -- get keyset
POST http://<vps_ip>:3338/v1/mint/bolt11            -- mint tokens
```

### Proof Submission (new)

Encrypted NIP-04 DM to coordinator's npub:

```json
{
  "vote_event_id": "<kind 38000 event ID>",
  "proof": "<serialized Cashu proof>"
}
```

### What to verify on Nostr (not HTTP)

- Final tally: kind 38003 from coordinator pubkey (see `13-TALLY_IMPLEMENTATION_PLAN.md` for implementation plan)
- Inclusion proofs: requested from coordinator via `GET /inclusion_proof`
- Issuance commitment root: kind 38005 from coordinator pubkey
- Spent commitment root: kind 38006 from coordinator pubkey
- Acceptance receipts: kind 38002 from coordinator pubkey
