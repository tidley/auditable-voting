# Structure

## Top Level
- `README.md` documents the project goals, deployment, and test commands.
- `AGENTS.md` defines repo-specific operating rules for coding sessions.
- `package.json` and `tsconfig.json` define the root TypeScript toolchain.
- `pyproject.toml` defines pytest markers and warning filters.

## Root TypeScript
- `src/cli.ts` is the command-line entry point.
- `src/nostrClient.ts` publishes simple vote events.
- `src/merkle.ts` implements canonical JSON hashing, Merkle trees, and eligibility roots.
- `src/voterServer.ts` provides the mock coordinator server used in local mode.
- `src/voterConfig.ts` loads client config and eligibility settings.

## Frontend
- `web/index.html` is the issuance portal.
- `web/vote.html` is the ballot submission page.
- `web/dashboard.html` is the operator dashboard.
- `web/src/App.tsx`, `VotingApp.tsx`, and `DashboardApp.tsx` are the major React entrypoints.
- `web/src/*.ts` files hold protocol clients, wallet state, signer abstractions, and event builders.
- `web/public/images/` stores branding and illustration assets.

## Coordinator
- `coordinator/voting-coordinator-client.py` is the main application and contains the HTTP handlers, event store, Merkle trees, and election join logic.
- `coordinator/voting-request-proof.py` is the voter-side proof CLI.
- `coordinator/derive-coordinator-keys.py` is the key derivation helper.
- `coordinator/proto/` contains the mint RPC proto and generated Python stubs.

## Tests
- `tests/test_signer.py` covers Nostr signer behavior.
- `tests/test_merkle_trees.py` and `tests/test_multi_coordinator.py` cover commitment logic and multi-coordinator rules.
- `tests/test_integration_readiness.py` checks build and live API readiness.
- `tests/test_ui_*.py` cover browser behavior with Playwright.
- `tests/test_coordinator_*.py` cover coordinator behavior, persistence, eligibility, issuance, tallying, and deployment.

