# Questionnaire migration and deletion plan

This plan implements `docs/questionnaire-voting-spec.md`. The governing rule is
that each phase removes or disconnects an old implementation before the next
phase begins. A fourth protocol implementation, compatibility facade, or broad
rewrite branch is not acceptable.

## Current duplication

There are three disconnected Rust implementations:

- `auditable-voting-core/` is the existing coordinator-oriented WASM crate.
- `web/rust-core/` is a second, single-file WASM helper crate for the simple flow.
- `worker/` is a native binary with independent questionnaire models and rules.

The active TypeScript questionnaire implementation duplicates protocol and
state rules in:

- `web/src/questionnaireOptionA.ts`
- `web/src/questionnaireOptionARuntime.ts`
- `web/src/questionnaireProtocol.ts`
- `web/src/questionnaireOptionAStorage.ts`
- `web/src/questionnaireTransport.ts`
- `web/src/questionnaireOptionABlindDm.ts`

Active questionnaire modules also import constants and event helpers from
legacy `simpleVotingSession.ts` and `simpleShardDm.ts`. This prevents deletion of
the legacy flow even where its state machine is no longer wanted.

## Target boundary

`auditable-voting-core/` becomes the only protocol crate. It builds as an `rlib`
for the worker and through a thin `wasm-bindgen` API for the browser.

The core owns pure data and decisions:

- signed questionnaire definition and canonical hash
- coordinator, voter, issuer, and observer state transitions
- admission and ballot-grant rules
- provisional and final response validation
- closure, acceptance, aggregate, and tally rules
- blind credential scheme interface and RSABSSA implementation
- retry, deduplication, and relay-selection policy
- versioned persistence and backup document formats

Platform code performs effects requested by the core:

- sign or verify a Nostr event
- publish, query, or subscribe on specified relays
- read, write, or delete an opaque persistence record
- obtain time and secure randomness
- encrypt or decrypt through an explicitly supplied key port

React renders snapshots and dispatches commands. It does not import voting
storage modules, calculate protocol state, or select transport retries.

The worker owns process configuration and the Nostr/network adapters only. It
does not define a second questionnaire model.

## Phase 0: enforce the privacy boundary

Changes:

- reject participant messages containing `vote_submitted` or `submissionId`
- accept voter identity-linked progress only through `Ballot received`
- prevent the issuer proxy from claiming ballot receipt for the voter
- emit voter `Ballot received` only when every required grant is present
- remove post-receipt fields from coordinator participant state

Tests:

- malformed and role-invalid participant status parser tests
- coordinator state test proving no submission identifier is stored
- multi-grant test proving partial issuance does not emit ballot receipt
- worker test proving issuance acknowledgement is not forwarded as voter state

Deletion gate: no production occurrence of `vote_submitted` or
`voteSubmittedAt` remains.

## Phase 1: sever legacy imports

Changes:

- create neutral questionnaire relay and Nostr event modules
- move `SIMPLE_PUBLIC_RELAYS`, `SIMPLE_DM_RELAYS`, and shared event constants to
  neutral names without changing their values
- update every `questionnaire*` module to use the neutral modules
- move any genuinely shared pure event helpers out of `simpleVotingSession.ts`
- prohibit new imports from `questionnaire*` into `simple*` and vice versa

Tests:

- relay normalisation and default-selection unit tests
- an architecture test that fails when active questionnaire modules import
  legacy simple-flow modules
- existing public and DM transport tests

Deletion gate: `rg 'from .*\\./simple' web/src/questionnaire*` returns no
matches.

## Phase 2: establish one Rust core

Changes:

- retain `auditable-voting-core/` as the canonical crate
- remove the unused OpenMLS feature and modules; encrypted questionnaire
  distribution is deferred
- define versioned core commands, snapshots, effects, and errors
- add the `BlindCredentialScheme` interface and move the current RSABSSA
  implementation behind it
- make `worker/` depend on the core by path
- move reusable functions from `web/rust-core/src/lib.rs` only when an active
  acceptance test requires them
- delete `web/rust-core/` and its generated package

Tests:

- native and WASM parity fixtures for canonical encoding and hashes
- RSABSSA issuance, unblinding, verification, and invalid-proof tests
- serialization fixtures consumed by both TypeScript and the worker

Deletion gate: one Cargo package defines questionnaire protocol models; the web
build invokes one WASM package.

## Phase 3: move persistence semantics into the core

Changes:

- define versioned coordinator, voter, issuer, and observer records in Rust
- return opaque storage effects from core commands
- implement a small browser storage port and a small worker file-storage port
- move encryption and backup schemas into the core
- keep private one-use invite plaintext in session memory only
- replace direct questionnaire `localStorage` access in components and runtimes

Tests:

- round-trip and migration tests for every persisted record version
- property tests for recovery idempotence and incompatible-state rejection
- browser-port tests proving UI code cannot access voting records directly
- backup tests proving claim plaintext and linkable post-receipt data are absent

Deletion gate: active React components do not import
`questionnaireOptionAStorage.ts` or access questionnaire voting keys directly.

## Phase 4: coordinator vertical slices

Implement these slices independently, with a failing transition test first:

1. Identity connect/import and draft definition.
2. Immutable canonical definition hash and publication.
3. Backup acknowledgement gate.
4. Issuer selection, verification, and lock on first shared link.
5. General, one-use, and named admission.
6. Optional admission freeze.
7. Manual, deadline, and all-finalised closure.
8. Signed aggregate and result publication with non-blocking mirrors.

Each slice replaces the corresponding TypeScript reducer/runtime branch and
deletes it before the next slice starts.

Tests:

- transition tables for valid and invalid coordinator commands
- immutable-definition and issuer-lock property tests
- duplicate, reordered, and delayed event tests
- mirror failure tests proving result publication is not blocked

Deletion gate: React coordinator code renders Rust snapshots and contains no
questionnaire transition logic.

## Phase 5: voter and proxy-voter vertical slices

Implement and replace in this order:

1. Stable identity and request ID recovery.
2. Local drafts before admission.
3. Exact blind request retry and signed request acknowledgement.
4. Independent scoped ballot grants and all-grants receipt.
5. Encrypted minimum self-recovery material.
6. Stable anonymous ballot identities.
7. Credential-proved monotonic provisional responses.
8. Manifest finalisation and exact-event retry.
9. Independent `Finalise all ready ballots` behaviour.
10. Public acceptance or rejection reconciliation.

Tests:

- one suite per slice for an ordinary voter and proxy voter
- property tests for stable IDs, monotonic sequence selection, and retry identity
- tests proving grants cannot be linked through identifiers or transport payloads
- recovery tests proving public state is restored and unpublished edits are not

Deletion gate: `questionnaireOptionARuntime.ts` no longer owns voter protocol
state or submission construction.

## Phase 6: native issuer migration

Changes:

- replace `worker/src/model.rs` protocol types with core types
- replace worker issuance and acceptance rules with core commands
- retain only CLI configuration, Nostr connections, scheduling, and file I/O in
  the worker package
- persist exact issuances and acknowledgement state through core records

Tests:

- the same issuance fixtures run against native and WASM builds
- restart and replay tests for exact issuance delivery
- authenticated-sender and delegation-scope tests
- multi-relay disconnect, reorder, duplication, and recovery tests

Deletion gate: worker source contains no independent protocol validation or
tally implementation.

## Phase 7: observer and legacy quarantine

Changes:

- implement compact-result loading and explicit `Validate votes` in the core
- cache validation by exact signed result and event-set hash
- extract the minimum old-format parser into a lazy, read-only Legacy Observer
- prevent that parser from importing active protocol, storage, issuer, or UI
  state modules

Tests:

- incomplete pre-closure warning tests
- deterministic full validation and invalid-event diagnostics
- cache-key and `Validate again` tests
- legacy fixtures proving read-only parsing without publish or mutation effects

Deletion gate: no active coordinator or voter bundle imports the legacy parser.

## Phase 8: delete superseded code

Delete active legacy flow modules and their creation/mutation tests, including:

- `simpleVotingSession.ts`
- `simpleRoundState.ts`
- `simpleShardDm.ts`
- `simpleMailbox.ts`
- `simpleShardCertificate.ts`
- `simpleVoteValidation.ts`
- legacy round, shard, mailbox, and ticket branches in `SimpleCoordinatorApp.tsx`
  and `SimpleUiApp.tsx`
- superseded TypeScript questionnaire reducers, runtime branches, transport
  policy, and storage schema code

Retain only generic shell/UI utilities that still have active callers and the
isolated read-only Legacy Observer.

Tests:

- production bundle import inspection
- active coordinator, voter, issuer, and observer end-to-end tests
- no-write Legacy Observer tests

Deletion gate: source search finds no active simple-round, shard-ticket,
mailbox, or threshold-certificate state.

## Phase 9: enforce verification and deployment

Replace the current build-only Pages workflow with required checks:

- Rust formatting, lint, unit, property, and fuzz smoke tests
- TypeScript checks and focused UI tests
- local multi-relay failure-injection end-to-end tests
- Chromium, Firefox, and WebKit Playwright tests
- real Safari tests on a macOS runner
- mandatory public-relay end-to-end tests
- production build and blind-credential verification

The Pages deploy job depends on the exact successful verification commit and
uploads only that commit's artifact. Pull request drafts may use reduced local
or optional checks; ready-for-review commits may not merge until every required
gate passes.

## Explicit non-goals

Do not implement during this migration:

- threshold or sharded blind Schnorr issuance
- encrypted questionnaire definition distribution
- a generic transport framework beyond the required browser and worker ports
- active compatibility writers for removed formats
- migrations for unshipped or non-persisted speculative state
