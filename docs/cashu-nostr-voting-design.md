# Cashu-Authenticated, Nostr-Published, Merkle-Auditable Voting System

## System Overview

Eligibility is defined by possession of a valid Cashu proof issued by a trusted mint.

- 1 proof = 1 vote
- Proofs are revealed privately to the mint
- Mint burns proofs and maintains a spent set
- Votes are publicly published via ephemeral Nostr npubs
- Mint computes tally
- Mint constructs a Merkle tree over accepted vote events
- Mint publishes Merkle root and final tally
- Voters receive Merkle inclusion proofs
- Mint publishes issuance commitment root
- Mint publishes spent commitment root
- Election defines a hard cap (max_supply)

The mint is trusted to issue proofs and compute results, but must provide cryptographic inclusion proofs so voters can verify their vote was counted.

This design additionally enforces issuance transparency and a fixed election supply so the mint cannot inflate the number of eligible votes without detection.

---

## Participants

Mint:
- Issues Cashu proofs
- Validates and burns proofs
- Accepts vote submissions
- Computes tally
- Builds Merkle tree over accepted votes
- Publishes Merkle root and results
- Provides inclusion proofs

Voter:
- Holds one valid Cashu proof
- Generates ephemeral Nostr keypair
- Publishes vote event
- Submits proof privately
- Verifies inclusion proof

Nostr Relays:
- Broadcast and store vote events

---

## Voting Flow

### 1. Ephemeral Identity

Voter generates a new Nostr keypair for this vote.

### 2. Public Vote Event

Nostr event content (plaintext):

{
  "election_id": "<string>",
  "vote_choice": "<candidate_id>",
  "timestamp": "<unix>"
}

- Custom kind (e.g., 38000)
- Tagged with election_id
- Signed by ephemeral key

### 3. Private Proof Submission

Voter sends to mint:

{
  "nostr_event_id": "<id>",
  "cashu_proof": "<proof>"
}

Proof is not publicly revealed.

### 4. Mint Validation

Mint verifies:
- Proof signature validity
- Proof not already spent
- Referenced Nostr event exists
- Election is active

If valid:
- Add proof secret to spent_set
- Add nostr_event_id to accepted_votes

---

## Accepted Vote Set

accepted_votes = set of nostr_event_ids

Only accepted votes are included in the Merkle tree.

---

## Election Supply Transparency

To prevent phantom vote inflation, the system commits to both issuance and spent proofs.

### Hard Cap

At election creation, the mint publishes:

{
  "election_id": "...",
  "max_supply": 5000
}

Invariant:

- Total issued proofs <= max_supply
- Total spent proofs <= total issued proofs

This prevents the mint from minting unlimited eligibility.

---

### Issuance Commitment Root

During the issuance phase, the mint computes commitments over every issued proof:

commitment = SHA256(proof_secret)

All commitments are placed into a Merkle tree.

Leaves sorted lexicographically by commitment.

The mint publishes:

{
  "election_id": "...",
  "issuance_commitment_root": "<hex>",
  "total_issued": 5000
}

This commits the mint to the exact set of eligible proofs.

---

### Spent Commitment Root

When voting concludes, the mint constructs a second Merkle tree over spent proof commitments:

spent_commitment = SHA256(proof_secret)

Leaves sorted lexicographically by commitment.

The mint publishes:

{
  "election_id": "...",
  "spent_commitment_root": "<hex>",
  "total_proofs_burned": 1234
}

Security guarantees:

- Every spent commitment must exist in the issuance commitment tree
- total_proofs_burned <= total_issued
- total_issued <= max_supply

This prevents the mint from introducing hidden eligibility or secretly minting additional votes.

---

## Merkle Tree Construction

### Leaf Encoding

leaf = SHA256(
    nostr_event_id ||
    vote_pubkey ||
    vote_choice ||
    timestamp
)

Canonical JSON encoding required.

### Ordering

Leaves sorted lexicographically by nostr_event_id.

### Internal Node

parent = SHA256(left || right)

If odd number of nodes, duplicate last node.

Final output: merkle_root

---

## Published Final Result

Mint publishes signed event:

{
  "election_id": "...",
  "total_votes": 1234,
  "results": {
    "Alice": 600,
    "Bob": 634
  },
  "merkle_root": "<hex>",
  "total_proofs_burned": 1234,
  "issuance_commitment_root": "<hex>",
  "spent_commitment_root": "<hex>",
  "max_supply": 5000
}

---

## Inclusion Proof

Mint returns to voter:

{
  "nostr_event_id": "...",
  "leaf_hash": "...",
  "merkle_path": [
    { "position": "left", "hash": "..." },
    { "position": "right", "hash": "..." }
  ],
  "merkle_root": "..."
}

Voter recomputes root and verifies match.

---

## Security Properties

Double voting prevented via spent_set.

Votes are public but unlinkable to Cashu proof.

Mint is trusted for correctness but must provide inclusion proofs.

With issuance commitments and a hard supply cap, the mint cannot:

- Inflate voter eligibility beyond max_supply
- Introduce hidden proofs after issuance
- Burn more proofs than were issued

The remaining trust assumption is that the mint does not censor valid proof submissions.

---

## Remaining Attack Surfaces

Even with issuance transparency and a hard cap, some risks remain.

### 1. Censorship of Proof Submissions

The mint could refuse to burn valid proofs or ignore encrypted proof submission events.

Effect:
- Eligible voters may be excluded.

Mitigation ideas:
- Public acceptance receipts (Kind 38002)
- Monitoring for unacknowledged proof submissions
- Multiple relays to reduce relay-level censorship

---

### 2. Selective Issuance Bias

The mint could selectively issue proofs to favored participants before publishing the issuance root.

Effect:
- Biased electorate composition.

Mitigation ideas:
- Public eligibility rules
- Transparent issuance window
- Third-party auditing of issuance list before root publication

---

### 3. Timing Attacks

The mint could:
- Close issuance early
- Close voting early
- Delay publishing commitment roots

Mitigation ideas:
- Election creation event (Kind 38007) defines immutable start_time and end_time
- Clients reject mint events that violate declared timing

---

### 4. Withholding Subset Proofs

If the mint does not provide inclusion proofs of spent commitments in the issuance tree, external verification becomes impossible.

Mitigation:
- Verification tools must require subset proofs before accepting final result

---

### 5. Relay-Level Data Availability

Nostr relays may:
- Drop events
- Refuse to serve historical events

Mitigation:
- Publish to multiple relays
- Archive election events externally
- Encourage independent relay operators

---

### 6. Mint Key Compromise

If the mint’s signing key is compromised, an attacker could publish fraudulent results.

Mitigation:
- Hardware key storage
- Publicly pinned mint pubkey
- Optional multi-signature mint design (future enhancement)

---

## Trust Model After Enhancements

The mint is now constrained by:

- Hard supply cap
- Public issuance commitment
- Public spent commitment
- Merkle-auditable vote set
- Subset proof requirement

The remaining trust assumption is limited to:

- Fair issuance policy
- Non-censorship of valid voters
- Honest timing adherence

The system is therefore not trustless, but is auditable with bounded cheating capability.
