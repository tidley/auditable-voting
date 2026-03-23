# Voting Issuance Nostr Client Design

Coordinator daemon and voter CLI for the auditable voting demo issuance flow.

> **Note:** The event kind specs in `../auditable-voting/docs/` (reference-architecture.md, cashu-nostr-voting-design.md) are outdated. The canonical protocol definitions live in this repo: `docs/04-VOTING_EVENT_INTEROP_NOTES.md` (kinds 38008, 38010, 38000) and this file.

## Overview

Eligible voters request 1-sat Cashu proofs from the mint. A kind 38010 Nostr event correlates the voter's npub with the mint quote. The coordinator's Nostr client auto-approves eligible requests via gRPC. The voter polls the mint for approval and receives a blinded proof.

## Protocol

### Kind 38008 — Election Announcement

Published by the coordinator to announce an election (questions, timing, mints). The event's own ID is the election ID. Voters discover elections by filtering `Kind(38008)` from the coordinator's pubkey. Full spec in `04-VOTING_EVENT_INTEROP_NOTES.md`.

### Kind 38000 — Vote Event

```
kind: 38000
content: {
  "election_id": "<38008_event_id>",
  "responses": [
    {"question_id": "q1", "value": "Alice"},
    {"question_id": "q2", "values": ["Lightning dev", "Privacy research"]},
    {"question_id": "q3", "value": 7},
    {"question_id": "q4", "value": "Great work overall!"}
  ],
  "timestamp": 1710000000
}
tags:
  - ["election", "<election_id>"]
```

| Question Type | Response Field | Value |
|--------------|---------------|-------|
| `choice` (single) | `"value"` | Selected option string |
| `choice` (multiple) | `"values"` | Array of selected option strings |
| `scale` | `"value"` | Number (integer or float per `step`) |
| `text` | `"value"` | String (within `max_length` if specified) |

### Kind 38010 — Proof Issuance Request

```
kind: 38010
content: "{\"action\":\"cashu_invoice_claim\",\"quote_id\":\"...\",\"invoice\":\"...\",\"npub\":\"...\"}"
tags:
  - ["p", "<coordinator_npub>"]
  - ["t", "cashu-issuance"]
  - ["quote", "<quote_id>"]
  - ["invoice", "<bolt11_invoice>"]
  - ["mint", "<mint_url>"]
  - ["amount", "1"]
  - ["election", "<election_id>"]
```

Purpose: correlate the voter's npub (event pubkey) with a specific mint quote so the coordinator can verify eligibility before approving via gRPC.

Tag reference:
- `p` — recipient coordinator's npub (relay uses this for server-side filtering)
- `t` — NIP-12 topic for general discoverability
- `quote` — mint quote ID from `POST /v1/mint/quote/bolt11`
- `invoice` — BOLT11 invoice string
- `mint` — mint URL the quote was created on
- `amount` — amount in sats
- `election` — election ID for multi-election support

### Flow

```
Voter                          Mint (HTTP)              Coordinator (auto-approve)
  |                               |                           |
  |-- POST /v1/mint/quote/bolt11->|                           |
  |<-- {quote_id, invoice} -------|                           |
  |                               |                           |
  |-- publish kind 38010 -------->|  (to relay)              |
  |                               |               <-- subscribe
  |                               |               pubkey in eligible_set?
  |                               |               already approved? (no)
  |                               |               amount == 1 sat? (yes)
  |                               |               -> gRPC approve
  |                               |               -> mark npub as issued
  |                               |<-- UpdateNut04Quote ------|
  |                               |    (quote_id, "paid")     |
  |                               |                           |
  |-- GET /v1/mint/quote/{id} --->|                           |
  |<-- state: "paid" ------------|                           |
  |-- POST /v1/mint/bolt11 ------>|  (cashu lib handles       |
  |   {quote_id, outputs[]}       |   blinding/unblinding)   |
  |<-- {signatures[]} ------------|                           |
  |   proofs saved to file        |                           |
```

No Nostr response from coordinator. Voter polls mint HTTP API.

## Constraints

| Constraint | Enforcement |
|---|---|
| Eligibility | Coordinator checks `pubkey in eligible_set` |
| 1 proof per npub | Coordinator tracks issued npubs in `issued-voters.json` |
| 1 sat only | Coordinator checks `amount == "1"`, voter CLI locks `--amount` to 1 |
| Auto-approve | No operator interaction -- eligible + first request + 1 sat = approve |

## Files

| File | Purpose |
|---|---|
| `scripts/voting-coordinator-client.py` | Coordinator daemon (Nostr listener + gRPC auto-approve) |
| `scripts/voting-request-proof.py` | Voter CLI (quote -> publish -> poll -> mint proof) |
| `eligible-voters.json` | Input: eligible npub list |
| `issued-voters.json` | Coordinator state: tracks already-issued npubs (created at runtime) |

## Dependencies

- `nostr-sdk` (used in `test-mint-auth.py`)
- `grpcio`, `grpcio-tools` (used in `mintctl`)
- `cashu` (new, for voter CLI blinding/unblinding)
- `requests` (new, for mint HTTP calls in voter CLI)
- `coincurve` (used in `derive-coordinator-keys.py`)

---

## Script 1: `scripts/voting-coordinator-client.py`

### Purpose

Daemon that auto-approves 1-sat mint quotes from eligible voters, max 1 per npub.

### Args

- `--nsec` -- coordinator's Nostr private key
- `--eligible` -- path to `eligible-voters.json` (array of npub hex strings)
- `--issued` -- path to `issued-voters.json` (tracks approved npubs, created if missing)
- `--grpc-endpoint` -- e.g. `23.182.128.64:8086`
- `--relays` -- relay URLs (default: `ws://localhost:10547 wss://relay.damus.io wss://nos.lol wss://relay.primal.net`)

### Startup

1. Load eligible npubs into `set[str]`
2. Load issued npubs from `issued-voters.json` into `set[str]` (empty if file doesn't exist)
3. Connect to relay(s), subscribe to `Kind(38010)` + `Tag(["p", "<coordinator_npub>"])`
4. Log: `Listening for issuance requests... (N eligible, M already issued)`

### Event Loop (on each kind 38010)

1. Extract `pubkey` from event
2. `pubkey in eligible_set`? If not -> log `SKIP: not eligible`
3. `pubkey in issued_set`? If yes -> log `SKIP: already issued`
4. Extract `quote_id` from `["quote"]` tag, `amount` from `["amount"]` tag
5. `amount == "1"` (1 sat)? If not -> log `SKIP: amount must be 1 sat`
6. Log `APPROVING: npub1... | quote: <id>`
7. Call gRPC `UpdateNut04Quote(quote_id, state="paid")`
8. On success: add `pubkey` to `issued_set`, persist `issued-voters.json`, log `DONE`
9. On error: log `ERROR: <reason>` (don't mark as issued)

### Issued Voters File Format

`issued-voters.json`:
```json
{
  "npubs": ["<hex_pubkey_1>", "<hex_pubkey_2>"]
}
```

Written after each successful approval. Simple `json.dump` with `indent=2`.

### gRPC Integration

Reuse `mintctl`'s proto loading pattern from `tools/mintctl/proto/cdk-mint-rpc.proto`. The relevant RPC:

```protobuf
rpc UpdateNut04Quote(UpdateNut04QuoteRequest) returns (UpdateNut04QuoteRequest) {}

message UpdateNut04QuoteRequest {
    string quote_id = 1;
    string state = 2;  // Set to "paid" to approve
}
```

Create insecure channel to `--grpc-endpoint`, call `UpdateNut04Quote` with `state="paid"`.

---

## Script 2: `scripts/voting-request-proof.py`

### Purpose

Voter CLI -- request 1-sat mint quote, publish kind 38010, wait for approval, receive proof via `cashu` Python library.

### Args

- `--nsec` -- voter's Nostr private key
- `--mint-url` -- e.g. `http://mint-a.mints.23.182.128.64.sslip.io`
- `--coordinator-npub` -- coordinator's npub
- `--amount` -- locked to `1` sat (reject other values)
- `--election` -- election ID string
- `--output` -- path to save proof (default: `proof.json`)
- `--relays` -- relay URLs

### Steps

1. Validate `--amount == 1` (fail if not)
2. `POST {mint_url}/v1/mint/quote/bolt11` with `{"amount": 1, "unit": "sat"}` -> `{quote_id, invoice}`
3. Publish kind 38010:
   ```
   kind: 38010
   tags:
     - ["p", "<coordinator_npub>"]
     - ["t", "cashu-issuance"]
     - ["quote", "<quote_id>"]
     - ["invoice", "<bolt11_invoice>"]
     - ["mint", "<mint_url>"]
     - ["amount", "1"]
     - ["election", "<election_id>"]
   content: "{\"action\":\"cashu_invoice_claim\",...}"
   ```
4. Log `Waiting for approval...`
5. Poll `GET {mint_url}/v1/mint/quote/bolt11/{quote_id}` until `state == "paid"` (1s, 2s, 4s... backoff, 5min timeout)
6. Use `cashu` Python library to:
   - Generate 1 secret locally
   - Build blinded output for the mint's active keyset
   - `POST {mint_url}/v1/mint/bolt11` with `{quote_id, outputs}`
   - Receive signatures, unblind to get proof
7. Save proof to `--output` file (Cashu serialized format)
8. Print `Proof saved to <path>`

---

## Script 3: `eligible-voters.json` (example)

```json
["npub1abc...", "npub1def...", "npub1ghi..."]
```

Coordinator loads at startup. Npub hex form used for set membership checks against event `pubkey` field.
