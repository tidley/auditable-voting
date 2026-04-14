Here is the clearest staged programme from the latest update.

## Progress update: `v0.73`

One concrete later-round correctness bug is now fixed:

- shard-request DM envelopes were using a different top-level `request_id` from the nested `blind_request.requestId`
- later ticket and acknowledgement logic uses the blind-request id
- that meant retries and later-round recovery could treat one logical request as two different requests

Implemented:

- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
  - outbound `simple_shard_request` now uses the blind-request id as the DM request id
  - parsed shard requests now normalise to the blind-request id when present
- [web/src/simpleShardDm.test.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.test.ts)
  - added coverage for outbound id consistency
  - added coverage for parser normalisation

Fresh local live result after that fix:

- `2 / 2 / 2`: one full clean rerun

Still unresolved:

- repeated reliability is not yet proven
- `5 / 10 / 3` is still not signed off in this tranche

The key change is that the failure is now classified well enough to stop guessing. The latest status says:

* widened relay selection improved things
* blind fixed-timer round-1 triggering was reduced by waiting for visible lead readiness
* `2 / 2 / 2` still degrades later, so the small gate is **not** stable
* `5 / 10 / 3` gets materially through round 1 now, but still times out later
* the dominant blocker is still the **DM ticket / acknowledgement pipeline**, especially **ack visibility under load** 

# Stage 1 - Re-stabilise the small gate

## Objective

Make `2 coordinators / 2 voters / 2 rounds` pass reliably across repeated reruns.

## Why this exists

The latest update says one fresh rerun no longer missed round 1, but the same rerun degraded in round 2 to `1 of 2` tickets per voter. So the small gate is still not trustworthy. 

## What this means

There is still a readiness or later-round settlement race. It is no longer just “MLS bootstrap missing”. It is more likely one of:

* final coordinator readiness not actually complete
* round-open visible, but ticket plane not actually settled
* later-round DM state still inheriting unresolved round-1 pressure
* ack recovery not strong enough before round 2 starts

## Required work

### 1. Add explicit readiness phases

In Rust or Rust-backed service state, expose:

* `mls_join_complete`
* `initial_control_backfill_complete`
* `auto_approval_complete`
* `round_open_publish_safe`
* `blind_key_publish_safe`
* `ticket_plane_safe`

### 2. Gate round open on all required readiness

The lead must not open a round until all required readiness flags are true.

### 3. Add round transition settlement guard

Do not allow round 2 to start unless round 1 has no unresolved required coordinator-side ticket states still pending beyond a bounded threshold.

### 4. Instrument round-2 startup specifically

Record:

* time round 1 closed
* unresolved ticket/ack count at that moment
* time round 2 opened
* unresolved ticket/ack count when round 2 started

## Required tests

* rerun `2 / 2 / 2` at least 20 times
* record:

  * round-1 open latency
  * round-2 open latency
  * unresolved ticket count at round boundary
  * pass/fail count

## Exit condition

`2 / 2 / 2` passes repeatedly enough that neither round is intermittently missing or degraded.

---

# Stage 2 - Turn ticket delivery into a measured pipeline

## Objective

Stop treating ticket send + ack as one opaque blob.

## Why this exists

The current evidence is already strong:

* `withPublishSucceeded: 100 / 100`
* `withVoterObserved: 72 / 100`
* `withAckSent: 72 / 100`
* `withAckSeen: 24 / 100`
* `sendGap: 28`
* `ackGap: 48`

So the failure is mixed, but **ack-side is worse**. 

## Required work

### 1. Make lifecycle states explicit

Every coordinator-voter ticket conversation must move through:

* `request_seen`
* `ticket_built`
* `publish_started`
* `publish_succeeded`
* `voter_observed`
* `ack_sent`
* `ack_seen`

### 2. Record full trace metadata for each transition

For every state transition, record:

* timestamp
* event id
* response id
* stable ticket id
* resend count
* whether this was latest attempt
* relay publish result
* relay visibility result
* round number
* coordinator id
* voter id

### 3. Produce per-run structured summaries

At end of each failed run, output:

* counts by stage
* conversations stuck at each stage
* latency histogram by stage
* clustering by:

  * coordinator
  * voter
  * round
  * relay subset

## Exit condition

Every failed `5 / 10 / 3` run can be classified precisely as:

* send-visibility dominant
* ack-visibility dominant
* mixed
* resend/id-matching regression

---

# Stage 3 - Fix ack-side dominant failure first

## Objective

Shrink `ackGap` before working on second-order send tuning.

## Why this exists

The latest update explicitly says the failure is mixed but **ack-side dominant**. 

## Likely cause

Acks are either:

* not being observed reliably
* not being matched reliably
* being lost behind live-subscription timing
* being obscured by resend attempt identity churn

## Required work

### 1. Make acknowledgement identity stable

For each ticket:

* define one stable `ticket_id`
* define one stable `ack_id` derived from it
* resends must not create a logically different acknowledgement target

### 2. Preserve all valid matching identities

If legacy or transitional paths require old `eventId` / `responseId` compatibility, keep them as aliases, but the canonical matching key must be `ticket_id`.

### 3. Add bounded ack backfill

If state becomes:

* `ticket_sent`
* no ack seen after threshold

then:

* fetch recent DM history for that exact conversation
* replay through the same reducer
* accept a valid ack found via backfill
* mark unresolved explicitly if still absent

### 4. Separate “ack not seen live” from “ack absent”

That distinction must be visible in diagnostics.

## Required tests

* ack seen only via backfill
* duplicate ack safe
* old resend attempt ack still maps to same stable ticket
* live + backfill produce same final ack state
* later-round ack does not regress earlier-round ticket state

## Exit condition

The number of conversations stuck at `ack_sent but ack_not_seen` drops materially in `5 / 10 / 3`.

---

# Stage 4 - Fix send-side visibility loss second

## Objective

Shrink `sendGap` after ack-side recovery is improved.

## Why this exists

There is still real send-side loss:

* `publishSucceededAt` exists
* but voter observation is missing in 28 traced conversations 

## Likely cause

One or more of:

* relay success semantics do not match later visibility
* publish timeout and real relay propagation are misaligned
* resend cadence causes confusion
* relay subset choice is still suboptimal under burst load

## Required work

### 1. Bound concurrent sends per coordinator

Do not let a coordinator flood all pending tickets at once.
Use a small concurrency window.

### 2. Distinguish publish success from voter observation

Ticket state must separately track:

* `publish_succeeded`
* `voter_observed`

### 3. Add bounded visibility recovery

If publish succeeded but voter did not observe after a threshold:

* fetch recent conversation history
* replay
* if still absent, retry with same stable ticket identity

### 4. Measure relay subset behaviour

Record which relay subset each send used and whether those paths correlate with missing voter observation.

## Required tests

* send visible only after backfill
* duplicate ticket safe under retry
* stable ticket id across retries
* bounded concurrency improves observation rate under burst

## Exit condition

`sendGap` falls materially and no longer dominates round-1 or round-2 failures.

---

# Stage 5 - Prevent unresolved DM pressure from contaminating later rounds

## Objective

Stop round 2 degradation caused by unfinished round-1 ticket/ack work.

## Why this exists

The latest update says round 1 can now complete cleanly in small runs, but round 2 can still degrade. That strongly suggests unresolved conversation state is leaking into later-round behaviour. 

## Required work

### 1. Round-scope all ticket and ack state explicitly

Every ticket conversation must include:

* `election_id`
* `round_id`
* `ticket_id`
* `ack_id`

### 2. Add end-of-round drain summary

Before next round:

* count unresolved sends
* count unresolved acks
* count unresolved backfill checks

### 3. Add bounded carry-forward policy

Do not let unresolved prior-round DM traffic silently interfere with current-round matching or UI status.

### 4. Surface unresolved prior-round state in diagnostics

If round 2 starts while round 1 still has unresolved conversations, that must be visible.

## Required tests

* prior-round resend does not satisfy next-round ticket state
* prior-round missing ack does not corrupt next-round matching
* round boundary summary matches replay state

## Exit condition

Round 2 reliability is no longer worse because of leftover round-1 DM state.

---

# Stage 6 - Keep the harness as the main diagnosis tool

## Objective

Do not lose the new observability.

## Why this exists

The harness is now good enough to classify failures structurally. That is valuable and should remain the main debugging surface. 

## Required work

Keep:

* structured dumps
* per-ticket lifecycle trace
* run artefacts under `.planning/debug/live-harness`

Extend if useful:

* aggregate ack-gap/send-gap summary
* round-boundary unresolved summary
* per-coordinator backlog summary

## Exit condition

Every failed live run yields enough structured data to decide the next change without guessing.

---

# Stage 7 - Restore repo-wide TypeScript signal

## Objective

Make `tsc --noEmit` useful again.

## Why this exists

The report still says repo-wide TS checking is red because of drift in `SimpleRound.test.tsx`. 

## Required work

Fix or split:

* `web/src/SimpleRound.test.tsx`

Update:

* stale config mocks
* stale result shapes
* missing helper names
* outdated `.status` expectations

## Exit condition

`cd web && npx tsc --noEmit` is green.

---

# Stage 8 - Only after small-gate and DM stability, move on

Do **not** jump ahead to:

* proof bundle work
* receipt commitments
* 1,000-style simulations
* cohort-group expansion
* threshold tally work

until these are true:

* `2 / 2 / 2` is stable
* `5 / 10 / 3` is either passing or failing in one narrowly-understood way
* ack-side and send-side gaps are materially reduced

# Short version

## Immediate next phases

1. **Re-stabilise `2 / 2 / 2`**
2. **Make ticket/ack lifecycle fully measurable**
3. **Fix ack-side dominant failure**
4. **Fix send-side visibility loss**
5. **Stop unresolved round-1 DM state contaminating round 2**
6. **Keep harness-driven diagnosis**
7. **Restore clean repo-wide TS typecheck**

## Core understanding

It is currently **not** primarily failing because of MLS bootstrap.

It is failing because:

* small-run round startup is still not fully settled
* larger runs hit a **mixed DM pipeline bottleneck**
* **ack visibility is worse than send visibility**
* later rounds may inherit unresolved prior-round DM pressure 

If you want, I can convert these stages into a paste-ready `TODO next` section for the repo.
