The status is much better now because the failure is finally classified.

## Progress update - 2026-04-07

What is now done in the tree:

- per-ticket lifecycle tracing exists in:
  - `web/src/simpleShardDm.ts`
  - `web/src/SimpleUiApp.tsx`
  - `web/scripts/live-simple-relay-check.js`
- coordinator ticket deliveries now preserve prior `eventId` / `responseId` attempts so a real acknowledgement is not lost just because a resend replaced the latest tracked ids
- coordinator acknowledgement backfill now runs more frequently

Latest trustworthy scale evidence from the current `5 / 10 / 3` trace set:

- `withRequestSeen: 100 / 100`
- `withTicketBuilt: 100 / 100`
- `withPublishStarted: 100 / 100`
- `withPublishSucceeded: 100 / 100`
- `withVoterObserved: 72 / 100`
- `withAckSent: 72 / 100`
- `withAckSeen: 24 / 100`
- `sendGap: 28`
- `ackGap: 48`

So the current diagnosis is:

- **mixed failure**
- **ack-side is worse than send-side**
- there is still a real send-visibility problem under load, but the larger gap is now between:
  - voter sent acknowledgement
  - coordinator observed acknowledgement

Important current boundary:

- `5 / 10 / 3` is still not green
- `2 / 2 / 2` is no longer stable enough to call boringly green either; it still alternates between clean runs and first-round misses

You no longer have an ambiguous “browser/harness died” problem. You now have a **real protocol/runtime bottleneck**:

* round visibility is fine
* blind-key visibility is fine
* blinded requests are being sent
* the stall is in **ticket send / receipt acknowledgement throughput under round-1 load** 

So the next work should be organised around proving or disproving that exact hypothesis, in a sequence that makes it obvious where the system is failing.

# Clear staged plan

## Stage 1 - Freeze the diagnosis and stop changing unrelated logic

### Purpose

Make sure every future failure is comparable.

### What is already known

In the latest trustworthy `5 / 10 / 3` run:

* `roundSeen: 50 / 50`
* `blindKeySeen: 50 / 50`
* `blindedRequestSent: 50 / 50`
* `ticketSent: 49 / 50`
* `receiptAcknowledged: 26 / 50`

That means the main failure is **after** round-open and **after** blinded request publication. 

### Action

Do not make broad architectural changes now.
Do not touch:

* public round-open logic
* MLS welcome sequencing
* Rust replay ordering
* voter-in-MLS design
* proof/tally work

Only work on:

* DM/ticket-send path
* receipt-ack path
* scale diagnostics
* harness repeatability

### Exit condition

You have one stable branch where the only moving parts are ticket delivery and acknowledgement handling.

---

## Stage 2 - Build a per-ticket lifecycle trace

### Purpose

You need to know exactly where a ticket flow dies.

### Problem

Right now you know aggregate counts, but not the per-conversation failure boundary.

### Action

For every coordinator-voter ticket conversation in round 1, add a single trace record with timestamps for:

1. blinded request seen by coordinator
2. ticket payload created
3. publish attempt started
4. publish success or timeout
5. ticket event observed back from relay
6. voter saw ticket
7. voter sent receipt acknowledgement
8. coordinator saw acknowledgement

### Where

Primarily:

* `web/src/simpleShardDm.ts`
* `web/src/simpleVotingSession.ts`
* `web/src/services/CoordinatorControlService.ts`
* harness dump path under `web/.planning/debug/live-harness`

### Output format

Use a structured JSON record per ticket conversation:

```json
{
  "round": 1,
  "coordinator": "c3",
  "voter": "v7",
  "conversationKey": "c3->v7",
  "blindedRequestSeenAt": 123,
  "ticketBuiltAt": 130,
  "publishStartedAt": 132,
  "publishSucceededAt": 148,
  "publishTimedOutAt": null,
  "ticketObservedByVoterAt": 211,
  "ackSentAt": 225,
  "ackSeenByCoordinatorAt": null
}
```

### Why

This will tell you whether the failure is mostly:

* coordinator publish timeout
* relay visibility delay
* voter receipt processing delay
* ack publish delay
* ack visibility delay back to coordinator

### Exit condition

For one failed `5 / 10 / 3` run, you can group all failed conversations into one of those buckets.

---

## Stage 3 - Determine whether the bottleneck is send-side or ack-side

### Purpose

Avoid guessing.

### Interpretation logic

#### Case A - send-side bottleneck

You see many conversations where:

* blinded request seen
* ticket built
* publish started
* publish timeout or long delay
* voter never sees ticket

Then the problem is **ticket send throughput / relay publish pressure**.

#### Case B - ack-side bottleneck

You see many conversations where:

* ticket publish succeeds
* voter sees ticket
* voter sends ack
* coordinator never sees ack

Then the problem is **receipt acknowledgement propagation or observation**.

#### Case C - mixed

You see both patterns materially.

Then you need separate mitigations for:

* send path
* ack path

### Exit condition

You can say, with evidence, “the dominant failure is X”.

---

## Stage 4 - Stress-test the DM publish path in isolation

### Purpose

Prove whether DM transport is collapsing under fanout.

### Problem

The latest report already notes:

* some publishes reported `publish timed out`
* queueing changed from recipient-only to sender-recipient conversation keys
* scale still times out under ticket-send / receipt-ack pressure 

### Action

Create a focused test that does **not** involve full voting rounds.

Simulate only:

* 5 coordinators
* 10 voters
* round already open
* blinded requests already present
* send 50 ticket DMs
* measure publish success/latency
* then send 50 acks back
* measure publish success/latency

### Where

Add a targeted test/harness mode in:

* `web/scripts/live-simple-relay-check.js`
* or a new dedicated script under `web/scripts/`

### Measurements

Record:

* publish latency distribution
* timeout count
* duplicate count
* observed-vs-published mismatch count
* ack round-trip latency

### Exit condition

You know whether the DM plane itself can sustain the required burst for one round.

---

## Stage 5 - Fix the dominant send-path problem, if confirmed

### If Stage 3 shows send-side congestion is dominant

### Most likely fixes

1. **Bound concurrent ticket sends per coordinator**

   * do not fire all ticket publishes at once
   * use a small concurrency window, e.g. 2 to 4

2. **Separate “publish started” from “delivered enough to proceed”**

   * ticket state should distinguish:

     * built
     * publish pending
     * publish confirmed
     * visible to voter
   * do not keep retrying blindly without state

3. **Increase publish timeout only if measurement justifies it**

   * do not just stretch timeouts globally without evidence

4. **Add resend with idempotent ticket identifiers**

   * if send times out but ticket may still appear later, retries must not create ambiguity
   * every ticket message needs a stable message id

5. **Shard DM relay usage if currently too concentrated**

   * if all private traffic is hammering too narrow a relay subset, widen or rebalance it

### Exit condition

A repeated 50-ticket burst test shows near-complete ticket visibility without pathological timeout growth.

---

## Stage 6 - Fix the dominant ack-path problem, if confirmed

### If Stage 3 shows ack-side congestion is dominant

### Most likely fixes

1. **Make voter ack send immediate and single-purpose**

   * no extra waits after ticket receipt
   * ack generated as soon as the ticket is validated locally

2. **Use idempotent acknowledgement records**

   * stable ack id per ticket
   * duplicate-safe handling on coordinator side

3. **Improve coordinator-side ack observation**

   * poll/backfill the conversation after send if ack not seen in window
   * do not rely only on live subscription timing

4. **Add bounded ack recovery**

   * if coordinator sent ticket and no ack seen after a window, run a focused history fetch for that conversation

5. **Surface ack-state diagnostics in UI and logs**

   * “ticket sent, ack missing”
   * “ack published, not yet observed”
   * “ack observed”

### Exit condition

Most failed conversations are no longer “ticket sent, waiting for ack” indefinitely.

---

## Stage 7 - Re-baseline the small gate after every DM-plane change

### Purpose

Protect against regressions.

The report already says `2 / 2 / 2` is passing now, but it still needs a proper repetition baseline after the DM queue-key change. 

### Action

After every material DM-path change:

* rerun `2 / 2 / 2` at least 10 times
* compare:

  * round 1 latency
  * ticket send latency
  * ack latency
  * pass/fail rate

### Exit condition

No fix for scale is allowed to destabilise the small gate.

---

## Stage 8 - Restore repo-wide TypeScript trustworthiness

### Purpose

You need clean typechecking before doing more large edits.

The report says `npx tsc --noEmit` is still red because of drift in `SimpleRound.test.tsx`. 

### Action

Fix or isolate:

* `web/src/SimpleRound.test.tsx`

Specifically:

* update stale coordinator config mocks
* update stale result object shapes
* restore or replace missing helper names
* remove outdated assumptions about `.status`

### Why now

Not because it fixes scale directly, but because you need the repo-wide TS signal back before more refactors pile up.

### Exit condition

`cd web && npx tsc --noEmit` is green.

---

## Stage 9 - Re-run `5 / 10 / 3` until the failure changes or disappears

### Purpose

Prove the fix worked, or move to the next actual bottleneck.

### Action

After the dominant send/ack fix:

* rerun `5 / 10 / 3` repeatedly
* collect structured dumps each time
* compare whether the bottleneck remains:

  * ticket send
  * ack
  * something later

### Desired result

Either:

* it passes repeatedly
* or the failure moves to a new, cleaner stage

That is real progress.

---

## Stage 10 - Only after `5 / 10 / 3` is green, continue the broader production plan

Only then resume:

* moving remaining TS issuance/ticket truth into Rust
* compact receipt commitments
* proof bundle skeleton
* MLS cap enforcement in code
* 1,000-style replay simulations

Those are still important, but they are not the immediate blocker right now.

# Short diagnosis summary

The system is **not failing because MLS bootstrap is broken anymore**.

It is currently failing because:

* first-round scale now reaches live round visibility
* blind keys are visible
* blinded requests are sent
* then the private ticket-delivery / receipt-ack path saturates or stalls under load in round 1 

So the next work should be about:

> **turning ticket delivery and acknowledgement into a fully traceable, measured, idempotent, congestion-tolerant path**

# Simplest practical sequence

If you want the shortest possible list:

1. **Add per-ticket lifecycle tracing**
2. **Classify send-side vs ack-side dominant failure**
3. **Stress-test DM transport in isolation**
4. **Fix the dominant congestion path**
5. **Repeat `2 / 2 / 2` many times**
6. **Repeat `5 / 10 / 3` until pass or new bottleneck**
7. **Clean `SimpleRound.test.tsx` so repo-wide typecheck is useful again**

That is the clearest route to understanding exactly why it is not working, and how to fix it.
