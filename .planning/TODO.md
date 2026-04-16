<!-- STATUS4 pointer: This file is historical context. Current planning status is in .planning/STATUS4.md (2026-04-16, v0.134). -->

# TODO-llm.md

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
- a strict MLS group size policy
- testing requirements
- anti-patterns to avoid
- what “done” means

> Status review context:
> the repo already has a real Rust/Wasm core, Rust-owned coordinator/public/ballot replay seams, snapshot/versioning/diagnostics modules, and a real OpenMLS-backed coordinator engine in Rust, but the live browser path still is not using MLS end-to-end, proof/tally expansion is not implemented, and larger live scale is not signed off. This brief therefore assumes a migration from a partially-complete state rather than a clean start. :contentReference[oaicite:0]{index=0}
>
> Current concrete progress as of `v0.64`:
> - recent local-preview live gates now pass again at `1 coordinator / 1 voter / 1 round` and `2 coordinators / 2 voters / 2 rounds`
> - the most recent repair was public live-round history backfill in the browser path, which removed a first-round race where round 1 could be missed while round 2 succeeded
> - the coordinator browser runtime now uses the OpenMLS supervisory engine on the repaired small live path; the main remaining gap is larger-scale live reliability rather than missing bootstrap/join carrier wiring
> - larger committee scale is still not signed off; `5 coordinators / 10 voters / 3 rounds` remains the next unresolved live gate

---

# 1. Core design goal

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

The architecture must have three distinct protocol planes.

## 3.1 A. Coordinator control plane
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
- cross-group liaison traffic

## 3.2 B. Public audit plane
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
- public group topology metadata if needed for audit context

## 3.3 C. Ballot submission plane
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

# 5. MLS group size policy

This section is mandatory and overrides any vague assumption that “MLS supports large groups, therefore large browser groups are fine”.

## 5.1 Policy

All live browser MLS groups must be bounded in size.

- **Preferred operating size:** **16 to 24 members**
- **Hard cap:** **25 members**
- **Emergency temporary ceiling:** **32 members**, only for short-lived, low-churn, one-day sessions
- **Not allowed as normal design target:** **50+ members**

If a workflow appears to require more than 25 private organisational participants, the correct response is:

- **split the group**
- **introduce cohort groups**
- **coordinate through a smaller supervisory group**

Do **not** respond by increasing the cap.

## 5.2 Why the cap exists

The cap exists because the current repo status does not yet sign off larger live scenarios and is not yet proven at the 1,000+ voter target; the main risks are replay, churn, browser recovery, transport disorder, and live end-to-end MLS wiring, not the raw MLS cryptographic model. :contentReference[oaicite:1]{index=1}

## 5.3 Intended operating model

For one-day voting sessions, the normal model should be:

- one supervisory coordinator group
- zero or more operational cohort groups
- each cohort capped at 25
- one or two liaisons per cohort
- voters outside MLS entirely

---

# 6. Multi-group organisational model

If there are more private organisational participants than the MLS cap allows, do **not** enlarge the group.

Use a hierarchical layout.

## 6.1 Supervisory group

One supervisory coordinator/control group:

- size: **5 to 9**
- purpose:
  - authoritative coordinator control
  - election/round control
  - cross-cohort coordination
  - dispute handling
  - checkpoint/recovery decisions
  - tally coordination
  - approval for public publication

This group is OpenMLS-backed and is the only group allowed to coordinate final authoritative control decisions.

## 6.2 Cohort groups

One or more cohort groups:

- size: **16 to 24 preferred**
- hard cap: **25**
- purpose:
  - private organisational distribution
  - notifications
  - liaison-mediated backplane messaging
  - bounded operational traffic

These groups are OpenMLS-backed only if actually needed for private internal messaging. Do not create them by default if the workflow can be handled by the supervisory group alone.

## 6.3 Liaisons

Each cohort group must have **1 or 2 liaisons**.

Liaison responsibilities:

- receive supervisory-group traffic relevant to that cohort
- re-emit or translate the permitted message into the cohort group
- send cohort-derived status back to the supervisory group
- never become an alternate source of protocol truth
- never bypass the supervisory group for authoritative election control

## 6.4 Cross-group coordination rule

If a message must affect more than one group:

- the supervisory group is the source of the authoritative private instruction
- liaisons propagate cohort-scoped copies
- the public audit plane carries public artefacts where appropriate
- all cross-group messages must carry stable identifiers:
  - `election_id`
  - `round_id`
  - `origin_group_id`
  - `target_group_id`
  - `message_class`
  - `origin_event_id`

---

# 7. Non-negotiable constraints

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
15. **all MLS groups in the browser must respect the hard cap of 25**
16. **inter-group coordination must be explicit and replayable**
17. **the public audit plane must remain compact and not devolve into noisy operational chatter**

---

# 8. Required end-state architecture

## 8.1 Rust/WASM owns

Rust must own:

- protocol types
- event normalisation
- event validation
- ordering rules
- replay engine
- coordinator control state
- OpenMLS-backed coordinator engine
- cohort-group coordination logic where used
- public election state reducer
- round reducer
- ballot acceptance reducer
- receipt derivation
- proof derivation
- diagnostics
- snapshot export/import
- versioning compatibility
- threshold tally abstraction where implemented

## 8.2 TypeScript owns

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
- group topology truth

---

# 9. Coordinator control plane requirements

## 9.1 OpenMLS must be used first

Use OpenMLS first for the coordinator control plane.

But OpenMLS must be fully hidden behind a Rust abstraction.

The app must not depend on OpenMLS directly.

## 9.2 Required Rust abstraction

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

## 9.3 Coordinator group assumptions

The implementation may assume, initially:

- fixed coordinator roster
- one supervisory coordinator group per election
- multiple rounds under one election
- persistent coordinator state across reload
- replay from transport history

It must **not** assume:

- generic chat product requirements
- dynamic coordinator churn in the first implementation pass
- multi-device sync as a requirement
- voter inclusion in coordinator control

---

# 10. Cohort-group requirements

This section is new and mandatory.

## 10.1 When cohort groups exist

Create cohort groups only if there are more private organisational participants than can comfortably fit into the supervisory group.

Examples of cohort-group use:

- organisational notification channels
- distribution/operations channels
- limited-scope private session logistics
- bounded sub-group co-ordination

Do **not** use cohort groups for:

- ballot submission itself
- voter membership
- public audit artefacts
- final authoritative decision source

## 10.2 Rust abstraction

Define a stable Rust abstraction such as:

- `OrganisationalGroupEngine`

It may share internals with the coordinator engine but must still be hidden from TS.

Operations should include:

- `create_group(...)`
- `join_group(...)`
- `receive_group_message(...)`
- `emit_group_message(...)`
- `snapshot_group(...)`
- `restore_group(...)`

## 10.3 Group metadata

For each MLS group, persist:

- `group_id`
- `group_role` (`supervisory` or `cohort`)
- `election_id`
- current epoch metadata
- member roster hash
- liaison set
- snapshot version
- last applied event id
- last replay checkpoint

---

# 11. Public state requirements

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

# 12. Ballot plane requirements

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

## 12.1 Ballot acceptance rule

Use:

- **first valid ballot wins**

Do not reconsider this unless there is a specific documented reason and the entire test suite is updated.

The rule must be:

- implemented in Rust only
- documented
- tested
- used consistently across coordinator, voter, and auditor views

## 12.2 Ballot reduction must produce

At minimum:

- accepted ballot set
- rejected ballot set
- rejection reasons where possible
- receipt compatibility data
- derived tally input set

---

# 13. Deterministic replay requirements

The system must support deterministic replay from mixed event streams.

Rust must own exactly one canonical ordering function.

Ordering must use:

1. logical event class precedence
2. coordinator epoch where applicable
3. `created_at`
4. event id lexical order

Do not rely on relay arrival order.

Do not allow multiple incompatible sorters in TS and Rust.

## 13.1 Replay must support mixed streams

Replay must support consuming:

- public events
- ballot events
- coordinator control events
- cohort-group private events if used

and deriving:

- coordinator state
- public state
- ballot state
- receipt/proof state
- final result state
- diagnostics
- group topology/health summaries if needed

## 13.2 Replay parity

The following must match:

- full replay from raw event log
- snapshot load + suffix replay

Any divergence here is a correctness bug.

---

# 14. Persistence and recovery requirements

TypeScript should continue to manage IndexedDB.

Persist at minimum:

- raw Nostr event log
- relay checkpoints
- Rust snapshot blobs or JSON snapshots
- metadata needed for suffix replay
- per-group snapshot references
- group membership metadata

Rust must support:

- export snapshot
- import snapshot
- replay from scratch
- replay from snapshot + suffix

## 14.1 Recovery scenarios that must be supported

The system must explicitly support recovery from:

- browser reload
- reconnect after downtime
- duplicate relay deliveries
- out-of-order delivery
- missing relay segment followed by backfill
- stale coordinator snapshot
- stale cohort snapshot
- late coordinator control messages
- partial tally workflows interrupted by reload
- group join/bootstrap recovery for bounded one-day session groups

These are normal operating conditions, not exceptional ones.

---

# 15. Scaling requirements for 1,000+ voters

The architecture must always be evaluated against the 1,000+ voter target.

## 15.1 What changes between 100 and 1,000 voters

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
- bounded private group sizes

## 15.2 Partitioning is mandatory

All event types must be partitioned cleanly by:

- `election_id`
- `round_id`
- event type
- plane
- `group_id` where relevant

This is required for:

- bounded replay
- auditor reconstruction
- reduced client load
- predictable recovery

## 15.3 Receipt commitments must be structured

For 1,000+ voters, receipt handling must move beyond ad hoc event visibility.

Use:

- receipt commitments
- batched or structured receipt summaries where appropriate
- stable receipt identifiers/hashes

This allows:

- voter inclusion checks
- compact public audit artefacts
- efficient reconstruction

## 15.4 Proof objects must be compact

Public proof objects must not become a noisy per-action chat log.

Favour:

- set commitments
- compact summaries
- proof bundles
- stable hashes
- auditor-friendly derived views

## 15.5 Group sizing must remain bounded

At 1,000+ voters:

- do not increase the MLS cap
- do not place organisational participants into oversized browser MLS groups
- do not trade replay tractability for fewer groups

If more than 25 private organisational participants are needed, split into cohorts.

---

# 16. Concrete implementation plan

This plan is deliberately detailed so the LLM has to do minimal design work and should mostly perform code and tests.

Follow the steps in order.

## Step 0 - read current repo and locate existing partial work

Before writing code:

1. locate the Rust/Wasm core crate
2. list existing implemented modules:
   - coordinator replay
   - public replay
   - ballot replay
   - snapshot/versioning
   - diagnostics
   - openmls engine
3. list remaining TS-authoritative private issuance/ticket flows
4. list existing browser flow paths that still bypass MLS
5. list existing tests and their gaps

Then write a short internal implementation checklist and proceed. Do not ask for confirmation.

## Step 1 - add MLS group-size policy to code-level configuration

Create or update a Rust config module:

- `auditable-voting-core/src/config.rs`

Add constants:

- `PREFERRED_MLS_GROUP_MIN = 16`
- `PREFERRED_MLS_GROUP_MAX = 24`
- `HARD_MLS_GROUP_CAP = 25`
- `EMERGENCY_MLS_GROUP_CAP = 32`
- `DEFAULT_SUPERVISORY_GROUP_MAX = 9`

Create validation functions:

- `validate_group_size(count)`
- `is_group_size_preferred(count)`
- `is_group_size_emergency_only(count)`

Add tests for each.

## Step 2 - add group topology types in Rust

Create or update:

- `src/types.rs`
- `src/event.rs`

Add types:

- `GroupRole = Supervisory | Cohort`
- `GroupId`
- `LiaisonAssignment`
- `GroupTopology`
- `CrossGroupInstruction`
- `CrossGroupReceipt`
- `GroupSnapshotMeta`

Ensure all are serialisable and versioned.

Add tests for serialisation round-trips.

## Step 3 - add Rust group topology reducer

Create:

- `src/group_topology.rs`

Responsibilities:

- enforce hard cap
- allocate cohort groups when participant count exceeds cap
- assign liaisons
- derive stable topology summaries
- reject invalid oversized groups
- expose warnings when group sizes enter emergency range

Add pure functions:

- `plan_groups(participants, role, cap)`
- `assign_liaisons(groups, supervisors_per_group)`
- `validate_topology(topology)`

Add deterministic tests:
- 1 group, <= 9 coordinators
- 10-25 operational members
- 26 members -> split to 2 groups
- 51 members -> split to multiple groups
- invalid topology with >25 member group rejected

## Step 4 - extend coordinator engine abstraction to include group routing metadata

Update:

- `src/coordinator_engine.rs`

Add explicit support for:

- origin group id
- target group id
- liaison forwarding metadata
- cross-group instruction class

Do not expose OpenMLS internals.

Add tests ensuring the TS boundary still sees only stable domain types.

## Step 5 - implement or complete supervisory-group routing in Rust

Create:

- `src/cross_group.rs`

Responsibilities:

- accept a supervisory instruction
- derive cohort-targeted messages
- preserve stable linkage from origin event to propagated event
- reject illegal direct cohort-to-cohort authoritative control

Rules:
- only supervisory group can originate authoritative election-control messages
- cohort groups may emit status/reporting messages upward
- cohort groups may not publish final authoritative election-control state privately

Add tests:
- supervisory -> cohort allowed
- cohort -> supervisory status allowed
- cohort -> cohort authority transfer rejected

## Step 6 - complete live browser OpenMLS carrier path for supervisory group

Update Rust and TS bridge modules so the live browser coordinator path actually uses the OpenMLS-backed engine where intended.

Status:
- partially complete
- the Rust side exists and the coordinator Wasm build includes the OpenMLS engine
- the remaining gap is browser bootstrap/join carrier wiring plus a passing live gate on that MLS-backed runtime

Required work:

Rust:
- ensure export/import snapshot for supervisory group is stable
- ensure carrier encoding/decoding is complete

TypeScript:
- update Nostr carrier publish/subscribe path
- load Rust snapshots
- deliver carrier payloads to Rust
- render Rust-derived state

Add tests:
- browser path uses OpenMLS-backed supervisory engine
- reload after snapshot restores same state
- replay after carrier backfill matches full replay

## Step 7 - add cohort-group carrier support only if needed

Do not add cohort-group MLS flows unless the code actually needs them.

If needed:

Rust:
- reuse group engine abstractions
- create separate group-role-specific wrappers

TS:
- support group-specific subscriptions
- persist per-group snapshots/checkpoints

Add tests:
- multiple groups can coexist
- each group snapshot restores independently
- inter-group events remain scoped and deterministic

## Step 8 - move remaining TS-authoritative private issuance/ticket truth into Rust

This is mandatory.

Audit existing TS modules such as:

- `simpleVotingSession.ts`
- `simpleRoundState.ts`
- `simpleLocalState.ts`
- `simpleShardDm.ts`

For each module:

1. identify protocol truth still held in TS
2. create Rust equivalent type/reducer/service
3. expose via WASM
4. switch TS module to thin adapter
5. delete or demote legacy reducer logic
6. add regression tests

Do not leave partial duplicated truth.

## Step 9 - add or complete compact receipt commitment support in Rust

Create or update:

- `src/receipts.rs`
- `src/public_state.rs`
- `src/proofs.rs`

Responsibilities:

- generate stable receipt identifiers
- batch or structure receipt commitments
- derive public receipt summaries
- expose voter inclusion compatibility data
- keep public artefacts compact

Add tests:
- identical input ballots -> identical receipt commitments
- duplicate events do not alter commitment set
- receipt summaries reconstruct correctly from replay

## Step 10 - add public proof bundle skeleton in Rust

Even if full threshold work is not implemented yet, add the typed skeleton now.

Create:

- `src/proofs.rs`

Add types:

- `ReceiptSetCommitment`
- `TallyInputCommitment`
- `ResultProofBundle`
- `CoordinatorApprovalSummary`
- `DisputeProofRecord`

Add reducers/derivers that populate what is currently available and leave explicit `NotAvailableYet` markers for unimplemented proof material.

Add tests:
- bundle serialisation
- bundle replay determinism
- bundle stable hashing
- contradiction visibility

## Step 11 - strengthen snapshot/versioning for multiple groups

Update:

- `src/snapshot.rs`
- `src/versioning.rs`

Requirements:

- snapshot metadata must include group role and group id
- snapshots must be loadable independently per group
- full replay vs snapshot+suffix parity must be tested for:
  - supervisory-only
  - supervisory + cohort
  - public + ballot + supervisory mixed streams

Add tests for all cases.

## Step 12 - extend diagnostics

Update:

- `src/diagnostics.rs`

Add diagnostics for:

- oversized group attempted
- emergency-range group size
- invalid liaison assignments
- cross-group routing violations
- stale cohort snapshot
- stale supervisory snapshot
- proof availability status
- compact receipt generation status

Expose through WASM.

TS must display them, not compute them.

## Step 13 - adapt TS adapter/service layer

Under:

- `web/src/core/`
- `web/src/services/`
- `web/src/nostr/`

Perform the following:

### `web/src/core/`
- update wasm loader if needed
- add group-topology bridge
- add diagnostics reader
- add snapshot group metadata helpers

### `web/src/services/`
- add `CoordinatorControlService` support for supervisory-group topology
- add `GroupTopologyService`
- add `ReceiptSummaryService`
- adapt existing UI services to read Rust-derived values only

### `web/src/nostr/`
- scope subscriptions by `election_id`, `round_id`, `plane`, and `group_id` where relevant
- avoid global oversized subscriptions
- route incoming events to correct Rust apply/replay path

Add TS integration tests after each change.

## Step 14 - remove or demote legacy TS protocol engines

For every migrated path:

- remove old reducer logic
- or mark it as compatibility-only and ensure it is not authoritative

Required checks:
- grep for old acceptance logic
- grep for round-state derivation in TS
- grep for ordering logic in TS
- grep for private issuance truth remaining in TS

Add a final test ensuring UI state still matches Rust-derived state.

## Step 15 - add transcript fixtures for bounded-group model

Create transcript fixtures covering:

1. one supervisory group only
2. supervisory + one cohort
3. supervisory + multiple cohorts
4. duplicate cross-group messages
5. out-of-order cross-group arrival
6. missing segment followed by backfill
7. reload mid-session
8. stale cohort snapshot recovery
9. supervisory snapshot recovery
10. public receipt commitment replay
11. 1,000-voter-style ballot event volume simulation with voters outside MLS

These fixtures are mandatory.

## Step 16 - add scale-oriented simulation tests

Add Rust and/or TS integration simulations for:

- `5 coordinators / 1000 voters / 3 rounds`
- `5 coordinators / 1000 voters / 5 rounds`
- bounded private organisational groups under cap
- large public ballot stream
- snapshot+suffix replay under load

These do not need to be full browser e2e performance tests, but they must validate:

- deterministic replay
- bounded group planning
- public artefact compactness
- no voter-in-MLS regression

## Step 17 - docs update

After code and tests pass, update docs:

- architecture section
- scaling section
- MLS group size policy
- multi-group coordination section
- public/private plane separation
- current limitations if threshold/proofs remain partial

Do not claim capabilities not implemented.

---

# 17. Suggested Rust crate layout

Create or expand a crate such as:

- `auditable-voting-core/`

Suggested files:

- `src/lib.rs`
- `src/config.rs`
- `src/types.rs`
- `src/event.rs`
- `src/order.rs`
- `src/replay.rs`
- `src/validation.rs`
- `src/error.rs`
- `src/diagnostics.rs`
- `src/snapshot.rs`
- `src/versioning.rs`
- `src/group_topology.rs`
- `src/cross_group.rs`
- `src/public_state.rs`
- `src/ballot_state.rs`
- `src/coordinator_state.rs`
- `src/coordinator_messages.rs`
- `src/coordinator_engine.rs`
- `src/openmls_engine.rs`
- `src/receipts.rs`
- `src/proofs.rs`
- `src/tally.rs`
- `src/threshold.rs`
- `src/wasm.rs`

Not every file must be fully populated immediately, but the design should head in this direction.

---

# 18. Suggested TypeScript adapter layout

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
- publish cohort-group carrier events if needed
- publish ballot events
- subscribe to election streams
- subscribe to coordinator streams
- subscribe to cohort-group streams if needed
- subscribe to ballot streams

These modules must **not** become protocol engines.

---

# 19. Existing files to adapt carefully

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

# 20. Threshold tally and proof expansion

This may not need to land first, but the architecture must support it.

## 20.1 Threshold abstraction

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

## 20.2 Public proof derivation

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

# 21. Diagnostics requirements

The system must expose structured diagnostics from Rust.

Useful diagnostics include:

- invalid event count by reason
- duplicate event count
- contradictory transition warnings
- stale snapshot warnings
- stale cohort snapshot warnings
- stale supervisory snapshot warnings
- coordinator desync indicators
- replay status
- proof availability status
- group size policy warnings
- invalid liaison assignment warnings
- quorum/threshold state if used

TypeScript may display these diagnostics.

TypeScript must not be responsible for inferring them from protocol rules.

---

# 22. Testing requirements

The migration is not acceptable without strong replay and recovery testing.

## 22.1 Rust truth tests

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
- group-topology planning correctness
- inter-group routing correctness
- MLS cap enforcement

## 22.2 Transcript-based fixtures are mandatory

Use transcript fixtures for:

- in-order delivery
- out-of-order delivery
- duplicate relay deliveries
- missing segment followed by backfill
- browser reload mid-workflow
- close-boundary edge cases
- contradictory public result publication
- stale snapshot recovery
- cohort/supervisory mixed recovery
- cross-group liaison forwarding

At 1,000+ voter scale, transcript correctness matters more than superficial component tests.

## 22.3 JS/TS integration tests

Add JS/TS integration tests for:

- WASM loading
- IndexedDB snapshot persistence/loading
- reload and recovery
- relay disorder integration
- UI consumption of Rust-derived state
- ensuring TS does not become authoritative again
- group-topology adapter correctness
- diagnostics display correctness

Truth tests should primarily live in Rust.

---

# 23. Anti-patterns to avoid

The LLM must avoid all of the following.

## 23.1 Forbidden architectural mistakes

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
- enlarging MLS groups beyond 25 instead of sharding

## 23.2 Forbidden scaling mistakes

- assuming full history replay is always acceptable
- failing to partition by election/round/group
- publishing excessively noisy public proof chatter
- not compacting receipt/proof outputs
- treating relay disorder as exceptional
- ignoring snapshot/suffix parity
- designing only for 100 voters instead of 1,000+
- assuming one giant organisational MLS group is acceptable because the session is only one day

---

# 24. Definition of done

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
- all browser MLS groups are capped at 25
- multi-group coordination is explicit, replayable, and test-covered
- tests pass
- docs accurately describe the final architecture

Current status against this definition:
- not done
- the repo is materially closer than before because the small live recovery gates are passing again and the Rust replay seams are in place
- the biggest remaining gaps are:
  - live browser use of the OpenMLS engine instead of the deterministic runtime seam
  - moving the remaining private issuance/ticket truth out of TypeScript where required by this brief
  - proof/tally expansion
  - live scale sign-off beyond the current small gates

---

# 25. Recommended practical mindset for the LLM

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
- never solve oversized-group pressure by increasing the cap; shard instead

---

# 26. Short mission statement

Build `auditable-voting` into a:

**browser-first, replayable, multi-coordinator voting system with Rust-owned protocol logic, OpenMLS-backed coordinator control, bounded-size organisational MLS groups, private ballot handling, public auditability, and a design that remains credible at 1,000+ voters.**
