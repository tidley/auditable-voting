# Most sensible next steps

## Progress update

As of `v0.70`:

- the live harness work in step 1 is materially done
- failed scale runs now produce structured snapshots and a trustworthy classification instead of dying with page/context closure
- the latest `5 / 10 / 3` verdict is now a real `protocol_timeout`
- the failure is no longer first-round public-round visibility
- the current blocker is partial ticket delivery and receipt-ack congestion during round 1
- an additional targeted fix has already been applied:
  - DM publish queueing is now keyed per sender-recipient conversation rather than per recipient only
- that change preserved the repaired small gate:
  - `2 / 2 / 2` still passes
- but `5 / 10 / 3` still does not complete cleanly

So the next steps below should now be read from that updated starting point.

## 1. Fix the live harness before changing protocol code

This is the immediate highest-value move.

This was the immediate highest-value move, and it has now been done well enough to trust the next scale verdict.

### Do next

Work first in:

* `web/scripts/live-simple-relay-check.js`

### Goals

* make browser/page closure non-fatal where possible
* record which tab/page died
* capture coordinator/voter state snapshots before exit
* distinguish:

  * harness failure
  * browser resource collapse
  * actual protocol stall

### Concrete changes

Add:

* guarded `locator.count()` / `ensureTab()` calls with better diagnostics
* per-page liveness checks before interaction
* structured dump on failure:

  * current round
  * participant index
  * last visible status text
  * last known URL
  * whether browser/context/page is closed
* screenshot + HTML dump on failure
* retry-once tab reacquire if the browser is still alive

### Exit condition

A failed `5 / 10 / 3` run must produce a trustworthy classification:

* harness/runtime failure
* or protocol failure

Current status:

- achieved
- the latest scale run now exits with a structured timeout report and participant snapshots

---

## 2. Re-run `5 / 10 / 3` and classify the failure mode precisely

Once the harness is stable, re-run the scale gate unchanged.

### Goal

Find out whether the next blocker is:

* first-round coordinator readiness
* proposal/commit propagation
* public round visibility
* blind-key visibility
* blinded request fanout
* ticket send/ack congestion
* browser/runtime instability only

The report explicitly says the current scale result is unresolved rather than a true protocol verdict. Fix that first. 

### Required output

For each failed run, capture:

* round where failure begins
* whether supervisory group is fully joined
* whether all coordinators reached approval-ready state
* whether public round-open event was visible to voters
* whether blinded requests were published
* whether coordinators saw them
* whether tickets were sent but not acked

That will tell you which subsystem is next.

---

## 3. Add explicit first-round readiness observability in the coordinator path

You already fixed the small-case stall by delaying non-lead welcome acknowledgement until after replay/backfill and auto-approval work. That strongly suggests first-round readiness remains the key sensitivity point. 

### Do next

In Rust/Wasm coordinator state and TS service display, add a single structured readiness model:

* `not_joined`
* `welcome_received`
* `welcome_applied`
* `initial_backfill_complete`
* `auto_approval_attempted`
* `approval_visible`
* `round_open_safe`
* `round_open_sent`

### Why

You need to know exactly where the first round is slow or stuck in larger runs, rather than inferring from UI text.

### Exit condition

Each coordinator can surface a machine-readable readiness stage for round 1.

---

## 4. Make `2 / 2 / 2` a true reliability gate, not just “it passed twice”

This is the smallest meaningful multi-coordinator path and should be made boringly reliable.

### Do next

Run it repeatedly:

* 20+ consecutive local reruns minimum

Collect:

* time to join
* time to round-open
* time to blinded request visibility
* time to ticket ack
* any retries used

### Why

If `2 / 2 / 2` is still occasionally flaky, `5 / 10 / 3` will remain noisy and hard to interpret.

### Exit condition

You should have a small-run reliability baseline with no unexplained first-round failures.

---

## 5. Clean `SimpleRound.test.tsx` drift now, before more changes accumulate

This is not the main product blocker, but it is now an engineering blocker.

The report says `tsc --noEmit` is red mainly because of drift in `SimpleRound.test.tsx`, including stale shapes and helper names. 

### Do next

Fix or quarantine that file immediately.

### Preferred approach

* update mock config/result shapes to current protocol types
* restore or replace missing helper names
* remove stale assumptions like old `.status` expectations
* if needed, split the giant test into smaller current-state tests

### Why

A broken repo-wide typecheck means future refactors become much riskier.

### Exit condition

`cd web && npx tsc --noEmit` is green again.

---

## 6. Only after the harness is stable, harden `5 / 10 / 3`

Once you know the scale failure mode, apply targeted fixes.

### If the stall is still first-round control-plane startup

Harden:

* approval replay on non-leads
* bounded lead re-proposal/re-commit
* delayed round-open until all required control-plane milestones are met

### If the stall is public round visibility

Harden:

* round-history backfill before “no live round”
* retry on round-open publication visibility checks
* clearer separation between coordinator-open and voter-visible-open

### If the stall is blinded request fanout or ticket delivery

Harden:

* per-round request visibility diagnostics
* bounded retransmit on ticket send if no ack after a window
* duplicate-safe request/ticket handling

But do **not** guess which of these is needed before the harness tells you.

---

## 7. Defer larger architectural work until `5 / 10 / 3` is trustworthy

I would **not** yet prioritise:

* proof bundle skeleton
* receipt commitment compaction
* MLS cohort-group implementation
* 1,000-style simulation
* threshold tally work

Those are still important, but the next practical production step is to make your first real scale gate measurable and repeatable.

# Suggested execution order

1. **Fix live harness failure classification**
2. **Re-run `5 / 10 / 3` until you get a trustworthy failure or pass**
3. **Add explicit first-round readiness state**
4. **Make `2 / 2 / 2` repeatedly reliable**
5. **Fix `SimpleRound.test.tsx` and restore clean `tsc --noEmit`**
6. **Apply targeted `5 / 10 / 3` protocol/runtime fixes based on actual failure class**
7. **Then move on to receipt/proof compactness and scale simulations**

# Production-ready bar from here

The next meaningful bar is not “1,000 voters”.

It is:

* harness stable
* `2 / 2 / 2` boringly reliable
* `5 / 10 / 3` trustworthy and repeatable
* repo-wide typecheck green
* clear observability for first-round coordinator readiness

Once those are in place, you can sensibly push toward receipt commitments, proof bundles, and larger replay simulations.

So the most sensible next step is:

> **treat the harness as production infrastructure, fix it first, then use it to get a clean diagnosis of `5 / 10 / 3` before changing more protocol logic.** 
