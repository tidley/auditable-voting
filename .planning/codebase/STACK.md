# Stack

## Languages
- TypeScript for the root CLI/server code in `src/` and the React frontend in `web/src/`.
- Python for the coordinator daemon, CLI helpers, and the pytest suite.
- Bash for repo scripts and deployment wrappers.

## Runtime Pieces
- Root Node.js project: builds the mock server/CLI from `src/` with `tsc`.
- Frontend Node.js project: builds the voter portal, voting page, and dashboard with Vite.
- Python coordinator: runs the live coordinator HTTP API, Nostr client, and gRPC mint bridge.
- Ansible: provisions VPS services, mints, Traefik, and client containers.

## Core Dependencies
- `nostr-tools` for Nostr event creation, signing, relays, and NIP-04 in TypeScript.
- `@cashu/cashu-ts` for blinded Cashu wallet operations in the frontend.
- `react` and `react-dom` for the browser UI.
- `vite`, `typescript`, and `vitest` for frontend build and test tooling.
- `grpcio`, `aiohttp`, `aiohttp-cors`, `requests`, `nostr-sdk`, and `cashu` for the coordinator and CLI helpers.
- `pytest`, `pytest-playwright`, `pytest-order`, `pytest-timeout`, `nostr-sdk`, and `cashu` for the Python test suite.

## Entry Points
- `src/cli.ts` provides the root CLI commands (`start-server`, `submit-vote`, and Merkle helpers).
- `web/index.html`, `web/vote.html`, and `web/dashboard.html` load the three browser apps.
- `coordinator/voting-coordinator-client.py` is the main coordinator runtime and HTTP API.
- `coordinator/voting-request-proof.py` is the voter-side proof request CLI.
- `coordinator/derive-coordinator-keys.py` derives bech32 Nostr keys from a mnemonic.

## Build And Run
- Root build: `npm run build`.
- Root mock server: `npm run server`.
- Frontend build: `cd web && npm run build`.
- Frontend dev server: `cd web && npm run dev`.
- Frontend tests: `cd web && npm run test`.
- Python tests: `.venv/bin/python -m pytest tests/ -v`.
- Deployment entry point: `ansible-playbook ansible/playbooks/deploy-and-prepare.yml`.

## Configuration
- `.env` controls frontend runtime URLs and mock mode.
- `eligible-voters.json` defines the eligible npub set.
- `ansible/inventory/group_vars/all.yml` and host vars define VPS and mint topology.
- Python coordinator and tests depend on environment-specific URLs and SSH/VPS access.

