# Protocol Reference Architecture

This document defines the architecture and Nostr event kinds for the Cashu-Nostr Merkle-auditable voting system.

### Terminology

- **Mint** — The Cashu CDK mint that issues, validates, and burns proofs via its HTTP/gRPC API. "Mint" in this spec refers exclusively to Cashu operations (token issuance, proof melting, keyset management).
- **Coordinator** — An independent Nostr actor that publishes `38xxx` event kinds (election announcements, eligibility commitments, acceptance receipts, final results). Each coordinator runs its own mint and derives its Nostr key from that mint's BIP39 mnemonic via BIP32. Multiple coordinators can participate in the same election. Coordinators are independently operated by different entities.
- **Election Creator** — The coordinator that publishes the initial kind 38008 event. Any coordinator can create an election.
- **Election Participant** — A coordinator that joins an existing election by publishing kind 38007 referencing the election_id.
- **Canonical Eligible Set** — The authoritative list of eligible npubs defined in the kind 38008 event. All participating coordinators must commit to the same eligible set via kind 38009.
- **All `38xxx` events are signed by the coordinator's Nostr key** (`<coordinator_npub>`).

---

## High-Level Components

1. Coordinators (plural) — announce elections, auto-approve proof issuance for eligible voters, publish commitment roots and final results
2. Mint Core Service (per coordinator) — Cashu proof validation, spent proof database
3. Nostr Relay Listener — subscribes to relays, filters by election kind and tag
4. Merkle Builder + Tally Engine — builds Merkle trees over accepted votes, computes tallies (runs inside each coordinator)
5. Inclusion Proof Service — provides per-vote Merkle inclusion proofs (exposed by each coordinator)
6. Public Verification Tools — CLI/Web for voters and auditors to verify results and detect fraud
7. Eligibility Auditor — verifies that all coordinators committed to the same eligible set and detects inflation

---

## 1. Coordinator

Each coordinator is an independently operated Nostr actor that:

- Can create elections (publishes kind 38008)
- Can join existing elections (publishes kind 38007 referencing the election_id)
- Publishes its own coordinator info (kind 38012) for voter discovery
- Commits to the canonical eligible set (kind 38009)
- Listens for proof issuance requests (kind 38010) from voters
- Auto-approves eligible requests via gRPC to its own mint
- Tracks already-issued voters to enforce 1 proof per npub
- Accepts vote submissions (via NIP-17 gift-wrap proof burning)
- Computes its own tally
- Publishes its own commitment roots and final results

---

## 2. Mint Core Service (Per Coordinator)

Each coordinator operates its own mint. Responsibilities:
- Cashu proof validation
- Spent proof database
- Eligibility verification against the canonical eligible set

Critical invariant:
Unique constraint on proof_secret prevents double voting per coordinator.

---

## 3. Nostr Relay Listener

Responsibilities:
- Subscribe to relays
- Filter by election kind and tag
- Store raw vote events

---

## 4. Merkle Builder + Tally Engine

Each coordinator runs its own independent tally engine.

Steps:
1. Query accepted_votes
2. Fetch corresponding vote_events
3. Canonicalize leaves
4. Sort by event_id
5. Build Merkle tree
6. Compute tally
7. Store merkle_root

---

## 5. Inclusion Proof Service

Each coordinator exposes:

GET /inclusion_proof?event_id=...

Returns:
- leaf_hash
- merkle_path
- merkle_root

---

## 6. Public Verification and Audit Tools

Auditor responsibilities:
- Fetch all coordinator 38003 events for an election
- Compare tallies across coordinators
- Count 38013 voter confirmations from canonical eligible npubs
- Detect tally inflation (coordinator tally > canonical confirmations)
- Detect censorship (coordinator tally < canonical confirmations)
- Detect fake voters (38013 from non-canonical npubs)

---

## Nostr Event Kinds

All state transitions are expressed as signed Nostr events.

### Event Kind Registry

| Kind | Name | Actor | Status |
|------|------|-------|--------|
| 38000 | Vote Event | Voter | Implemented |
| 38001 | Encrypted Proof Submission | Voter → Coordinator | Spec only |
| 38002 | Vote Acceptance Receipt | Coordinator | Implemented |
| 38003 | Final Result | Coordinator | Implemented |
| 38005 | Issuance Commitment Root | Coordinator | Implemented |
| 38006 | Spent Commitment Root | Coordinator | Implemented |
| 38007 | Hard Cap / Join Event | Coordinator | Implemented |
| 38008 | Election Announcement | Coordinator | Implemented |
| 38009 | Eligibility Set Commitment | Coordinator | Implemented |
| 38010 | Proof Issuance Request | Voter → Coordinator | Implemented |
| 38011 | Issuance Approval Receipt | Coordinator | Implemented |
| 38012 | Coordinator Info | Coordinator | New |
| 38013 | Voter Confirmation | Voter | New |

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
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_1)>"]
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_2)>"]
```

The `proof-hash` tags contain SHA256 of the proof secret for each coordinator. These are public commitments that allow anyone to verify the coordinator received the proof (cross-reference with the coordinator's kind 38002 `proof_commitment` field). One `proof-hash` tag per coordinator the voter obtained a proof from.

Response fields by question type:

| Question Type | Response Field | Value |
|--------------|---------------|-------|
| `choice` (single) | `"value"` | Selected option string |
| `choice` (multiple) | `"values"` | Array of selected option strings |
| `scale` | `"value"` | Number (integer or float per `step`) |
| `text` | `"value"` | String (within `max_length` if specified) |

---

### Kind 38001 — Encrypted Proof Submission (Spec)

Voter submits a Cashu proof privately to a coordinator, correlating it with a vote event.

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

Transport: NIP-17 gift wrap or NIP-44 encrypted payload.

---

### Kind 38002 — Vote Acceptance Receipt

Published by the coordinator each time a proof is successfully burned on the mint. Each event contains the proof commitment and a running spent count, enabling incremental Merkle tree reconstruction by any verifier.

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

- `proof_commitment` — SHA256 of the burned proof's secret. Used as a leaf in the spent commitment Merkle tree. Must match a `proof-hash` tag on the corresponding kind 38000 vote event.
- `spent_count` — running total of burned proofs for this election.

---

### Kind 38003 — Final Result

Each coordinator publishes its own signed final tally. Auditors compare results across coordinators to detect discrepancies.

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

### Kind 38005 — Issuance Commitment Root

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

### Kind 38006 — Spent Commitment Root

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

### Kind 38007 — Hard Cap / Join Event

Published by a coordinator to join an existing election. This serves dual purpose: declaring supply/timing constraints and signalling participation.

A coordinator joins an election by publishing kind 38007 referencing the election_id from the kind 38008 event.

```
kind: 38007
pubkey: <coordinator_npub>
content: {
  "election_id": "<38008_event_id>",
  "max_supply": 5000,
  "vote_start": 1710000000,
  "vote_end": 1710003600,
  "confirm_end": 1710007200
}
tags:
  - ["election", "<election_id>"]
  - ["eligible-root", "<hex>"]
  - ["eligible-count", "5000"]
```

- `max_supply` — immutable once published. Must equal the canonical eligible count.
- `vote_start`, `vote_end`, `confirm_end` — timing must match the 38008 event.
- `eligible-root` — Merkle root of the coordinator's local eligible-voters.json. Must match the canonical root from 38008.

Auditors verify:
- All coordinators' eligible-roots match the canonical root from 38008
- All coordinators' timing matches the 38008 event

---

### Kind 38008 — Election Announcement

Published by a coordinator to announce an election. The event's own ID is the election_id. The canonical eligible set is defined here.

```
kind: 38008
pubkey: <coordinator_npub>
content: {
  "title": "...",
  "description": "...",
  "questions": [...],
  "vote_start": 1710000000,
  "vote_end": 1710003600,
  "confirm_end": 1710007200
}
tags:
  - ["t", "election-announcement"]
  - ["coordinator", "<npub1>"]
  - ["coordinator", "<npub2>"]
  - ["eligible-root", "<merkle_root_of_eligible_npubs>"]
  - ["eligible-count", "5000"]
  - ["eligible-url", "<https://...eligible-voters.json>"]
  - ["mint", "<mint_url_1>"]
  - ["mint", "<mint_url_2>"]
```

- `vote_start` (t0) — voting window opens
- `vote_end` (t1) — voting window closes, confirmation window opens
- `confirm_end` (t2) — confirmation window closes
- `["coordinator", npub]` — expected coordinator participants (election creator + known participants)
- `["eligible-root", hex]` — Merkle root of canonical eligible npub set (leaf = SHA256(npub_hex))
- `["eligible-count", N]` — number of eligible voters
- `["eligible-url", url]` — URL where the full eligible npub list can be fetched
- `["mint", url]` — mint URLs for participating coordinators

The phased timing (vote window t0-t1, confirmation window t1-t2) prevents timing attacks that could correlate vote events with voter confirmations, protecting ballot secrecy.

---

### Kind 38009 — Eligibility Set Commitment

Each coordinator publishes a commitment to the canonical eligible set. This is the mechanism by which auditors verify that all coordinators agree on who is eligible.

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

Auditors verify all coordinators' 38009 events reference the same `eligible_root` as the 38008 event.

---

### Kind 38010 — Proof Issuance Request

Correlates the voter's npub with a specific mint quote so the coordinator can verify eligibility before approving via gRPC. One 38010 event per coordinator.

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

Voters publish one 38010 per coordinator, each tagged with the corresponding coordinator's npub.

---

### Kind 38011 — Issuance Approval Receipt

Published by the coordinator each time it approves a kind 38010 issuance request.

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

This enables stateless coordinator operation and public auditability. Auditors can verify that every `approved_npub` in a coordinator's 38011 events is in the canonical eligible set from 38008.

---

### Kind 38012 — Coordinator Info (New)

Published by each coordinator to advertise its HTTP API endpoint, mint URL, and supported relays. Voters use this to discover how to interact with a coordinator.

```
kind: 38012
pubkey: <coordinator_npub>
content: {
  "http_api": "https://coordinator-a.example.com:8081",
  "mint_url": "https://mint-a.example.com:3338",
  "supported_relays": ["wss://relay.example.com"]
}
tags:
  - ["t", "coordinator-info"]
```

Voters discover coordinators for an election by:
1. Fetching the 38008 event (by event_id or by filtering kind 38008)
2. Extracting coordinator npubs from `["coordinator", ...]` tags
3. Querying kind 38012 by each coordinator's npub to get HTTP API endpoints

This is a replaceable parameterized event — a coordinator updates it by publishing a new 38012 with the same `["t", "coordinator-info"]` tag.

---

### Kind 38013 — Voter Confirmation (New)

Published by the voter's **real npub** (not ephemeral) during the confirmation window (t1–t2). Mandatory — every voter must publish this after submitting their vote.

```
kind: 38013
pubkey: <voter_real_npub>
content: {
  "election_id": "<38008_event_id>",
  "action": "voted"
}
tags:
  - ["election", "<election_id>"]
```

**Timing constraint:** `created_at >= vote_end` AND `created_at <= confirm_end`. Events published before `vote_end` are rejected.

**Purpose — anti-inflation detection:**
- Establishes a lower bound on legitimate participation
- Auditors count 38013 events where `pubkey ∈ canonical_eligible_set`
- Any coordinator whose tally exceeds this count has provably inflated votes
- Any 38013 from an npub NOT in the canonical eligible set is a red flag (fake voter sock puppet)

**Purpose — anti-censorship detection:**
- Any coordinator whose tally is below this count has provably censored voters

**Purpose — anti-doxing:**
- The phased timing (vote window t0-t1, confirmation window t1-t2) prevents temporal correlation between vote events (signed by ephemeral keys) and confirmation events (signed by real keys)
- All confirmations are batched after all votes, making it difficult to correlate which vote belongs to which voter

---

## Audit Algorithm

For each coordinator C participating in election E:

```
# 1. Fetch canonical eligible set
canonical_root = 38008.tags["eligible-root"]
canonical_count = 38008.tags["eligible-count"]
canonical_npubs = fetch(38008.tags["eligible-url"])

# 2. Verify coordinator's commitment
if C.38009.eligible_root != canonical_root:
    FLAG("eligible root mismatch — coordinator may have different eligible set")

# 3. Count canonical confirmations
confirmations = count of 38013 events where:
    election_id == E
    created_at >= vote_end AND created_at <= confirm_end
    pubkey ∈ canonical_npubs

# 4. Detect fake voter confirmations
fake_confirmations = 38013 events where:
    election_id == E
    pubkey ∉ canonical_npubs

# 5. Compare tally
tally_C = C.38003.total_votes

if tally_C > canonical_count:
    FLAG("tally exceeds canonical eligible count")
if tally_C > confirmations:
    FLAG("possible inflation — tally exceeds canonical confirmations")
if tally_C < confirmations:
    FLAG("possible censorship — confirmations exceed tally")
if fake_confirmations > 0:
    FLAG("fake voter confirmations from non-canonical npubs detected")

# 6. Verify issuance against canonical set
for each 38011 from C:
    if approved_npub ∉ canonical_npubs:
        FLAG("coordinator issued proof to non-canonical npub")
```

---

## Subset Proof Requirement (Spent ⊆ Issued)

To verify the coordinator did not introduce phantom proofs, each spent commitment must be provably included in the issuance commitment tree.

For every spent_commitment, the coordinator must provide:
- Merkle inclusion proof in the issuance tree

Verification rule:
- For every spent_commitment: verify inclusion in issuance tree, ensure no duplicates
- Confirm total_spent matches number of unique spent_commitments

---

## Data Model Summary

Per coordinator:

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
- N coordinators produce N independent tallies — audit is O(N)

---

## Trust Model

Each coordinator is independently constrained by:

- Hard supply cap (kind 38007)
- Canonical eligible set commitment (kind 38009)
- Public issuance commitment (kind 38005)
- Public spent commitment (kind 38006)
- Merkle-auditable vote set
- Subset proof requirement
- Mandatory voter confirmations (kind 38013)

With multiple coordinators:
- Censorship by one coordinator is detectable (tally < confirmations)
- Inflation by one coordinator is detectable (tally > confirmations)
- Fake voter injection is detectable (38013 from non-canonical npubs)
- Only one honest coordinator is needed for a vote to be heard (1-of-N quorum)
- Discrepancies between coordinator tallies are immediately visible

The remaining trust assumptions are:

- At least one coordinator behaves honestly
- The election creator publishes an accurate canonical eligible set
- Honest timing adherence by coordinators

The system is not trustless, but is auditable with bounded cheating capability and multi-coordinator cross-verification.
