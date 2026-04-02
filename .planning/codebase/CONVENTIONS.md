# Conventions

## Code Style
- TypeScript code in `web/src/` is written in strict mode and organized one major component per file.
- Browser-side protocol code is split by concern: coordinator API, mint API, ballot publishing, proof submission, signer handling, and wallet persistence.
- Python code follows pytest conventions for tests and a single-coordinator daemon style for runtime code.

## Naming And Shapes
- Event kinds and tags are handled explicitly, with helpers for proof hashes, Merkle leaves, and Nostr event verification URLs.
- Public APIs use descriptive object shapes such as `ElectionInfo`, `TallyInfo`, `CoordinatorProof`, and `MintQuoteResponse`.
- Eligibility is represented as npub lists and committed roots, not ad hoc booleans.

## Repo Practices
- The repo intentionally separates mock/local development from live deployment.
- Runtime URLs are always environment-driven in the frontend and deploy-time configurable in Ansible.
- The coordinator and frontend both support multi-coordinator election flow, but the implementation is still incremental.
- Tests are expected to carry a pytest marker from the repo marker set.

## Human Workflow
- Changes should be verified with the lightest relevant test tier first.
- Deployment and live-state changes are treated as first-class and have dedicated fixtures and playbooks.
- Because the system spans browser, relay, mint, and VPS, config drift matters more than in a single-process app.

