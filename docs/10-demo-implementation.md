# Demo Development & Implementation Guide

> **Source of truth:** This repo (`tg-mint-orchestrator/docs/`) is the canonical location for all protocol specifications. The copy in `../auditable-voting/docs/` is outdated and should not be referenced.

This document describes the demo implementation and development roadmap for the auditable voting system.

---

## Demo Goals

In 5 minutes, the audience should see:

1. Coordinator publishes election announcement (kind 38008) with questions
2. Public list of eligible npubs (kind 38009)
3. User requests proof from mint (kind 38010 issuance request)
4. Coordinator auto-approves via gRPC
5. Vote is published publicly (kind 38000 with structured responses)
6. Proofs are submitted privately to mints
7. Coordinators publish spent commitment roots (kind 38006)
8. Merkle root is produced
9. Inclusion proof verifies the vote
10. 2-of-3 mint quorum working (tolerate single-mint failure)

---

## Current Implementation (TypeScript Prototype)

A working end-to-end demo exists in `../auditable-voting/` (TypeScript/Node.js). It demonstrates:

1. Transparent eligibility set (list of npubs)
2. Challenge-response eligibility verification
3. Simplified blind issuance (commitment + signature)
4. Private proof burn
5. Merkle tree construction over accepted votes
6. Inclusion proof verification

### Source Code

| File | Purpose |
|------|---------|
| `src/demo/demoMint.ts` | Mint: eligibility verification, blind issuance, proof burning, spent set |
| `src/demo/demoWallet.ts` | Wallet: key generation, challenge signing, blind request, proof storage, vote creation |
| `src/demo/demoCLI.ts` | CLI runner: orchestrates the full 6-step demo flow |
| `src/merkle.ts` | Merkle tree: build, inclusion proof, verification |
| `src/nostrClient.ts` | Nostr relay client: publishes vote events (used by `cli.ts`) |

### How It Works

1. Mint holds a set of eligible npubs (hex pubkeys)
2. Wallet generates a Nostr keypair, signs a mint-issued challenge
3. Mint verifies signature and checks pubkey is in eligible set
4. Wallet generates random secret, computes `commitment = SHA256(secret)`, sends to mint
5. Mint signs commitment (never sees secret)
6. Wallet creates vote event with `vote_choice` field
7. Wallet submits proof privately to mint
8. Mint verifies, burns proof, adds to accepted set
9. Mint builds Merkle tree over accepted votes
10. Inclusion proof extracted and verified

### Building and Running

```bash
cd ../auditable-voting
npm install
npm run build
node dist/demo/demoCLI.js
```

### Limitations (Current Demo)

- Single mint (no quorum)
- In-memory state only
- Vote events are local (not published to a Nostr relay in the demo flow)
- No issuance/spent commitment roots published
- Simplified blind issuance (commitment signing, not full Cashu blind signatures)
- No double-spend prevention across restarts
- Uses old single `vote_choice` field (not the new `responses` array)

---

## Current Production Deployment (CDK + Ansible)

A production-ready deployment exists using CDK Cashu mints on a VPS with coordinator-managed issuance. See `06-VPS_VOTING_PLAYBOOK_DESIGN.md`.

### Architecture

- 3 CDK Cashu mints behind Traefik reverse proxy
- Coordinator keys derived from mint mnemonics (BIP32 master key)
- gRPC for mint management (manual approval mode)
- Nostr for voter-coordinator communication (kind 38010)
- Ansible for deployment automation

### What's Deployed

- 3 voting mints running on VPS (23.182.128.64)
- Coordinator key derivation script (`scripts/derive-coordinator-keys.py`)
- Coordinator Nostr client daemon (`scripts/voting-coordinator-client.py`)
- Traefik routing for HTTP access
- gRPC ports exposed for coordinator communication

### What's Not Yet Deployed

- Kind 38008 election announcement — **publication script planned** (see below)
- Kind 38000 vote events not yet published through the system
- No inclusion proof HTTP endpoint (`GET /inclusion_proof`)
- No auto-close timer (close_election exists but no scheduled trigger)
- Voter CLI (`scripts/voting-request-proof.py`) needs updating

---

## Election Announcement (Planned)

### Publication Script

**File:** `scripts/publish-election.py` (to be created)

One-off script that publishes a kind 38008 election announcement:
1. Reads coordinator's nsec from `--nsec-file` (defaults to `/opt/tollgate/coordinator/nsec.env`)
2. Constructs the kind 38008 event using `nostr_sdk.EventBuilder`
3. Connects to all 4 relays (nak + damus + nos.lol + primal)
4. Publishes event, waits for `OK` from at least one relay
5. Prints the event ID — this becomes the `election_id`

See `docs/04-VOTING_EVENT_INTEROP_NOTES.md` for the full kind 38008 spec (questions, timing, tags).

### After Publication

- `GET http://23.182.128.64:8081/election` — coordinator auto-caches from relay, returns the election
- `GET http://23.182.128.64:8081/info` — `electionId` field populated with the event ID
- `GET http://23.182.128.64:8081/tally` — starts returning live counts once votes come in
- Voters use the event ID as `["election", "<id>"]` in their kind 38010 and 38000 events

---

## Development Roadmap

### Phase 1 — Coordinator + Issuance (Done)

- [x] Deploy 3 CDK mints on VPS
- [x] Derive coordinator Nostr keys from mnemonics
- [x] Implement coordinator Nostr client (kind 38010 listener + gRPC approval)
- [x] Design kind 38008 election announcement
- [x] Run coordinator client in production
- [x] End-to-end test: voter requests proof -> coordinator approves -> voter mints proof
- [x] NIP-04 DM proof burning + kind 38002 acceptance receipts
- [x] 49/49 tests passing (unit + deploy + integration + voter)

### Phase 1.5 — Publish Election Announcement (Planned)

- [ ] Create `scripts/publish-election.py` one-off publisher
- [ ] Publish kind 38008 election to all relays
- [ ] Verify `GET /election` returns the election
- [ ] Deploy updated eligible voters to VPS
- [ ] Verify coordinator auto-caches election from relay

### Phase 2 — Tally + Inclusion Proofs (Current)

See `13-TALLY_IMPLEMENTATION_PLAN.md` for full plan.

- [x] MerkleTree base class with `get_proof()` support
- [x] VoteMerkleTree (leaf = SHA256(canonical_json(event_id, pubkey, responses, timestamp)))
- [x] IssuanceCommitmentTree (leaf = SHA256(npub_hex))
- [x] Refactor SpentCommitmentTree to use MerkleTree base
- [x] Publish kind 38007 (hard cap) at election close
- [x] Publish kinds 38005/38006/38003 at election close
- [x] `close_election()` orchestrator
- [x] `_compute_results()` for per-question vote tallying
- [ ] `POST /close`, `GET /result`, `GET /inclusion_proof` HTTP endpoints
- [ ] Auto-close timer
- [ ] 45 new tests (23 unit + 9 publish + 3 persistence + 10 E2E)

### Phase 3 — Transparency + Audit

- [ ] Subset proof verification (spent ⊆ issuance)
- [ ] Public verification CLI

### Phase 3 — Multi-Mint Quorum

- [ ] Voter obtains proofs from 2+ mints
- [ ] Cross-mint proof submission
- [ ] 2-of-3 quorum validation
- [ ] Demo: kill one mint, quorum still works

### Phase 4 — Polish

- [ ] Update TypeScript demo to use `responses` array
- [ ] Update TypeScript demo to publish to real Nostr relay
- [ ] Web UI for verification
- [ ] Multiple election support
- [ ] Tor transport for proof submission

---

## Demo Narrative Script (5 Minutes)

1. "Here is the coordinator's election announcement with questions and timing."
2. "Here is the public list of eligible voters."
3. "I request a proof from the mint."
4. "The coordinator auto-approves my request."
5. "I publish my vote publicly — note the structured responses."
6. "I privately submit my proof to each mint."
7. "The mints cannot link my vote to my identity."
8. "Here are the spent commitment roots."
9. "Here is the Merkle root."
10. "Here is my inclusion proof — it verifies."
11. "Even if one mint fails, the 2-of-3 quorum still works."

---

## What Not To Build

- Full Cashu protocol (CDK handles this)
- Persistent DB for the demo (SQLite is fine)
- Full REST production server
- Frontend UI (keep it CLI)

Keep everything CLI-focused for the demo. Production can add HTTP/Web later.
