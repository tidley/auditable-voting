# Demo Development Plan

This document describes a practical plan to build a compelling demo of the:

- Transparent eligibility set
- Blind Cashu issuance
- Nostr-published vote
- Private proof submission
- Merkle-auditable tally
- Optional 3-mint quorum model

The goal is not production readiness. The goal is a clear, exciting 5-minute demo that proves the core ideas.

---

# Demo Goals

In 5 minutes, the audience should see:

1. Public list of eligible npubs
2. User proves eligibility by signing a challenge
3. Blind issuance occurs
4. Vote is published publicly (Nostr event)
5. Proofs are submitted privately
6. Merkle root is produced
7. Inclusion proof verifies the vote
8. (Optional) 2-of-3 mint quorum working

---

# Architecture for the Demo

Keep everything simple and local.

Components:

- `mint-A` (Node/TS service)
- `mint-B`
- `mint-C`
- `vote-coordinator` (can be same process as mint for demo)
- `wallet-cli`
- (Optional) Real Nostr relay

State can be in-memory.

---

# Phase 1 — Eligibility Setup

## Step 1: Define Eligible npubs

Hardcode a small list (e.g., 3 npubs) in a JSON file:

```json
{
  "eligible_npubs": [
    "npub1...",
    "npub1...",
    "npub1..."
  ]
}
```

For demo simplicity:

- You may skip Merkle tree for eligibility.
- Just check membership in array.

Mint publishes (log to console or Nostr event):

```
eligible_count = 3
```

---

# Phase 2 — Eligibility Verification Flow

Implement challenge-response:

### Mint

- Endpoint: `/challenge`
- Returns random 32-byte challenge

### Wallet

- Signs challenge using eligible Nostr private key
- Sends signature back to mint

### Mint

- Verifies signature
- Confirms npub is in eligible list
- If valid → allow blind issuance

---

# Phase 3 — Blind Issuance (Minimal Implementation)

For demo, you do NOT need full Cashu.

Minimal viable model:

1. Wallet generates random `secret`
2. Wallet computes `commitment = SHA256(secret)`
3. Wallet sends commitment
4. Mint signs commitment with secp256k1 key
5. Wallet stores `{secret, signature}` as proof

This preserves the key idea:

- Secret is generated client-side
- Mint signs something derived from it
- Mint never sees secret until burn

---

# Phase 4 — Vote Publication

Two options:

## Option A (Simpler)

Just log vote event locally.

## Option B (More Impressive)

Use `nostr-tools`:

- Generate ephemeral key
- Create event kind 38000
- Publish to public relay

This creates a visible public vote.

---

# Phase 5 — Proof Submission

Wallet submits to each mint:

```json
{
  "event_id": "...",
  "secret": "...",
  "signature": "..."
}
```

Mint verifies:

- signature valid for SHA256(secret)
- secret not already spent

If valid:

- Add secret to `spent_set`
- Add event_id to `accepted_votes`

---

# Phase 6 — Merkle Tree + Tally

At end of demo:

1. Collect accepted vote events
2. Compute leaf = SHA256(event_id || pubkey || vote_choice || timestamp)
3. Sort lexicographically
4. Build Merkle tree
5. Print root

Provide CLI command:

```
wallet verify <event_id>
```

It recomputes inclusion proof and verifies root.

---

# Optional — 3-Mint 2-of-3 Quorum

For extra impact:

Rule:

```
Vote valid if at least 2 mints accept proof
```

Implementation:

- Each mint returns `accepted: true/false`
- Coordinator counts approvals
- If approvals >= 2 → accept vote

Live demo trick:

- Simulate Mint C failure
- Still show vote valid

---

# Suggested File Structure

```
src/
  mint.ts
  wallet.ts
  merkle.ts
  quorum.ts
  nostrClient.ts (optional)
```

---

# 3–4 Hour Implementation Plan

Hour 1:
- Implement eligibility list
- Implement challenge verification

Hour 2:
- Implement simplified blind issuance
- Store proof in wallet

Hour 3:
- Implement vote submission
- Implement spent set
- Build Merkle tree

Hour 4 (optional):
- Add 3-mint quorum
- Add Nostr publishing
- Polish CLI output

---

# What Makes the Demo Exciting

During the demo:

1. Show eligible list
2. Sign challenge live
3. Mint proof
4. Publish vote
5. Submit proof
6. Show Merkle root
7. Verify inclusion
8. Kill one mint → quorum still works

That sequence clearly communicates:

- Eligibility control
- Blind issuance
- Vote privacy
- Auditability
- Censorship resistance

---

# What Not To Build

- Full Cashu protocol
- Persistent DB
- Full REST production server
- Frontend UI

Keep everything CLI and in-memory.

---

# Demo Narrative Script (5 Minutes)

1. "Here is the public list of eligible voters."
2. "I prove control of my npub."
3. "Mint blindly issues credential."
4. "I publish my vote publicly."
5. "I privately submit proof."
6. "Mint cannot link my vote to my npub."
7. "Here is the Merkle root."
8. "Here is my inclusion proof."
9. "Even if one mint fails, quorum still works."

---

This demo proves the core cryptographic separation between eligibility and vote while remaining feasible within a few hours of development.
