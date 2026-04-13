Below is the literal patch plan by file for the **initial course-feedback deployment**:

* **1 coordinator**
* **25 voters**
* **1 round**
* **1 ballot per voter**
* **ack is best-effort only**
* **valid ballot submission counts as delivery confirmation**

This plan assumes the current state you described: mailbox send path is partly in place, mailbox truth is still largely in TS, and the present weak point is still the private delivery path rather than the coordinator MLS bootstrap itself. 

---

# Patch objective

Change the system from:

* request
* ticket
* receipt ack
* ballot

where **receipt ack is effectively blocking**

to:

* request
* ticket
* ballot

where:

* receipt ack is **optional / diagnostic**
* ballot acceptance is the **authoritative completion signal**

---

# Patch 1 - `web/src/simpleVotingSession.ts`

## Goal

Make ballot acceptance close the ticket-delivery loop.

## Add fields

Find the per-voter/per-round session state and add these booleans if they do not already exist:

```ts id="coqc4u"
ticketAckSeen: boolean
ticketDeliveryConfirmedByAck: boolean
ticketDeliveryConfirmedByBallot: boolean
ticketDeliveryConfirmed: boolean
ballotSubmitted: boolean
ballotAccepted: boolean
```

## Add derived rule

Wherever the session derives completion state, add:

```ts id="m4vxr5"
ticketDeliveryConfirmedByAck = Boolean(ticketAckSeen);

ticketDeliveryConfirmedByBallot = Boolean(ballotAccepted);

ticketDeliveryConfirmed =
  ticketDeliveryConfirmedByAck || ticketDeliveryConfirmedByBallot;
```

## Change blocking logic

Find any logic that currently gates progress on:

* `ticketAckSeen`
* `waitingForReceipts`
* `receiptAcknowledged`

Change it so the gate becomes:

```ts id="bdncat"
canProceedAfterTicket =
  ticketSent && ticketDeliveryConfirmed;
```

or, if the voter can submit a ballot immediately after decrypting the ticket:

```ts id="4v6fsl"
canProceedAfterTicket =
  ticketSent && (ticketAckSeen || ballotSubmitted || ballotAccepted);
```

Prefer `ballotAccepted` as the authoritative coordinator-side completion signal.

## Remove / demote checks

Remove any hard check like:

```ts id="hc7c8b"
if (!ticketAckSeen) {
  return "waiting";
}
```

Replace with:

```ts id="by6j3e"
if (!ticketDeliveryConfirmed) {
  return "waiting";
}
```

## Add reducer update on ballot accept

Where the valid ballot is accepted, also set:

```ts id="djg7ju"
state.ballotSubmitted = true;
state.ballotAccepted = true;
state.ticketDeliveryConfirmedByBallot = true;
state.ticketDeliveryConfirmed = true;
```

## Add tests

In the matching test file, add these cases:

* ballot accepted with no ack still marks delivery confirmed
* ack seen with no ballot still marks delivery confirmed
* both seen is still idempotent
* missing ack does not keep a valid voter stuck after ballot acceptance

---

# Patch 2 - `web/src/SimpleCoordinatorApp.tsx`

## Goal

Stop coordinator UI and coordinator-side flow from treating missing ack as a hard blocker.

## Find blocking status text / logic

Look for logic producing states like:

* `Ticket sent. Waiting for voter ticket receipt acknowledgement.`

## Replace with softer completion state

Introduce a new completion state string:

* `Ticket sent. Waiting for acknowledgement or valid ballot submission.`

Or better:

* `Ticket issued. Waiting for voter completion confirmation.`

## Change the completion predicate

Where coordinator status for a voter currently uses something like:

```ts id="6huhni"
const complete = ticketAckSeen;
```

replace it with:

```ts id="qow6zs"
const complete = ticketAckSeen || ballotAccepted;
```

## Update counts

If coordinator summaries include:

* `waitingForReceipts`

split into:

* `waitingForAcknowledgements`
* `waitingForCompletionConfirmation`

Use:

```ts id="6mfndu"
waitingForCompletionConfirmation = voters.filter(
  (v) => !v.ticketDeliveryConfirmed,
).length;
```

and keep `waitingForAcknowledgements` as diagnostic only.

## Do not block round success on receipts

If the round is currently considered incomplete because some acks are missing, change the criterion to accepted ballots instead.

For this 1/25/1 deployment, round success should be based on:

* accepted ballots
* not receipt ack visibility

## Add diagnostics

Expose on `globalThis.__simpleCoordinatorDebug`:

```ts id="dh5g41"
{
  waitingForAcknowledgements,
  waitingForCompletionConfirmation,
  voters: [
    {
      voterPubkey,
      ticketSent,
      ticketAckSeen,
      ballotAccepted,
      ticketDeliveryConfirmed,
    }
  ]
}
```

---

# Patch 3 - `web/src/SimpleUiApp.tsx`

## Goal

Allow the voter flow to complete even if receipt ack is not later observed by the coordinator.

## Change post-ticket behaviour

If the voter currently:

* decrypts ticket
* sends ack
* waits or assumes ack success before continuing

change that to:

1. decrypt ticket
2. fire ack as best-effort
3. allow ballot submission immediately
4. show ack as informational only

## Add voter-side state

Add or expose:

```ts id="mtf8wq"
ticketObserved: boolean
ticketAckSent: boolean
ballotSubmitted: boolean
ballotAccepted: boolean
```

## Update displayed status

Where the voter currently shows something like:

* `Waiting for acknowledgement...`

replace with:

* `Ticket received. You can now submit your ballot.`
* if ack send fails, do not block the ballot form

## Expose debug state

On `globalThis.__simpleVoterDebug`, include:

```ts id="d4xrfa"
{
  roundSeen,
  blindKeySeen,
  ticketObserved,
  ticketAckSent,
  ballotSubmitted,
  ballotAccepted
}
```

---

# Patch 4 - `web/src/simpleShardDm.ts`

## Goal

Demote ack transport from critical-path truth to best-effort signal.

## Keep current request-id fix

Do not undo the `request_id = blind_request.requestId` normalisation. Keep it.

## Add stable ticket identity if missing

Ensure the ticket send path computes or carries a stable `ticket_id`.

If not present, add one derived from:

* `request_id`
* `round_id`
* ticket payload commitment

For example:

```ts id="dgpgwh"
const ticketId = sha256(
  JSON.stringify({
    electionId,
    roundId,
    requestId,
    payloadCommitment,
  }),
);
```

## Add stable ack identity if missing

Ack should derive from `ticket_id`, not from latest resend event id.

```ts id="8s2639"
const ackId = sha256(
  JSON.stringify({
    electionId,
    roundId,
    ticketId,
    kind: "ack",
  }),
);
```

## Change ack handling

Where ack polling / matching currently influences correctness, split it into:

* `ackObservedLegacy`
* `ackObservedMailbox`
* merged `ackSeen`

But do **not** make `ackSeen` the sole completion signal anymore.

## Add helper

Add a helper like:

```ts id="socc0m"
export function isDeliveryConfirmed(params: {
  ackSeen: boolean;
  ballotAccepted: boolean;
}): boolean {
  return params.ackSeen || params.ballotAccepted;
}
```

Use it everywhere instead of direct `ackSeen` checks.

## Remove hard wait loops

If there is code that repeatedly waits for ack before allowing success, remove that as a hard dependency.

Change:

* retry / poll for ack remains for diagnostics
* but no “cannot complete without ack”

## Add tests

In `web/src/simpleShardDm.test.ts`, add:

* ack missing but ballot accepted => delivery confirmed
* resend does not change `ticket_id`
* resend does not change `ack_id`
* duplicate ack remains idempotent

---

# Patch 5 - `web/src/simpleMailbox.ts`

## Goal

Make mailbox transport align with the simplified rule without requiring the full Rust mailbox reducer tranche yet.

## Add explicit local state shape

Where mailbox state is currently parse/reconcile map based, add explicit local objects:

```ts id="p7yeav"
type MailboxRequestState = {
  requestId: string;
  roundId: string;
  mailboxId: string;
  requestSeen: boolean;
};

type MailboxTicketState = {
  requestId: string;
  ticketId: string;
  roundId: string;
  mailboxId: string;
  ticketSent: boolean;
  ticketObserved: boolean;
};

type MailboxAckState = {
  ticketId: string;
  ackId: string;
  roundId: string;
  mailboxId: string;
  ackSeen: boolean;
};
```

## Add derived completion helper

Add:

```ts id="oczq1j"
type MailboxCompletionState = {
  ticketSent: boolean;
  ackSeen: boolean;
  ballotAccepted: boolean;
  ticketDeliveryConfirmed: boolean;
};

function deriveMailboxCompletionState(input: {
  ticketSent: boolean;
  ackSeen: boolean;
  ballotAccepted: boolean;
}): MailboxCompletionState {
  return {
    ticketSent: input.ticketSent,
    ackSeen: input.ackSeen,
    ballotAccepted: input.ballotAccepted,
    ticketDeliveryConfirmed: input.ackSeen || input.ballotAccepted,
  };
}
```

## Do not make mailbox ack authoritative

Where mailbox reconcile currently ends in something like:

* “waiting for ack”
  make that diagnostic only.

## Keep mailbox fetch, but do not block on mailbox ack visibility

If mailbox ticket is visible and the voter can submit a ballot, proceed.

---

# Patch 6 - ballot submission path

## Goal

Make ballot submission the authoritative downstream confirmation.

## Find ballot envelope builder / sender

Where the final questionnaire ballot is created, ensure it includes:

* `election_id`
* `round_id`
* `request_id`
* `ticket_id`
* `ballot_id`

Example:

```ts id="rk0cf7"
const ballot = {
  ballotId,
  electionId,
  roundId,
  requestId,
  ticketId,
  responses,
};
```

## Change ballot accept handler

Where the coordinator accepts a valid ballot, add:

```ts id="8ml3k7"
markBallotAccepted({
  voterPubkey,
  roundId,
  ballotId,
});

markTicketDeliveryConfirmedByBallot({
  voterPubkey,
  roundId,
  requestId,
  ticketId,
});
```

If there is no helper yet, implement one.

## Add tests

* valid ballot without ack marks completion
* duplicate ballot does not break completion state
* ballot tied to wrong `request_id` is rejected
* ballot tied to wrong `ticket_id` is rejected

---

# Patch 7 - `web/src/services/ProtocolStateService.ts`

## Goal

Expose the correct state to UI and harness.

## Add fields

Add derived fields to protocol state:

```ts id="q40n9g"
ticketDeliveryConfirmedByAck: boolean;
ticketDeliveryConfirmedByBallot: boolean;
ticketDeliveryConfirmed: boolean;
waitingForAcknowledgement: boolean;
waitingForCompletionConfirmation: boolean;
```

## Derived logic

Use:

```ts id="kvk9cm"
ticketDeliveryConfirmedByAck = ackSeen;
ticketDeliveryConfirmedByBallot = ballotAccepted;
ticketDeliveryConfirmed =
  ticketDeliveryConfirmedByAck || ticketDeliveryConfirmedByBallot;

waitingForAcknowledgement =
  ticketSent && !ackSeen;

waitingForCompletionConfirmation =
  ticketSent && !ticketDeliveryConfirmed;
```

## Important

UI should use:

* `waitingForCompletionConfirmation`

not:

* `waitingForAcknowledgement`

as the primary health signal.

---

# Patch 8 - `web/src/core/derivedStateAdapter.ts`

## Goal

Make the derived-state layer expose the simplified semantics.

## Add new summary fields

At per-voter and per-round summary level, expose:

```ts id="cl1b3q"
ticketDeliveryConfirmedByAck
ticketDeliveryConfirmedByBallot
ticketDeliveryConfirmed
ballotAccepted
```

## Update old summaries

If existing summaries currently report:

* `receiptAcknowledged`
  as the main completion field, keep it but add the new ones and switch downstream consumers over.

---

# Patch 9 - `web/scripts/live-simple-relay-check.js`

## Goal

Change the success model for the initial deployment.

## Add new metrics

Track:

* `ticketObserved`
* `ballotSubmitted`
* `ballotAccepted`
* `ticketDeliveryConfirmedByAck`
* `ticketDeliveryConfirmedByBallot`
* `ticketDeliveryConfirmed`

## Change round success criteria

For the first deployment mode, a voter is successful if:

```js id="ov6l23"
success =
  ticketSent &&
  ballotAccepted;
```

Optionally also require:

* `blindKeySeen`
* `blindedRequestSent`

But **do not** require `receiptAcknowledged`.

## Keep ack as diagnostic

Still print:

* `receiptAcknowledged`

but do not use it as the primary pass/fail criterion.

## Add summary output

At end of run, print:

* `ticketSent`
* `ticketObserved`
* `receiptAcknowledged`
* `ballotSubmitted`
* `ballotAccepted`
* `ticketDeliveryConfirmedByAck`
* `ticketDeliveryConfirmedByBallot`

## Add deployment mode flag

Add a simple environment switch, for example:

```js id="8m4r7g"
const deploymentMode =
  process.env.LIVE_DEPLOYMENT_MODE || "course_feedback";
```

If `course_feedback`, use the simplified success rule.

---

# Patch 10 - `web/scripts/live-simple-relay-repeat.js`

## Goal

Measure what actually matters for the first release.

## Add per-run summary fields

Record:

* round formed
* ticket sent count
* ballot accepted count
* ack count
* completion by ballot count

## Change pass condition

A repeated run counts as pass if:

* round forms
* tickets are issued
* ballots are accepted

Missing ack alone should not fail the run.

---

# Patch 11 - `web/src/services/CoordinatorControlService.ts`

## Goal

Do not let coordinator completion logic depend on ack-only semantics.

## Check for hidden dependencies

Audit for any code that:

* waits for receipts before marking completion
* blocks round closure on receipts only
* derives readiness from receipts only

Change those checks to:

* accepted ballot or ack

If there is a function like:

* `isVoterComplete(...)`
  make it:

```ts id="znn52s"
function isVoterComplete(input: {
  ticketAckSeen: boolean;
  ballotAccepted: boolean;
}): boolean {
  return input.ticketAckSeen || input.ballotAccepted;
}
```

---

# Patch 12 - optional: `web/src/simpleMailbox.ts` fetch filter

## Goal

Do not expand scope too far, but stop digging deeper into the old model.

You said mailbox fetch still filters by `#p` recipient rather than fully mailbox-id keyed reducer flow.

For this tranche:

* leave fetch largely as-is if it is working well enough
* but add `mailbox_id` into internal state and envelope parsing
* prefer `mailbox_id` in new code paths where easy
* do **not** spend this tranche implementing the full Rust mailbox reducer/API set

This is intentionally deferred.

---

# Minimum patch acceptance checklist

The patch is correct when all of these are true:

* valid ballot acceptance marks ticket delivery confirmed
* missing receipt ack does not keep a voter stuck
* coordinator UI no longer treats missing ack as the only blocker
* harness success for course feedback depends on accepted ballots, not ack visibility
* stable `request_id` and `ticket_id` remain in use
* repeated 1 coordinator / 25 voters / 1 round can be evaluated on ballot acceptance

---

# Suggested order to apply patches

1. `simpleVotingSession.ts`
2. `SimpleCoordinatorApp.tsx`
3. `SimpleUiApp.tsx`
4. `simpleShardDm.ts`
5. ballot submission / acceptance path
6. `ProtocolStateService.ts`
7. `derivedStateAdapter.ts`
8. `live-simple-relay-check.js`
9. `live-simple-relay-repeat.js`
10. `CoordinatorControlService.ts`

---

# Short implementation summary

For this initial deployment, patch the app so that:

* **ack becomes optional**
* **ballot acceptance becomes the authoritative confirmation**
* **UI and harness measure accepted ballots, not receipt-ack visibility, as the main success condition**

That is the most practical and least disruptive way to get the first course-feedback version working.
