<!-- STATUS4 pointer: This file is historical context. Current planning status is in .planning/STATUS4.md (2026-04-16, v0.134). -->

TODO6 progress update on `v0.72`

- done:
  - widened ticket and acknowledgement DM publish/read relay selection beyond the ordinary DM subset
  - widened coordinator-control publish/read relay selection slightly beyond the ordinary DM subset
  - moved round-1 live e2e triggering off a blind fixed timer; the harness now waits for the lead to be visibly ready before broadcasting
- observed after the change:
  - a fresh `2 / 2 / 2` rerun no longer missed round 1; round 1 completed cleanly
  - the same rerun still degraded in round 2 to `1 of 2` tickets per voter, so the small gate is still not sign-off clean
  - a fresh `5 / 10 / 3` rerun now got materially through round 1 instead of stalling at zero, but still timed out later under mixed ticket/ack pressure
- implication:
  - the old blind round-1 startup miss is reduced
  - the remaining dominant work is still the measured DM ticket/ack pipeline, especially later-round and ack-side reliability

Given this latest status, the next phases should be defined around two facts:

the system is now instrumented enough to classify the failure properly
the dominant blocker is no longer MLS bootstrap, but private DM ticket delivery and especially acknowledgement visibility under load, while the small gate is still not stable enough to trust fully

So the plan should no longer be “wire MLS” or “general hardening”. It should be a narrow staged programme focused on stability first, then throughput, then cleanup.

Phase 1 - Re-stabilise the small gate
Objective

Make 2 coordinators / 2 voters / 2 rounds reliably pass across repeated reruns.

Why this phase exists

The latest report says the small gate is no longer stable enough to call green: one rerun completed both rounds, another missed round 1 and only completed round 2. That means the system still has a first-round startup race even after the earlier fixes.

Working hypothesis

There is still a coordinator-side round-1 readiness race, likely around one of:

final non-lead startup readiness
public round-open visibility timing
first DM/ticket activity beginning before the whole control plane is truly settled
Required work

Add explicit round-1 readiness state and block round open until all required conditions are met.

Implement

In Rust or the Rust-backed service layer, define a single readiness model:

mls_join_complete
initial_control_backfill_complete
auto_approval_complete
round_open_publish_safe
blind_key_publish_safe
ticket_plane_safe

Make the lead gate round 1 open on all required readiness flags, not just welcome acknowledgement.

Add diagnostics

For each coordinator, expose:

current readiness phase
last successful coordinator-control replay timestamp
current epoch
whether round-open was published
whether round-open was observed back locally after relay success
Required tests
repeat 2 / 2 / 2 at least 20 times
collect:
round-1 open latency
round-1 blind-key visibility latency
first ticket-send latency
pass/fail count
Exit condition

2 / 2 / 2 passes repeatedly enough that round 1 is no longer intermittently absent.

Phase 2 - Turn the DM path into a measured pipeline
Objective

Stop treating ticket send and ack as one opaque process. Split it into explicit stages and measure each one.

Why this phase exists

The latest trace summary is already telling you a lot:

withPublishSucceeded: 100 / 100
withVoterObserved: 72 / 100
withAckSent: 72 / 100
withAckSeen: 24 / 100
sendGap: 28
ackGap: 48

So the failure is mixed, but ack-side is worse than send-side. That is now the main actionable insight.

Working hypothesis

The DM plane is suffering from both:

visibility loss / delay after publish success
ack visibility loss that is worse than ticket visibility loss

This could be:

relay subset pressure
publish timeout semantics not matching real visibility
resend behaviour interacting badly with tracking ids
coordinator-side ack observation lag
voter-side ack publication or observation lag
Required work

Make the per-ticket lifecycle the core debugging object.

Enforce lifecycle states

Every coordinator-voter ticket conversation must move through explicit states:

request_seen
ticket_built
publish_started
publish_succeeded
voter_observed
ack_sent
ack_seen
Add metrics

For every state transition, record:

timestamp
event id
response id
resend count
whether this is latest attempt or preserved prior attempt
relay publish result
relay visibility result
Required outputs

Per failed run, produce:

counts by stage
latency histogram per stage
list of conversations stuck at each stage
whether stuck conversations cluster by:
coordinator
voter
relay subset
round
Exit condition

A failed 5 / 10 / 3 run can be categorised precisely as:

mostly send-visibility loss
mostly ack-visibility loss
mixed but ack-dominant
resend/id-tracking regression
Phase 3 - Fix ack-side dominant failure
Objective

Reduce the ackGap first, because it is currently larger than the send gap.

Why this phase exists

The report now says the failure is mixed, but ack-side dominant. That means the next protocol/runtime fix should primarily target acknowledgement observation, not first-round visibility or MLS startup.

Working hypothesis

Many acks are being sent but not observed by coordinators, or not matched correctly to the right ticket attempt.

Required work
1. Make acknowledgements idempotent and stable

For each ticket:

define one stable ticket id
define one stable acknowledgement id derived from it
do not let resend replace the identity of the thing being acknowledged

The report already notes one fix around preserving prior eventId / responseId attempts so a valid acknowledgement is not lost. Continue in that direction and make it systematic.

2. Decouple ack observation from live-subscription luck

After sending a ticket, coordinators should:

watch live
but also run bounded conversation-history backfill if ack is not seen within a short window

Do not rely only on live subscription arrival.

3. Add bounded ack recovery

If state is:

ticket_sent
ack_not_seen_after_threshold

then:

fetch recent DM history for that conversation
replay through the same reducer
if still absent, mark as unresolved rather than silent waiting forever
Required tests
ack sent late but seen via backfill
duplicate ack safe
old resend attempt ack still matches valid ticket
live + backfill parity for acknowledgement state
Exit condition

The number of conversations stuck at ack_sent but ack_not_seen drops materially in 5 / 10 / 3.
