This is a good fix.

It removes one real correctness hazard: the same logical blinded request no longer carries two competing ids. That directly improves:

* retry selection
* pending request cleanup
* ticket trace correlation
* acknowledgement matching
* later-round replay consistency

It also fits the current evidence: the system is no longer mainly failing at MLS bootstrap or round visibility; it is failing in the private DM request/ticket/ack path under load.

## What this fix changes

Before this change, one logical request could diverge into:

* DM envelope `request_id`
* nested `blind_request.requestId`

That means later logic could:

* retry the wrong request
* fail to match a ticket to the intended request
* fail to match an acknowledgement to the intended ticket lineage
* treat an old request and a resent request as different conversations

Now that outbound and parsed request ids normalise to the blind-request id, the whole downstream pipeline has a much better chance of remaining coherent across:

* resend
* replay
* recovery
* later rounds

So this was a **worthwhile structural fix**, not just cleanup.

## What it does **not** prove yet

It does **not** yet prove:

* repeated `2 / 2 / 2` reliability
* `5 / 10 / 3` viability
* that ack visibility is solved
* that later-round contamination is solved
* that all resend/id-matching issues are gone

A single fresh clean rerun is encouraging, but it is still only a signal.

## Progress update after implementation work

This tranche is now partly executed.

### Added tooling

- [web/scripts/live-simple-relay-repeat.js](/home/tom/code/auditable-voting/web/scripts/live-simple-relay-repeat.js)
- [web/package.json](/home/tom/code/auditable-voting/web/package.json)

The repo now has a repeat runner for the existing live harness:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4220/simple.html \
LIVE_COORDINATORS=2 \
LIVE_VOTERS=2 \
LIVE_ROUNDS=2 \
LIVE_STARTUP_WAIT_MS=20000 \
LIVE_ROUND_WAIT_MS=15000 \
LIVE_TICKET_WAIT_MS=15000 \
LIVE_NIP65=off \
LIVE_REPEAT_COUNT=5 \
npm --prefix web run test:live-relays:repeat
```

### Repeat result on `v0.73`

- repeated runs: `5`
- fully passing runs: `4`
- failed runs: `1`

Round-by-round:

- round 1:
  - successes: `4/5`
  - failures: `1/5`
  - failed sample had:
    - `votersWithTickets: 0`
    - `ticketSent: 0`
    - `ackSeen: 0`
- round 2:
  - successes: `5/5`
  - failures: `0/5`

So the request-id repair materially improved the small gate, but did **not** make it boringly reliable yet. The weak point is still round-1 startup under some reruns, not later-round degradation in this sample.

### Fresh `5 / 10 / 3` reclassification on `v0.73`

Latest command:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4220/simple.html \
LIVE_COORDINATORS=5 \
LIVE_VOTERS=10 \
LIVE_ROUNDS=3 \
LIVE_STARTUP_WAIT_MS=25000 \
LIVE_ROUND_WAIT_MS=20000 \
LIVE_TICKET_WAIT_MS=20000 \
LIVE_NIP65=off \
npm --prefix web run test:live-relays
```

Observed:

- failure class: `protocol_timeout`
- completed rounds: none
- round 1 stage metrics:
  - `roundSeen: 0 / 50`
  - `blindKeySeen: 0 / 50`
  - `blindedRequestSent: 0 / 50`
  - `ticketSent: 0 / 50`
  - `receiptAcknowledged: 0 / 50`

This means the latest scale failure no longer looks like the previously classified mixed send/ack bottleneck. On this rerun it failed earlier, at first-round public/control visibility again.

# Next phases

## Phase 1 - Prove the id fix actually stabilised the small gate

### Goal

Determine whether this request-id repair materially improves repeatability.

### Do next

Run `2 / 2 / 2` repeatedly, ideally 20+ times, on the same build.

Record for each run:

* round 1 success/failure
* round 2 success/failure
* request count
* ticket sent count
* ack seen count
* unresolved conversations at round boundary
* whether any request lineage splits still appear

### What to look for

If the new id model is helping, you should see:

* fewer later-round mismatches
* fewer “ticket sent, waiting for ack” conversations that never resolve
* fewer cases where round 2 degrades after a clean round 1

### Exit condition

`2 / 2 / 2` is boringly reliable, not just occasionally clean.

---

## Phase 2 - Expand lineage tracing from request id to full conversation lineage

### Goal

Make every ticket conversation unambiguous.

### Why

You fixed the first request identity split. Now you need to make sure the rest of the pipeline also uses one stable lineage.

### Do next

For each logical conversation, define and persist:

* `request_id` = blind-request id
* `ticket_id` = stable id derived from or linked to request id
* `ack_id` = stable id derived from ticket id

Do **not** let resend generate a new logical lineage.

### Add tracing

For every conversation record:

* request seen
* ticket built
* publish started
* publish succeeded
* voter observed
* ack sent
* ack seen

And always include:

* stable `request_id`
* stable `ticket_id`
* stable `ack_id`
* resend count
* latest attempt id
* prior valid attempt ids

### Exit condition

Every failed conversation can be traced end-to-end without ambiguity.

---

## Phase 3 - Re-test `5 / 10 / 3` and reclassify the failure

### Goal

See how much of the previous scale failure was caused by request-lineage mismatch versus real DM congestion.

### Do next

Re-run `5 / 10 / 3` with the new request-id fix and the current structured harness.

Compare the previous metrics to the new run:

* `withRequestSeen`
* `withTicketBuilt`
* `withPublishStarted`
* `withPublishSucceeded`
* `withVoterObserved`
* `withAckSent`
* `withAckSeen`
* `sendGap`
* `ackGap`

### What to look for

Best case:

* `sendGap` drops
* `ackGap` drops
* more round-1 completions
* fewer stuck later-round conversations

More realistic immediate outcome:

* `sendGap` changes modestly
* `ackGap` remains the larger problem
* but trace correlation becomes much cleaner

### Exit condition

You have a new trustworthy `5 / 10 / 3` trace showing whether the id fix materially reduced the gap.

---

## Phase 4 - Fix stable ack identity and matching

### Goal

Apply the same discipline to acknowledgements that you just applied to requests.

### Why

Your current dominant failure remains ack-side visibility/matching under load. The request-id fix helps upstream, but ack matching likely still needs the same treatment.

### Do next

Make acknowledgement identity stable and derived from the stable ticket identity.

Rules:

* one logical ticket -> one logical ack target
* resend must not change what counts as a valid ack
* older valid ack observations must still satisfy the same logical ticket

### Add logic

If an ack arrives for:

* current attempt id
* prior valid attempt id
* stable ticket-derived ack id

then it should reconcile to the same logical conversation.

### Exit condition

Ack matching is no longer dependent on whichever attempt was latest.

---

## Phase 5 - Add bounded ack recovery via conversation backfill

### Goal

Reduce the cases where ack was probably sent but not seen live.

### Do next

After a ticket is marked sent:

* wait a short threshold
* if ack not seen, fetch recent history for that exact conversation
* replay it through the same reducer
* accept any valid ack found through backfill

### Why

This addresses the likely case where:

* ticket was delivered
* voter observed it
* voter sent ack
* coordinator missed it in live flow

### Exit condition

A noticeable fraction of `ack_sent but ack_not_seen` cases now resolve via backfill.

---

## Phase 6 - Prevent unresolved round-1 DM state contaminating round 2

### Goal

Stop later-round degradation caused by stale prior-round state.

### Why

Your clean `2 / 2 / 2` rerun is promising, but the broader pattern has been that later rounds degrade after earlier-round pressure.

### Do next

Make round scoping strict for:

* request ids
* ticket ids
* ack ids
* pending state
* cleanup logic

Before opening round 2, record:

* unresolved requests
* unresolved tickets
* unresolved acks
* conversations still under backfill recovery

If there is too much unresolved state, either:

* delay round 2 briefly
* or surface explicit diagnostics

### Exit condition

Round 2 no longer fails because round 1 left ambiguous DM state behind.

# Best immediate interpretation

This fix most likely means:

* one class of later-round mismatch bug is removed
* trace quality should improve
* resend logic should become more coherent
* small-gate reliability may improve

But the likely dominant blocker is still:

> **ack visibility and acknowledgement reconciliation under load**

So the most sensible next move is **not** new architecture work. It is:

1. stress the small gate repeatedly
2. re-run `5 / 10 / 3`
3. compare the new `sendGap` and `ackGap`
4. then target stable ack identity and bounded ack backfill

## Short version

### Immediate next steps

1. Repeat `2 / 2 / 2` many times
2. Re-run `5 / 10 / 3` with current tracing
3. Compare gap metrics before/after this id fix
4. Make ack identity stable
5. Add conversation-specific ack backfill
6. Enforce stricter round-boundary cleanup

That is the cleanest route from this fix to understanding whether the remaining problem is still mostly:

* ack matching
* ack visibility
* or residual send-side congestion.
