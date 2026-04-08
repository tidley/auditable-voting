# Auditable Voting

Client-only Nostr voting with browser-based voter, coordinator, and auditor flows.

## Current state

This repo now contains only the static web app in `web/`.

The shipped app currently includes:

- voter, coordinator, and auditor screens
- tabbed voter and coordinator flows with `Configure`, `Vote`/`Voting`, and `Settings`
- a new Rust/Wasm-backed coordinator control seam for round-open agreement and replay
- a real OpenMLS-backed coordinator group engine implemented inside the Rust core and compiled into the coordinator Wasm artefact
- a new Rust/Wasm public and ballot replay seam now used by the voter, coordinator, and auditor public-state views
- versioned Rust protocol snapshots with explicit compatibility checks
- Rust-exposed replay status and structured diagnostics for the shared public-state engine
- regular custom Nostr event kinds for coordinator control, live rounds, and ballots, avoiding replaceable-kind transcript loss
- round announcements over Nostr
- coordinator control carrier events over Nostr, replayed through a Rust state machine
- NIP-17 DM traffic for follow, blind request, direct ticket, and acknowledgement flows
- per-round blind-signature key announcements
- blind-signature share issuance and public ballot verification
- coordinator-side per-ticket relay publish diagnostics for issued shares
- periodic history backfill for missed live rounds and ticket delivery
- smaller primary relay subsets for live reads and subscriptions, with ordinary DM traffic kept tight while coordinator-control and ticket/ack traffic use a slightly wider primary subset for recovery and first-round reliability
- local browser persistence, backup, and optional passphrase protection
- optional relay hint resolution via NIP-65, disabled by default
- a growing Rust/Wasm core for deterministic protocol logic

The client-only architecture is in place, and the browser coordinator control path now runs through the OpenMLS-backed Rust/Wasm engine for the repaired small live cases. The first multi-coordinator round now waits for sub-coordinator MLS welcome acknowledgement only after the non-lead has completed an initial coordinator-control backfill pass, and the live harness now waits for the lead to be visibly ready before firing round 1. That removed the earlier blind round-1 startup miss, but it did not finish the job: `2 / 2 / 2` still is not stable enough to sign off because later-round ticket/ack behaviour can still degrade, and `5 / 10 / 3` is still not signed off.
Empirically, recent local-preview runs are solid at `1 coordinator / 2 voters / 2 rounds`, and the single-coordinator path has also been strong at `1 coordinator / 20 voters / 3 rounds`. On the current `v0.72` build, a fresh `2 coordinators / 2 voters / 2 rounds` rerun now completed round 1 cleanly but still degraded in round 2 to `1 of 2` tickets per voter. The latest trustworthy `5 coordinators / 10 voters / 3 rounds` run now gets materially through round 1 instead of stalling at zero, but still times out later under mixed ticket-delivery and acknowledgement pressure. `5 coordinators / 10 voters / 10 rounds` remains non-viable on the current public relay set.

## What is in this repo

- `web/` — the shipped React + Vite app
- `docs/project-explainer.md` — the main written explainer
- `presentation/project-overview.html` — the portable presentation deck
- `.github/workflows/static.yml` — GitHub Pages deployment

Older backend, Cashu, deployment, and coordinator-server code has been removed.

## Main routes

- `/` — voter shell
- `/vote.html` — voter shell
- `/dashboard.html` — coordinator shell
- `/simple.html` — shared role-switching shell
- `/simple-coordinator.html` — coordinator-first shell
- `/project-explainer.html` — published explainer page

## Local development

Install dependencies:

```bash
npm --prefix web install
```

The app uses a Rust/Wasm core. First-time local setup also needs:

```bash
rustup target add wasm32-unknown-unknown
```

This repo now builds two Rust/Wasm packages:

- `web/rust-core` for existing deterministic helpers already used by the app
- `auditable-voting-core` for the new coordinator-control engine and replay logic

Run the app:

```bash
npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Open:

- `http://127.0.0.1:5173/`
- `http://127.0.0.1:5173/vote.html`
- `http://127.0.0.1:5173/dashboard.html`
- `http://127.0.0.1:5173/simple.html`

## Build and verification

Production build:

```bash
npm --prefix web run build
```

Verification:

```bash
cd web
npm test
npm run test:rust
npm run verify:simple-blind-shares
npx tsc --noEmit
npm run build
```

Coordinator-control replay tests also run in the new root Rust crate:

```bash
cargo test --manifest-path auditable-voting-core/Cargo.toml
```

## Protocol shape

At a high level:

1. Coordinators exchange typed control messages for round draft / proposal / commit over a dedicated coordinator-control carrier on Nostr.
2. Those coordinator-control events are replayed deterministically inside the `auditable-voting-core` Rust/Wasm engine.
3. Once coordinator round-open agreement is reached, and the supervisory MLS group is acknowledged ready for the round after initial non-lead control-plane sync, the lead publishes the public live round.
4. Public round events and public ballot events can also be replayed through the Rust/Wasm core, which now drives the shared voter, coordinator, and auditor public-state views.
5. Coordinators publish per-round blind-signing keys, and the lead auto-sends share indexes to sub-coordinators.
6. A voter adds coordinators in `Configure`, the client follows them over DMs, and then sends blinded issuance requests.
7. Each coordinator returns its own blind-signature share directly to the voter; ticket delivery is retried automatically when acknowledgements are missing, and voters periodically backfill missed ticket DMs from relay history.
8. The voter unblinds enough shares locally and submits a ballot from an ephemeral key.
9. Coordinators and auditors validate ballots and recompute the tally from public data.

Public state:

- coordinator-control carrier events for round-open coordination
- round announcements
- blind-key announcements
- ballots
- results / tally inputs

Current Rust-derived public slice:

- public round lifecycle replay
- deterministic ballot acceptance with a fixed `first valid wins` rule
- derived public receipt hashes for accepted ballots
- shared round summaries and rejection reasons for voter, coordinator, and auditor views
- versioned snapshot export/import with compatibility metadata
- replay status and structured diagnostics exposed from Rust rather than inferred in the UI

Private or local state:

- actor secret keys
- blind request secrets
- coordinator-control snapshots and replay checkpoints
- issuance DM traffic
- ticket acknowledgements
- browser-local cache and backup bundles

## Relay model

The app currently uses:

- public relays for round and ballot events
- a public Nostr carrier for coordinator-control events, replayed locally in Rust/Wasm
- DM relays for NIP-17 gift-wrapped messages
- optional NIP-65 inbox/outbox hints for relay discovery when enabled in `Settings`

The default path currently prefers a tighter curated relay set. Publishes can still fan out more broadly, but live reads and subscriptions are intentionally kept to a smaller primary subset to reduce relay-side `too many concurrent REQs` pressure. Coordinator-control and ticket/ack DM traffic now use a slightly wider primary subset than ordinary DM reads so the first control wave and receipt recovery are less dependent on only two relays. NIP-65 is available as an option, but it is not the default transport path.

## Known limitations

- live public relay convergence is still the main operational weakness
- the `2 coordinators / 2 voters / 2 rounds` gate no longer misses round 1 by default in the live harness, but it still is not reliable enough to sign off because later-round ticket/ack behaviour can still degrade
- larger public-relay committee runs remain unreliable; `5 coordinators / 10 voters / 10 rounds` did not complete cleanly in the current live harness
- the latest `5 coordinators / 10 voters / 3 rounds` traces show a mixed ticket-delivery / acknowledgement bottleneck, with acknowledgement visibility currently the larger gap
- the protocol works much better in tests than on unhealthy public relay sets
- local secret material is still a browser-custody problem even with passphrase protection
- the cryptographic path is materially improved, but still deserves external review before strong production claims

## GitHub Pages

The app is deployed as a static site with GitHub Actions.

The workflow in `.github/workflows/static.yml`:

- installs `web/` dependencies
- builds the Vite app with a Pages-safe base path
- uploads `web/dist`
- deploys it to GitHub Pages

To test the same base path locally:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
```

## Related material

- [Project explainer](./docs/project-explainer.md)
- [Marmot migration plan](./docs/marmot-migration-plan.md)
- [Portable presentation](./presentation/project-overview.html)
