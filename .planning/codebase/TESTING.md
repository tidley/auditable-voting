# Testing

## Pytest Markers
- `fast` covers local unit tests with no network dependence.
- `integration` covers remote API checks without destructive VPS operations.
- `e2e` covers VPS-backed end-to-end flows.
- `ui` covers Playwright browser tests.
- `vps` covers VPS mint and coordinator tests.
- `voter` covers public mint availability and voter flow checks.

## Main Commands
- Full suite: `.venv/bin/python -m pytest tests/ -v`.
- Fast only: `.venv/bin/python -m pytest tests/ -v -m fast`.
- Fast plus integration: `.venv/bin/python -m pytest tests/ -v -m \"fast or integration\"`.
- Frontend tests: `cd web && npx vitest run`.

## Test Layers
- Unit tests validate signer logic, Merkle trees, eligibility roots, and protocol event shapes.
- Integration tests validate coordinator and mint API connectivity, election state, and build readiness.
- E2E tests exercise real issuance, proof submission, vote publication, and tally flows against the VPS.
- UI tests use Playwright to check the live portal, voting page, and dashboard text and behavior.

## Fixtures And Environment
- `tests/conftest.py` loads the coordinator module and provides shared helpers.
- `tests/conftest_e2e.py` contains relay publishing, SSH, and proof/quote helpers.
- `tests/conftest_vps.py` and `tests/conftest_voter.py` define VPS and voter constants.
- Many tests depend on fixed URLs, SSH access, and live coordinator state.

## Operational Notes
- The pre-commit hook runs pytest automatically before commits unless bypassed by environment variables.
- VPS-backed tests can mutate eligibility state and should be treated as stateful.
- Browser tests assume the live frontend and coordinator are reachable and may require stable relays.

