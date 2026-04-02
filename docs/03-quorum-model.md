# Multi-Coordinator Election Model

This document defines the multi-coordinator architecture using:

- Multiple independent coordinators (each with their own mint)
- Coordinator-managed proof issuance
- 1-of-N quorum (any coordinator acceptance counts)
- Nostr-based vote publication
- Canonical eligible set with cross-coordinator verification
- Mandatory voter confirmations (kind 38013) for anti-inflation detection
- Phased timing (voting window + confirmation window) for anti-doxing

The design provides:

- Unlinkable eligibility credentials
- Supply transparency
- Censorship resistance (1-of-N)
- Phantom voter detection
- Coordinator fraud detection

---

# High-Level Model

Multiple independent coordinators participate in the same election. Each coordinator runs its own mint. Voters obtain one blinded proof from each coordinator during a public issuance window.

At vote time:

- Voter publishes one Nostr vote event (kind 38000) with proof-hash tags for each coordinator.
- Voter submits proofs privately to each coordinator via NIP-04 DM.
- Each coordinator burns proofs and publishes its own acceptance receipts (kind 38002).
- Each coordinator publishes its own tally (kind 38003).
- Voters and auditors compare tallies across coordinators.
- Voters publish mandatory confirmations (kind 38013) from their real npub during the confirmation window.

Validation rule:

    Vote heard ⇔ at least 1 coordinator accepted the proof

Fraud detection:

    Coordinator inflated ⇔ coordinator tally > canonical voter confirmations
    Coordinator censored  ⇔ coordinator tally < canonical voter confirmations

---

# Actors

- Voter (runs Cashu wallet, interacts with all coordinators)
- Coordinator A (independent operator, own mint, own Nostr key)
- Coordinator B (independent operator, own mint, own Nostr key)
- Coordinator N (any number of independent coordinators)
- Nostr relays
- Auditors (verify cross-coordinator consistency)

---

# Phase 0 — Election Creation

Any coordinator can create an election by publishing kind 38008:

- Election questions, title, description
- Timing: vote_start (t0), vote_end (t1), confirm_end (t2)
- Canonical eligible set (eligible-root, eligible-count, eligible-url)
- Expected coordinator participants (["coordinator", npub] tags)

The event's ID becomes the election_id.

---

# Phase 0b — Coordinators Join

Other coordinators discover the election via relay subscription to kind 38008 and join by:

1. Fetching the canonical eligible list from `eligible-url`
2. Computing the Merkle root
3. Verifying it matches `eligible-root` from 38008
4. Publishing kind 38007 (hard cap + eligible-root commitment + timing)
5. Publishing kind 38009 (eligibility set commitment)
6. Publishing kind 38012 (coordinator info — HTTP API, mint URL, relays)

Voters discover coordinators by:
1. Reading `["coordinator", ...]` tags from 38008
2. Querying kind 38012 by each coordinator's npub

```
CoordinatorA -->|kind 38007, 38009, 38012| Relays
CoordinatorB -->|kind 38007, 38009, 38012| Relays
Relays --> Voters (discover via 38008 + 38012)
```

Invariants:

- All coordinators' eligible-roots must match the canonical root from 38008
- All coordinators' timing must match 38008
- max_supply must equal canonical eligible_count

---

# Phase 1 — Proof Issuance (Per Coordinator)

Voters obtain one proof from each coordinator independently.

### Sequence (repeated for each coordinator):

```
Voter -> Coordinator's Mint: POST /v1/mint/quote/bolt11
Voter -> Relays: publish kind 38010 (["p", coordinator_npub], quote_id, mint_url, amount=1, election_id)
Coordinator: check pubkey in canonical eligible_set
Coordinator: check not already issued
Coordinator: check amount == 1 sat
Coordinator -> Mint: gRPC UpdateNut04Quote(quote_id, state="paid")
Mint -> Voter: quote state becomes "paid"
Voter -> Mint: POST /v1/mint/bolt11 (blinded outputs)
Mint -> Voter: signed blinded proofs
Voter: unblind and store proof + proof_secret
```

Privacy property:

- Coordinator sees which eligible npub requested issuance
- Mint never sees the voter's npub (only the coordinator's gRPC approval)
- Mint cannot link final proof secret to issuance request due to blind signatures

---

# Phase 2 — Vote Publication

Voter publishes vote event publicly via Nostr with proof-hash tags:

```
kind: 38000
content: {election_id, responses, timestamp}
tags:
  - ["election", "<election_id>"]
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_A)>"]
  - ["proof-hash", "<SHA256(proof_secret_for_coordinator_B)>"]
```

The proof-hash tags are public commitments. Anyone can verify a coordinator received the proof by cross-referencing with that coordinator's kind 38002 events (which contain `proof_commitment`).

Vote event does NOT contain the proofs themselves.

---

# Phase 3 — Proof Submission (Per Coordinator)

Voter submits proofs privately to each coordinator via NIP-04 encrypted DM.

```
Voter -> CoordinatorA: Encrypted DM {event_id, proof_A}
Voter -> CoordinatorB: Encrypted DM {event_id, proof_B}
```

Each coordinator:
- Verifies proof signature (via its mint)
- Ensures proof not previously spent
- Burns proof (via its mint)
- Records commitment = SHA256(proof_secret)
- Publishes acceptance receipt (kind 38002)

---

# Phase 4 — Voter Confirmation

After the voting window closes (t1), each voter publishes a kind 38013 from their **real npub**:

```
kind: 38013
pubkey: <voter_real_npub>
content: {"election_id": "<election_id>", "action": "voted"}
tags: [["election", "<election_id>"]]
```

Must be published during t1–t2. Events before t1 are rejected.

This establishes the canonical confirmation count: the number of real eligible voters who actually voted.

---

# Phase 5 — Transparency Publication

Each coordinator publishes:

- Issuance commitment root (kind 38005)
- Spent commitment root (kind 38006)
- Final result (kind 38003)
- total_issued, total_spent

Public verifiers and auditors check:
- spent ⊆ issuance (per coordinator)
- total_issued <= max_supply (per coordinator)
- total_spent <= total_issued (per coordinator)
- All coordinators' eligible-roots match canonical root
- All coordinators' tallies are consistent with canonical confirmations

---

# Audit Algorithm

For each coordinator C:

```
canonical_confirmations = count of 38013 events where:
    election_id matches
    created_at >= vote_end AND created_at <= confirm_end
    pubkey ∈ canonical_eligible_set

fake_confirmations = 38013 events where pubkey ∉ canonical_eligible_set

tally_C = C's 38003.total_votes

if tally_C > canonical_confirmations:
    FLAG("inflation")
if tally_C < canonical_confirmations:
    FLAG("censorship")
if fake_confirmations > 0:
    FLAG("fake voters")

for each 38011 from C:
    if approved_npub ∉ canonical_eligible_set:
        FLAG("issuance to non-canonical npub")
```

---

# Vote Validation Rule (1-of-N)

A vote is heard if:

1. At least one coordinator published a kind 38002 for the vote event
2. The vote event exists on relays (kind 38000)
3. At least one coordinator includes it in its vote Merkle tree

A vote is verified-legitimate if:

1. The voter published a 38013 confirmation from their real npub
2. The real npub is in the canonical eligible set
3. At least one coordinator accepted the corresponding proof

---

# Adversarial Analysis

## Threat 1 — Single Malicious Coordinator

If 1 of N coordinators is malicious:

- Refuses issuance → voter gets proofs from other coordinators
- Refuses burn → other coordinators still accept
- Attempts phantom issuance → detected via 38011 audit (non-canonical npubs) and 38013 confirmations (tally > confirmations)
- Attempts censorship → detected via 38013 (tally < confirmations)

Security holds if at least 1 coordinator is honest.

---

## Threat 2 — N-1 Malicious Coordinators

If N-1 of N coordinators collude:

- They can censor (the one honest coordinator's tally is the only accurate one)
- They can inflate (but the honest coordinator's lower tally exposes this)
- Auditors can identify which coordinator is honest by comparing against canonical confirmations

The honest coordinator provides ground truth. The system degrades gracefully.

---

## Threat 3 — All Coordinators Collude

If all N coordinators collude:

- They can censor, inflate, and fabricate
- 38013 confirmations still provide a lower bound from voters themselves
- But if no auditor notices, the fraud stands

This is the fundamental trust boundary. Mitigation:
- Make it easy for anyone to deploy a coordinator
- Encourage diverse, independent coordinator operators
- More coordinators = harder to collude

---

## Threat 4 — Eligibility Inflation

A coordinator adds fake npubs to its local eligible-voters.json and issues proofs to itself.

Detection:
- Coordinator's 38009 eligible-root will differ from canonical root → detected immediately
- If coordinator lies about root: 38011 events will reference non-canonical npubs → detected by auditor
- Coordinator's tally will exceed canonical confirmations → detected by 38013 audit

---

## Threat 5 — Fake Voter Confirmations

A coordinator publishes 38013 events from its fake npubs to pad the confirmation count.

Detection:
- 38013 events from npubs not in the canonical eligible set are trivially filtered
- These non-canonical 38013s are themselves red flags (evidence of fraud attempt)

---

## Threat 6 — Timing Attack (Doxing)

An observer correlates vote events (ephemeral keys) with confirmation events (real keys) based on publication timestamps.

Mitigation:
- Phased timing: voting window (t0–t1) is separated from confirmation window (t1–t2)
- All votes are submitted during t0–t1, all confirmations during t1–t2
- Temporal correlation is unreliable — all confirmations happen in a batch after all votes

---

## Threat 7 — Coordinator Learns Vote Identity

Blind issuance prevents linking proof to issuance identity.

Coordinator only learns:
- Proof secret at burn time
- Associated vote event id

Coordinator does NOT learn:
- Which human received that proof

Additional protection from phased timing:
- Even if coordinator observes when a 38013 appears from a real npub, it cannot reliably correlate it to a specific vote event because all confirmations are batched in the confirmation window

---

# Trust Model Summary

Compared to a single-coordinator design:

- Censorship by any single coordinator is detectable
- Inflation by any single coordinator is detectable
- Fake voter injection is detectable
- Only one honest coordinator needed for a vote to be heard
- Timing attacks on voter identity are mitigated by phased windows

Security assumption:

    At least 1 coordinator behaves honestly.

---

# Privacy Guarantees

- Votes are public but unlinkable to identity (ephemeral keys)
- Proof issuance is blind
- Proof submission is private (encrypted DM)
- No proof appears in public vote events
- Voter confirmations are separated from votes by a time gap
- The system achieves anonymous eligibility with auditable bounded supply

---

# Recommended Parameters

- Number of coordinators: ≥ 3
- Quorum requirement: 1-of-N (any coordinator acceptance counts)
- Blind issuance mandatory
- Issuance + spent commitment roots required
- Mandatory voter confirmations (kind 38013)
- Phased timing: confirmation window starts after voting window closes
- Tor recommended for wallet transport
- Coordinator key derived from mint mnemonic (BIP32 master key)

---

# Deployment Model

Each operator independently deploys their own coordinator + mint:

```bash
make deploy                    # Deploy coordinator + mint to your VPS
make join-election ELECTION_ID=<id>  # Join an existing election
```

No shared infrastructure between coordinators. Each operator provides their own VPS, mint, and Nostr key. The only shared state is the canonical eligible set (referenced by URL in the 38008 event) and the Nostr relay network.
