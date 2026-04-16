<!-- STATUS4 pointer: This file is historical context. Current planning status is in .planning/STATUS4.md (2026-04-16, v0.134). -->

Given the current state, the most sensible next steps are **not** new features. They are:

1. **stabilise multi-coordinator runtime**
2. **eliminate remaining TS protocol authority**
3. **make public audit artefacts compact and deterministic**
4. **codify scaling constraints in code**
5. **prove recovery and replay at larger simulated scale**

That follows directly from the attached status: real OpenMLS is already live in the browser path, the repaired small gates now include `1 / 2 / 2` and repeated clean `2 / 2 / 2` reruns after the new first-round readiness barrier, and `5 / 10 / 3` is still the next unresolved live gate. 

## What “production-ready” should mean here

Before thinking about 1,000+ voters in production, the project should satisfy these operational properties:

* repeated identical outcomes under reruns
* deterministic recovery after reload
* no hidden TS-side truth in issuance/ticket flows
* bounded MLS group size enforced in code
* compact public commitments for audit
* strong observability when a round stalls
* simulation evidence for larger ballot volume

Right now, the gap is mainly **runtime reliability**, not missing high-level architecture. 

# Recommended next steps

## Priority 1 - make `2 / 2 / 2` boringly reliable

This is the immediate blocker.

The file says the browser OpenMLS path is already live, and the remaining problem is runtime stability of the first multi-coordinator round. That means the next work should focus on first-round readiness, join/bootstrap timing, and replay/recovery around that boundary. 

### Do next

* add explicit **supervisory-group readiness state** in Rust
* do not allow round-open until all required coordinator prerequisites are visible:

  * joined group
  * imported welcome
  * current epoch known
  * required public round metadata visible
  * blind-key/ticket prerequisites visible if needed
* add a single Rust-derived status enum for coordinator readiness, not ad hoc UI inference

### Add diagnostics now

Expose, per coordinator:

* joined/not joined
* welcome applied/not applied
* current epoch
* snapshot freshness
* public round visibility state
* reason round-open is blocked

Status:

* partial
* Rust now exposes supervisor-readiness fields through the coordinator engine status:

  * `joined_group`
  * `welcome_applied`
  * `current_epoch`
  * `snapshot_freshness`
  * `public_round_visibility`
  * `readiness`
  * `blocked_reason`
* the browser coordinator UI/service path now consumes that Rust status instead of inferring everything from the latest round alone
* the first-round runtime fix is now in place:

  * non-leads acknowledge successful MLS welcome application back to the lead
  * the lead blocks round-open until those welcome acknowledgements are visible
  * the lead then auto-resumes the pending broadcast attempt
* latest verified local-preview result:

  * repeated `2 / 2 / 2` reruns passed cleanly
  * round 1 and round 2 both reached `2 of 2` tickets
* this closes the immediate round-1 small-run stall, but it does **not** close the next scale gate

### Gate

Run `2 / 2 / 2` repeatedly, at least 20+ reruns locally, and do not proceed until failures are rare enough to explain specifically.

---

## Priority 2 - pass `5 / 10 / 3`

This is the first real production-style gate.

Do not jump to 1,000-style simulations until this is green repeatedly. The file explicitly identifies `5 / 10 / 3` as the next unresolved live gate. 

### Focus areas

* coordinator join ordering
* replay after missed control carriers
* stale snapshot rejection/rebuild
* delayed round history visibility
* duplicate control-carrier handling

### Add a dedicated live-gate harness

Create one repeatable script that:

* starts 5 coordinators
* starts 10 voters
* runs 3 rounds
* captures:

  * per-coordinator epoch timeline
  * first-round readiness timeline
  * round-open timestamps
  * ticket issuance timing
  * backfill/replay events
  * final derived-state hashes

### Gate

`5 / 10 / 3` should pass repeatedly and produce identical final Rust-derived hashes after reload.

---

## Priority 3 - remove remaining TS protocol truth in issuance/ticket flows

This is the biggest architectural risk left after runtime stability.

The file says Rust is the protocol source of truth for migrated coordinator/public/ballot slices, but remaining private issuance/ticket truth is still in TS. That is not production-ready. 

### Do next

Audit and migrate, in this order:

* `simpleVotingSession.ts`
* `simpleShardDm.ts`
* `simpleLocalState.ts`

For each:

* identify state that changes protocol truth
* move that state machine into Rust
* expose Wasm methods for reads/writes
* leave TS only as adapter/view glue
* remove duplicate TS branches

### Minimum completion bar

TS must no longer decide:

* ticket validity
* issuance completion
* redemption acceptance
* acceptance/rejection truth

---

## Priority 4 - add compact receipt commitments

This is the next most valuable production step after stability and Rust ownership.

Without compact receipt commitments, you do not yet have a good public audit surface for scale. The file says this is still not done. 

### Do next

In Rust, add:

* stable `ReceiptId`
* per-round `ReceiptSetCommitment`
* deterministic receipt summary derivation
* inclusion lookup from accepted ballot set

### Why this matters

At production scale, you need:

* compact public artefacts
* deterministic auditor reconstruction
* voter inclusion checks without noisy public chatter

### Gate

Same accepted ballot set must always yield the same receipt commitment across:

* full replay
* shuffled replay
* snapshot + suffix replay

---

## Priority 5 - add proof bundle skeleton

Do not wait for full threshold tally cryptography to start this.

A proof bundle skeleton gives you:

* a stable auditor-facing structure
* explicit markers for what is implemented
* less ambiguity in docs and UI

### Do next

In Rust, define:

* `ResultProofBundle`
* `ReceiptSetCommitment`
* `TallyInputCommitment`
* `CoordinatorApprovalSummary`
* `DisputeProofRecord`
* `ProofFieldStatus = Present | NotAvailableYet`

### Gate

Auditor UI can render a proof bundle today, even if some fields are marked incomplete.

---

## Priority 6 - enforce MLS group-size policy in code

This is low effort and high value.

Right now it appears to be a doc policy, not an enforced runtime rule. That is not enough for production. The plan already says the cap should be 25. 

### Do next

Implement Rust config and validation:

* preferred range 16-24
* hard cap 25
* emergency ceiling 32
* reject oversized browser MLS groups by default

### Also add

* topology planner
* liaison assignment model
* diagnostics for oversized group attempts

### Gate

Any attempt to create an oversized group fails deterministically and visibly.

---

## Priority 7 - add 1,000-style replay/load simulations

Only after the earlier steps.

Do not claim production readiness for 1,000+ voters from architecture alone. The file correctly says simulation evidence is still missing. 

### Do next

Add simulations for:

* `5 / 1000 / 3`
* `5 / 1000 / 5`

Validate:

* voters remain outside MLS
* private groups stay under cap
* public ballot stream replays deterministically
* compact receipt artefacts remain bounded
* snapshot + suffix replay matches full replay

### Important

This does not need full browser e2e at 1,000 voters yet. Rust replay/simulation evidence is enough for this stage.

---

# What I would deprioritise for now

These are not the most sensible next production steps:

* full threshold tally crypto
* cohort-group UX polish
* broad React refactors
* backend services
* advanced auditor UI polish
* any increase in MLS group size cap

They are useful later, but they are not what currently blocks production readiness.

# Practical production-readiness checklist

I would call it production-ready enough for an initial serious deployment only when all of these are true:

* `2 / 2 / 2` is reliable across repeated reruns
* `5 / 10 / 3` passes repeatedly
* Rust owns all critical issuance/ticket truth
* OpenMLS browser supervisory path is the real live path
* receipt commitments exist and are deterministic
* proof bundle skeleton exists
* MLS cap is enforced in code
* 1,000-style replay simulations pass
* docs clearly separate:

  * implemented
  * partially implemented
  * not yet implemented

# Best order to do the work

1. **stabilise `2 / 2 / 2`**
2. **clear `5 / 10 / 3`**
3. **migrate remaining TS issuance/ticket truth into Rust**
4. **add receipt commitments**
5. **add proof bundle skeleton**
6. **enforce MLS cap/topology in code**
7. **add 1,000-style simulations**
8. **only then consider deeper proof/tally expansion**

That is the shortest sensible path from the current state to something I would call production-oriented. 

If you want, I can turn this into a strict release plan with “must pass before next stage” gates.
