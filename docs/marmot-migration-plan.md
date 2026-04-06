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

## Current state

Today the app uses:

- Nostr public events for rounds, blind keys, ballots, and results
- NIP-17 gift-wrapped DMs for issuance traffic
- direct coordinator-to-voter ticket delivery for all coordinators

That means the current private plane is still relay-driven and message-heavy, even though the auditable public plane is already in the right place.

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

- The lead remains the public round publisher.
- Sub-coordinators remain independent share issuers.
- The lead should remain the public round publisher, but non-lead coordinators should send their own shares directly to voters over the Marmot private plane.

## Migration phases

### Phase 1: transport abstraction

Create a private-message transport interface in the web app and move all NIP-17 calls behind it.

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

Do not change public round or ballot code in this phase.

### Phase 2: Marmot committee-only path

Use Marmot first for coordinator-only traffic:

- sub-coordinator join
- share-index assignment
- coordinator roster maintenance
- lead/non-lead forwarding coordination

This is the safest first move because it removes some of the highest-value private control traffic without changing the voter flow yet.

### Phase 3: Marmot voter issuance path

Move voter issuance traffic next:

- follow
- follow acknowledgement
- blinded request
- ticket share
- receipt acknowledgement

Keep the voter UI and ballot logic unchanged. Only swap the private transport.

### Phase 4: reliability and recovery

Rebuild the current retry/reconcile logic around Marmot session state:

- delivery receipt semantics
- reconnect and resync
- missed-message recovery
- per-stage diagnostics in the UI

### Phase 5: remove NIP-17 issuance path

Once Marmot is stable:

- keep NIP-17 optional only behind a feature flag for fallback testing
- then remove it from the private issuance path entirely

## Pros and cons

### Marmot migration pros

- better private messaging model than ad hoc NIP-17 flows
- richer acknowledgement and session semantics
- cleaner coordinator-group behaviour
- lower dependence on public-relay behaviour for private issuance
- better long-term privacy story for private coordination

### Marmot migration cons

- substantial implementation effort
- browser integration complexity
- larger Rust/Wasm boundary
- likely new persistence and synchronisation work
- more protocol/state-machine complexity than the current DM wrappers

## What it would take to Wasm MDK/Marmot

The realistic browser design is not "compile everything and call it done". It would need a deliberate Rust/Wasm adapter layer.

### Dependency audit snapshot

Audited against the current upstream MDK workspace at the time of review:

- workspace version: `0.7.1`
- checked crates:
  - `mdk-core`
  - `mdk-memory-storage`
  - `mdk-sqlite-storage`

Commands run:

```bash
cargo check -p mdk-core --target wasm32-unknown-unknown
cargo check -p mdk-memory-storage --target wasm32-unknown-unknown
cargo check -p mdk-sqlite-storage --target wasm32-unknown-unknown
```

#### Immediate findings

1. `mdk-core` is **not browser-ready as-is**.
   - The first hard build blocker is `nostr -> secp256k1 -> secp256k1-sys`.
   - In the audited build, that path failed before the Rust code could finish checking for `wasm32-unknown-unknown`.
   - Concretely, the failure was in the `secp256k1-sys` C build step.

2. `mdk-sqlite-storage` is **not suitable for browser Wasm**.
   - It depends on:
     - `rusqlite`
     - `libsqlite3-sys`
     - `refinery`
     - `keyring-core`
   - That is a native SQLite/SQLCipher path, not a browser persistence path.
   - Even if forced to compile with extra toolchain work, it is still the wrong storage backend for a browser app.

3. `mdk-memory-storage` is the only plausible starting point for a browser integration.
   - It still inherits the `nostr -> secp256k1-sys` blocker.
   - But architecturally it is much closer to what a browser/Wasm integration would want.

#### Dependency classification

Likely acceptable or plausible for browser Wasm:

- `mdk-storage-traits`
- `mdk-memory-storage`
- `openmls`
- `openmls_traits`
- `openmls_basic_credential`
- `openmls_rust_crypto`
- `serde`
- `postcard`
- `chacha20poly1305`
- `hkdf`
- `sha2`

Immediate blockers or strong friction points:

- `nostr` because the current path pulls in `secp256k1-sys`
- `secp256k1-sys` because it requires a native C build step in the audited target path
- `mdk-sqlite-storage`
- `libsqlite3-sys`
- `rusqlite`
- `refinery`
- `mdk-uniffi` for browser use, because UniFFI is not the right boundary for a web app

#### Secondary risks

Even after the `secp256k1-sys` issue is resolved, there are still areas that need validation rather than assumption:

- `openmls` currently pulls in `rayon`, which may be awkward in browser Wasm depending on threading assumptions
- `mdk-core` includes mandatory image-processing dependencies:
  - `image`
  - `blurhash`
  - `fast-thumbhash`
  - `kamadak-exif`
- these may compile, but they increase code size and are not obviously essential to the minimal private-control-plane use case

#### Practical conclusion

The audit says:

- **do not** plan around `mdk-sqlite-storage` in the browser
- **do** plan around a browser-specific storage adapter, replacing SQLite entirely
- **do not** assume `mdk-core` can be dropped into Wasm unchanged
- **do** expect to patch or feature-gate the `nostr`/`secp256k1-sys` path before a browser build will work reliably

### Likely shape

- Rust/Wasm owns:
  - Marmot state machines
  - group/session state
  - message encode/decode
  - acknowledgement / receipt handling
  - recovery state
- TypeScript owns:
  - UI
  - browser timers
  - IndexedDB adapter
  - transport adapter to whichever network path is used

### Expected work items

1. Audit MDK crate dependencies for wasm compatibility.
2. Expose a `wasm-bindgen` API for:
   - creating identities
   - joining groups
   - ingesting inbound messages
   - producing outbound messages
   - persisting / restoring group state
3. Add a browser storage adapter:
   - IndexedDB-backed state snapshots
   - encryption of persisted private state
4. Add a JS transport adapter:
   - outbound message publishing
   - inbound message delivery into the Wasm core
5. Define a stable TS <-> Wasm schema for:
   - voter follow state
   - coordinator roster state
   - blinded request state
   - ticket / receipt state
6. Add deterministic tests for:
   - reconnect
   - duplicate inbound messages
   - out-of-order delivery
   - missed receipt recovery

### Likely blockers

- if MDK assumes native async/runtime patterns that do not fit browser Wasm cleanly
- if its crypto or storage assumptions are not browser-friendly
- if the current transport expectations are closer to native peers than to browser clients

### Practical assessment

Wasm integration looks feasible, but it is a medium-to-large engineering project, not a small swap.

The right strategy is:

- keep the public auditable plane on Nostr
- move the private coordination plane behind a transport abstraction first
- integrate Marmot through a Rust/Wasm core only after that boundary is clean

## Recommendation

If the goal is operational improvement without losing public auditability:

1. keep rounds, blind keys, ballots, and results public on Nostr
2. move all private issuance traffic behind a transport interface
3. use Marmot for coordinator-only traffic first
4. then migrate voter issuance traffic
5. only remove NIP-17 after the Marmot path has equivalent recovery, diagnostics, and tests
