# Auditable Voting Demo

Local demo of a Nostr + Cashu-style voting flow.

The current project covers:

- local allowlist-based voter eligibility
- mock not-voted checks
- mock mint invoice -> proof issuance
- Nostr claim publishing for proof issuance
- ballot publishing with a proof hash
- operator dashboard for allowed and verified voters

## Overview

The system separates a few concerns:

- voter eligibility is based on an allowed list of `npub`s
- proof issuance is coordinated through a Mint API flow
- claim and ballot events are published through Nostr relays
- the final ballot carries a hash of the voter proof instead of the raw proof

Right now everything is simplified for local development:

- the allowed voter list is hardcoded in `src/voterConfig.ts`
- the already-voted check is mocked and always returns `false`
- the mint is mocked inside the same local server
- proof issuance is time-based, not real blinded ecash yet

## What Is Implemented

- A Node/TypeScript voter server in `src/voterServer.ts`
- Local allowed voter config in `src/voterConfig.ts`
- A voter portal in `web/src/App.tsx` for:
  - entering or generating an `npub`/`nsec`
  - checking whether the `npub` is on the allowlist
  - checking whether the voter has already voted via a mock API
  - requesting a mint invoice
  - signing and publishing an invoice claim to Nostr relays
  - polling for a proof
- A local single-proof wallet in `web/src/cashuWallet.ts`
- A voting page in `web/src/VotingApp.tsx` for:
  - loading election metadata from the stored invoice
  - answering 2 single-choice ballot questions
  - publishing a ballot event with a proof hash
- A dashboard in `web/src/DashboardApp.tsx` showing allowed and verified voters
- Server-side debug logs for:
  - invoice details
  - claim event details
  - publish results
  - proof details

## Current Flow

1. Start the local server
2. Open the voter portal
3. Enter an `npub` from the allowlist in `src/voterConfig.ts`
4. The server checks:
   - the `npub` is allowed
   - the `npub` has not voted yet (mocked to `false`)
5. If the check passes, request an invoice from the mock Mint API
6. The invoice response provides:
   - voter `npub`
   - coordinator `npub`
   - election ID
   - ballot questions
   - relay list
7. Sign the invoice claim locally with `nsec`
8. Publish that claim to Nostr relays
9. Poll until the proof is ready
10. Open the voting page and publish a ballot event with the proof hash

## Project Structure

```text
docs/                       design docs and planning notes
src/                        server and CLI TypeScript code
src/voterServer.ts          local voter server and mock mint
src/voterConfig.ts          hardcoded allowed npubs
web/                        React + Vite frontend
web/src/App.tsx             voter portal
web/src/VotingApp.tsx       voting page
web/src/DashboardApp.tsx    operator dashboard
web/src/cashuMintApi.ts     mock mint API client
web/src/cashuWallet.ts      single-proof local wallet storage
web/src/ballot.ts           ballot event publishing and proof hashing
web/src/nostrIdentity.ts    Nostr key and claim helpers
web/src/voterManagementApi.ts allowlist and vote-status API client
```

## Local Development

Install dependencies:

```bash
npm install
npm --prefix web install
```

Build:

```bash
npm run build
npm --prefix web run build
```

Start the local server:

```bash
npm run server
```

Start the frontend dev server:

```bash
npm --prefix web run dev
```

## Pages

- Voter portal: `http://localhost:5173/`
- Dashboard: `http://localhost:5173/dashboard.html`
- Voting page: `http://localhost:5173/vote.html`

## Current API Endpoints

- `GET /api/eligibility`
  - returns the local allowlist plus verified voters
- `GET /api/eligibility/check?npub=...`
  - checks whether the `npub` is in the allowlist and can proceed
- `GET /api/vote-status?npub=...`
  - mock vote-status API, currently always returns `hasVoted: false`
- `POST /api/debug/claim-log`
  - internal debug endpoint used by the frontend to mirror claim details into the server console
- `GET /mock-mint/invoice`
  - returns a mock invoice plus voter `npub`, coordinator `npub`, election ID, and ballot questions
- `GET /mock-mint/proof/:quoteId`
  - returns `pending` until proof issuance is ready, then returns the proof and marks the voter as verified

## Allowed Npubs

The current local allowlist lives in `src/voterConfig.ts`:

- `npub1ukdwfffcayn5pyt8duv5fyfkwyjrykgr2efql5vmj5y9df4c82lsgkypvg`
- `npub1kl7g5wf90gezwukh44jqtgh7dmdkv6nd20s7u88djqvv433x7ufsjrq6th`
- `npub1et7edyz9vcpdzljns4da5t7l7qgspe3dr6flx09x6jsy2sut5xfqyfnd3u`

## Notes

- State is in-memory only
- The mock already-voted API always returns `false`
- The local wallet stores one proof per voter session
- `nsec` stays in the browser and is never sent to the server or mint API
- The mock mint is not real blinded Cashu issuance yet

## Roadmap

- replace mock invoice/proof endpoints with the real teammate mint API
- replace the mock already-voted API with a real spent-proof / participation check
- move election config and ballot questions fully behind the mint/coordinator service
- implement real Cashu blind issuance
- submit proofs privately for vote counting
- build Merkle commitments and public verification tools

## Related Docs

- `docs/demo-development-plan.md`
- `docs/reference-architecture.md`
- `docs/cashu-nostr-voting-design.md`
- `docs/self-service-issuance-3-mint-model.md`
