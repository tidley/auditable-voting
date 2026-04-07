Here is the concrete finish plan, tuned to the current progress in the attached brief, especially the facts that `1c/1v/1r` and `2c/2v/2r` are passing again, round-history backfill was recently repaired, the real OpenMLS engine already exists in Rust/Wasm, and the next unresolved live gate is `5 coordinators / 10 voters / 3 rounds`. 

## Finish strategy

Do **not** broaden scope yet.

The shortest path to “substantially finished” is:

1. **Make the live browser coordinator path actually use the OpenMLS engine**
2. **Pass the `5 / 10 / 3` live gate**
3. **Remove remaining TS authority in private issuance/ticket flows**
4. **Add compact receipt commitments and proof skeletons**
5. **Add bounded-group and 1,000-style replay/load simulations**
6. **Only then expand proof/tally depth**

That sequence matters because the biggest current architectural gap is not reducers or snapshots in general; it is that the shipped browser runtime still bypasses the real MLS path. 

---

# Concrete plan to finish

## Stage 1 - land the real browser OpenMLS path

### Goal

Replace the live coordinator browser runtime’s deterministic-engine path with the real OpenMLS-backed engine already present in Rust/Wasm. 

### Deliverables

* browser bootstrap/join carrier wiring complete
* OpenMLS-backed supervisory group used in live browser flow
* snapshot/restore stable on the MLS path
* replay/backfill stable on the MLS path

### Code tasks

#### Rust

Work in:

* `src/openmls_engine.rs`
* `src/coordinator_engine.rs`
* `src/snapshot.rs`
* `src/wasm.rs`

Implement or finish:

* bootstrap package generation
* join/welcome carrier encode/decode
* restore-from-snapshot on MLS path
* deterministic apply of inbound carrier messages
* explicit engine identity in diagnostics, e.g. `deterministic` vs `openmls`

Add/finish exported Wasm calls for:

* `bootstrap_supervisory_group(...)`
* `join_supervisory_group(...)`
* `apply_supervisory_carrier(...)`
* `get_supervisory_engine_status()`
* `export_supervisory_snapshot()`
* `import_supervisory_snapshot(...)`

#### TypeScript

Work in:

* `web/src/core/`
* `web/src/services/CoordinatorControlService.ts`
* `web/src/nostr/subscribeCoordinatorControl.ts`
* `web/src/nostr/publishCoordinatorControl.ts`

Implement:

* Nostr event kind/tag mapping for bootstrap/join/welcome carriers
* replay/backfill ingestion for those carriers
* snapshot load before live subscribe
* engine-status display hook for debugging
* strict routing by `election_id`, `round_id`, `group_id`

### Required tests

Add before moving on:

* bootstrap group with 1 coordinator
* join second coordinator
* reload both coordinators from snapshot
* replay backfill after missed welcome/commit
* verify browser path is using `openmls`, not `deterministic`

### Exit condition

`2 coordinators / 2 voters / 2 rounds` must pass **on the OpenMLS browser path**, not only on the deterministic seam.

---

## Stage 2 - clear the next live gate: `5 / 10 / 3`

### Goal

Make the first non-trivial multi-coordinator live gate pass reliably. This is the correct next milestone because it is already identified as the next unresolved live gate in the brief. 

### Deliverables

* 5 coordinators join same supervisory group
* 10 voters complete 3 rounds
* no missed round history
* no stuck coordinator epochs
* no divergent replay state after reload

### Code tasks

#### Rust

Work in:

* `src/replay.rs`
* `src/order.rs`
* `src/coordinator_state.rs`
* `src/diagnostics.rs`

Implement or harden:

* better detection of stale coordinator snapshot
* epoch mismatch diagnostics
* explicit replay checkpoint markers per round
* commit ordering assertions
* mixed-stream parity checks

#### TypeScript

Work in:

* relay subscription code
* snapshot recovery code
* round-history backfill code
* coordinator UI state service

Implement or harden:

* round-scoped historical backfill before UI marks round as absent
* retry for missed control carriers
* delayed subscribe after snapshot import
* debounce duplicate coordinator-carrier application

### Required tests

* transcript: 5 coordinators, out-of-order joins
* transcript: one coordinator reloads mid-round
* transcript: duplicate control carriers
* transcript: delayed round 1 history then round 2 arrives first
* live gate script for `5 / 10 / 3`

### Exit condition

`5 / 10 / 3` passes repeatedly in local preview and produces identical derived state after reload.

---

## Stage 3 - finish TS-to-Rust migration for private issuance/ticket truth

### Goal

Remove the remaining architectural inconsistency where TS still holds authoritative truth in parts of private issuance/ticket flows. The brief explicitly says this is still incomplete. 

### Deliverables

* Rust owns issuance/ticket state machine
* TS becomes thin adapter only
* no duplicated acceptance/redeem/issue truth

### Code tasks

Audit and migrate these first:

* `web/src/simpleVotingSession.ts`
* `web/src/simpleShardDm.ts`
* `web/src/simpleLocalState.ts`

For each file:

1. identify state that changes protocol truth
2. create Rust type
3. create Rust reducer/service
4. expose Wasm accessor and mutator
5. replace TS logic with bridge call
6. add regression test
7. remove old authoritative TS branch

#### Rust modules to add/expand

* `src/issuance_state.rs`
* `src/ticket_state.rs`
* `src/event.rs`
* `src/validation.rs`
* `src/wasm.rs`

### Required tests

* blind-signature/ticket issue flow replay
* duplicate issuance messages
* reload between issuance and redemption
* ticket accepted/rejected parity across replay
* UI state mirrors Rust-derived issuance state

### Exit condition

A grep/audit shows TS no longer decides:

* ticket validity
* issuance truth
* redemption truth
* acceptance truth

---

## Stage 4 - add compact receipt commitments

### Goal

Make the public audit layer compact and credible for scale, rather than relying on ad hoc visible state. This is necessary before any serious 1,000-style claim. The brief explicitly calls this not yet done. 

### Deliverables

* stable receipt identifiers
* batched or structured public receipt summaries
* voter inclusion compatibility data
* replay-stable receipt commitments

### Code tasks

#### Rust

Create or finish:

* `src/receipts.rs`
* `src/public_state.rs`
* `src/proofs.rs`

Implement:

* `ReceiptId`
* `ReceiptSetCommitment`
* receipt-batch derivation
* per-round commitment summarisation
* inclusion lookup helper from accepted ballot set

#### TypeScript

Only bridge and render:

* receipt summary retrieval
* simple inclusion check UI
* no receipt derivation logic in TS

### Required tests

* duplicate ballots do not perturb commitment set
* same accepted set yields same receipt commitment
* replay from shuffled input yields same receipt commitment
* receipt summary survives snapshot+suffix replay

### Exit condition

Public receipt state is compact, deterministic, and available from Rust.

---

## Stage 5 - add proof bundle skeleton, not full proof system

### Goal

Create the public proof structure now, even if some fields remain explicitly unavailable. This removes ambiguity and prepares later tally/proof work without blocking finish on cryptographic completeness.

### Deliverables

* typed proof bundle
* current-implementation fields populated
* explicit placeholders for unimplemented proof material

### Code tasks

#### Rust

In `src/proofs.rs`, add:

* `ReceiptSetCommitment`
* `TallyInputCommitment`
* `ResultProofBundle`
* `CoordinatorApprovalSummary`
* `DisputeProofRecord`
* `ProofFieldStatus = Present | NotAvailableYet`

Populate:

* available receipt commitments
* available tally input hash
* result object hash
* contradiction/dispute visibility

### Required tests

* serialisation round-trip
* deterministic hashing
* replay-stable proof bundle
* contradiction visibility included

### Exit condition

Auditor path can display a coherent proof bundle, even if some fields are explicitly marked incomplete.

---

## Stage 6 - bounded-group implementation and tests

### Goal

Implement the MLS cap policy in code and prove the group-planning model, even if cohort groups are not yet heavily used live.

### Deliverables

* hard cap enforcement at 25
* topology planner
* liaison assignment model
* cross-group routing rules
* tests for supervisory + cohort planning

### Code tasks

#### Rust

Create or finish:

* `src/config.rs`
* `src/group_topology.rs`
* `src/cross_group.rs`

Implement:

* cap validation
* topology planning
* liaison assignment
* cross-group instruction validation
* diagnostics for oversize/emergency range

### Required tests

* `<=9` supervisory coordinators valid
* `26` participants split into cohorts
* `51` participants split deterministically
* illegal direct cohort authority rejected
* oversized group rejected

### Exit condition

Group-size policy is enforced in code, not just docs.

---

## Stage 7 - 1,000-style simulation gates

### Goal

Do not claim 1,000+ viability from architecture alone. Add simulation-style gates that exercise the replay model and public compactness with voters outside MLS.

### Deliverables

* `5 / 1000 / 3` simulation
* `5 / 1000 / 5` simulation
* bounded private groups
* large public ballot stream
* snapshot+suffix replay parity under load

### Code tasks

#### Rust

Create simulation/transcript fixtures using:

* large accepted ballot sets
* shuffled relay arrival
* duplicate public events
* backfill after missing segment

#### TS integration

Only where useful:

* IndexedDB load/reload
* browser-style suffix replay
* no full browser e2e required yet

### Required checks

Simulation must validate:

* deterministic replay
* compact public artefacts
* no voter-in-MLS regression
* bounded group planning
* snapshot+suffix parity

### Exit condition

Repo has evidence for the 1,000-voter target in replay/simulation terms, even if not yet full live-browser human testing at that scale.

---

# What not to do now

Do **not** prioritise these before the stages above:

* full threshold tally cryptography
* cohort-group live UX polish
* broad React redesign
* new backend services
* fancy auditor UX
* expanding MLS group size above 25
* putting voters into MLS “for convenience”

Those are not on the critical path to finish.

---

# Concrete milestone sequence

Use these milestones exactly.

## Milestone A

**MLS browser path live**

* OpenMLS browser bootstrap/join wired
* `2 / 2 / 2` passes on real MLS path

## Milestone B

**Next unresolved live gate cleared**

* `5 / 10 / 3` passes reliably
* reload/recovery parity holds

## Milestone C

**TS protocol truth removed where still critical**

* issuance/ticket truth migrated to Rust

## Milestone D

**Public audit compactness added**

* receipt commitments live
* proof bundle skeleton live

## Milestone E

**Scaling policy codified**

* MLS cap enforced
* topology/cross-group tests pass

## Milestone F

**1,000-style evidence added**

* replay/load simulations pass
* docs updated accurately

---

# Recommended order of files to touch

## First wave

* Rust:

  * `src/openmls_engine.rs`
  * `src/coordinator_engine.rs`
  * `src/snapshot.rs`
  * `src/wasm.rs`
  * `src/replay.rs`
  * `src/diagnostics.rs`
* TS:

  * `web/src/nostr/subscribeCoordinatorControl.ts`
  * `web/src/nostr/publishCoordinatorControl.ts`
  * `web/src/services/CoordinatorControlService.ts`
  * `web/src/core/*`

## Second wave

* Rust:

  * `src/issuance_state.rs`
  * `src/ticket_state.rs`
  * `src/validation.rs`
  * `src/event.rs`
  * `src/wasm.rs`
* TS:

  * `simpleVotingSession.ts`
  * `simpleShardDm.ts`
  * `simpleLocalState.ts`

## Third wave

* Rust:

  * `src/receipts.rs`
  * `src/proofs.rs`
  * `src/public_state.rs`
  * `src/config.rs`
  * `src/group_topology.rs`
  * `src/cross_group.rs`

---

# Practical completion bar

I would treat the repo as “finished enough for this migration” when all of these are true:

* real OpenMLS engine is used in the live browser coordinator path
* `5 / 10 / 3` passes reliably
* no remaining critical private issuance/ticket truth lives in TS
* receipt commitments and proof bundle skeleton exist in Rust
* MLS cap is enforced in code
* 1,000-style replay simulations pass
* docs state clearly what is implemented vs not yet implemented

That is the shortest credible path from the current attached state to a strong, defensible finish. 

If you want, I can turn this into a paste-ready replacement section for `TODO-llm.md` under “Current concrete progress” and “Concrete implementation plan”.
