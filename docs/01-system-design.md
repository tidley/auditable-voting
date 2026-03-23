# Cashu-Authenticated, Nostr-Published, Merkle-Auditable Voting System

> **Source of truth:** This repo (`tg-mint-orchestrator/docs/`) is the canonical location for all protocol specifications. The copy in `../auditable-voting/docs/` is outdated and should not be referenced.

## System Overview

Eligibility is defined by possession of a valid Cashu proof issued by a trusted mint.

- 1 proof = 1 vote
- Proofs are revealed privately to the mint
- Mint burns proofs and maintains a spent set
- Votes are publicly published via ephemeral Nostr npubs
- Coordinator computes tally
- Coordinator constructs a Merkle tree over accepted vote events
- Coordinator publishes Merkle root and final tally
- Voters receive Merkle inclusion proofs
- Coordinator publishes issuance commitment root
- Coordinator publishes spent commitment root
- Election defines a hard cap (max_supply)
- Election defines a transparent eligibility set (list or Merkle root of eligible npubs)

The coordinator (whose Nostr key is derived from the mint's seedphrase) is trusted to issue proofs and compute results, but must provide cryptographic inclusion proofs so voters can verify their vote was counted.

This design additionally enforces issuance transparency and a fixed election supply so the coordinator cannot inflate the number of eligible votes without detection.

Eligibility transparency ensures that only publicly declared Nostr pubkeys may obtain voting credentials, while blind issuance ensures that the coordinator cannot link an eligible pubkey to a specific vote.

---

## Participants

Mint:
- Issues Cashu proofs (via coordinator approval)
- Validates and burns proofs

Coordinator:
- Publishes election announcements (kind 38008) with questions, timing, and mint URLs
- Listens for proof issuance requests (kind 38010) from voters
- Auto-approves eligible requests via gRPC to the mint
- Enforces 1 proof per npub
- Verifies eligibility of npubs during issuance window
- Accepts vote submissions (via NIP-04 DM proof burning)
- Computes tally
- Builds Merkle tree over accepted votes
- Publishes commitment roots (kinds 38005, 38006, 38007) and final results (kind 38003)
- Provides inclusion proofs

Voter:
- Discovers election via coordinator's kind 38008 event
- Holds one valid Cashu proof
- Controls an eligible Nostr pubkey (npub)
- Generates ephemeral Nostr keypair
- Publishes vote event (kind 38000) with structured responses
- Submits proof privately
- Verifies inclusion proof

Nostr Relays:
- Broadcast and store vote events

---

## Voting Flow

### 0. Election Announcement

The coordinator publishes a kind 38008 event defining the election. Its event ID becomes the election_id. Voters discover the election by filtering `Kind(38008)` from the coordinator's pubkey. See `04-VOTING_EVENT_INTEROP_NOTES.md` for the full 38008 spec.

### 1. Transparent Eligibility Set

Before the issuance window begins, each coordinator publishes either:

1. A full list of eligible npubs (kind 38009), OR
2. A Merkle root committing to the eligible npubs (kind 38009)

```
{
  "election_id": "<38008_event_id>",
  "eligible_root": "<hex>",
  "eligible_count": 5000
}
```

Eligibility is public. Participation privacy is not guaranteed, but vote privacy is preserved.

During issuance, a voter must prove control of an eligible npub by signing a coordinator-provided challenge.

Flow:

- Coordinator sends random challenge
- Voter signs challenge with eligible npub
- Coordinator verifies signature
- Coordinator proceeds with blind issuance (via gRPC to the mint)

Blind issuance ensures the coordinator cannot link the issued proof to the eligible npub at vote time.

### 2. Proof Issuance (Coordinator-Managed)

Voters request 1-sat proofs from the mint. The coordinator auto-approves eligible requests via gRPC. Full flow in `05-VOTING_ISSUANCE_NOSTR_CLIENT_DESIGN.md`.

1. Voter requests mint quote: `POST /v1/mint/quote/bolt11`
2. Voter publishes kind 38010 issuance request to Nostr (tags coordinator's npub, quote_id, mint URL, amount, election_id)
3. Coordinator receives event, checks eligibility, approves via gRPC `UpdateNut04Quote(quote_id, state="paid")`
4. Voter polls mint for approval, mints blinded proof

### 3. Public Vote Event

Voter generates a new ephemeral Nostr keypair and publishes:

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

Vote event does NOT contain any Cashu proofs.

### 4. Private Proof Submission

Voter submits proof to coordinator via encrypted DM (NIP-04/44) or HTTPS:

```
{
  "nostr_event_id": "<id>",
  "cashu_proof": "<proof>"
}
```

Proof is not publicly revealed.

### 5. Proof Validation and Burning

The coordinator submits the proof to the mint, which verifies:
- Proof signature validity
- Proof not already spent
- Referenced Nostr event exists
- Election is active

If valid:
- Mint adds proof secret to spent_set
- Coordinator adds nostr_event_id to accepted_votes

---

## Accepted Vote Set

accepted_votes = set of nostr_event_ids

Only accepted votes are included in the Merkle tree.

---

## Election Supply Transparency

To prevent phantom vote inflation, the system commits to both issuance and spent proofs.

### Hard Cap

Each coordinator publishes kind 38007 at election creation:

```
{
  "election_id": "<election_id>",
  "max_supply": 5000
}
```

Invariants:

- Total issued proofs <= max_supply
- Total spent proofs <= total issued proofs

This prevents the coordinator from minting unlimited eligibility.

---

### Issuance Commitment Root

During the issuance phase, the coordinator computes commitments over every issued proof:

commitment = SHA256(proof_secret)

All commitments are placed into a Merkle tree. Leaves sorted lexicographically by commitment.

The coordinator publishes kind 38005:

```
{
  "election_id": "<election_id>",
  "issuance_commitment_root": "<hex>",
  "total_issued": 5000
}
```

This commits the coordinator to the exact set of eligible proofs.

---

### Spent Commitment Root

When voting concludes, the coordinator constructs a second Merkle tree over spent proof commitments:

spent_commitment = SHA256(proof_secret)

Leaves sorted lexicographically by commitment.

The coordinator publishes kind 38006:

```
{
  "election_id": "<election_id>",
  "spent_commitment_root": "<hex>",
  "total_proofs_burned": 1234
}
```

Security guarantees:

- Every spent commitment must exist in the issuance commitment tree
- total_proofs_burned <= total_issued
- total_issued <= max_supply

This prevents the coordinator from introducing hidden eligibility or secretly minting additional votes.

---

## Merkle Tree Construction

### Leaf Encoding

leaf = SHA256(
    nostr_event_id ||
    vote_pubkey ||
    canonical_json(responses) ||
    timestamp
)

Canonical JSON encoding required. The `responses` array is serialized deterministically.

### Ordering

Leaves sorted lexicographically by nostr_event_id.

### Internal Node

parent = SHA256(left || right)

If odd number of nodes, duplicate last node.

Final output: merkle_root

---

## Published Final Result

Coordinator publishes kind 38003:

```
{
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
```

For `choice` questions: per-option counts (plurality for single, approval for multiple).
For `scale` questions: statistical summary (mean, median, count).
For `text` questions: published verbatim, not tallied.

---

## Inclusion Proof

Coordinator returns to voter:

```
{
  "nostr_event_id": "...",
  "leaf_hash": "...",
  "merkle_path": [
    { "position": "left", "hash": "..." },
    { "position": "right", "hash": "..." }
  ],
  "merkle_root": "..."
}
```

Voter recomputes root and verifies match.

---

## Security Properties

Double voting prevented via spent_set.

Votes are public but unlinkable to Cashu proof.

Eligibility (npub membership) is public, but the coordinator cannot link an eligible npub to a specific vote if blind issuance is implemented correctly.

Coordinator is trusted for correctness but must provide inclusion proofs.

With issuance commitments and a hard supply cap, the coordinator cannot:

- Inflate voter eligibility beyond max_supply
- Introduce hidden proofs after issuance
- Burn more proofs than were issued

The remaining trust assumption is that the coordinator does not censor valid proof submissions.

With 2-of-3 mint quorum (see `02-3MINT_QUORUM_MODEL.md`):

- Single-mint censorship is tolerated
- Single-mint phantom voter injection is prevented
- At least 2 mints must collude to break the system

---

## Ephemeral Keypair and Voter Privacy

Every vote event (kind 38000) and its corresponding proof DM (kind 4) are published under a freshly generated ephemeral Nostr keypair — not the voter's real npub from `eligible-voters.json`. This is not an implementation detail; it is the primary mechanism that preserves ballot secrecy against two distinct adversary classes.

### Voter vs. the Public

The vote event (kind 38000) is intentionally public so that anyone can independently verify the tally. If it were signed by the voter's real npub, any relay operator or passive observer could trivially construct a mapping of `npub → vote choice`, destroying ballot secrecy entirely. The ephemeral key makes the public vote unlinkable to any real-world identity.

### Voter vs. the Coordinator

This is the more critical threat. The coordinator has a privileged position: it processes proofs, interacts with the mint, and facilitates tallying. It necessarily observes both the proof content and the vote content. If the NIP-04 DM were signed by the real npub, the coordinator would learn which eligible voter cast which vote — information it has no legitimate need for. Its job is only to verify that the proof itself is valid and unspent.

Two cryptographic layers ensure the coordinator cannot link issuance to a vote:

1. **Cryptographic unlinkability (Cashu blind signatures):** During issuance, the voter requests a token under their real npub (kind 38010). Because Cashu uses blind signatures, the token the coordinator helps issue cannot later be linked back to that specific issuance request. The proof submitted for burning is cryptographically independent of the issuance claim.

2. **Identity separation (ephemeral key):** Even if the blind signature scheme had a weakness, the ephemeral key provides a second layer. The coordinator sees the DM arrive from a random npub it has never encountered before and has no way to correlate it with the npub that appeared in the kind 38010 issuance event.

### Summary of Key Usage by Event Kind

| Event Kind | Purpose | Signed By | Eligibility Checked? |
|---|---|---|---|
| 38010 | Issuance claim | Voter's real npub | Yes — pubkey must be in `eligible-voters.json` |
| 38000 | Public vote | Ephemeral keypair | No |
| 4 (NIP-04 DM) | Proof submission to coordinator | Same ephemeral keypair as ballot | No |

The real npub proves *this person is eligible* during issuance; the ephemeral npub proves *someone eligible voted this way* during casting — and the two cannot be linked.

---

## Remaining Attack Surfaces

### 1. Censorship of Proof Submissions

The coordinator could refuse to burn valid proofs or ignore encrypted proof submission events.

Mitigation:
- Public acceptance receipts (kind 38002)
- Monitoring for unacknowledged proof submissions
- Multiple relays to reduce relay-level censorship
- 2-of-3 quorum tolerates single-mint censorship

### 2. Selective Issuance Bias

The coordinator could selectively issue proofs to favored participants before publishing the issuance root.

Mitigation:
- Public eligibility rules
- Transparent issuance window
- Third-party auditing of issuance list before root publication

### 3. Timing Attacks

The coordinator could close issuance early, close voting early, or delay publishing commitment roots.

Mitigation:
- Election announcement (kind 38008) defines start_time and end_time
- Mint hard cap declaration (kind 38007) is immutable
- Clients reject coordinator events that violate declared timing

### 4. Withholding Subset Proofs

If the coordinator does not provide inclusion proofs of spent commitments in the issuance tree, external verification becomes impossible.

Mitigation:
- Verification tools must require subset proofs before accepting final result

### 5. Relay-Level Data Availability

Nostr relays may drop events or refuse to serve historical events.

Mitigation:
- Publish to multiple relays
- Archive election events externally
- Encourage independent relay operators

### 6. Coordinator Key Compromise

If the coordinator's signing key is compromised, an attacker could publish fraudulent results.

Mitigation:
- Hardware key storage
- Publicly pinned coordinator pubkey
- Optional multi-signature coordinator design (future enhancement)

---

## Trust Model Summary

The coordinator is constrained by:

- Hard supply cap
- Public issuance commitment
- Public spent commitment
- Merkle-auditable vote set
- Subset proof requirement
- 2-of-3 quorum (if multi-mint)

The remaining trust assumptions are limited to:

- Fair issuance policy
- Non-censorship of valid voters
- Honest timing adherence

The system is therefore not trustless, but is auditable with bounded cheating capability.
