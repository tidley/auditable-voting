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
- Eligibility verification against published npub set

State:
- proofs_spent table
- elections table
- eligible_npubs (or eligible_root reference)

Suggested storage:
- PostgreSQL (production)
- SQLite (development)

Critical invariant:
Unique constraint on proof_secret prevents double voting.

Additional invariant:
Only npubs included in the published eligibility set may obtain blind-issued proofs.

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

Note: Proof issuance is gated during the issuance window by eligibility verification using Nostr challenge-response.

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

## Nostr Event Kinds

The mint operates as a Nostr-native actor. All state transitions are expressed as signed Nostr events.

Suggested custom kinds (example range 38000+):

- 38000 — Vote Event (voter, ephemeral pubkey)
- 38001 — Encrypted Proof Submission (voter → mint)
- 38002 — Vote Acceptance Receipt (mint)
- 38003 — Final Result (mint)
- 38005 — Issuance Commitment Root (mint)
- 38006 — Spent Commitment Root (mint)
- 38007 — Election Creation / Hard Cap Declaration (mint)
- 38009 — Eligibility Set Commitment (mint)

All mint events must be signed by the mint’s long-term public key.

---

## Issuance + Spent Transparency Mechanics

### 1. Election Creation (Hard Cap)

Kind: 38007

{
  "election_id": "...",
  "max_supply": 5000,
  "start_time": 1710000000,
  "end_time": 1710003600
}

Invariant:
- max_supply is immutable once published.

---

### 1b. Eligibility Set Commitment

Kind: 38009

The mint publishes either:

- A full list of eligible npubs, OR
- A Merkle root committing to eligible npubs

For the current local demo, the full list is populated through a small self-service voter page where a user pastes an `npub` or generates a local `npub`/`nsec` pair, then registers only the `npub` with the mint. The resulting eligibility list is shown on a separate backend dashboard page so voters do not see every registered `npub`.

Example:

{
  "election_id": "...",
  "eligible_root": "<hex>",
  "eligible_count": 5000
}

Issuance rule:

1. Mint generates random challenge
2. User signs challenge with eligible npub
3. Mint verifies signature
4. Mint proceeds with blind issuance

In the current demo implementation, the signature is delivered as a signed Nostr event containing a `challenge` tag so the mint can verify the signature, the challenge binding, and the eligible `npub` match.

Blind issuance ensures the mint cannot link the issued proof secret to the eligible npub at vote time.

---

### 2. Issuance Commitment Root

Kind: 38005

For each issued proof:

commitment = SHA256(proof_secret)

Build Merkle tree:
- Leaves sorted lexicographically by commitment
- Internal node = SHA256(left || right)
- Duplicate last node if odd

Published event:

{
  "election_id": "...",
  "issuance_commitment_root": "<hex>",
  "total_issued": 5000
}

Constraint:
- total_issued <= max_supply

---

### 3. Spent Commitment Root

Kind: 38006

For each spent proof:

spent_commitment = SHA256(proof_secret)

Build Merkle tree with identical ordering rules.

Published event:

{
  "election_id": "...",
  "spent_commitment_root": "<hex>",
  "total_spent": 1234
}

Constraints:
- total_spent <= total_issued

---

## Subset Proof Requirement (Spent ⊆ Issued)

To verify the mint did not introduce phantom proofs, each spent commitment must be provably included in the issuance commitment tree.

Mechanism:

For every spent_commitment, the mint must provide:
- Merkle inclusion proof in the issuance tree

This can be implemented in two ways:

Option A (Per-Vote Proofs):
- When a vote is accepted, the mint returns:
  - Inclusion proof of spent_commitment in issuance tree
  - Inclusion proof of vote leaf in vote Merkle tree

Option B (Bulk Transparency File):
- At election close, mint publishes:
  - Full list of spent_commitments
  - Inclusion proofs into issuance tree

Verification rule:
- For every spent_commitment:
  - Verify inclusion in issuance tree
  - Ensure no duplicates
- Confirm total_spent matches number of unique spent_commitments

This guarantees:
- No new eligibility introduced after issuance
- No hidden mint-created proofs used for voting


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
