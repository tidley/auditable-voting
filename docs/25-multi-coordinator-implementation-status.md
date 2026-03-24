# Multi-Coordinator Implementation Status

Branch: `feature/multi-coordinator-voting-deployment`

This document tracks the progress of refactoring the auditable-voting system from a single-coordinator model to a multi-coordinator model where multiple independent operators each run their own coordinator + mint pair.

---

## Completed (8 commits)

### Commit 1 — Protocol Spec Updates (`36c3cf0`)

Rewrote core design docs for multi-coordinator model:

- `docs/01-system-design.md` — Multi-coordinator system design, trust model, attack surfaces, phased timing
- `docs/02-protocol-reference.md` — All event kinds including new 38012 (coordinator info) and 38013 (voter confirmation), audit algorithm
- `docs/03-quorum-model.md` — Replaced 2-of-3 mint quorum with 1-of-N coordinator quorum, adversarial analysis, privacy guarantees

### Commit 2 — Eligible Root Computation (`8abee08`)

Added `compute_eligible_root()` in both TypeScript and Python:

- `src/merkle.ts` — `computeEligibleLeaf()` and `computeEligibleRoot()` functions
- `coordinator/voting-coordinator-client.py` — `compute_eligible_root()` and `EligibleMerkleTree` class

### Commit 3 — Coordinator Join Mode (`735eca7`)

Added `--join-election` CLI mode and new event publishers:

- `coordinator/voting-coordinator-client.py` — `_publish_38007()` (updated with eligible-root tags and timing), `_publish_38009()`, `_publish_38012()`, `--join-election` and `--http-api-url` CLI args

### Commit 4 — Startup Cross-Check (`377309a`)

On startup with `--election-id`, coordinator fetches all 38007 events from relays and compares eligible-root tags. Logs warnings when coordinators have different roots.

### Commit 5 — Multi-Coordinator Frontend (`4068e58`)

Complete frontend rewrite for multi-coordinator support:

- `web/src/coordinatorApi.ts` — `discoverCoordinators()`, `fetchPerCoordinatorTallies()`, `runAudit()`, `checkVoteAccepted()` returns per-coordinator array, all API functions accept optional `httpApi` param
- `web/src/cashuWallet.ts` — `StoredWalletBundle` restructured with `coordinatorProofs` array, `addCoordinatorProof()`, `storeEphemeralKeypair()`, legacy migration preserved
- `web/src/ballot.ts` — `coordinatorProofs` parameter to `publishBallotEvent()`, computes SHA256(proof_secret) via Web Crypto, adds `["proof-hash", hash]` tags
- `web/src/proofSubmission.ts` — `submitProofsToAllCoordinators()` loops over coordinator+proof pairs
- `web/src/App.tsx` — Updated for renamed fields (vote_start/vote_end), new API signatures, new wallet bundle structure
- `web/src/VotingApp.tsx` — Updated for new wallet bundle structure and per-coordinator acceptance check
- `web/src/DashboardApp.tsx` — Updated for renamed fields and multi-coordinator election discovery

### Commit 6 — Ansible Playbooks (`fcf2a08`)

New Ansible playbooks and Makefile targets:

- `ansible/playbooks/init-election.yml` — Creates election with 38008 + 38007 + 38009 + 38012, computes eligible-root
- `ansible/playbooks/join-election.yml` — Joins existing election, verifies eligible root match, publishes 38007 + 38009 + 38012
- `ansible/playbooks/deploy-and-prepare.yml` — Updated 38008 publication to use `vote_start`/`vote_end`/`confirm_end` and coordinator/eligible-root tags
- `Makefile` — Added `init-election` and `join-election` targets

### Commit 7 — Unit Tests (`65d7d6d`)

21 unit tests in `tests/test_multi_coordinator.py`:

- `TestComputeEligibleRoot` (6 tests) — Deterministic root, sorted input, empty input, large sets, different sets
- `TestEligibleMerkleTree` (3 tests) — Build tree, root matches, empty tree
- `TestEventStoreGetEvents` (3 tests) — Filter by kind, empty store, multiple kinds
- `TestAuditAlgorithm` (4 tests) — No inflation, inflation detected, censorship detected, fake confirmations
- `TestProtocolEventShapes` (5 tests) — 38007/38009/38012/38013 tag shapes, content structure

### Commit 8 — Frontend Wiring (`a631f5e`)

Wired the multi-coordinator UI flows:

- `web/src/App.tsx` — Auto-discovers all coordinators via kind 38012 events, "Request from all N coordinators" button runs the full issuance loop (quote -> claim -> poll -> mint) per coordinator with live per-coordinator progress UI
- `web/src/VotingApp.tsx` — Step 5 panel: publishes kind 38013 voter confirmation from ephemeral key after the voting window closes (blocked until confirmation window opens)
- `web/src/DashboardApp.tsx` — Audit panel: "Run audit" button fetches per-coordinator tallies and compares against canonical 38013 confirmations, flags inflation/censorship per coordinator with color-coded indicators
- `web/src/mintApi.ts` — `createMintQuote()` and `checkQuoteStatus()` now accept optional `mintUrl` parameter for multi-mint support

---

## Remaining (Requires VPS)

### 1. Multi-Coordinator Issuance E2E Test

Deploy two coordinators, run `init-election` on one, `join-election` on the other, and verify the frontend issuance loop works end-to-end:

- [ ] Deploy coordinator A (init-election) with canonical eligible set
- [ ] Deploy coordinator B (join-election) with matching eligible root
- [ ] Verify both coordinators publish 38007, 38009, 38012
- [ ] Run voter flow: discover both coordinators, request quotes from each, mint proofs from each
- [ ] Verify `coordinatorProofs` array in wallet bundle has 2 entries

### 2. Full Voter Flow with Multiple Coordinators

- [ ] Publish ballot (kind 38000) with proof-hash tags for both coordinators
- [ ] Submit proofs via NIP-04 DM to both coordinators
- [ ] Verify both coordinators publish 38002 acceptance events
- [ ] Verify `checkVoteAccepted()` returns accepted=true for both

### 3. 38013 Confirmation E2E Test

- [ ] Wait for voting window to close (or set short window for testing)
- [ ] Publish kind 38013 from voter's ephemeral key during confirmation window
- [ ] Verify 38013 appears on relays with correct tags
- [ ] Verify early 38013 (before vote_end) is rejected by audit

### 4. Audit Detection E2E Test

- [ ] Run audit on dashboard with 2 honest coordinators (tallies match, no flags)
- [ ] Simulate inflation: have one coordinator report higher tally than canonical confirmations
- [ ] Verify audit flags "possible inflation"
- [ ] Simulate censorship: have one coordinator report lower tally
- [ ] Verify audit flags "possible censorship"
- [ ] Publish 38013 from non-canonical npub
- [ ] Verify audit counts fake confirmations

### 5. Ansible Playbook Testing

- [ ] Test `make init-election` end-to-end on VPS
- [ ] Test `make join-election ELECTION_ID=<id>` end-to-end on VPS
- [ ] Verify 38008 event appears on relays with coordinator tags
- [ ] Verify 38009 eligible-root matches across coordinators

### 6. Coordinator Startup Cross-Check Verification

- [ ] Start coordinator A with `--election-id`
- [ ] Start coordinator B with same `--election-id`
- [ ] Verify both log eligible-root cross-check (match or mismatch)
- [ ] Test mismatch scenario (one coordinator has different eligible list)

---

## Files Modified (Summary)

| File | Changes |
|------|---------|
| `docs/01-system-design.md` | Rewritten for multi-coordinator model |
| `docs/02-protocol-reference.md` | New event kinds 38012, 38013, audit algorithm |
| `docs/03-quorum-model.md` | Replaced 2-of-3 mint with 1-of-N coordinator quorum |
| `src/merkle.ts` | Added `computeEligibleLeaf()`, `computeEligibleRoot()` |
| `coordinator/voting-coordinator-client.py` | Join mode, 38007/38009/38012 publishers, cross-check, `--http-api-url` |
| `web/src/coordinatorApi.ts` | Discovery, audit, per-coordinator APIs |
| `web/src/cashuWallet.ts` | `coordinatorProofs` array, `addCoordinatorProof()`, legacy migration |
| `web/src/ballot.ts` | Proof-hash tags on vote events |
| `web/src/proofSubmission.ts` | Multi-coordinator DM submission |
| `web/src/App.tsx` | Multi-coordinator issuance loop with progress UI |
| `web/src/VotingApp.tsx` | 38013 voter confirmation publishing |
| `web/src/DashboardApp.tsx` | Audit panel with per-coordinator tallies and flags |
| `web/src/mintApi.ts` | Optional `mintUrl` param on `createMintQuote()`/`checkQuoteStatus()` |
| `ansible/playbooks/init-election.yml` | New: election creation playbook |
| `ansible/playbooks/join-election.yml` | New: election join playbook |
| `ansible/playbooks/deploy-and-prepare.yml` | Updated for new field names |
| `Makefile` | `init-election`, `join-election` targets |
| `tests/test_multi_coordinator.py` | 21 unit tests |
| `AGENTS.md` | Updated event kinds, voter flow, timing diagram |

---

## Related Documentation

- `docs/01-system-design.md` — Canonical system design
- `docs/02-protocol-reference.md` — All Nostr event kinds (38000-38013)
- `docs/03-quorum-model.md` — Multi-coordinator trust model and adversarial analysis
- `docs/09-issuance-client-design.md` — Coordinator daemon + voter CLI design
- `docs/15-coordinator-deployment.md` — Coordinator systemd deployment
- `docs/17-integration-test-plan.md` — 3-layer test architecture
