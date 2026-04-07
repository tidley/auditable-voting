# TODOv2.md

## Purpose

This file is the **next executable tranche** after the broader architecture brief in [TODO.md](/home/tom/code/auditable-voting/.planning/TODO.md).

It exists because the repo is no longer at “blank migration brief” stage. There is already:

- a Rust/Wasm coordinator core
- Rust-owned public and ballot replay seams
- snapshot/versioning/diagnostics modules
- a real OpenMLS-backed coordinator engine in Rust
- small live gates passing again:
  - `1 coordinator / 1 voter / 1 round`
  - `2 coordinators / 2 voters / 2 rounds`

But there are still two concrete gaps:

1. the **browser coordinator runtime still uses the deterministic engine path**, not the OpenMLS-backed engine end to end
2. the **larger live scale gate still fails operationally**
   - `5 coordinators / 10 voters / 3 rounds` is still not signed off

This document narrows the immediate work to those two gaps.

---

# 1. Immediate objective

Move the repo from:

- “small live cases pass, architecture seams exist”

to:

- “browser coordinator runtime actually uses MLS for coordinator control”
- “the system survives the current medium-scale gate”

without redesigning the whole application.

---

# 2. Current factual status

## 2.1 Already true

- The app is still browser-first and static-site compatible.
- Rust/Wasm already owns a substantial part of protocol truth.
- Public round and ballot replay now run through the Rust-derived path for the migrated slices.
- The small e2e gates are currently green:
  - `1 / 1 / 1`
  - `2 / 2 / 2`
- The latest concrete repair was:
  - public live-round history backfill
  - which fixed a first-round race where round 1 could be missed while round 2 succeeded

## 2.2 Not yet true

- The live browser coordinator path does **not** yet use the OpenMLS-backed engine end to end.
- Browser MLS bootstrap/join carrier wiring is still incomplete.
- The system is **not** yet signed off at:
  - `5 / 10 / 3`
- The threshold/proof expansion from the long-term brief is still out of scope for now.

---

# 3. Non-negotiable constraints for this tranche

1. Keep the app static, browser-first, and backend-free.
2. Do not move voters into MLS.
3. Do not redesign blind-signature issuance in this tranche.
4. Do not put protocol truth back into TypeScript.
5. Do not broaden UI churn.
6. Do not try to solve scale by increasing relay fanout blindly.
7. Do not claim MLS is “done” until the browser runtime actually uses it.

---

# 4. Required outcome for this tranche

This tranche is complete only when:

1. the browser coordinator runtime can be configured to use the OpenMLS-backed engine path
2. the TypeScript side still only sees stable domain-level coordinator operations
3. `2 / 2 / 2` still passes on that path
4. `5 / 10 / 3` either:
   - passes, or
   - fails with enough stage-level evidence to isolate the next bottleneck precisely

If `5 / 10 / 3` still fails, that is acceptable only if the MLS/browser runtime seam is truly in place and the failure is narrowed to a concrete transport/load issue rather than hand-wavy “scale is hard”.

---

# 5. Execution order

Follow this order exactly.

## Step 1 - wire browser runtime selection for coordinator engine

Make the coordinator browser path choose between:

- deterministic engine
- OpenMLS-backed engine

through a Rust-owned configuration seam exposed over Wasm.

Requirements:

- TypeScript must not instantiate OpenMLS types
- the browser path must not scrape `engine_kind` as protocol truth
- restore-from-snapshot must restore the same engine kind that created the snapshot

Deliverables:

- Rust constructor/config path supports explicit engine selection
- Wasm constructor exposes that selection safely
- TS adapter/service can request MLS mode without knowing OpenMLS internals

## Step 2 - implement MLS bootstrap/join carrier path

Add the minimum browser transport needed for the supervisory coordinator group:

- bootstrap/welcome material publication or delivery path
- join path for non-lead coordinators
- snapshot restore after join
- replay after backfill

Requirements:

- keep the carrier minimal and election-scoped
- keep it coordinator-only
- do not turn this into a generic chat transport

Tests:

- one lead + one non-lead can bootstrap
- restored snapshot can decode subsequent control messages
- backfilled carrier history produces the same state as live delivery

## Step 3 - keep the existing live public round path working

Do not regress the current repaired flow where:

- coordinator control reaches round-open agreement
- lead publishes the public live round
- voters recover missed live rounds from history
- tickets are still issued directly coordinator-to-voter

This is a migration seam, not a separate product.

Tests:

- `1 / 1 / 1`
- `2 / 2 / 2`

must stay green after MLS browser wiring lands.

## Step 4 - add relay-load controls for `5 / 10 / 3`

The current likely remaining scale pressure is not raw correctness but browser/relay load.

Add the minimum control mechanisms needed to test that hypothesis:

- bounded concurrent subscription/query waves
- explicit per-plane relay caps
- stronger stage logging for:
  - round seen
  - blind key seen
  - blinded request sent
  - ticket sent
  - receipt acknowledged
- admission control so the harness does not stampede all actors at once

The goal is not to hide the problem. The goal is to separate:

- protocol failure
- relay overload
- harness overload
- browser event-loop overload

## Step 5 - rerun and classify live gates

Required runs after the above work:

1. `1 / 1 / 1`
2. `2 / 2 / 2`
3. `5 / 10 / 3`

For each run, record:

- pass/fail
- completion vs stall
- which stage first underperformed
- whether coordinator 2+ lagged materially
- whether the issue was:
  - control-plane agreement
  - live-round visibility
  - blind-key visibility
  - request delivery
  - ticket delivery
  - receipt acknowledgement

---

# 6. File-level direction

## 6.1 Rust

Primary likely touchpoints:

- `auditable-voting-core/src/coordinator_engine.rs`
- `auditable-voting-core/src/openmls_engine.rs`
- `auditable-voting-core/src/wasm.rs`
- any snapshot/versioning module needed to preserve engine-kind compatibility

## 6.2 TypeScript

Primary likely touchpoints:

- `web/src/core/coordinatorCoreAdapter.ts`
- `web/src/services/CoordinatorControlService.ts`
- `web/src/core/coordinatorEventBridge.ts`
- `web/src/nostr/publishCoordinatorControl.ts`
- `web/src/nostr/subscribeCoordinatorControl.ts`
- `web/scripts/live-simple-relay-check.js`

Secondary touchpoints only if required:

- `web/src/SimpleCoordinatorApp.tsx`
- `web/src/SimpleUiApp.tsx`
- `web/src/simpleVotingSession.ts`

---

# 7. Explicit anti-patterns for this tranche

Forbidden:

- claiming the browser “uses MLS now” when the runtime still uses deterministic control internally
- moving ticket issuance into MLS
- moving voters into MLS
- adding a backend or relay-side coordinator
- broad React refactors
- adding more relay fanout without measurement
- hiding `5 / 10 / 3` stalls behind longer waits and calling that success

---

# 8. Testing requirements

## 8.1 Rust tests

Add or extend tests for:

1. engine selection and snapshot restore parity
2. OpenMLS bootstrap/join for bounded supervisory group
3. restore + decode after snapshot export/import
4. deterministic replay parity after carrier backfill

## 8.2 TS/integration tests

Add or extend tests for:

1. Wasm adapter can create/restore the selected engine kind
2. coordinator service survives reload with MLS-backed snapshot
3. live harness still passes `1 / 1 / 1`
4. live harness still passes `2 / 2 / 2`
5. live harness reports a truthful result for `5 / 10 / 3`

---

# 9. Definition of done for TODOv2

TODOv2 is complete only when:

- the browser coordinator path can genuinely run through the MLS-backed engine
- the TS boundary still exposes only domain-level operations
- `1 / 1 / 1` passes
- `2 / 2 / 2` passes
- `5 / 10 / 3` is either passing or narrowed to a specific measured bottleneck with evidence
- docs and status artefacts reflect the real state honestly

---

# 10. Practical note

If the MLS browser carrier path proves to be the blocking issue, finish that first.

Do **not** jump ahead to threshold proofs or large architectural expansion while the repo is still failing its current medium-scale live gate.
