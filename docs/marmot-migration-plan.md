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
- lead-mediated forwarding for non-lead ticket shares

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
- Non-lead shares can continue to be forwarded by the lead as an operational simplification, but the forwarding hop should be implemented inside the Marmot private plane rather than over NIP-17.

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
