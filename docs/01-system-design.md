# Cashu-Authenticated, Nostr-Published, Merkle-Auditable Voting System

## System Overview

A multi-coordinator voting system where multiple independent operators each run their own coordinator + mint pair. Voters interact with all participating coordinators, and one honest coordinator is sufficient for a vote to be heard.

- 1 proof per coordinator = 1 vote contribution
- Proofs are revealed privately to each coordinator's mint
- Each mint burns proofs and maintains its own spent set
- Votes are publicly published via ephemeral Nostr npubs
- Each coordinator independently computes its own tally
- Each coordinator constructs its own Merkle tree over accepted vote events
- Each coordinator publishes its own Merkle root and final tally
- Voters receive Merkle inclusion proofs from each coordinator
- Voters publish mandatory confirmations (kind 38013) from their real identity
- Auditors compare tallies across coordinators to detect fraud

### Canonical Eligible Set

The election creator defines the authoritative list of eligible npubs in the kind 38008 event. All participating coordinators must commit to this same set via kind 38009 (eligible-root tag). Auditors verify that all coordinators' roots match.

### Anti-Inflation via Voter Confirmations

After voting, each voter publishes a kind 38013 event from their real npub during the confirmation window. Auditors count canonical confirmations (38013 from npubs in the eligible set) and compare against each coordinator's tally:

- `tally > canonical_confirmations` → coordinator inflated (fake votes)
- `tally < canonical_confirmations` → coordinator censored (ignored real votes)
- 38013 from non-canonical npub → fake voter sock puppet detected

### Phased Timing (Anti-Doxing)

Elections have two phases separated by a time gap:

```
┌─────────────┐         ┌──────────────┐
│  VOTING     │  GAP    │ CONFIRMATION │
│  WINDOW     │         │  WINDOW      │
│  t0 → t1    │         │  t1 → t2     │
│             │         │              │
│ vote events │         │ 38013 events │
│ proof DMs   │         │              │
└─────────────┘         └──────────────┘
```

This prevents timing-based correlation between vote events (ephemeral keys) and confirmation events (real keys), protecting ballot secrecy.

---

## Participants

Coordinator (per operator):
- Can create elections (publishes kind 38008)
- Can join existing elections (publishes kind 38007)
- Publishes coordinator info (kind 38012) for discovery
- Commits to canonical eligible set (kind 38009)
- Listens for proof issuance requests (kind 38010) from voters
- Auto-approves eligible requests via gRPC to its own mint
- Enforces 1 proof per npub
- Verifies eligibility of npubs against canonical eligible set
- Accepts vote submissions (via NIP-04 DM proof burning)
- Computes its own tally
- Builds its own Merkle tree over accepted votes
- Publishes its own commitment roots (kinds 38005, 38006) and final results (kind 38003)
- Provides inclusion proofs

Mint (per coordinator):
- Issues Cashu proofs (via coordinator approval)
- Validates and burns proofs

Voter:
- Discovers election and coordinators via 38008 + 38012 events
- Verifies canonical eligible set (38008 eligible-root)
- Obtains one blinded proof from each coordinator
- Controls an eligible Nostr pubkey (npub) on the canonical list
- Generates ephemeral Nostr keypair
- Publishes vote event (kind 38000) with proof-hash tags
- Submits proofs privately to each coordinator
- Publishes voter confirmation (kind 38013) during confirmation window
- Compares tallies across coordinators

Nostr Relays:
- Broadcast and store all events

Auditor:
- Verifies coordinator eligible-set commitments match canonical root
- Counts canonical voter confirmations
- Compares tallies across coordinators
- Flags inflation, censorship, and fake voter attempts

---

## Voting Flow

### 0. Election Creation

Any coordinator publishes a kind 38008 event defining the election, its questions, timing (vote_start, vote_end, confirm_end), the canonical eligible set (eligible-root, eligible-count, eligible-url), and expected coordinator participants. The event's own ID is the election_id.

### 0b. Coordinators Join

Other coordinators discover the election (via relay subscription to kind 38008) and join by publishing kind 38007 referencing the election_id. Their 38007 includes their commitment to the canonical eligible set (eligible-root tag). They also publish kind 38012 (coordinator info) and kind 38009 (eligibility commitment).

Voters discover coordinators by reading `["coordinator", ...]` tags from 38008, then querying kind 38012 by each coordinator's npub.

### 1. Canonical Eligible Set

The 38008 event defines the authoritative eligible npub set:

```
tags:
  - ["eligible-root", "<merkle_root>"]
  - ["eligible-count", "5000"]
  - ["eligible-url", "<https://...eligible-voters.json>"]
```

Where `eligible_root = MerkleRoot([SHA256(npub_hex) for npub in eligible_npubs])`.

Each coordinator independently fetches the eligible list, computes the root, and verifies it matches before joining. Auditors verify all coordinators' 38009 roots match.

### 2. Proof Issuance (Per Coordinator)

Voters obtain one proof from each coordinator independently:

1. Voter requests mint quote from coordinator's mint: `POST /v1/mint/quote/bolt11`
2. Voter publishes kind 38010 issuance request tagged with that coordinator's npub
3. Coordinator receives event, checks eligibility against canonical set, approves via gRPC
4. Voter polls mint for approval, mints blinded proof
5. Voter repeats for each coordinator

### 3. Public Vote Event

Voter generates a new ephemeral Nostr keypair and publishes:

```
kind: 38000
content: {
  "election_id": "<38008_event_id>",
  "responses": [
    {"question_id": "q1", "value": "Alice"},
    {"question_id": "q2", "values": ["Lightning dev", "Privacy research"]},
    {"question_id": "q3", "value": 7}
  ],
  "timestamp": 1710000000
}
tags:
  - ["election", "<election_id>"]
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_1)>"]
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_2)>"]
```

### 4. Private Proof Submission (Per Coordinator)

Voter submits proof to each coordinator via encrypted DM (NIP-04/44):

```
{
  "nostr_event_id": "<id>",
  "cashu_proof": "<proof>"
}
```

### 5. Proof Validation and Burning (Per Coordinator)

Each coordinator independently submits proofs to its mint, which verifies:
- Proof signature validity
- Proof not already spent
- Referenced Nostr event exists
- Election is active

If valid:
- Mint adds proof secret to spent_set
- Coordinator adds nostr_event_id to accepted_votes
- Coordinator publishes kind 38002 (acceptance receipt)

### 6. Voter Confirmation

After the voting window closes (t1), each voter publishes a kind 38013 event from their **real npub**:

```
kind: 38013
pubkey: <voter_real_npub>
content: {
  "election_id": "<election_id>",
  "action": "voted"
}
tags:
  - ["election", "<election_id>"]
```

This must be published during the confirmation window (t1–t2). Events published before t1 are rejected.

### 7. Tally Comparison

After the confirmation window closes (t2), each coordinator publishes its kind 38003 final result. Voters and auditors fetch all 38003 events and compare:

- Tallies should be similar (within tolerance for censorship)
- Any coordinator with significantly higher tally may be inflating
- Any coordinator with significantly lower tally may be censoring
- The audit algorithm (see Protocol Reference) produces formal flags

---

## Accepted Vote Set

Per coordinator:

accepted_votes = set of nostr_event_ids

Only accepted votes are included in that coordinator's Merkle tree.

A vote is "heard" if at least one coordinator includes it in its accepted_votes (1-of-N quorum).

---

## Election Supply Transparency

### Hard Cap

Each coordinator publishes kind 38007 with `max_supply` equal to the canonical eligible count.

Invariants:

- Total issued proofs <= max_supply
- Total spent proofs <= total issued proofs

---

### Issuance Commitment Root

During the issuance phase, each coordinator computes commitments over every issued proof:

commitment = SHA256(proof_secret)

All commitments are placed into a Merkle tree. Leaves sorted lexicographically by commitment.

Each coordinator publishes kind 38005 with its issuance commitment root.

---

### Spent Commitment Root

When voting concludes, each coordinator constructs a Merkle tree over spent proof commitments:

spent_commitment = SHA256(proof_secret)

Each coordinator publishes kind 38006 with its spent commitment root.

---

## Merkle Tree Construction

### Leaf Encoding

leaf = SHA256(
    nostr_event_id ||
    vote_pubkey ||
    canonical_json(responses) ||
    timestamp
)

### Eligible Set Root

eligible_leaf = SHA256(npub_hex)

eligible_root = MerkleRoot(sorted([eligible_leaf for npub in eligible_npubs]))

### Ordering

Leaves sorted lexicographically.

### Internal Node

parent = SHA256(left || right)

If odd number of nodes, duplicate last node.

Final output: merkle_root

---

## Published Final Result

Each coordinator independently publishes kind 38003:

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

---

## Inclusion Proof

Each coordinator returns to voter:

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

Double voting prevented via per-coordinator spent_set.

Votes are public but unlinkable to Cashu proof.

Eligibility (npub membership) is public, but coordinators cannot link an eligible npub to a specific vote if blind issuance is implemented correctly.

With multiple independent coordinators:

- Censorship by one coordinator is detectable (tally < canonical confirmations)
- Inflation by one coordinator is detectable (tally > canonical confirmations, or 38011 to non-canonical npubs)
- Fake voter injection is detectable (38013 from non-canonical npubs)
- Only one honest coordinator needed for a vote to be heard

---

## Ephemeral Keypair and Voter Privacy

Every vote event (kind 38000) and its corresponding proof DM (kind 4) are published under a freshly generated ephemeral Nostr keypair. The voter confirmation (kind 38013) is published under the voter's real npub, but only during the confirmation window (t1–t2), which is separated from the voting window (t0–t1) by a time gap.

### Voter vs. the Public

The vote event (kind 38000) is public so anyone can verify the tally. The ephemeral key makes the public vote unlinkable to any real-world identity.

### Voter vs. the Coordinator

Two cryptographic layers ensure the coordinator cannot link issuance to a vote:

1. **Cryptographic unlinkability (Cashu blind signatures):** The proof the coordinator helps issue cannot be linked to the issuance request.

2. **Identity separation (ephemeral key):** The coordinator sees the DM from a random npub with no correlation to the issuance event.

3. **Temporal separation (phased timing):** The confirmation window (t1–t2) is separated from the voting window (t0–t1), preventing timing-based correlation between vote events and confirmation events.

### Summary of Key Usage by Event Kind

| Event Kind | Purpose | Signed By | Eligibility Checked? |
|---|---|---|---|
| 38010 | Issuance claim (per coordinator) | Voter's real npub | Yes — pubkey must be in canonical eligible set |
| 38000 | Public vote | Ephemeral keypair | No |
| 4 (NIP-04 DM) | Proof submission to coordinator | Same ephemeral keypair | No |
| 38013 | Voter confirmation | Voter's real npub | Yes — only canonical npubs count |

---

## Remaining Attack Surfaces

### 1. Censorship of Proof Submissions

A coordinator could refuse to burn valid proofs.

Mitigation:
- 1-of-N quorum: other coordinators still accept the vote
- Public acceptance receipts (kind 38002) per coordinator
- Mandatory voter confirmations (kind 38013): tally < confirmations = proven censorship

### 2. Eligibility Inflation

A coordinator adds fake npubs to its eligible set and issues proofs to itself.

Mitigation:
- Canonical eligible set in 38008 (ground truth)
- Each coordinator's 38009 must commit to the same root (detectable mismatch)
- 38011 issuance events are public (auditable against canonical list)
- 38013 confirmations from canonical npubs establish lower bound
- Any coordinator whose tally exceeds canonical confirmations is flagged

### 3. Fake Voter Confirmations

A coordinator publishes 38013 events from its fake npubs.

Mitigation:
- Auditors filter 38013 events against the canonical eligible set
- 38013 from non-canonical npubs are trivially detected as fake
- This is actually worse for the attacker — it's public evidence of fraud

### 4. Timing Attacks (Doxing)

An observer correlates vote events (ephemeral keys) with confirmation events (real keys) based on publication time.

Mitigation:
- Phased timing: voting window (t0–t1) and confirmation window (t1–t2) are separated
- All confirmations are batched after all votes
- Temporal correlation is unreliable

### 5. Selective Issuance Bias

A coordinator could selectively issue proofs to favored participants.

Mitigation:
- Public eligibility rules
- Transparent issuance window
- 38011 events are publicly auditable

### 6. Timing Manipulation

A coordinator could close issuance early, close voting early, or delay publishing commitment roots.

Mitigation:
- Election announcement (kind 38008) defines vote_start, vote_end, confirm_end
- All coordinators' 38007 timing must match 38008
- Clients reject coordinator events that violate declared timing

### 7. Withholding Subset Proofs

If a coordinator does not provide inclusion proofs, external verification becomes impossible.

Mitigation:
- Verification tools must require subset proofs before accepting final result

### 8. Relay-Level Data Availability

Nostr relays may drop events.

Mitigation:
- Publish to multiple relays
- Archive election events externally

### 9. All Coordinators Collude

If all coordinators collude, they can censor, inflate, and fabricate.

This is the fundamental trust boundary. Mitigation:
- Encourage diverse, independent coordinator operators
- Make it easy for anyone to deploy a coordinator
- Lower the barrier to running a coordinator

---

## Trust Model Summary

Each coordinator is constrained by:

- Canonical eligible set commitment (kind 38009)
- Hard supply cap (kind 38007)
- Public issuance commitment (kind 38005)
- Public spent commitment (kind 38006)
- Merkle-auditable vote set
- Subset proof requirement
- Mandatory voter confirmations (kind 38013)

Cross-coordinator verification provides:

- Censorship detection (tally < canonical confirmations)
- Inflation detection (tally > canonical confirmations)
- Fake voter detection (38013 from non-canonical npubs)
- Eligibility root mismatch detection

The system requires at least one honest coordinator. It is auditable with bounded cheating capability.
