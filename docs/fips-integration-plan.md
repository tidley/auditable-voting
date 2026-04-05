# FIPS Integration Plan

This document explains how FIPS-style direct voter/coordinator connectivity could be integrated into the current client-only voting app, what can be reused from the local `fips-nostr-bootstrap` repo, and where the hard boundaries are.

## Short version

FIPS is a good fit for this project's control traffic:

- follow / join / share-assignment messages
- blinded issuance requests
- blinded issuance responses
- acknowledgements and retries

It is **not** a direct drop-in for the current pure browser app as it stands, because the current FIPS bootstrap/runtime uses UDP hole punching and Node/native socket APIs.

That means:

- **browser-only static app**: keep Nostr as the fallback transport
- **desktop / mobile / wrapped app**: FIPS can become the primary control transport
- **best near-term compromise**: introduce a local FIPS companion/runtime and let the web UI talk to it over localhost

Public protocol state should remain on Nostr:

- round announcements
- ballots
- results

Private control traffic should move off public relays when possible:

- issuance
- follow / join control
- ticket delivery

## Why this is worth doing

The current live failure mode is mostly before voting:

- follower propagation does not converge reliably
- live rounds do not reach every participant consistently
- blind-key and request propagation stall
- ticket issuance never becomes enabled in larger live runs

The latest measured run was:

- `5` coordinators
- `10` voters
- `3` rounds
- `0/10` voters receiving tickets in every round

The problem is not just "add more relays". The current architecture still depends on public-relay convergence for too much of the issuance path.

FIPS is appealing because it separates:

- Nostr as the rendezvous/control bootstrap
- direct peer transport as the actual private message path

That is a much better fit for issuance than repeatedly publishing critical state into a weak public relay mesh.

## Relevant FIPS source material

The local bootstrap repo is:

- [/home/tom/code/fips-nostr-bootstrap/README.md](/home/tom/code/fips-nostr-bootstrap/README.md)

Important supporting docs:

- [/home/tom/code/fips-nostr-bootstrap/docs/ARCHITECTURE.md](/home/tom/code/fips-nostr-bootstrap/docs/ARCHITECTURE.md)
- [/home/tom/code/fips-nostr-bootstrap/docs/PROTOCOLS.md](/home/tom/code/fips-nostr-bootstrap/docs/PROTOCOLS.md)
- [/home/tom/code/fips-nostr-bootstrap/packages/fips-nostr-rendezvous/README.md](/home/tom/code/fips-nostr-bootstrap/packages/fips-nostr-rendezvous/README.md)

The important reusable ideas are:

- NIP-17 DMs as a rendezvous/control plane
- STUN-assisted endpoint observation
- UDP hole punching for a direct path
- signed, versioned rendezvous messages:
  - `fips.rendezvous.hello`
  - `fips.rendezvous.server-info`
  - `fips.rendezvous.error`

## Hard constraint: browser feasibility

This needs to be stated plainly.

The current `@fips/nostr-rendezvous` implementation is not browser-native in the way this voting app is browser-native:

- it uses UDP sockets
- it relies on Node/native runtime capabilities
- browsers do not expose raw UDP hole punching primitives to ordinary web apps

So there are only three realistic integration shapes.

### 1. Native companion model

Run a local FIPS daemon alongside the browser app.

The browser app:

- keeps the UI
- keeps local key handling
- talks to `http://127.0.0.1:<port>` or a localhost WebSocket

The companion:

- runs FIPS bootstrap
- manages UDP punching / direct sessions
- delivers private issuance/control messages

This is the most practical path if the browser UI must remain the main product surface.

### 2. Wrapped desktop/mobile client

Move the voting client into:

- Tauri / Electron / native shell
- Flutter / mobile wrapper
- Rust-backed desktop/mobile runtime

This allows FIPS to become the default private control transport without a separate companion process.

### 3. Browser-only fallback

Keep the current Nostr/NIP-17 path in browsers that have no native companion.

This is necessary even if FIPS is integrated, because direct transport will sometimes fail or be unavailable.

## Recommended architecture

Use a dual transport model.

### Public state on Nostr

Keep these public:

- round announcements
- coordinator roster / share-index assignments
- ballots
- results

These are the auditable layer and should remain reconstructable from relays.

### Private control path over FIPS

Move these to the FIPS path when available:

- voter follow / join
- sub-coordinator join
- share assignment delivery
- blind-key delivery hints
- blinded request submission
- blinded response delivery
- acknowledgements and retries

This is the unreliable section today, and it is the best candidate for a direct path.

### Fallback rule

If direct FIPS session establishment fails:

- fall back to NIP-17 DM transport
- keep the exact same message schema at the application layer

That keeps the protocol consistent while changing only the transport.

## Transport boundary to introduce in this repo

Before integrating FIPS, the app needs a transport abstraction.

Add a new module boundary for private control traffic:

- `sendControlMessage(...)`
- `subscribeControlMessages(...)`
- `ackControlMessage(...)`

Backends:

- `nostr-dm` backend: current `simpleShardDm.ts`
- `fips-direct` backend: future direct/private transport

Do not let UI components call Nostr DM helpers directly once this abstraction exists.

That refactor is the prerequisite for a clean FIPS integration.

## Message mapping

The current DM message families already map well to a transport abstraction.

### Current messages

- `simple_coordinator_follow`
- `simple_subcoordinator_join`
- `simple_share_assignment`
- `simple_shard_request`
- `simple_shard_response`
- `simple_round_ticket`
- acknowledgement messages

### Proposed mapping

Keep the message bodies stable, but send them through:

- FIPS direct session if available
- otherwise NIP-17

That minimises protocol churn.

## Concrete phased plan

### Phase 1: isolate private transport

Goal:

- remove direct UI dependency on `simpleShardDm.ts`

Work:

- create `simpleControlTransport.ts`
- define transport-neutral request/response types
- implement `nostr-dm` adapter first
- route voter/coordinator flows through this interface

Definition of done:

- the app works exactly as before, but all private control traffic goes through the transport interface

### Phase 2: add a FIPS companion API contract

Goal:

- define how the browser UI talks to a local/native FIPS runtime

Work:

- define localhost API or local WebSocket contract
- operations:
  - `start`
  - `advertise`
  - `connectToPeer`
  - `sendPrivateControlMessage`
  - `subscribePrivateControlMessages`
  - `ack`
  - `status`
- include peer/session state:
  - connecting
  - direct
  - fallback
  - failed

Definition of done:

- stable interface documented before implementation

### Phase 3: integrate bootstrap-only FIPS path

Goal:

- use FIPS/Nostr rendezvous for connection establishment, but still allow fallback

Work:

- reuse the local repo’s rendezvous message model
- map coordinator identity to target peer identity
- use `fips.rendezvous.hello` and `server-info`
- establish direct session where possible
- keep NIP-17 fallback active

Definition of done:

- a voter can attempt direct connection to a coordinator from the app
- failures degrade to the existing DM path without breaking the round

### Phase 4: move blinded issuance onto the direct path

Goal:

- make the most fragile part of the flow no longer depend on relay convergence

Work:

- blinded request goes over direct session
- blinded response goes over direct session
- ticket receipt acknowledgement goes over direct session
- retain optional mirrored ack on Nostr only for observability if needed

Definition of done:

- ticket issuance works even when public relay propagation is poor

### Phase 5: coordinator-to-coordinator direct path

Goal:

- reduce lead/sub-coordinator dependence on public relays

Work:

- sub-coordinator join over direct path
- share assignment over direct path
- optional round-key distribution/control over direct path

Definition of done:

- multi-coordinator readiness does not depend on public relay convergence alone

### Phase 6: native-first clients

Goal:

- make the direct path the preferred mode, not just an enhancement

Work:

- ship desktop/mobile wrapper or companion
- add UI for direct session status
- prefer direct transport automatically when healthy

Definition of done:

- the app can run whole issuance rounds primarily over direct sessions, with Nostr as audit/public layer and fallback transport

## What to reuse from the local FIPS repo

Reuse directly or conceptually:

### Wire contract

From:

- [/home/tom/code/fips-nostr-bootstrap/docs/PROTOCOLS.md](/home/tom/code/fips-nostr-bootstrap/docs/PROTOCOLS.md)

Reuse:

- versioned message types
- `sessionId`
- `nonce`
- `issuedAt`
- structured failure messages

### Architecture split

From:

- [/home/tom/code/fips-nostr-bootstrap/docs/ARCHITECTURE.md](/home/tom/code/fips-nostr-bootstrap/docs/ARCHITECTURE.md)

Reuse:

- control plane vs data plane distinction
- direct transport as data plane
- Nostr as rendezvous plane

### JS package shape

From:

- [/home/tom/code/fips-nostr-bootstrap/packages/fips-nostr-rendezvous/README.md](/home/tom/code/fips-nostr-bootstrap/packages/fips-nostr-rendezvous/README.md)

Reuse:

- node/session lifecycle
- trusted peer allowlist
- advert/discovery model
- session object abstraction

## Security notes

FIPS does not remove all privacy concerns.

It improves:

- dependence on public relays for private issuance traffic
- metadata exposure to the wider relay graph
- dropped-message behaviour when direct sessions are healthy

It does not automatically solve:

- browser key custody
- coordinator compromise
- participation privacy
- ballot timing leakage
- double-spend rules

The privacy model still needs to say clearly:

- what coordinators learn
- what relays learn
- what auditors can verify

## Ack/retry rules with or without FIPS

These should exist regardless of transport.

Recommended rules:

### Follow / join

- resend up to `3` times
- backoff: `2s`, `5s`, `10s`
- stop resending once acked

### Blinded request

- resend up to `5` times while round is open
- require explicit coordinator ack
- if direct session exists, prefer direct resend only

### Blinded response / ticket

- coordinator keeps a pending-delivery queue
- resend until voter receipt ack or round close
- on reconnect, replay latest unresolved response

### Observability

- show:
  - queued
  - sent
  - acked
  - retrying
  - failed
- separate transport status from application status

## What I would do next

1. Introduce the private-control transport interface in this repo.
2. Keep Nostr as the first adapter.
3. Build a localhost/native FIPS companion proof of concept.
4. Use it first for voter-to-coordinator blinded issuance only.
5. Measure whether ticket delivery becomes materially more reliable before moving more protocol traffic onto it.

## Bottom line

FIPS looks like the right long-term answer for the issuance/control path.

But the correct integration is:

- **not** "replace Nostr everywhere"
- **not** "drop it straight into the browser app"

It is:

- Nostr for public audit state
- FIPS for private control traffic where a direct path is possible
- NIP-17 fallback when direct transport is unavailable
- a companion or wrapped client for browser-facing deployments
