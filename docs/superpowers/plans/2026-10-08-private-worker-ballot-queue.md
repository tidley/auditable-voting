# Private Worker Ballot Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send ballots to a delegated worker over NIP-17, persist them privately, and release shuffled public batches only at a threshold or deadline.

**Architecture:** Existing NIP-17 transport carries typed worker ballot and progress messages. The Rust worker owns the durable queue and enforces delegation, nullifier, and deadline rules. The existing public ballot format remains the released representation, produced only by the worker flush path.

**Tech Stack:** TypeScript, React, nostr-tools NIP-17 transport, Rust worker, Vitest, Rust tests.

---

### Task 1: Define private-queue protocol messages

**Files:**
- Modify: `web/src/questionnaireWorkerDelegation.ts`
- Modify: `web/src/questionnaireOptionABlindDm.ts`
- Modify: `worker/src/model.rs`
- Test: `web/src/questionnaireWorkerDelegation.test.ts`

- [ ] Write failing tests that a current delegation enables `queue_private_submissions`, but not `publish_submission_decisions`.
- [ ] Add these capability literals to both protocol models: `queue_private_submissions`, `report_private_progress`, and `release_submission_batches`.
- [ ] Define JSON message types: `private_ballot_submission`, `private_ballot_receipt`, and `private_queue_progress`. Submission and receipt include `electionId`, `submissionId`, and `schemaVersion`; progress includes `electionId`, `schemaVersion`, and aggregate counts, threshold, and deadline only.
- [ ] Run `npx vitest run src/questionnaireWorkerDelegation.test.ts` and `cargo test` from `worker`.

### Task 2: Add voter-to-worker encrypted delivery

**Files:**
- Modify: `web/src/questionnaireOptionABlindDm.ts`
- Modify: `web/src/questionnaireOptionARuntime.ts`
- Test: `web/src/questionnaireOptionA.runtime.test.ts`

- [ ] Write a failing runtime test that, when a pinned worker delegation has `queue_private_submissions`, vote submission calls the NIP-17 sender with the worker `npub` and no public kind `6424` publish.
- [ ] Add `sendPrivateBallotSubmission({ workerNpub, relays, payload })`, serialising the blind ballot payload inside a `private_ballot_submission` DM.
- [ ] Route only delegated private-queue elections through this sender; retain public submission for elections without that capability.
- [ ] Make voter UI state say `Queued privately` only after a receipt is decrypted. Do not create a public provisional receipt.
- [ ] Run `npx vitest run src/questionnaireOptionA.runtime.test.ts`.

### Task 3: Persist and deduplicate worker intake

**Files:**
- Modify: `worker/src/model.rs`
- Modify: `worker/src/main.rs`
- Test: `worker/src/main.rs`

- [ ] Write Rust tests for accepting a valid pre-deadline envelope once, treating the same `submission_id` as idempotent, rejecting a reused nullifier, and rejecting an envelope after the deadline.
- [ ] Add persisted `QueuedPrivateBallot` state with `submission_id`, `nullifier`, opaque ballot payload, and durable queue status.
- [ ] In the NIP-17 intake handler, verify pinned election/delegation, validate the existing blind proof and nullifier, then atomically persist the nullifier and queue entry before sending a reply.
- [ ] Send encrypted voter receipt and encrypted coordinator progress only after persistence; progress contains no submission ID or voter identity.
- [ ] Run `cargo test` from `worker`.

### Task 4: Flush threshold and deadline batches

**Files:**
- Modify: `worker/src/main.rs`
- Modify: `worker/src/model.rs`
- Test: `worker/src/main.rs`

- [ ] Write Rust tests that threshold flush publishes all queued payloads in a non-arrival order, deadline flush publishes a below-threshold queue, and a failed publish stays retryable without duplicate public events after restart.
- [ ] Add a queue configuration with `batch_threshold` and `submission_deadline` to the worker election state.
- [ ] Shuffle queued entries using an OS-random permutation. Convert each entry to a fresh public ballot event without original DM metadata or queue timestamp.
- [ ] Persist per-entry release status and a batch ID before/after public publish so recovery retries only unpublished entries.
- [ ] Publish a batch record containing election ID, batch ID, release reason, and aggregate count only.
- [ ] Run `cargo test` from `worker`.

### Task 5: Configure and display private batching

**Files:**
- Modify: `web/src/questionnaireProtocol.ts`
- Modify: `web/src/QuestionnaireCoordinatorPanel.tsx`
- Modify: `web/src/questionnaireOptionARuntime.ts`
- Test: `web/src/questionnaireOptionA.runtime.test.ts`
- Modify: `README.md`
- Modify: `docs/project-explainer.md`
- Modify: `web/public/project-explainer.html`
- Modify: `presentation/project-overview.html`

- [ ] Write a failing runtime test for serialising a private batching configuration with a positive threshold, ISO deadline, and pinned worker `npub`.
- [ ] Add optional configuration only for delegated-worker elections: `batchThreshold` and `submissionDeadline`; reject zero/non-integer thresholds and deadlines not after election start.
- [ ] Show coordinator aggregate queue counts and next release condition. Do not render per-ballot status or timing.
- [ ] Update visible documentation to state that timing privacy depends on the worker queue and that the worker can observe encrypted-DM arrival metadata.
- [ ] Run `npx vitest run src/questionnaireOptionA.runtime.test.ts`, `npm --prefix web run build`, and `cargo test` from `worker`.

### Task 6: End-to-end regression coverage

**Files:**
- Modify: `web/src/questionnaireOptionA.runtime.test.ts`
- Modify: `worker/src/main.rs`

- [ ] Add a combined regression test proving private queue capability does not fall back to public submission before a flush.
- [ ] Add a restart recovery test that loads persisted accepted entries, publishes exactly once, and reports an aggregate completion update.
- [ ] Run `cd web && npx vitest run` and `cargo test` from `worker`.
- [ ] Request independent correctness and regression/scope reviews, fix demonstrated findings, then rerun the relevant checks.
