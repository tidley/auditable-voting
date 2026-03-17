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

The mint is trusted to issue proofs and compute results, but must provide cryptographic inclusion proofs so voters can verify their vote was counted.

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
  "total_proofs_burned": 1234
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
