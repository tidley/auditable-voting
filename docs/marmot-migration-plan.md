# Marmot Migration Plan

## Goal

Replace the current private NIP-17 control plane with Marmot/MDK for private coordinator and voter messaging, while keeping the auditable public voting surface on Nostr.

The public side should stay public:

- round announcements
- blind-key announcements
- ballots
- tally / result events

The private side should move off plain NIP-17:

- voter follow / coordinator follow acknowledgement
- coordinator roster updates
- sub-coordinator join
- share-index assignment
- blinded issuance requests
- ticket-share delivery
- ticket receipts and other acknowledgements

## Feasibility verdict

This is **possible**, but not as a drop-in `cargo add mdk-core` browser integration.

It is realistic if we do all of the following:

- maintain a browser-specific MDK/Wasm integration layer
- replace the SQLite/keyring backend with an IndexedDB-backed storage backend
- remove or isolate the current `nostr -> secp256k1-sys` dependency path from the Wasm core
- keep the public auditable voting plane on Nostr and move only the private control plane to Marmot

It is **not** realistic to:

- ship upstream `mdk-core` unchanged to the browser today
- use `mdk-sqlite-storage` in the browser
- claim there will be no security risk without a dedicated browser-side review and test programme

The right claim is:

- feasible with a browser fork / adapter strategy
- secure enough to pursue if the security constraints in this document are enforced
- not ready to trust without additional implementation, review, and adversarial testing

## Sources and audit basis

This plan is based on:

- current upstream MDK workspace at commit `93ae32479211d7a241ff379c34d3fe87ac161e7a`
- current upstream workspace version `0.7.1`
- current upstream `SECURITY.md`
- Least Authority audit of MDK

Local checks performed during this planning pass:

```bash
git clone --depth 1 https://github.com/marmot-protocol/mdk /home/tom/code/mdk-plan-audit
cd /home/tom/code/mdk-plan-audit
cargo check -p mdk-core --target wasm32-unknown-unknown
cargo tree -p mdk-core -i secp256k1-sys
cargo tree -p mdk-core -i rayon
cargo tree -p mdk-sqlite-storage -i libsqlite3-sys
```

## Current state in this repo

Today the app uses:

- Nostr public events for rounds, blind keys, ballots, and results
- NIP-17 gift-wrapped DMs for issuance traffic
- direct coordinator-to-voter ticket delivery for all coordinators
- a small primary relay subset for live reads and subscriptions, with broader fanout reserved for publishes

This is already the correct public/private split at a conceptual level, but the private plane is still relay-driven and message-heavy. That shows up in practice: small live runs are now workable, but larger public-relay committee runs are still not operationally viable.

## Target architecture

### Public auditable plane

Keep on Nostr:

- live round publication
- authorised coordinator roster in the round event
- blind-key publication
- submitted ballots
- public tallying and auditor recomputation

### Private coordination plane

Move to Marmot:

- voter-to-coordinator follow / registration traffic
- lead-to-voter coordinator roster pushes
- sub-coordinator registration with the lead
- lead-to-sub-coordinator share-index assignment
- blinded request delivery
- ticket-share delivery
- acknowledgements and receipts

### Routing model

- The lead remains the public round publisher and coordinator orchestrator.
- Sub-coordinators remain independent share issuers.
- Each coordinator sends its own ticket share directly to the voter over the private Marmot plane.
- The lead is not used as a forwarding bottleneck for non-lead shares.

That preserves the current threshold semantics better than a lead-forwarding model.

## Hard blockers and concrete resolutions

### 1. `nostr -> secp256k1 -> secp256k1-sys`

#### Current finding

Current upstream `mdk-core` depends on:

- `nostr v0.44.2`
- which depends on `secp256k1`
- which depends on `secp256k1-sys`

The current `wasm32-unknown-unknown` check still fails in that path. In the checked environment the immediate error was the `secp256k1-sys` C build step needing `clang`.

#### Why this matters

Even if this can be made to build in a controlled CI environment, it is the wrong browser boundary:

- it pulls native C tooling into the Wasm build
- it couples the MDK core tightly to Nostr event/signing concerns
- it expands the trusted and fragile part of the browser build

#### Preferred solution

Create a **browser fork of MDK** that removes the `nostr` crate from the Wasm-critical core.

Concretely:

- define browser-safe MDK message/event types inside the fork
- move Nostr event signing, verification, relay URL parsing, and key handling to the TypeScript host layer
- feed the Wasm core only the minimal verified data it actually needs

That changes the boundary from:

- `TS UI -> Wasm MDK+Nostr+secp`

to:

- `TS UI + Nostr host adapter -> Wasm MDK core`

This is the cleanest path because the browser app already has a strong Nostr/TS layer.

#### Acceptable fallback

If the forked-boundary approach is too slow initially:

- build the browser fork with a dedicated Wasm C toolchain in CI
- pin the toolchain
- ship prebuilt Wasm artefacts only

This can prove feasibility, but it should be treated as a spike path, not the final architecture.

#### Go / no-go rule

Do not move past prototype stage unless one of these is true:

- the browser fork no longer requires `secp256k1-sys`, or
- the Wasm build is reproducible and pinned under CI with explicit review of the native toolchain

The first option is preferred.

### 2. SQLite and keyring storage

#### Current finding

`mdk-sqlite-storage` depends on:

- `rusqlite`
- `libsqlite3-sys`
- `refinery`
- `keyring-core`

This is not a browser backend.

#### Resolution

Do not use `mdk-sqlite-storage` in the browser.

Instead build a new browser backend:

- `mdk-indexeddb-storage` in Rust, or
- a thinner Wasm adapter over TS-owned IndexedDB calls

The key fact making this feasible is that MDK storage is already trait-based via `MdkStorageProvider` and related storage traits.

#### Recommended browser storage design

Use IndexedDB object stores for:

- groups
- snapshots
- messages
- welcomes
- pending outbound messages
- identity and membership metadata

Do **not** store raw sensitive state unencrypted.

Use this key hierarchy:

1. Generate a random per-device **DEK** for Marmot state.
2. Encrypt all persisted Marmot state with that DEK.
3. Wrap the DEK with a **KEK** derived from:
   - a user passphrase using Argon2id, initially
   - optional WebAuthn-backed wrapping later

Do not use:

- plaintext IndexedDB
- plaintext `localStorage`
- `npub`/`nsec` self-encryption tricks

#### Security note

Upstream MDK `SECURITY.md` focuses heavily on SQLCipher and platform keyrings. For the browser fork, those guarantees must be replaced by:

- authenticated encryption of persisted state
- strong KEK derivation
- explicit locking / unlock flow
- no assumption that the browser provides a secure keyring equivalent

### 3. `openmls -> rayon`

#### Current finding

Current upstream `openmls` still pulls in `rayon`.

That is not automatically fatal for Wasm, but it is a risk area.

#### Resolution

Treat this as a prototype gate, not a theoretical blocker.

Prototype in this order:

1. Try a single-threaded Wasm build of the browser fork.
2. If `rayon` compiles but is unused in the browser execution path, keep it documented as tolerated technical debt.
3. If `rayon` breaks the Wasm build or forces an undesirable browser threading model:
   - patch or fork the dependency path to disable parallelism in browser builds
   - do not require `SharedArrayBuffer`, COOP, or COEP for the first web deployment

The first production browser version should be single-threaded unless there is a compelling need otherwise.

### 4. Mandatory media-processing dependencies

#### Current finding

Current upstream `mdk-core` includes mandatory image/media dependencies:

- `image`
- `blurhash`
- `fast-thumbhash`
- `kamadak-exif`

These are not the core need for auditable voting.

#### Resolution

For the browser fork, split media features from the control-plane minimum.

Create a browser MVP feature set that includes only:

- MLS state
- group membership
- message encode / decode
- acknowledgements
- persistence

Do not carry media/image features into the first browser voting integration unless they are actually required.

This reduces:

- bundle size
- attack surface
- review burden

### 5. `mdk-uniffi` is not the browser boundary

#### Current finding

UniFFI is useful for native/mobile bindings, not as the primary boundary for a web app.

#### Resolution

The web integration should use:

- `wasm-bindgen`
- typed serialisable DTOs
- a narrow API surface

The browser-facing Wasm API should expose:

- identity creation / import
- group creation / join
- outbound private message generation
- inbound private message ingestion
- receipt generation
- state export / import
- recovery / replay operations

## Security constraints

This migration should not proceed unless these rules are enforced.

### Boundary rules

- Public auditable data stays on Nostr.
- Private coordination data stays off the public event plane.
- The Wasm core owns private protocol state.
- The TS layer must not receive raw MLS exporter secrets unless there is no practical alternative.

### Storage rules

- No plaintext Marmot state in IndexedDB.
- No secrets in `localStorage`.
- Use authenticated encryption for persisted records or snapshots.
- Passphrase-based unlock must be mandatory for persisted Marmot state in the first browser release.

### Logging and diagnostics

- Never log:
  - private keys
  - MLS exporter secrets
  - group identifiers
  - per-group secret material
  - decrypted message contents
- UI diagnostics may show delivery state, but not raw cryptographic payloads.
- Browser error reporting must not send private-plane data to third parties.

### Web hardening

- no third-party scripts on the voting app
- strict CSP
- `Referrer-Policy: no-referrer`
- explicit `Permissions-Policy`
- pinned dependency versions
- reproducible Wasm artefacts in CI

### Review gates

Before the NIP-17 path is removed:

- internal protocol review
- external cryptography / protocol review
- browser-state persistence review
- adversarial delivery / replay / recovery testing

This plan can reduce obvious security weaknesses, but it cannot honestly guarantee the absence of all cybersecurity weaknesses. That still requires review and testing.

## Concrete migration phases

### Phase 0: feasibility spike

Objective:

- prove that a browser fork is viable before changing app protocol behaviour

Deliverables:

- fork `mdk-core` into a browser branch
- remove or isolate direct `nostr` dependency from the Wasm-critical path
- compile minimal Wasm artefact
- prove:
  - create identity
  - create group
  - ingest outbound/inbound private message payloads
  - serialise and restore state

Exit criteria:

- successful browser Wasm build
- no SQLite/keyring dependency in browser artefact
- documented API boundary

### Phase 1: transport abstraction in this repo

Objective:

- move all private messaging behind a transport interface without changing user-visible protocol behaviour

The interface should cover:

- send follow
- send follow acknowledgement
- send coordinator roster
- send sub-coordinator join
- send share assignment
- send blinded request
- send blinded-request acknowledgement
- send ticket share
- send receipt acknowledgement
- subscribe / fetch for each of the above

Exit criteria:

- NIP-17 implementation is behind one interface
- no direct NIP-17 calls from UI components

### Phase 2: browser storage backend

Objective:

- provide a browser-safe MDK storage implementation

Deliverables:

- IndexedDB storage design
- encrypted persistence
- snapshot support
- recovery tests

Exit criteria:

- all MDK state needed for reconnect survives reload
- locked-state and unlock flow work
- no plaintext secret persistence

### Phase 3: coordinator-only Marmot path

Objective:

- move coordinator-only private traffic first

Move:

- sub-coordinator join
- share-index assignment
- coordinator roster maintenance

Keep voter issuance on NIP-17 for this phase.

Exit criteria:

- lead/sub-coordinator coordination is stable without NIP-17
- coordinator recovery works after reload / reconnect

### Phase 4: voter issuance over Marmot

Objective:

- move voter private traffic after the committee path is stable

Move:

- follow
- follow acknowledgement
- blinded request
- ticket share
- receipt acknowledgement

Keep:

- round announcements public on Nostr
- blind keys public on Nostr
- ballots public on Nostr

Exit criteria:

- `1 / 20 / 3` live run equals or beats current reliability
- `2 / 2 / 1` threshold run equals or beats current reliability

### Phase 5: hardening and scale

Objective:

- prove the Marmot path is not just functionally correct, but operationally better

Required tests:

- reconnect
- duplicate inbound messages
- out-of-order delivery
- missed receipt recovery
- multi-coordinator scale runs
- browser refresh / restore in the middle of a round

Required live targets:

- `1 / 20 / 3`
- `2 / 10 / 3`
- `5 / 10 / 3`

Exit criteria:

- private-plane stage metrics are better than NIP-17 baseline
- no obvious new privacy regressions
- no plaintext persistence regressions

### Phase 6: cutover

Objective:

- retire NIP-17 for issuance traffic once Marmot is at feature parity

Steps:

- keep NIP-17 as a feature flag for one transition period
- switch default private path to Marmot
- remove NIP-17 issuance only after the review gates pass

## Practical recommendation

The strongest practical strategy is:

1. keep rounds, blind keys, ballots, and tallying public on Nostr
2. build a browser-specific MDK/Wasm fork rather than forcing upstream desktop assumptions into the browser
3. replace SQLite/keyring with encrypted IndexedDB
4. keep direct coordinator-to-voter ticket delivery in the private plane
5. do not centralise private issuance through the lead

## Final assessment

The migration is feasible, but only under this interpretation:

- **possible** as a browser-specific Marmot integration
- **not possible as a zero-change upstream MDK drop-in**

The main blockers are solvable:

- `secp256k1-sys` by removing or isolating the `nostr` dependency from the browser Wasm core
- SQLite/keyring by replacing them with encrypted IndexedDB storage
- `rayon` and media dependencies by treating them as explicit browser-fork feature-gating work

If that work is accepted, Marmot is a credible long-term replacement for the private NIP-17 control plane in this repo.
