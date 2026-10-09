# Private Worker Ballot Queue

## Goal

Prevent public relay metadata from linking a voter ballot to its arrival time.
The coordinator must receive only aggregate queue progress until the worker
releases a batch.

## Authority

The worker creates and persists its own Nostr identity. It sends its public
key and a one-time pairing nonce to the coordinator through an encrypted
message. The coordinator verifies the nonce, then signs a delegation that
pins the worker public key to one election.

The coordinator-signed public election definition contains an immutable
`privateWorker` block with the pinned worker `npub`, a non-empty allowlist of
private DM relays, a positive batch threshold, and the submission deadline.
Voters use this block, not browser-local delegation state, and must not fall
back to control or default relays. The worker accepts private ballots only for
the matching signed configuration.

The delegation has separate capabilities for private submission queueing,
private progress reporting, and batch release. It does not grant a worker a
capability merely because it has a different worker capability.

## Private Intake

The voter sends the existing blind ballot material in a NIP-17 encrypted DM to
the pinned worker public key. The envelope contains the election ID, a unique
submission ID, and the blinded credential request or ballot payload needed by
the current protocol.

The worker accepts an envelope only when its delegation is current, the
election is open, and the credential and election-specific nullifier are
valid. It records accepted nullifiers and queued encrypted payloads durably in
one transaction before sending any acknowledgement or count update. Duplicate
submissions are idempotent. Submissions after the deadline are rejected.

No public per-ballot event, public receipt, or public acceptance decision is
published during intake.

## Progress

The worker sends encrypted coordinator DMs with aggregate accepted, rejected,
and queued counts, batch threshold, and deadline. They identify neither a
voter nor a ballot. Voters receive encrypted acknowledgements only; these are
not public proof of inclusion.

## Release

The worker flushes the queue when it reaches the configured threshold or the
deadline passes. At the deadline, it releases every accepted queued ballot,
including a batch smaller than the threshold. It randomises output order,
creates fresh public events, and excludes original arrival times and transport
identity from their public content.

After a successful flush, the worker persists the released submission IDs. On
restart it resumes unfinished releases without emitting duplicates. A batch
release record states the election ID, batch ID, release reason (threshold or
deadline), and aggregate count, but not the source envelopes.

## Failure Rules

- The worker must not report acceptance before durable queue persistence.
- Failure to publish a batch leaves the batch queued for retry; it does not
  permit intake after the deadline.
- A coordinator can observe aggregate progress but cannot decrypt voter-worker
  ballot DMs.
- A worker-key compromise remains in scope only for the worker operator; key
  isolation or separate tally encryption is required when that operator is
  untrusted.
- Redelegation must not clear queued ballots. A release persists a batch ID and
  each entry's publication state, so recovery retries only unpublished events.

## Verification

Tests cover delegated authority, encrypted intake, nullifier deduplication,
threshold and deadline flushes, shuffled output, late rejection, durable
restart recovery, and the absence of public events before release.
