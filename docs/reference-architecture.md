# Reference Architecture

This document defines a minimal but production-oriented architecture for the Cashu-Nostr Merkle-auditable voting system.

---

## High-Level Components

1. Mint Core Service
2. Vote API Service
3. Nostr Relay Listener
4. Merkle Builder + Tally Engine
5. Inclusion Proof Service
6. Public Verification Tools

All services may run inside a single deployable binary initially, but are logically separated.

---

## 1. Mint Core Service

Responsibilities:
- Cashu proof validation
- Spent proof database
- Election lifecycle management

State:
- proofs_spent table
- elections table

Suggested storage:
- PostgreSQL (production)
- SQLite (development)

Critical invariant:
Unique constraint on proof_secret prevents double voting.

---

## 2. Vote API Service

Endpoint:

POST /submit_vote

Payload:
{
  "nostr_event_id": "...",
  "cashu_proof": "..."
}

Flow:
- Validate proof
- Check not spent
- Verify nostr event exists
- Mark proof spent
- Add nostr_event_id to accepted_votes

Response:
- success or failure

---

## 3. Nostr Relay Listener

Responsibilities:
- Subscribe to relays
- Filter by election kind and tag
- Store raw vote events

Storage:
- vote_events table

Fields:
- event_id (PK)
- pubkey
- content
- timestamp

---

## 4. Merkle Builder + Tally Engine

Triggered when election closes.

Steps:
1. Query accepted_votes
2. Fetch corresponding vote_events
3. Canonicalize leaves
4. Sort by event_id
5. Build Merkle tree
6. Compute tally
7. Store merkle_root

Data tables:
- accepted_votes
- merkle_nodes (optional if storing full tree)

---

## 5. Inclusion Proof Service

Endpoint:

GET /inclusion_proof?event_id=...

Returns:
- leaf_hash
- merkle_path
- merkle_root

Proofs may be computed on demand or precomputed at tally time.

---

## 6. Public Verification Tools

CLI Tool Responsibilities:
- Fetch vote event from relay
- Recompute leaf hash
- Apply merkle path
- Verify root
- Verify mint signature on final result

Optional Web UI:
- Paste event_id
- Display verification result

---

## Suggested Tech Stack

Backend:
- Rust (Actix or Axum) OR
- Go (Fiber or standard net/http)

Crypto:
- SHA256 (standard library)
- secp256k1 for Nostr verification

Database:
- PostgreSQL

Deployment:
- Single container
- Relays external

---

## Data Model Summary

proofs_spent(
  proof_secret PRIMARY KEY,
  spent_at
)

vote_events(
  event_id PRIMARY KEY,
  pubkey,
  content,
  timestamp
)

accepted_votes(
  event_id PRIMARY KEY,
  accepted_at
)

elections(
  election_id PRIMARY KEY,
  status,
  merkle_root,
  total_votes
)

---

## Scaling Considerations

- Merkle tree build is O(n)
- Inclusion proof generation is O(log n)
- Spent set lookup must be indexed
- Relays may be sharded for high throughput

---

## Trust Model Reminder

Mint is trusted to:
- Issue proofs honestly
- Not censor valid proofs
- Compute tally correctly

Merkle inclusion proofs guarantee:
- If vote was accepted, it is included in tally set
