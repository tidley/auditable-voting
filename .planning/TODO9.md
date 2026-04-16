<!-- STATUS4 pointer: This file is historical context. Current planning status is in .planning/STATUS4.md (2026-04-16, v0.134). -->

Given this latest status, the work should split into **two tracks**:

* **Track A - make the small gate truly stable**
* **Track B - make the scale gate diagnostically deterministic**

Right now you do **not** have a single stable failure shape at `5 / 10 / 3`. Sometimes the system reaches the mixed ticket/ack bottleneck, and sometimes it falls back to the older round-1 visibility failure. That means the next phases must first isolate and stabilise the lower-level startup path before treating DM congestion as the only blocker. 

# Phase 1 - Lock down the small gate

## Goal

Make `2 / 2 / 2` boringly reliable.

## Why

Your own repeat run says `4/5` clean, with the only miss being a full round-1 startup miss and all `5/5` round-2 passes. That means the small gate is improved, but **not signed off**, and it still contains the same class of round-1 readiness failure that can poison interpretation of larger runs. 

## What this phase should prove

Whether the remaining instability is:

* lead opening too early
* non-lead not actually fully ready
* public round-open publication not visible enough
* blind-key publication racing startup
* harness triggering too soon for some participant state

## Required work

Add one explicit Rust-backed readiness state machine for coordinators:

* `mls_join_complete`
* `welcome_ack_sent`
* `initial_control_backfill_complete`
* `auto_approval_complete`
* `round_open_publish_safe`
* `blind_key_publish_safe`
* `ticket_plane_safe`

Then require:

* lead cannot open round 1 until all required readiness phases are true
* UI must expose current readiness phase for each coordinator

## Required tests

* run `2 / 2 / 2` at least 20 times
* record per run:

  * whether round 1 opened
  * whether blind key became visible
  * whether first blinded request was sent
  * whether first ticket was sent
  * whether first ack was seen

## Exit condition

No more “round 1 all-zero” misses in the small gate.

---

# Phase 2 - Separate startup failure from DM congestion

## Goal

Stop mixing two different classes of failure into one diagnosis.

## Why

The latest `5 / 10 / 3` run on `v0.73` regressed all the way back to:

* `roundSeen: 0 / 50`
* `blindKeySeen: 0 / 50`
* `blindedRequestSent: 0 / 50`
* `ticketSent: 0 / 50`
* `receiptAcknowledged: 0 / 50`

But an earlier trustworthy run reached:

* request seen everywhere
* ticket built everywhere
* publish started everywhere
* publish succeeded everywhere
* then failed under mixed send/ack pressure, ack-side dominant

So you currently have **at least two failure modes**. 

## Required work

Classify every failed `5 / 10 / 3` run into one of two buckets:

### Class S - startup failure

Symptoms:

* round 1 never becomes visible
* all stage metrics stay near zero
* coordinators remain waiting for live round

### Class D - downstream DM failure

Symptoms:

* round is visible
* requests are sent
* tickets are built/published
* failure appears in send visibility or ack visibility

## Required output

Modify the harness dump so every failed run includes:

* `failureClass: startup | dm_pipeline | mixed`
* first stage that never became non-zero
* coordinator readiness snapshot at timeout
* per-coordinator round-open status
* per-voter round visibility status

## Progress update

Implemented in this tranche:

- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)
  - coordinator pages now expose runtime readiness diagnostics for:
    - `mls_join_complete`
    - `welcome_ack_sent`
    - `initial_control_backfill_complete`
    - `auto_approval_complete`
    - `round_open_publish_safe`
    - `blind_key_publish_safe`
    - `ticket_plane_safe`
  - those diagnostics are also exported on `globalThis.__simpleCoordinatorDebug`
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
  - voter pages now export round-visibility state on `globalThis.__simpleVoterDebug`
- [web/scripts/live-simple-relay-check.js](/home/tom/code/auditable-voting/web/scripts/live-simple-relay-check.js)
  - failed runs now emit:
    - `protocolFailureClass`
    - `firstMissingStage`
    - `coordinatorReadinessSummary`
    - `voterRoundVisibilitySummary`

This does not complete `TODO9`, but it does complete the diagnostic split needed to separate startup-class failures from downstream DM-pipeline failures without relying only on screenshots.

Current shipped status on this step:

- coordinator pages expose the readiness phases in the running browser UI
- the harness records `protocolFailureClass`, `firstMissingStage`, coordinator readiness summaries, and voter round-visibility summaries
- focused tests and build are green
- a fresh `5 / 10 / 3` rerun was started on the `v0.74` build during this pass, but it did not complete in a useful window, so this step improves diagnosis rather than claiming a new scale result

## Exit condition

Every failure is classified automatically, with no manual reading of screenshots needed.

---

# Phase 3 - Finish the round-1 startup fix for scale

## Goal

Eliminate the startup-class failure at `5 / 10 / 3`.

## Why

Until startup-class failures disappear, DM-pipeline tuning will be noisy and unreliable.

## Required work

For the lead coordinator, add a stricter round-1 open predicate:

* all expected coordinators joined
* all welcome acknowledgements received
* all non-leads completed initial replay/backfill
* all non-leads completed auto-approval attempt
* lead has observed its own published control state back via relay success path
* required public round-open prerequisites are locally visible

Add bounded retry only after those prerequisites are true.

## Required tests

* transcript test: delayed non-lead backfill
* transcript test: delayed approval visibility
* live repeat: `2 / 2 / 2`
* live repeat: `5 / 10 / 3` until no startup-class failures remain in sample set

## Exit condition

`5 / 10 / 3` either passes or fails **only** downstream of round-open visibility.

---

# Phase 4 - Turn the DM plane into a strict state machine

## Goal

Once startup is stable, isolate the DM bottleneck properly.

## Why

Earlier trustworthy scale traces already showed:

* publish success everywhere
* voter observation incomplete
* ack visibility much worse than send visibility

So the DM plane needs to be treated as a state machine, not a loose set of async events. 

## Required states

For each coordinator-voter request lineage:

* `request_seen`
* `ticket_built`
* `publish_started`
* `publish_succeeded`
* `voter_observed`
* `ack_sent`
* `ack_seen`

Each conversation must have:

* stable `request_id`
* stable `ticket_id`
* stable `ack_id`
* resend count
* latest attempt id
* prior valid attempt ids

## Required work

The `v0.73` request-id normalisation was correct. Continue that same discipline through the rest of the pipeline:

* stable ticket identity
* stable ack identity
* resend-safe matching
* round-scoped lineage

## Exit condition

Every stalled conversation can be located at one exact state boundary.

---

# Phase 5 - Fix ack-side dominant failure first

## Goal

Reduce `ackGap` before optimising send-side further.

## Why

In the last trustworthy scale trace before the regression, ack visibility was clearly worse than send visibility:

* `sendGap: 28`
* `ackGap: 48` 

## Required work

### 1. Stable ack identity

One logical ticket must map to one logical ack target.

### 2. Ack matching must survive resend

Resending must not invalidate earlier valid acknowledgements.

### 3. Ack observation must not depend only on live subscription

If no ack is seen after threshold:

* backfill recent DM history for that conversation
* replay through the same reducer
* accept valid ack found through backfill

### 4. Add explicit coordinator ack states

* `ack_not_expected_yet`
* `ack_waiting`
* `ack_seen_live`
* `ack_seen_via_backfill`
* `ack_missing_after_recovery`

## Required tests

* ack only visible via backfill
* duplicate ack safe
* resend does not change logical ack target
* older valid ack still resolves current ticket lineage

## Exit condition

A large fraction of `ack_sent but ack_not_seen` cases disappear.

---

# Phase 6 - Fix send visibility loss second

## Goal

Reduce the remaining `publishSucceeded but voter never observed` cases.

## Required work

* cap per-coordinator ticket-send concurrency
* distinguish publish success from voter observation
* add conversation backfill when publish succeeded but voter did not observe
* preserve stable ticket identity across resend
* record relay subset used per send

## Exit condition

`sendGap` falls materially and no longer dominates failed conversations.

---

# Phase 7 - Prevent round-1 leftovers from contaminating round 2+

## Goal

Stop unresolved prior-round DM state from destabilising later rounds.

## Why

The small repeat evidence is now:

* round 1: `4/5`
* round 2: `5/5`

That suggests round 1 is still the weak point, but once things are flowing, later rounds can succeed. You need to preserve that and stop stale prior-round state from leaking forward. 

## Required work

Make round scoping explicit for:

* request ids
* ticket ids
* ack ids
* pending request maps
* resend maps
* cleanup maps

At round boundary, record:

* unresolved sends
* unresolved acks
* unresolved backfill recoveries

## Exit condition

Later rounds do not inherit ambiguous state from earlier rounds.

---

# Phase 8 - Restore repo-wide typecheck trust

## Goal

Make `tsc --noEmit` useful again.

## Why

The status still says repo-wide typecheck is red because of `SimpleRound.test.tsx` drift. That makes the next refactors riskier than they need to be. 

## Required work

Fix:

* stale coordinator config mocks
* stale result shapes
* missing helpers
* old `.status` assumptions

## Exit condition

`cd web && npx tsc --noEmit` passes.

---

# Phase 9 - Only after that, resume broader production work

Do **not** prioritise yet:

* proof bundles
* receipt commitments
* 1,000-style simulation gates
* cohort-group implementation
* threshold tally expansion

Until:

* startup-class failures are gone
* DM pipeline failures are narrowly understood
* `2 / 2 / 2` is stable
* `5 / 10 / 3` has one consistent failure class or passes

# Clean summary

## Current reality

You do **not** yet have one stable bottleneck.

You have:

1. an **improved but still flaky round-1 startup path**
2. a **downstream DM ticket/ack congestion problem**
3. a **scale gate that can still regress into startup failure**

## Therefore the next phases are:

1. **Stabilise round-1 startup in the small gate**
2. **Auto-classify scale failures into startup vs DM pipeline**
3. **Eliminate startup-class failures at `5 / 10 / 3`**
4. **Fix ack-side dominant DM failure**
5. **Fix send-side visibility loss**
6. **Stop round-1 leftovers contaminating later rounds**
7. **Restore repo-wide TS typecheck**
8. **Only then continue broader production hardening**
