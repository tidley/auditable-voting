# 3-Mint Election Quorum Model

This document defines the privacy-preserving multi-mint architecture using:

- Coordinator-managed proof issuance
- Three independent Cashu mints
- Threshold-style eligibility (k-of-3 recommended: 2-of-3)
- Nostr-based vote publication
- Transparent eligibility set (published npub list or Merkle root)

The design provides:

- Unlinkable eligibility credentials
- Supply transparency
- Censorship resistance (bounded)
- Phantom voter resistance

> **Source of truth:** This repo (`tg-mint-orchestrator/docs/`) is the canonical location for all protocol specifications. The copy in `../auditable-voting/docs/` is outdated and should not be referenced.

---

# High-Level Model

Each voter must obtain blinded proofs from three independent mints during a public issuance window. In the current implementation, issuance is coordinator-managed via gRPC approval (see `05-VOTING_ISSUANCE_NOSTR_CLIENT_DESIGN.md`).

At vote time:

- Voter publishes a Nostr vote event (kind 38000).
- Voter submits proofs privately to each mint.
- Mints burn proofs. Coordinators publish spent commitments (kind 38006).
- Final tally includes only votes backed by valid mint quorum.

Recommended validation rule:

    Vote valid ⇔ proofs from at least 2-of-3 mints are valid and unspent

---

# Actors

- Voter (runs Cashu wallet)
- Coordinator (announces election, approves issuance, derives key from mint mnemonic)
- Mint A
- Mint B
- Mint C
- Nostr relays
- Public verifiers

---

# Phase 1 — Election Creation

### 1a. Coordinator Announces Election

The coordinator publishes kind 38008 with election questions, timing, and mint URLs. The event's ID becomes the election_id. See `04-VOTING_EVENT_INTEROP_NOTES.md` for the full spec.

### 1b. Each Coordinator Declares Hard Cap

Each coordinator publishes kind 38007:

- max_supply
- Issuance window
- Voting window
- Eligibility set commitment (eligible npubs via kind 38009)

All mints reference the same election_id (the kind 38008 event ID).

```
CoordinatorA -->|kind 38007| Relays
CoordinatorB -->|kind 38007| Relays
CoordinatorC -->|kind 38007| Relays
Relays --> Voters
```

Invariants:

- max_supply is immutable per mint
- Election parameters are publicly visible before issuance begins
- Only npubs included in the published eligibility set may obtain blind-issued proofs

---

# Phase 2 — Proof Issuance (Coordinator-Managed)

In the current implementation, issuance is not self-service but coordinator-managed. Voters interact with the coordinator via Nostr, and the coordinator approves mint quotes via gRPC.

### Sequence: Coordinator-Managed Issuance

```
Voter -> Relays: publish kind 38010 (quote_id, mint_url, amount=1, election_id)
Relays -> Coordinator: filtered by ["p", coordinator_npub]
Coordinator: check pubkey in eligible_set
Coordinator: check not already issued
Coordinator: check amount == 1 sat
Coordinator -> Mint: gRPC UpdateNut04Quote(quote_id, state="paid")
Mint -> Voter: quote state becomes "paid"
Voter -> Mint: POST /v1/mint/bolt11 (blinded outputs)
Mint -> Voter: signed blinded proofs
Voter: unblind and store proofs
```

This process is repeated independently for each mint (or at least 2-of-3 for quorum).

Privacy property:

- Coordinator sees which eligible npub requested issuance
- Mint never sees the voter's npub (only the coordinator's gRPC approval)
- Mint cannot link final proof secret to issuance request due to blind signatures

---

# Phase 3 — Vote Publication

Voter publishes vote event publicly via Nostr.

Kind: 38000

```json
{
  "election_id": "<38008_event_id>",
  "responses": [
    {"question_id": "q1", "value": "Alice"}
  ],
  "timestamp": 1710000000
}
tags:
  - ["election", "<election_id>"]
```

Vote event does NOT contain any Cashu proofs.

---

# Phase 4 — Proof Submission (Out-of-Band)

Voter submits proofs privately to each mint.

Transport options:

- Encrypted Nostr DM (NIP-04 / NIP-44) — kind 38001
- HTTPS endpoint
- Tor strongly recommended

```
Voter -> MintA: Encrypted {event_id, proof_A}
Voter -> MintB: Encrypted {event_id, proof_B}
Voter -> MintC: Encrypted {event_id, proof_C}
```

Each coordinator:

- Verifies proof signature (via mint)
- Ensures proof not previously spent
- Burns proof (via mint)
- Records commitment = SHA256(proof_secret)
- Publishes acceptance receipt (kind 38002)

---

# Phase 5 — Transparency Publication

Each coordinator publishes:

- Issuance commitment root (kind 38005)
- Spent commitment root (kind 38006)
- total_issued
- total_spent

```
CoordinatorA --> Relays
CoordinatorB --> Relays
CoordinatorC --> Relays
```

Public verifiers check:

- spent ⊆ issuance
- total_issued <= max_supply
- total_spent <= total_issued

---

# Vote Validation Rule (2-of-3 Recommended)

A vote is valid if:

1. Vote event is included in vote Merkle tree
2. At least 2 mints include the corresponding proof commitment in their spent tree

This prevents:

- Single-mint censorship
- Single-mint phantom voter injection

---

# Adversarial Analysis

## Threat 1 — Single Malicious Mint

If 1 mint:

- Refuses issuance → voter can still obtain 2-of-3
- Refuses burn → 2-of-3 still sufficient
- Attempts phantom issuance → cannot fabricate quorum alone

Security holds if ≥ 2 mints are honest.

---

## Threat 2 — Two Colluding Mints

If 2 mints collude:

- They can censor (block quorum)
- They can fabricate eligibility

This is the quorum failure boundary.

Trust assumption:

    At least 2 mints behave honestly.

---

## Threat 3 — Issuance Bias

Each mint controls its issuance policy.

Mitigation:

- Transparent eligibility rules
- Public issuance window
- Independent auditors

Bias requires ≥ 2 mints to align to affect quorum.

---

## Threat 4 — Mint Learns Vote Identity

Blind issuance prevents linking proof to issuance identity.

Mint only learns:

- Proof secret at burn time
- Associated vote event id

Mint does NOT learn:

- Which human received that proof

Unless blind protocol is broken or network metadata is logged.

---

## Threat 5 — Network-Level Deanonymization

Possible if mints log:

- IP addresses
- Timing correlations

Mitigation:

- Wallet uses Tor
- Delay between issuance and voting
- Multiple relays

---

# Trust Model Summary

Compared to a single-mint design:

- Phantom voter attack requires ≥ 2 mints colluding
- Censorship requires ≥ 2 mints colluding
- Eligibility inflation requires ≥ 2 mints colluding

This is a Byzantine-style threshold trust model without a blockchain.

Security assumption:

    Fewer than 2 mints are malicious.

---

# Privacy Guarantees

- Votes are public but unlinkable to identity
- Proof issuance is blind
- Proof submission is private
- No proof appears in public vote events

The system achieves anonymous eligibility with auditable bounded supply.

---

# Recommended Parameters

- Number of mints: 3
- Quorum requirement: 2-of-3
- Blind issuance mandatory
- Issuance + spent commitment roots required
- Tor recommended for wallet transport
- Coordinator key derived from mint mnemonic (BIP32 master key)

---

# Current Implementation

The current deployment uses CDK Cashu mints behind Traefik on a VPS, with coordinator-managed issuance via gRPC. See `06-VPS_VOTING_PLAYBOOK_DESIGN.md` for deployment details.

- Mint URLs: `http://mint-{a,b,c}.mints.<vps_ip>.sslip.io`
- gRPC: `<vps_ip>:808{6,7,8}`
- Coordinator keys: derived from each mint's BIP39 mnemonic via BIP32 master key
- Issuance: voter publishes kind 38010 → coordinator approves via gRPC → voter mints proof

This model provides strong censorship resistance, bounded trust, and preserved voter anonymity without introducing blockchain consensus.
