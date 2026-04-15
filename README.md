# Auditable Voting

Client-only Nostr voting with browser-based voter, coordinator, and auditor flows.

## Current state

This repo now contains only the static web app in `web/`.

The shipped app currently includes:

- voter, coordinator, and auditor screens
- tabbed role flows, including a staged coordinator questionnaire builder with `Build`, `Audience`, `Publish`, `Responses`, and `Results`
- a new Rust/Wasm-backed coordinator control seam for round-open agreement and replay
- a real OpenMLS-backed coordinator group engine implemented inside the Rust core and compiled into the coordinator Wasm artefact
- a new Rust/Wasm public and ballot replay seam now used by the voter, coordinator, and auditor public-state views
- versioned Rust protocol snapshots with explicit compatibility checks
- Rust-exposed replay status and structured diagnostics for the shared public-state engine
- coordinator runtime readiness diagnostics for MLS join, welcome acknowledgement, initial control backfill, auto-approval, round-open safety, blind-key safety, and ticket-plane safety
- startup control-carrier diagnostics for exact publish payloads, live/backfill filter shapes, relay write/read overlap, and `kind_only` vs filtered probe counts
- single-coordinator runtime bypass now uses deterministic coordinator-control readiness, skipping MLS join/startup observation loops in `1 coordinator` mode
- blind-key stall diagnostics now classify `not_attempted` vs publish/observe/apply failure shapes with relay-target and event-id evidence
- private-first questionnaire flow is wired in Coordinator/Voter UIs, and blind-token response foundations are added (`questionnaire_response_blind`, transport helpers, and relay-harness metrics)
- regular custom Nostr event kinds for coordinator control, live rounds, and ballots, avoiding replaceable-kind transcript loss
- round announcements over Nostr
- coordinator control carrier events over Nostr, replayed through a Rust state machine
- NIP-17 DM traffic for follow, roster, MLS welcome, and share-assignment flows
- encrypted mailbox-object traffic for blind requests, ticket delivery, and ticket acknowledgements
- course-feedback deployment mode (`1 coordinator / 25 voters / 1 round`) now treats ticket acknowledgements as best-effort diagnostics, with valid ballot acceptance as the authoritative completion signal
- per-round blind-signature key announcements
- blind-signature share issuance and public ballot verification
- coordinator-side per-ticket relay publish diagnostics for issued shares
- explicit ticket recovery diagnostics for publish-started vs publish-succeeded, live vs backfill observation, resend eligibility, resend blocked reasons, and relay-target outcomes
- first-send queue prioritisation over resend work for ticket scheduling, with runtime-tunable send concurrency and retry-age thresholds for relay reliability experiments
- separate observation-recovery timing for published-but-unobserved tickets, with live/backfill/resend recovery counters promoted in harness summaries
- request-id keyed mailbox reads with frozen per-request mailbox bindings for ticket live/backfill recovery, plus explicit read/backfill mailbox consistency diagnostics
- periodic history backfill for missed live rounds and ticket delivery
- smaller primary relay subsets for live reads and subscriptions, with ordinary DM traffic kept tight while coordinator-control and ticket/ack traffic use a slightly wider primary subset for recovery and first-round reliability
- randomised automatic follow/request/ticket/ack send pacing, plus slower retry windows, to reduce relay-side rate limiting when many browser actors act at once
- lead coordinator roster DMs now include active questionnaire ids (`open`/`published`) so accepted followers can auto-discover questionnaires without manual restore
- voter vote-tab gating now verifies announced questionnaire ids against public definition+state (`open`/`published`) before enabling Vote, reducing manual restore races
- questionnaire responses now use a stable per-questionnaire responder identity per voter profile, with one accepted submission per questionnaire in the voter flow
- local browser persistence, backup, and optional passphrase protection
- voter questionnaire participation history is now stored locally and included in voter backups/restores
- auditor round selection now supports lead-coordinator filter, coordinator-npub filter, and free-text search (npub/round ID/prompt), with slower non-overlapping refreshes to reduce relay REQ spikes
- optional relay hint resolution via NIP-65, disabled by default
- a growing Rust/Wasm core for deterministic protocol logic

The client-only architecture is in place, and the browser coordinator control path now runs through the OpenMLS-backed Rust/Wasm engine for the repaired small live cases. The first multi-coordinator round now waits for sub-coordinator MLS welcome acknowledgement only after the non-lead has completed an initial coordinator-control backfill pass, and the live harness now waits for the lead to be visibly ready before firing round 1. The private issuance path has now been redesigned around encrypted mailbox envelopes with stable `request_id`, `ticket_id`, and `ack_id` lineages instead of pairwise DM ticket chatter. In `v0.74`, the app also exposes coordinator runtime readiness phases in the browser and the live harness now emits protocol-layer failure classes (`startup`, `dm_pipeline`, `mixed`) with coordinator readiness summaries and voter round-visibility snapshots, so scale failures can be separated into startup and downstream mailbox-plane cases without relying only on screenshots. Startup control-plane recovery now also records exact publish/filter evidence, runs `kind_only`/broader diagnostic probes when precise startup backfill is empty, and performs one bounded forced startup backfill replay while MLS join is pending. Automatic sends are now spread by a random `0-30s` client-side delay, mailbox ticket publishes from one coordinator are serialised through a sender-scoped queue, and retry windows are longer so many test actors do not hammer the same public relays at once.
Empirically, recent local-preview runs are solid at `1 coordinator / 2 voters / 2 rounds`, but a fresh `1 coordinator / 20 voters / 1 round` run exposed relay rate limiting in the private ticket/ack path before the pacing change. Repeated `2 coordinators / 2 voters / 2 rounds` runs improved after the request-id fix, but are still not signed off as boringly reliable. Larger multi-coordinator runs are still not signed off: `5 coordinators / 10 voters / 3 rounds` can still fail either at first-round startup visibility or later under ticket-delivery / acknowledgement pressure. `5 coordinators / 10 voters / 10 rounds` remains non-viable on the current public relay set.

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
npm run test:relay-load
npm run test:rust
npm run verify:simple-blind-shares
npx tsc --noEmit
npm run build
```

`npm run test:relay-load` runs a Node-only `1 coordinator / 40 voters / 1 round` mailbox relay-load scenario with an in-memory relay pool. It exercises the request, ticket, and acknowledgement path without Playwright or headless Chromium, and checks that ticket publishes keep the anchor relays while rotating secondary relays.

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
6. A voter adds coordinators in `Configure`, the client follows them over DMs, and then sends blinded issuance requests through encrypted mailbox envelopes.
7. Each coordinator returns its own blind-signature share directly to the voter through mailbox ticket envelopes; retries keep the same logical `ticket_id`, and acknowledgements are also mailbox objects so backfill and replay can reconcile the same lineage.
8. In course-feedback mode, acknowledgement visibility is diagnostic only; a valid accepted ballot also confirms ticket delivery completion.
9. The voter unblinds enough shares locally and submits a ballot from an ephemeral key, carrying stable `request_id` and `ticket_id` lineage in the ballot payload.
10. Coordinators and auditors validate ballots and recompute the tally from public data.

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
- accepted-ballot lineage (`request_id` / `ticket_id`) exposed from Rust replay for coordinator mapping and harness diagnostics
- shared round summaries and rejection reasons for voter, coordinator, and auditor views
- versioned snapshot export/import with compatibility metadata
- replay status and structured diagnostics exposed from Rust rather than inferred in the UI

Private or local state:

- actor secret keys
- blind request secrets
- coordinator-control snapshots and replay checkpoints
- issuance mailbox objects
- ticket mailbox acknowledgements
- browser-local cache and backup bundles

## Relay model

The app currently uses:

- public relays for round and ballot events
- a public Nostr carrier for coordinator-control events, replayed locally in Rust/Wasm
- DM relays for NIP-17 gift-wrapped follow/control support traffic
- mailbox-plane relays for encrypted blind-request, ticket, and acknowledgement objects
- optional NIP-65 inbox/outbox hints for relay discovery when enabled in `Settings`

The default path currently prefers a tighter curated relay set. Publishes can still fan out more broadly, but live reads and subscriptions are intentionally kept to a smaller primary subset to reduce relay-side `too many concurrent REQs` pressure. Coordinator-control traffic and mailbox-plane ticket/ack recovery use a slightly wider primary subset than ordinary DM reads so the first control wave and receipt recovery are less dependent on only two relays. The curated defaults include the Bits By Tom general relay, the Tom Dwyer NIP-17 relay, and additional public relays such as `offchain.pub`, `nostr.mom`, `relay.snort.social`, and `nostr-pub.wellorder.net`; the mailbox plane avoids relays that currently require proof-of-work or web-of-trust admission for these custom events. Request ids are now kept stable across the mailbox request, ticket, and acknowledgement path so recovery and replay can treat retries as the same logical request. Automatic voter and coordinator sends use random `0-30s` human-style pacing, ticket publishes from one coordinator share a sender-scoped mailbox queue, mailbox delivery includes one deterministic anchor relay plus rotated secondary relays, and relays returning rate-limit/pow/spam/policy failures are temporarily cooled down before reuse. Retries also wait longer before resending to reduce relay `you are noting too much` limits. NIP-65 is available as an option, but it is not the default transport path.

The live harness now also emits a protocol-facing failure classification alongside the raw timeout class. Failed runs are tagged as `startup`, `dm_pipeline`, or `mixed`, with the first missing stage and the current coordinator/voter readiness snapshots included in the debug dump.

## Known limitations

- live public relay convergence is still the main operational weakness
- the `2 coordinators / 2 voters / 2 rounds` gate is improved, but it still is not signed off as repeatedly reliable yet
- larger single-coordinator bursts can still hit public-relay rate limits, so scale checks should allow enough wall-clock time for the randomised send pacing and slower retries
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
- [Questionnaire blind-token protocol](./docs/questionnaire-blind-token-protocol.md)
- [Questionnaire protocol decisions](./docs/questionnaire-protocol-decisions.md)
- [Marmot migration plan](./docs/marmot-migration-plan.md)
- [Portable presentation](./presentation/project-overview.html)
