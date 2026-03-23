# Protocol Reference Architecture

This document defines the architecture and Nostr event kinds for the Cashu-Nostr Merkle-auditable voting system.

> **Source of truth:** This repo (`tg-mint-orchestrator/docs/`) is the canonical location for all protocol specifications. The copy in `../auditable-voting/docs/` is outdated and should not be referenced.

### Terminology

- **Mint** — The Cashu CDK mint that issues, validates, and burns proofs via its HTTP/gRPC API. "Mint" in this spec refers exclusively to Cashu operations (token issuance, proof melting, keyset management).
- **Coordinator** — The Nostr actor that publishes all `38xxx` event kinds (election announcements, eligibility sets, commitment roots, acceptance receipts, final results). The coordinator's Nostr key is deterministically derived from the mint's BIP39 mnemonic via the BIP32 master key. Because they share a seedphrase, the coordinator and mint are effectively the same trust entity — the coordinator is the mint's Nostr identity.
- **All `38xxx` events are signed by the coordinator's Nostr key** (`<coordinator_npub>`). In earlier drafts of this spec, some events were incorrectly attributed to the mint. The coordinator is the sole publisher of Nostr events.

---

## High-Level Components

1. Coordinator — announces elections, auto-approves proof issuance for eligible voters, publishes commitment roots and final results
2. Mint Core Service — Cashu proof validation, spent proof database, eligibility verification
3. Nostr Relay Listener — subscribes to relays, filters by election kind and tag
4. Merkle Builder + Tally Engine — builds Merkle trees over accepted votes, computes tallies (runs inside the coordinator)
5. Inclusion Proof Service — provides per-vote Merkle inclusion proofs (exposed by the coordinator)
6. Public Verification Tools — CLI/Web for voters to verify inclusion

All services may run inside a single deployable binary initially, but are logically separated.

---

## 1. Coordinator

The coordinator is a Nostr actor (with a deterministically-derived key from the mint's BIP39 mnemonic) that:

- Publishes election announcements (kind 38008)
- Listens for proof issuance requests (kind 38010)
- Auto-approves eligible requests via gRPC to the mint
- Tracks already-issued voters to enforce 1 proof per npub

See `05-VOTING_ISSUANCE_NOSTR_CLIENT_DESIGN.md` for the full coordinator daemon spec.

---

## 2. Mint Core Service

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
- Verify coordinator signature on final result

Optional Web UI:
- Paste event_id
- Display verification result

---

## Nostr Event Kinds

All state transitions are expressed as signed Nostr events.

### Event Kind Registry

| Kind | Name | Actor | Status |
|------|------|-------|--------|
| 38000 | Vote Event | Voter | Implemented |
| 38001 | Encrypted Proof Submission | Voter → Coordinator | Spec only |
| 38002 | Vote Acceptance Receipt | Coordinator | Implemented |
| 38003 | Final Result | Coordinator | Spec only |
| 38005 | Issuance Commitment Root | Coordinator | Spec only |
| 38006 | Spent Commitment Root | Coordinator | Spec only |
| 38007 | Election Hard Cap Declaration | Coordinator | Spec only |
| 38008 | Election Announcement | Coordinator | Spec only |
| 38009 | Eligibility Set Commitment | Coordinator | Spec only |
| 38010 | Proof Issuance Request | Voter → Coordinator | Implemented |
| 38011 | Issuance Approval Receipt | Coordinator | Implemented |

All `38xxx` events are signed by the coordinator's Nostr key. The coordinator key is derived from the mint's BIP39 mnemonic, so they share the same trust root.

---

### Kind 38000 — Vote Event

Published by the voter using an ephemeral pubkey.

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

Response fields by question type:

| Question Type | Response Field | Value |
|--------------|---------------|-------|
| `choice` (single) | `"value"` | Selected option string |
| `choice` (multiple) | `"values"` | Array of selected option strings |
| `scale` | `"value"` | Number (integer or float per `step`) |
| `text` | `"value"` | String (within `max_length` if specified) |

Full question type spec: see `04-VOTING_EVENT_INTEROP_NOTES.md` (Kind 38008 section).

---

### Kind 38001 — Encrypted Proof Submission (Spec)

Voter submits a Cashu proof privately to the coordinator, correlating it with a vote event.

```
kind: 38001
content: <encrypted>
  {
    "nostr_event_id": "<id>",
    "cashu_proof": "<proof>"
  }
tags:
  - ["p", "<coordinator_npub>"]
```

Transport: NIP-04 or NIP-44 encrypted DM.

---

### Kind 38002 — Vote Acceptance Receipt

Published by the coordinator each time a proof is successfully burned on the mint. Each event contains the proof commitment and a running spent count, enabling incremental Merkle tree reconstruction by any verifier. The coordinator is the burn agent — it receives proofs via NIP-04 DM, submits them to the mint, and publishes 38002 on success.

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

- `proof_commitment` — SHA256 of the burned proof's secret. Used as a leaf in the spent commitment Merkle tree.
- `spent_count` — running total of burned proofs for this election. Enables verification of completeness.

All 38002 events for an election can be collected to reconstruct the full spent commitment Merkle tree (see kind 38006).

---

### Kind 38003 — Final Result (Spec)

Signed final tally event containing per-question results, merkle_root, and commitment roots.

```
kind: 38003
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "total_votes": 1234,
  "results": {
    "q1": {"Alice": 600, "Bob": 634, "Carol": 0},
    "q3": {"mean": 7.2, "median": 7, "count": 1234}
  },
  "merkle_root": "<hex>",
  "total_proofs_burned": 1234,
  "issuance_commitment_root": "<hex>",
  "spent_commitment_root": "<hex>",
  "max_supply": 5000
}
tags:
  - ["election", "<election_id>"]
```

For `text` questions, responses are published verbatim (not tallied).

---

### Kind 38005 — Issuance Commitment Root (Spec)

For each issued proof: `commitment = SHA256(proof_secret)`

Build Merkle tree:
- Leaves sorted lexicographically by commitment
- Internal node = SHA256(left || right)
- Duplicate last node if odd

```
kind: 38005
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "issuance_commitment_root": "<hex>",
  "total_issued": 5000
}
tags:
  - ["election", "<election_id>"]
```

Constraint: total_issued <= max_supply

---

### Kind 38006 — Spent Commitment Root (Spec)

For each spent proof: `spent_commitment = SHA256(proof_secret)`

Build Merkle tree with identical ordering rules.

```
kind: 38006
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "spent_commitment_root": "<hex>",
  "total_spent": 1234
}
tags:
  - ["election", "<election_id>"]
```

Constraints: total_spent <= total_issued

---

### Kind 38007 — Election Hard Cap Declaration (Spec)

Published by the coordinator to declare immutable supply and timing constraints.

```
kind: 38007
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "max_supply": 5000,
  "start_time": 1710000000,
  "end_time": 1710003600
}
tags:
  - ["election", "<election_id>"]
```

Invariant: max_supply is immutable once published.

---

### Kind 38008 — Election Announcement

Published by the coordinator to announce an election: its questions, timing, and which mints to use. The event's own ID is the election ID. Full spec in `04-VOTING_EVENT_INTEROP_NOTES.md`.

```
kind: 38008
pubkey: <coordinator_npub>
content: {
  "title": "...",
  "description": "...",
  "questions": [...],
  "start_time": 1710000000,
  "end_time": 1710003600
}
tags:
  - ["t", "election-announcement"]
  - ["mint", "<mint_url_1>"]
  - ["mint", "<mint_url_2>"]
  - ["mint", "<mint_url_3>"]
```

---

### Kind 38009 — Eligibility Set Commitment (Spec)

The coordinator publishes either a full list of eligible npubs, or a Merkle root committing to them.

```
kind: 38009
pubkey: <coordinator_npub>
content: {
  "election_id": "<election_id>",
  "eligible_root": "<hex>",
  "eligible_count": 5000
}
tags:
  - ["election", "<election_id>"]
```

Issuance rule:
1. Coordinator generates random challenge
2. User signs challenge with eligible npub
3. Coordinator verifies signature
4. Coordinator proceeds with blind issuance (via gRPC to the mint)

Blind issuance ensures the coordinator cannot link the issued proof secret to the eligible npub at vote time.

---

### Kind 38010 — Proof Issuance Request

Correlates the voter's npub with a specific mint quote so the coordinator can verify eligibility before approving via gRPC. Full spec in `05-VOTING_ISSUANCE_NOSTR_CLIENT_DESIGN.md`.

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

---

### Kind 38011 — Issuance Approval Receipt

Published by the coordinator each time it approves a kind 38010 issuance request. Replaces local `issued-voters.json` — the coordinator's issued set is reconstructed on startup by querying relays for past 38011 events.

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

This enables stateless coordinator operation: no local files needed for tracking issued voters. On restart, the coordinator queries the relay for kind 38011 events tagged with the current election to rebuild the issued set.

---

## Subset Proof Requirement (Spent ⊆ Issued)

To verify the coordinator did not introduce phantom proofs, each spent commitment must be provably included in the issuance commitment tree.

For every spent_commitment, the coordinator must provide:
- Merkle inclusion proof in the issuance tree

Option A (Per-Vote Proofs):
- When a vote is accepted, the coordinator returns inclusion proofs for both the spent commitment in the issuance tree and the vote leaf in the vote Merkle tree.

Option B (Bulk Transparency File):
- At election close, the coordinator publishes the full list of spent_commitments with inclusion proofs into the issuance tree.

Verification rule:
- For every spent_commitment: verify inclusion in issuance tree, ensure no duplicates
- Confirm total_spent matches number of unique spent_commitments

This guarantees:
- No new eligibility introduced after issuance
- No hidden coordinator-created proofs used for voting

---

## Data Model Summary

```
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
```

---

## Scaling Considerations

- Merkle tree build is O(n)
- Inclusion proof generation is O(log n)
- Spent set lookup must be indexed
- Relays may be sharded for high throughput

---

## Trust Model

The coordinator (acting as the mint's Nostr identity) is trusted to:
- Issue proofs honestly (via the mint's Cashu API)
- Not censor valid proofs
- Compute tally correctly

Merkle inclusion proofs guarantee:
- If vote was accepted, it is included in tally set

With 2-of-3 mint quorum:
- Phantom voter attack requires ≥ 2 mints colluding
- Censorship requires ≥ 2 mints colluding
- Eligibility inflation requires ≥ 2 mints colluding

The system is not trustless, but is auditable with bounded cheating capability.
