# STATUS3

Repository: `/home/tom/code/auditable-voting`  
Date: `2026-04-08`  
Current visible app version: `v0.73`

## Current headline

The scale failure is now properly instrumented, and the small gate has moved forward again with shard-request id normalisation, but the larger relay-scale gate is still unresolved.

What is currently true:

- `1 coordinator / 2 voters / 2 rounds` still passes locally
- `2 coordinators / 2 voters / 2 rounds` has a fresh clean rerun on `v0.73`, but is still not signed off as repeatedly reliable
- the recurring small-case `round 1` stall was caused by opening the round before the non-lead had completed enough MLS/control-plane startup work, and the live harness had also been firing round 1 on a blind timer rather than waiting for visible readiness
- `5 coordinators / 10 voters / 3 rounds` is still **not signed off**
- the latest trustworthy scale failure before the latest request-id fix was **mixed, with acknowledgement visibility worse than send-side delivery under load**
- the latest trustworthy `5 / 10 / 3` rerun now gets materially through round 1 before timing out later

This file is intended as a handoff for another model to continue analysis, not as a claim that the whole migration plan is complete.

---

## New change in `v0.73`

The voter/coordinator DM request path was carrying two ids for the same logical blinded request:

- top-level DM `request_id`
- nested `blind_request.requestId`

Those ids were diverging because the DM envelope was generating a fresh UUID while later ticket and acknowledgement logic used the nested blind-request id. That created avoidable later-round mismatch risk in:

- pending request cleanup
- request retry selection
- ticket trace correlation
- acknowledgement matching

### Fix made

Main file:

- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)

Changes:

1. `sendSimpleShardRequest(...)` now publishes `request_id: input.blindRequest.requestId` instead of a new random UUID.
2. `parseSimpleShardRequest(...)` now normalises parsed request ids to `blind_request.requestId` when present, so older mixed-id events also replay more consistently.

Supporting test:

- [web/src/simpleShardDm.test.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.test.ts)
  - asserts outbound request id matches the blind request id
  - asserts parsed requests normalise to the blind request id even if the envelope id differed

Verification for this tranche:

```bash
cd web && npx vitest run src/simpleShardDm.test.ts src/simpleVotingSession.test.ts src/services/CoordinatorControlService.test.ts src/core/derivedStateAdapter.test.ts src/services/ProtocolStateService.test.ts
cd web && npm run build
```

Latest live small-gate rerun after this fix:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4218/simple.html \
LIVE_COORDINATORS=2 \
LIVE_VOTERS=2 \
LIVE_ROUNDS=2 \
LIVE_STARTUP_WAIT_MS=20000 \
LIVE_ROUND_WAIT_MS=15000 \
LIVE_TICKET_WAIT_MS=15000 \
LIVE_NIP65=off \
npm --prefix web run test:live-relays
```

Observed:

- round 1: `2/2` voters got `2 of 2`
- round 2: `2/2` voters got `2 of 2`

That is a useful repair, but it is still a single fresh rerun, not a final stability claim.

---

## What was fixed in the earlier small-run repair

The small-run stall was happening before any blinded requests started:

- voters saw no live round
- coordinators stayed at:
  - `Follow request received.`
  - `Waiting for this voter's blinded ticket request.`
  - `Waiting for a live round.`

The working theory was that the lead was treating “welcome applied” as sufficient readiness for the first `round open` wave, but the non-lead still had a startup race around initial coordinator-control replay and first approval publication.

### Changes made

Main file:

- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)

Important logic changes:

1. Non-lead MLS welcome acknowledgement is now delayed until after an initial coordinator-control backfill/replay pass completes.
2. After welcome join, the non-lead explicitly:
   - fetches coordinator-control history
   - replays it through the Rust service
   - attempts auto-approval
   - only then sends the `simple_mls_welcome` acknowledgement back to the lead
3. The lead still waits for welcome acknowledgements before opening the first round.
4. A bounded lead-side recovery loop was added for `open_proposed` rounds:
   - if the lead remains stuck waiting for approvals
   - it republishes the same-round proposal/commit up to a small retry limit

Additional related change:

- [web/src/services/CoordinatorControlService.ts](/home/tom/code/auditable-voting/web/src/services/CoordinatorControlService.ts)
  - coordinator-control publish path now retries and only applies local echo after at least one relay success

Supporting TypeScript cleanup in this pass:

- [web/src/simpleShardCertificate.ts](/home/tom/code/auditable-voting/web/src/simpleShardCertificate.ts)
- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
  - interval typing adjusted to `ReturnType<typeof globalThis.setInterval>` to avoid Node/browser timer drift in strict typing

Docs updated to reflect the current shipped behaviour:

- [README.md](/home/tom/code/auditable-voting/README.md)
- [docs/project-explainer.md](/home/tom/code/auditable-voting/docs/project-explainer.md)
- [web/public/project-explainer.html](/home/tom/code/auditable-voting/web/public/project-explainer.html)
- [presentation/project-overview.html](/home/tom/code/auditable-voting/presentation/project-overview.html)
- [docs/phases](/home/tom/code/auditable-voting/docs/phases)
- [TODO3.md](/home/tom/code/auditable-voting/.planning/TODO3.md)

---

## Verified behaviour on the latest build

Preview used for the latest clean checks:

- `http://127.0.0.1:4211/simple.html`

### Current live checks

1. `1 / 2 / 2`

Command shape:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4211/simple.html \
LIVE_COORDINATORS=1 \
LIVE_VOTERS=2 \
LIVE_ROUNDS=2 \
LIVE_STARTUP_WAIT_MS=20000 \
LIVE_ROUND_WAIT_MS=15000 \
LIVE_TICKET_WAIT_MS=15000 \
LIVE_NIP65=off \
npm --prefix web run test:live-relays
```

Observed:

- round 1: `2/2` voters got tickets
- round 2: `2/2`

2. `2 / 2 / 2`

Command shape:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4211/simple.html \
LIVE_COORDINATORS=2 \
LIVE_VOTERS=2 \
LIVE_ROUNDS=2 \
LIVE_STARTUP_WAIT_MS=20000 \
LIVE_ROUND_WAIT_MS=15000 \
LIVE_TICKET_WAIT_MS=15000 \
LIVE_NIP65=off \
npm --prefix web run test:live-relays
```

Observed most recently:

- one rerun completed round 1 and round 2 cleanly
- a later rerun missed round 1 entirely and only completed round 2
- so the small multi-coordinator gate is **not yet stable enough to mark green**

Round-1 startup remains the weak point in the small gate, even though it can succeed.

---

## What is still unresolved

### 1. `5 / 10 / 3` is not signed off

Latest trustworthy command:

```bash
LIVE_SIMPLE_BASE_URL=http://127.0.0.1:4213/simple.html \
LIVE_COORDINATORS=5 \
LIVE_VOTERS=10 \
LIVE_ROUNDS=3 \
LIVE_STARTUP_WAIT_MS=25000 \
LIVE_ROUND_WAIT_MS=20000 \
LIVE_TICKET_WAIT_MS=20000 \
LIVE_NIP65=off \
npm --prefix web run test:live-relays
```

Latest result:

- the hardened harness timed out with a structured `protocol_timeout` dump instead of collapsing
- per-ticket lifecycle tracing is now available in the dump
- the latest trace summary for the failed `5 / 10 / 3` run shows:
  - `withRequestSeen: 100 / 100`
  - `withTicketBuilt: 100 / 100`
  - `withPublishStarted: 100 / 100`
  - `withPublishSucceeded: 100 / 100`
  - `withVoterObserved: 72 / 100`
  - `withAckSent: 72 / 100`
  - `withAckSeen: 24 / 100`
  - `sendGap: 28`
  - `ackGap: 48`
- coordinators and voters stayed alive throughout; snapshots were written under:
  - `/home/tom/code/auditable-voting/web/.planning/debug/live-harness`

Concrete observations from that run:

- the scale run reached round 1 broadly
- all coordinator-voter pairs built and attempted ticket publishes
- the failure is now clearly **mixed**
- there is still real send/visibility loss:
  - `28` traced conversations had `publishSucceededAt` without voter observation
- but the larger remaining gap is acknowledgement visibility:
  - `48` traced conversations had `ackSentAt` without coordinator observation
- many coordinators were still showing:
  - `Ticket sent. Waiting for voter ticket receipt acknowledgement.`
- some ticket publishes still reported:
  - `publish timed out`
- the previous ambiguous harness/browser-closure failure mode is no longer the blocker

Additional targeted changes after classification:

- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
  - per-ticket lifecycle tracing
  - more frequent acknowledgement backfill
  - DM publish queueing keyed by sender-recipient conversation
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)
  - ticket deliveries now preserve prior `eventId` / `responseId` attempts so a valid acknowledgement is not lost when a resend replaces the latest tracked ids

Effect of those changes:

- diagnosis is much sharper
- stale latest-attempt receipt matching is reduced
- `5 / 10 / 3` is still timing out
- `2 / 2 / 2` is still not stable enough to sign off

So the current status is:

- small gate: flaky
- scale gate: unresolved
- latest scale failure mode: trustworthy protocol timeout with mixed send/ack failure, ack-side dominant

### 2. `npx tsc --noEmit` is still red because of pre-existing drift in `SimpleRound.test.tsx`

Latest relevant command:

```bash
cd web && npx tsc --noEmit
```

Current failures are dominated by the large legacy test file:

- [web/src/SimpleRound.test.tsx](/home/tom/code/auditable-voting/web/src/SimpleRound.test.tsx)

Examples:

- stale mocked coordinator config shape still expects older fields
- stale mock result objects still expect `.status`
- missing helper names like:
  - `coordinatorControlPublishAttempts`
  - `coordinatorMlsWelcomes`
  - `coordinatorMlsWelcomeSubscribers`
  - `autoDeliverCoordinatorMlsWelcomes`

The app build and focused tests are green; the repository-wide TypeScript check is not yet clean because of this test drift.

---

## Commands that passed in this pass

```bash
cargo test --manifest-path auditable-voting-core/Cargo.toml --features openmls-engine
```

```bash
cd web && npx vitest run \
  src/services/CoordinatorControlService.test.ts \
  src/simpleVotingSession.test.ts \
  src/simpleShardDm.test.ts \
  src/core/derivedStateAdapter.test.ts \
  src/services/ProtocolStateService.test.ts
```

```bash
cd web && npm run build
```

Live gates that passed:

- `1 / 2 / 2`
- repeated `2 / 2 / 2`

---

## Current likely next steps

If another model continues from here, the best next tasks are:

1. Keep the hardened harness and use the structured dumps as the default scale diagnosis path.
   - Focus files:
     - [web/scripts/live-simple-relay-check.js](/home/tom/code/auditable-voting/web/scripts/live-simple-relay-check.js)
     - `/home/tom/code/auditable-voting/web/.planning/debug/live-harness`

2. Target ticket-send / receipt-ack congestion specifically.
   - Current likely hotspots:
     - DM publish max-wait / timeout behaviour
     - ticket resend cadence under load
     - voter-side shard-response visibility / acknowledgement timing
     - relay subset pressure on the DM plane

3. Run the small reliability gate repeatedly, not just once.
   - `2 / 2 / 2` still needs a proper repetition baseline after the latest DM queue-key change.

4. Clean up `SimpleRound.test.tsx` drift so `tsc --noEmit` becomes useful again.

---

## Important caution

Do **not** overclaim the current state.

Accurate summary:

- browser OpenMLS coordinator path is live
- small multi-coordinator gate is now materially better and currently passing
- large-scale live reliability is still unresolved, but now with a trustworthy protocol-timeout classification
- the migration plan is still not complete
