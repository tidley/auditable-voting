# TODO-llm.md

> Status review comment (2026-04-07):
> This brief is only partially implemented. The repo now has a real Rust/Wasm core, Rust-owned coordinator/public/ballot replay seams, snapshot/versioning/diagnostics modules, and a real OpenMLS-backed coordinator engine in Rust. The live browser path still does not use MLS end to end, threshold/proof expansion is not implemented, and larger live scale such as `5 / 10 / 3` is still not signed off.

## Purpose

This file is the implementation brief for the LLM working on `auditable-voting`.

The target outcome is **not** a demo chat system and **not** a partial Rust port.

The target outcome is a:

- browser-first
- static-site compatible
- multi-coordinator
- auditable
- censorship-resistant
- privacy-preserving
- replayable

voting system over Nostr, designed with the practical scale target of:

- **1,000+ voters**
- multiple coordinators
- multiple rounds
- browser reload/recovery
- no backend required for correctness

This file defines:

- the desired architecture
- non-negotiable constraints
- implementation order
- module layout
- replay and recovery requirements
- scaling constraints for 1,000+ voters
- testing requirements
- anti-patterns to avoid
- what “done” means

---

# 1. Core design goal

> Status comment:
> Partially done. Rust/Wasm owns much more protocol logic than before, and TS has been reduced materially, but TS still remains authoritative for private issuance/ticket flows in places. OpenMLS is implemented in Rust, but not yet wired through the live browser coordinator path.

Build a system in which:

- **Rust/WASM is the single source of truth for protocol logic**
- **TypeScript is only UI, relay transport, IndexedDB persistence, and WASM bridging**
- **OpenMLS is used for the coordinator control plane**
- **OpenMLS is fully hidden behind a stable Rust abstraction**
- **voters are not MLS members**
- **public election state is replayable from Nostr events**
- **ballot handling remains private**
- **auditors reconstruct from public artefacts only**
- **the app remains a static browser app**

This is a **migration** of the existing repo, not a greenfield rewrite.

---

# 2. Scale target must always be kept in mind

> Status comment:
> Not done as an achieved target. The architecture now explicitly accounts for replay, partitioning, snapshots, and disorder, but the repo is not yet operationally credible at the stated `1,000+ voters` goal. Current live evidence is good at `1 / 2 / 2`, `2 / 2 / 2`, and `1 / 20 / 3`, while `5 / 10 / 3` remains unresolved.

The design must always assume the system will need to work for:

- **1,000+ voters**
- **5+ coordinators**
- **multiple rounds per election**

This means the implementation must be designed for:

- event duplication
- out-of-order arrival
- relay backfill
- reload/recovery
- bounded replay
- per-round partitioning
- structured receipt commitments
- compact public proofs
- deterministic reducers

The design must **not** assume:

- tiny event volume
- one relay
- in-order transport
- a trusted server
- trivial browser replay
- all participants sharing one group state machine

---

# 3. Architectural overview

> Status comment:
> Partially done. The three-plane split exists conceptually and partly in code: coordinator control has its own Rust seam, public/ballot replay exists in Rust, and the voter issuance/ballot privacy path remains separate. The full end-state separation is not yet complete because private voter issuance is still largely TS-owned.

## 3.1 Three logical planes

The architecture must have three distinct protocol planes.

### A. Coordinator control plane
Private coordinator-only control traffic.

Properties:

- small fixed coordinator set
- OpenMLS-backed
- Rust-owned
- replayable
- persistent across reload
- transported over Nostr
- private
- not visible to normal auditors

Used for:

- round proposals
- round opening/closing co-ordination
- ballot batch notices
- partial tally coordination
- result approval
- dispute handling
- recovery checkpoints

### B. Public audit plane
Public Nostr events.

Properties:

- replayable
- visible to auditors
- source of public truth
- basis for public verification
- compact enough for browser reconstruction

Used for:

- election definition
- round definition
- round open/close notices
- receipt commitments
- final result publication
- dispute records
- public proof bundles

### C. Ballot submission plane
Private ballot submission flow.

Properties:

- voters are not MLS members
- encrypted ballot submissions
- replayable in Rust
- compatible with 1,000+ voter event volume
- independent from coordinator MLS group semantics

Used for:

- encrypted ballot submission
- acknowledgements if needed
- inclusion-related artefacts
- input to tallying

---

# 4. Why voters must not be MLS members

> Status comment:
> Done. Voters are not MLS members anywhere in the current implementation.

This is non-negotiable.

Even though MLS is intended to support large group secure communication, this application is not just a group chat problem.

For this repo and this scale target, do **not** place voters into a single MLS group.

Reasons:

- browser replay complexity
- membership churn complexity
- epoch recovery complexity
- large-scale transport disorder
- round partitioning complexity
- ballot/audit model is not the same as chat semantics
- voters do not need shared control-plane state
- the real problem is election replay and audit correctness, not merely shared group encryption

Correct model:

- **coordinators use MLS**
- **voters submit encrypted ballots outside MLS**
- **public artefacts remain replayable**

---

# 5. Non-negotiable constraints

> Status comment:
> Mixed. Some are now true in practice, including no backend, browser-first, and no voters in MLS. Others remain partial, especially “Rust sole source of truth”, “all protocol-critical reducers in Rust”, and the `1,000+ voters` viability claim.

The LLM must respect all of these.

1. **Rust/WASM must become the sole source of truth for protocol logic**
2. **OpenMLS must be used first for the coordinator control plane**
3. **OpenMLS must be hidden behind a stable Rust abstraction**
4. **TypeScript must never depend directly on OpenMLS internals**
5. **voters must not become MLS members**
6. **blind-signature issuance must not be casually redesigned**
7. **auditor reconstruction must depend only on public artefacts**
8. **TypeScript must not remain an authoritative protocol engine**
9. **React components must not hold protocol truth**
10. **no backend is required for correctness**
11. **replay determinism is mandatory**
12. **the app must remain browser-first and static-site compatible**
13. **all protocol-critical reducers must end up in Rust**
14. **the implementation must remain viable for 1,000+ voters**

---

# 6. Required end-state architecture

> Status comment:
> Partially done. Rust now owns coordinator replay, public replay, ballot acceptance, validation helpers, snapshots, versioning, and diagnostics. Proof derivation, tally abstractions, and full removal of TS protocol truth are still outstanding.

## 6.1 Rust/WASM owns

Rust must own:

- protocol types
- event normalisation
- event validation
- ordering rules
- replay engine
- coordinator control state
- OpenMLS-backed coordinator engine
- public election state reducer
- round reducer
- ballot acceptance reducer
- receipt derivation
- proof derivation
- diagnostics
- snapshot export/import
- versioning compatibility
- threshold tally abstraction where implemented

## 6.2 TypeScript owns

TypeScript may own only:

- React UI
- relay subscriptions and publishing
- IndexedDB persistence plumbing
- WASM loading
- bridging raw events into Rust
- temporary UI-local state
- display-only formatting

TypeScript must **not** own:

- round truth
- ballot truth
- ordering truth
- replay truth
- coordinator truth
- proof truth

---

# 7. Coordinator control plane requirements

> Status comment:
> Mostly done at the Rust seam, not done in the shipped browser workflow. `CoordinatorControlEngine` exists and hides engine internals from TypeScript. A real OpenMLS-backed engine now exists in Rust, but the live browser flow still runs through the deterministic engine because MLS bootstrap/join carriers are not yet wired end to end.

## 7.1 OpenMLS must be used first

Use OpenMLS first for the coordinator control plane.

But OpenMLS must be fully hidden behind a Rust abstraction.

The app must not depend on OpenMLS directly.

## 7.2 Required Rust abstraction

Define a stable domain-oriented abstraction, such as:

- `CoordinatorControlEngine`

It should expose operations like:

- `propose_round_open(...)`
- `commit_round_open(...)`
- `record_ballot_batch_notice(...)`
- `submit_partial_tally(...)`
- `approve_result(...)`
- `apply_transport_message(...)`
- `snapshot()`
- `restore(...)`

It must **not** expose raw OpenMLS state or OpenMLS-specific semantics to TypeScript.

## 7.3 Coordinator group assumptions

The implementation may assume, initially:

- fixed coordinator roster
- one coordinator group per election
- multiple rounds under one election
- persistent coordinator state across reload
- replay from transport history

It must **not** assume:

- generic chat product requirements
- dynamic coordinator churn in the first implementation pass
- multi-device sync as a requirement
- voter inclusion in coordinator control

---

# 8. Public state requirements

> Status comment:
> Partially done. Rust defines public events and reduces public round state. Auditor, voter, and coordinator public-state consumers now use the shared Rust-derived adapter/service path. Full proof-bundle support is not implemented yet.

Rust must define and reduce public events such as:

- `ElectionDefinition`
- `RoundDefinition`
- `RoundOpen`
- `RoundClose`
- `BallotReceipt`
- `FinalResult`
- `DisputeRecord`
- `ProofBundle` or equivalent public proof records

Each event must include, as appropriate:

- `schema_version`
- `election_id`
- `round_id`
- `event_type`
- `created_at`
- sender binding
- event id
- structured payload

Public state must be enough to derive:

- round lifecycle
- receipt commitments
- public result state
- contradictions/disputes
- public proof visibility

The auditor path must be able to use this without private coordinator state.

---

# 9. Ballot plane requirements

> Status comment:
> Partially done. Rust owns ballot event types and deterministic ballot acceptance for the migrated slice, with `first valid ballot wins` already implemented. The private ballot/issuance transport path is still not fully Rust-owned.

Rust must define ballot-related events, such as:

- `EncryptedBallot`
- `BallotAck` if needed
- `InclusionProofResponse` if used
- ballot receipt commitment support

Ballot submission must be:

- private
- replayable
- deterministic in acceptance/rejection
- scalable to 1,000+ voters
- decoupled from coordinator group chat semantics

## 9.1 Ballot acceptance rule must be explicit

> Status comment:
> Done. The current Rust reducer uses `first valid ballot wins`, and that rule is test-covered.

Pick one and enforce it globally:

- **first valid ballot wins**
- or
- **latest valid ballot before close wins**

That rule must be:

- implemented in Rust only
- documented
- tested
- used consistently across coordinator, voter, and auditor views

No ambiguity is allowed.

## 9.2 Ballot reduction must produce

> Status comment:
> Mostly done for the migrated slice. Accepted ballots, rejected ballots, rejection reasons, and round summaries exist in Rust. Receipt compatibility and richer tally input/public proof material are still incomplete.

At minimum:

- accepted ballot set
- rejected ballot set
- rejection reasons where possible
- receipt compatibility data
- derived tally input set

---

# 10. Deterministic replay requirements

> Status comment:
> Largely done for the migrated slices. Rust owns canonical ordering and mixed replay across coordinator/public/ballot events. This is one of the stronger parts of the current repo state.

This is one of the most important parts of the whole project.

The system must support deterministic replay from mixed event streams.

Rust must own exactly one canonical ordering function.

Ordering must use:

1. logical event class precedence
2. coordinator epoch where applicable
3. `created_at`
4. event id lexical order

Do not rely on relay arrival order.

Do not allow multiple incompatible sorters in TS and Rust.

## 10.1 Replay must support mixed streams

> Status comment:
> Done for the migrated core. The Rust engine can consume mixed coordinator/public/ballot streams and derive state plus diagnostics.

Replay must support consuming:

- public events
- ballot events
- coordinator control events

and deriving:

- coordinator state
- public state
- ballot state
- receipt/proof state
- final result state
- diagnostics

## 10.2 Replay parity

> Status comment:
> Partially done. Snapshot + suffix parity is covered for the shared protocol engine, but this still needs broader hardening around the live coordinator MLS path and more recovery scenarios.

The following must match:

- full replay from raw event log
- snapshot load + suffix replay

Any divergence here is a correctness bug.

---

# 11. Persistence and recovery requirements

> Status comment:
> Partially done. IndexedDB remains in TS, and Rust snapshots/version compatibility exist. Recovery is stronger than before, but still not robust enough to claim completion for relay disorder at larger multi-coordinator scale.

TypeScript should continue to manage IndexedDB.

Persist at minimum:

- raw Nostr event log
- relay checkpoints
- Rust snapshot blobs or JSON snapshots
- metadata needed for suffix replay

Rust must support:

- export snapshot
- import snapshot
- replay from scratch
- replay from snapshot + suffix

## 11.1 Recovery scenarios that must be supported

> Status comment:
> Partial. Duplicate and out-of-order replay are covered in Rust tests, and some live backfill/recovery logic exists. Full coverage of stale coordinator snapshots, interrupted tally workflows, and larger relay-disorder recovery is not complete.

The system must explicitly support recovery from:

- browser reload
- reconnect after downtime
- duplicate relay deliveries
- out-of-order delivery
- missing relay segment followed by backfill
- stale coordinator snapshot
- late coordinator control messages
- partial tally workflows interrupted by reload

These are normal operating conditions, not exceptional ones.

---

# 12. Scaling requirements for 1,000+ voters

> Status comment:
> Not done as an achieved outcome. Some architectural preconditions are in place, especially partitioning, snapshots, and reducing relay-read scope, but the repo is not yet proven anywhere near the stated target.

The architecture must always be evaluated against the 1,000+ voter target.

## 12.1 What changes between 100 and 1,000 voters

> Status comment:
> Recognised architecturally, not completed operationally.

At 1,000 voters, the system must not rely on:

- full replay of all history on every load
- sloppy per-event visible acknowledgements
- loosely tagged public events
- DM-style fallback truth
- TS-side acceptance logic
- manual operator recovery

Instead, it must support:

- per-round partitioning
- bounded replay
- snapshot + suffix replay
- compact receipt commitments
- deterministic merges across relays
- structured diagnostics
- transcript-tested recovery

## 12.2 Partitioning is mandatory

> Status comment:
> Partially done. Election/round partitioning is present in the newer Rust/public/coordinator paths, but the whole private issuance path has not been fully migrated to the same end-state model.

All event types must be partitioned cleanly by:

- `election_id`
- `round_id`
- event type
- plane

This is required for:

- bounded replay
- auditor reconstruction
- reduced client load
- predictable recovery

## 12.3 Receipt commitments must be structured

> Status comment:
> Not done in the intended end-state sense. There are public receipt and ballot-related structures, but not the compact structured commitment system described here.

For 1,000+ voters, receipt handling must move beyond ad hoc event visibility.

Use:

- receipt commitments
- batched or structured receipt summaries where appropriate
- stable receipt identifiers/hashes

This allows:

- voter inclusion checks
- compact public audit artefacts
- efficient reconstruction

## 12.4 Proof objects must be compact

> Status comment:
> Not done. Public proof bundles/compact proofs remain future work.

Public proof objects must not become a noisy per-action chat log.

Favour:

- set commitments
- compact summaries
- proof bundles
- stable hashes
- auditor-friendly derived views

---

# 13. Testing requirements

> Status comment:
> Partial. Rust truth tests now exist for coordinator replay, public reducer behaviour, ballot acceptance, ordering, and snapshot/versioning. The live e2e gate is still not strong enough at larger scale.

The migration is not acceptable without strong replay and recovery testing.

## 13.1 Rust truth tests

> Status comment:
> Partially done and improving. Many of these tests now exist, but proof derivation correctness is not implemented because proofs are not implemented yet.

Add Rust tests for:

- deterministic ordering
- coordinator replay
- public reducer correctness
- ballot reducer correctness
- duplicate handling
- contradictory event sequences
- replay under out-of-order inputs
- full replay vs snapshot+suffix parity
- diagnostics correctness
- proof derivation correctness where applicable

## 13.2 Transcript-based fixtures are mandatory

> Status comment:
> Partial. There is transcript-style replay coverage in Rust and TS, but this area still needs expansion, especially around recovery/backfill and more pathological relay disorder.

Use transcript fixtures for:

- in-order delivery
- out-of-order delivery
- duplicate relay deliveries
- missing segment followed by backfill
- browser reload mid-workflow
- close-boundary edge cases
- contradictory public result publication
- stale snapshot recovery

At 1,000+ voter scale, transcript correctness matters more than superficial component tests.

## 13.3 JS/TS integration tests

> Status comment:
> Partial. WASM loading, snapshot restore, and Rust-derived state consumption are covered in focused tests. IndexedDB reload/reconnect and larger live-relay scenarios still need stronger automated coverage.

Add JS/TS integration tests for:

- WASM loading
- IndexedDB snapshot persistence/loading
- reload and recovery
- relay disorder integration
- UI consumption of Rust-derived state
- ensuring TS does not become authoritative again

Truth tests should primarily live in Rust.

---

# 14. Required implementation order

> Status comment:
> Followed broadly, but not completed. The repo has already passed through seams, Rust core growth, coordinator/public/ballot replay migration, and partial UI switching. The later hardening and proof/tally steps are still outstanding.

The LLM must follow this internal order.

Do not start with a broad UI refactor.

## Step 1 - identify migration seams
Inspect the repo and find the smallest safe seams where protocol truth can move into Rust without replacing the whole app.

## Step 2 - build/refine Rust core
Create or expand a Rust crate containing:

- types
- events
- ordering
- replay
- validation
- coordinator abstraction
- public reducer
- ballot reducer
- diagnostics
- snapshots
- versioning

## Step 3 - integrate OpenMLS behind abstraction
Use OpenMLS first for the coordinator control plane, but keep it fully behind the Rust abstraction.

## Step 4 - move coordinator truth into Rust
Coordinator control state, replay, and recovery must move into Rust first.

## Step 5 - move public and ballot reducers into Rust
Public state and ballot acceptance must be migrated into Rust.

## Step 6 - expose stable WASM APIs
Expose a minimal, stable interface for TS to call.

## Step 7 - wire TS adapters/services to Rust
TS should load WASM, pass in events, persist raw logs/snapshots, and read derived state.

## Step 8 - switch UI flows to Rust-derived state
Existing React screens should consume Rust-derived state rather than independent TS protocol logic.

## Step 9 - remove or demote legacy TS protocol truth
Once parity is proven, remove old TS reducers/state machines or make them clearly non-authoritative.

## Step 10 - harden recovery/diagnostics/proofs
Strengthen snapshots, diagnostics, proof derivation, and recovery flows.

## Step 11 - update docs and tests
Docs must match the actual shipped architecture.

---

# 15. Suggested Rust crate layout

> Status comment:
> Partially done. The crate now contains many of the listed files: `lib.rs`, `types.rs`, `event.rs`, `order.rs`, `replay.rs`, `validation.rs`, `error.rs`, `diagnostics.rs`, `snapshot.rs`, `versioning.rs`, `public_state.rs`, `ballot_state.rs`, `coordinator_state.rs`, `coordinator_messages.rs`, `coordinator_engine.rs`, `openmls_engine.rs`, and `wasm.rs`. `proofs.rs`, `tally.rs`, and `threshold.rs` are still missing.

Create or expand a crate such as:

- `auditable-voting-core/`

Suggested files:

- `src/lib.rs`
- `src/types.rs`
- `src/event.rs`
- `src/order.rs`
- `src/replay.rs`
- `src/validation.rs`
- `src/error.rs`
- `src/diagnostics.rs`
- `src/snapshot.rs`
- `src/versioning.rs`
- `src/public_state.rs`
- `src/ballot_state.rs`
- `src/coordinator_state.rs`
- `src/coordinator_messages.rs`
- `src/coordinator_engine.rs`
- `src/openmls_engine.rs`
- `src/proofs.rs`
- `src/tally.rs`
- `src/threshold.rs`
- `src/wasm.rs`

Not every file must be fully populated immediately, but the design should head in this direction.

---

# 16. Suggested TypeScript adapter layout

> Status comment:
> Mostly done for the migration seam. `web/src/core/`, `web/src/services/`, and `web/src/nostr/` now exist as the main adapter/service layers around the Rust core. Some legacy `simple*` modules still remain because the migration is not complete.

TypeScript modules should remain thin.

Suggested directories/modules:

- `web/src/core/`
- `web/src/services/`
- `web/src/nostr/`

Likely responsibilities:

## `web/src/core/`
- WASM loading
- event bridging
- snapshot import/export handling
- reading Rust-derived state

## `web/src/services/`
- compatibility services for existing UI screens
- exposing derived state to components
- coordinating transport/storage with Rust APIs

## `web/src/nostr/`
- publish public events
- publish coordinator control carrier events
- publish ballot events
- subscribe to election streams
- subscribe to coordinator streams
- subscribe to ballot streams

These modules must **not** become protocol engines.

---

# 17. Existing files to adapt carefully

> Status comment:
> In progress. `SimpleCoordinatorApp.tsx`, `SimpleUiApp.tsx`, and `SimpleAuditorApp.tsx` now consume Rust-derived state for migrated slices. `simpleVotingSession.ts`, `simpleRoundState.ts`, `simpleLocalState.ts`, and `simpleShardDm.ts` still contain important compatibility and transport logic.

Do not broadly rewrite UI before the Rust seams are proven.

Pay attention to existing files such as:

- `web/src/SimpleCoordinatorApp.tsx`
- `web/src/SimpleUiApp.tsx`
- `web/src/SimpleAuditorApp.tsx`
- `web/src/simpleVotingSession.ts`
- `web/src/simpleRoundState.ts`
- `web/src/simpleLocalState.ts`
- `web/src/simpleShardDm.ts`

Strategy:

- preserve current user-facing flow where possible
- adapt internal state source to Rust
- keep compatibility layers where needed
- remove legacy logic only after parity is proven

---

# 18. Threshold tally and proof expansion

> Status comment:
> Not done. This is still future architecture work.

This may not need to land first, but the architecture must support it.

## 18.1 Threshold abstraction

> Status comment:
> Not done.
If stronger tally secrecy is introduced, it must sit behind a Rust abstraction such as:

- `ThresholdTallyEngine`
- or `BallotCryptoEngine`

This abstraction may support:

- round encryption context creation
- public encryption material export
- encrypted ballot ingestion
- partial contribution production
- contribution verification
- final tally combination

Do not leak specific threshold crypto library internals into the app boundary.

## 18.2 Public proof derivation

> Status comment:
> Not done.
Public proof outputs should be generated in Rust and may include:

- receipt set commitments
- tally input commitments
- result proof bundle
- coordinator approval summaries
- dispute records

These must be:

- versioned
- replayable
- compact
- auditor-consumable

---

# 19. Diagnostics requirements

> Status comment:
> Partially done. Rust now exposes structured diagnostics, replay status, and snapshot compatibility status through the wasm boundary. The richer quorum/proof/tally diagnostics described here are not implemented yet.

The system must expose structured diagnostics from Rust.

Useful diagnostics include:

- invalid event count by reason
- duplicate event count
- contradictory transition warnings
- stale snapshot warnings
- coordinator desync indicators
- replay status
- proof availability status
- quorum/threshold state if used

TypeScript may display these diagnostics.

TypeScript must not be responsible for inferring them from protocol rules.

---

# 20. Anti-patterns to avoid

> Status comment:
> Mostly respected so far. The repo remains browser-first with no backend, OpenMLS is hidden from TS, and voters are not in MLS. The main remaining risk is leaving too much private issuance truth in TS for too long.

The LLM must avoid all of the following.

## Forbidden architectural mistakes

- putting voters into MLS
- exposing OpenMLS internals to TS
- keeping TS as an authoritative protocol engine
- relying on relay arrival order
- using timestamps as the sole conflict rule
- deriving auditor truth from private coordinator state
- introducing a backend for correctness
- broad UI redesign before replay correctness
- replacing working issuance logic casually
- keeping dead legacy reducers “just in case”

## Forbidden scaling mistakes

- assuming full history replay is always acceptable
- failing to partition by election/round
- publishing excessively noisy public proof chatter
- not compacting receipt/proof outputs
- treating relay disorder as exceptional
- ignoring snapshot/suffix parity
- designing only for 100 voters instead of 1,000+

---

# 21. Definition of done

> Status comment:
> Not done. The repo is materially closer than before, but the definition-of-done bar is not yet met.

The migration is complete only when:

- the app still builds and runs as a static web app
- Rust/WASM is the sole source of truth for protocol logic
- OpenMLS is fully encapsulated behind a Rust abstraction
- coordinator control, public state, and ballot reducers are replayable in Rust
- snapshot + suffix replay matches full replay
- TS is no longer authoritative for migrated protocol logic
- auditor reconstruction works from public artefacts only
- diagnostics and recovery are surfaced cleanly
- the architecture remains viable for 1,000+ voters
- tests pass
- docs accurately describe the final architecture

---

# 22. Recommended practical mindset for the LLM

> Status comment:
> Broadly followed. The work so far has mostly been migration-underneath rather than UI rewrite.

When working on this repo:

- prefer migration over rewrite
- prefer replay correctness over UI polish
- prefer Rust-owned truth over TS convenience
- prefer stable abstractions over exposing library internals
- prefer transcript tests over optimistic assumptions
- always think about 1,000+ voter event volume
- never assume relay order is reliable
- never make the browser do unnecessary full-history work if snapshots can be used
- preserve current working surfaces until the new seam is proven

---

# 23. Short mission statement

> Status comment:
> This still describes the intended end-state, not the current completed state.

Build `auditable-voting` into a:

**browser-first, replayable, multi-coordinator voting system with Rust-owned protocol logic, OpenMLS-backed coordinator control, private ballot handling, public auditability, and a design that remains credible at 1,000+ voters.**
