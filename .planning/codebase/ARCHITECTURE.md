# Architecture

## System Shape
- This is a three-tier voting system:
- Browser clients handle voter discovery, issuance, ballot submission, and dashboard rendering.
- A Python coordinator mediates eligibility, mint approvals, tallying, and Nostr publication.
- A Cashu mint issues blinded proofs after coordinator approval.

## Browser Runtime
- The voter portal lives in `web/src/App.tsx` and handles discovery, eligibility checks, issuance requests, and wallet storage.
- The voting page in `web/src/VotingApp.tsx` publishes ballots, submits proof DMs, and checks acceptance and tally status.
- The dashboard in `web/src/DashboardApp.tsx` surfaces eligibility, issuance state, tally state, and audit results.

## Coordinator Runtime
- `coordinator/voting-coordinator-client.py` is a single long-running process that:
- connects to relays,
- recovers state from historical events,
- subscribes to live Nostr events and DMs,
- exposes an aiohttp HTTP API,
- and bridges quote approval into the mint via gRPC.
- The coordinator keeps local trees for spent commitments, issuance commitments, vote commitments, and eligibility roots.

## Data Flow
- Voter eligibility starts from `eligible-voters.json` and becomes a committed eligible root.
- An election announcement publishes the election metadata and coordinator participation on Nostr.
- Voters publish a claim, get a quote approved, mint proofs, publish a ballot event, then send a NIP-04 proof DM.
- The coordinator tallies accepted votes, stores commitment roots, and publishes result events.
- In multi-coordinator mode, the portal discovers all participating coordinators and tracks proofs per coordinator.

## Repository Organization
- `src/` contains the root TypeScript CLI/server and Merkle helpers.
- `web/` contains the browser apps and client-side protocol helpers.
- `coordinator/` contains the Python runtime and gRPC proto stubs.
- `tests/` contains unit, integration, E2E, UI, and VPS-backed verification.
- `ansible/` contains deployment automation and templates.
- `docs/` contains the canonical design and protocol references.

