# Auditable Voting Demo

This repo is a local demo of a Cashu-authenticated, Nostr-published, Merkle-auditable voting system.

Right now the project focuses on the first two phases of the demo:

- transparent eligibility setup
- Nostr challenge-response eligibility verification

The implementation is intentionally simple and in-memory so the core flow is easy to demo and extend.

## Overview

The project explores a voting model where eligibility, vote publication, and final auditability are separated:

- eligibility is based on a public set of approved Nostr public keys
- a voter proves control of an eligible key without exposing their private key to the mint
- blind issuance is intended to create a credential the mint cannot later link to a specific vote
- votes are intended to be published publicly through Nostr
- proof spending happens privately with the mint
- final tallying is intended to be auditable through a Merkle root and inclusion proofs

The main goal is to demonstrate the cryptographic separation between:

- who is allowed to participate
- who actually participates
- which vote gets counted

## Key Ideas

- `1 proof = 1 vote`
- eligibility is transparent, so the allowed voter set is public
- vote privacy comes from blind issuance and ephemeral vote identities
- proofs are submitted privately and burned to prevent double voting
- accepted votes are committed into a Merkle tree so anyone can verify inclusion
- optional multi-mint quorum can reduce trust in any single mint

## What Is Implemented

- A Node/TypeScript mint service with in-memory eligibility state in `src/mint.ts`
- A voter-facing React + TypeScript page for:
  - entering an existing `npub`
  - generating a fresh `npub` + `nsec` locally
  - registering the `npub` with the mint
  - requesting a challenge from the mint
  - signing the challenge locally with `nsec`
  - verifying eligibility without sending `nsec` to the backend
- A separate backend dashboard page that shows:
  - all registered `npub`s
  - which `npub`s completed challenge verification
  - eligible and verified counts
- Console logging in the mint for:
  - registered `npub`s
  - `eligible_count`
  - challenge issuance
  - successful eligibility verification
- Multi-page Vite setup for separate voter and dashboard pages

## Current Demo Flow

1. Start the mint locally
2. Open the voter portal
3. Paste an existing `npub` or generate a fresh `npub` + `nsec`
4. Register the `npub` with the mint
5. Request a challenge
6. Sign the challenge locally with the matching `nsec`
7. Mint verifies the signed event and marks that `npub` as ready for blind issuance
8. Open the dashboard to see the public eligibility registry and verification status

## Project Structure

```text
docs/                  design docs and demo plan
src/                   mint + CLI TypeScript code
web/                   React + Vite frontend
web/src/App.tsx        voter-facing portal
web/src/DashboardApp.tsx backend dashboard
web/src/mintApi.ts     shared frontend API client
web/src/nostrIdentity.ts shared Nostr key/signing helpers
```

## Local Development

### 1. Install dependencies

Root project:

```bash
npm install
```

Web app:

```bash
cd web
npm install
```

### 2. Build the backend CLI/mint

```bash
npm run build
```

### 3. Start the mint

```bash
npm run mint
```

This starts the mint on `http://localhost:8787`.

### 4. Start the web app

In `web/`:

```bash
npm run dev
```

By default Vite serves on `http://localhost:5173`.

## Web Pages

- Voter portal: `http://localhost:5173/`
- Backend dashboard: `http://localhost:5173/dashboard.html`

## Mint Endpoints

- `GET /api/eligibility`
  - returns registered and verified `npub` state
- `POST /api/eligibility/register`
  - registers an eligible `npub`
- `POST /challenge`
  - issues a random challenge for an eligible `npub`
- `POST /verify-eligibility`
  - verifies a signed Nostr event tagged with the issued challenge

## Notes And Constraints

- State is currently in-memory only
- The mint does not persist registered or verified users across restarts
- `nsec` is generated and used only in the browser; it is never sent to the mint
- This is still a demo system, not a production-ready voting implementation

## Roadmap

### Done

- Phase 1: self-service eligibility registration
- Phase 1: separate backend dashboard for public eligibility visibility
- Phase 2: challenge-response verification using Nostr signing

### Next

- Phase 3: minimal blind issuance flow
  - client generates random secret
  - client sends `SHA256(secret)` commitment
  - mint signs the commitment
  - wallet stores `{secret, signature}` proof
- Phase 4: vote publication
  - local logging or Nostr relay publishing
  - ephemeral vote key support
- Phase 5: private proof submission
  - submit `{event_id, secret, signature}` to mint
  - track spent proofs
  - accept valid votes
- Phase 6: Merkle tally
  - build Merkle tree over accepted votes
  - publish Merkle root
  - verify inclusion proofs

### Later / Optional

- 3-mint quorum model
- persistent storage
- auth or access control for the dashboard
- nicer operator tooling and election lifecycle management
- public verification UI for inclusion proof checks

## Related Docs

- `docs/demo-development-plan.md`
- `docs/reference-architecture.md`
- `docs/cashu-nostr-voting-design.md`
- `docs/self-service-issuance-3-mint-model.md`
