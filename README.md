# Auditable Voting

Client-only Nostr voting with browser-based voter, coordinator, and auditor flows.

## Current state

This repo now contains only the static web app in `web/`.

The shipped app currently includes:

- voter, coordinator, and auditor screens
- tabbed voter and coordinator flows with `Configure`, `Vote`/`Voting`, and `Settings`
- round announcements over Nostr
- NIP-17 DM traffic for follow, blind request, ticket, and acknowledgement flows
- per-round blind-signature key announcements
- blind-signature share issuance and public ballot verification
- local browser persistence, backup, and optional passphrase protection
- optional relay hint resolution via NIP-65, disabled by default
- a growing Rust/Wasm core for deterministic protocol logic

The client-only architecture is in place, but live relay reliability and recovery behaviour still need hardening.

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

## Protocol shape

At a high level:

1. A coordinator publishes a live round.
2. Coordinators publish per-round blind-signing keys, and the lead auto-sends share indexes to sub-coordinators.
3. A voter adds coordinators in `Configure`, the client follows them over DMs, and then sends blinded issuance requests.
4. Coordinators return blind-signature shares over DMs.
5. The voter unblinds enough shares locally and submits a ballot from an ephemeral key.
6. Coordinators and auditors validate ballots and recompute the tally from public data.

Public state:

- round announcements
- blind-key announcements
- ballots
- results / tally inputs

Private or local state:

- actor secret keys
- blind request secrets
- issuance DM traffic
- ticket acknowledgements
- browser-local cache and backup bundles

## Relay model

The app currently uses:

- public relays for round and ballot events
- DM relays for NIP-17 gift-wrapped messages
- optional NIP-65 inbox/outbox hints for relay discovery when enabled in `Settings`

The default path currently prefers a tighter curated relay set. NIP-65 is available as an option, but it is not the default transport path.

## Known limitations

- live public relay convergence is still the main operational weakness
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
- [Portable presentation](./presentation/project-overview.html)
