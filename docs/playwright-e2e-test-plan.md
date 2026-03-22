# Playwright E2E Test Plan

## Objective

Use `pytest-playwright` to test the full voter flow through the browser UI against the deployed site at `http://vote.mints.23.182.128.64.sslip.io`. This catches bugs that CLI E2E tests miss: CORS failures, WebSocket relay issues, React state machine bugs, localStorage serialization, and cross-page navigation.

## Setup

```bash
pip install pytest-playwright
playwright install chromium
```

## Test Files

| File | Tests | Scope |
|------|-------|-------|
| `tests/test_ui_dashboard.py` | 4 | Read-only dashboard verification |
| `tests/test_ui_issuance.py` | 1 (9-step flow) | Full quote/claim/proof issuance |
| `tests/test_ui_voting.py` | 3 (2 static + 1 full flow) | Ballot + proof submission + tally |

## Current Status: 8/8 PASSING

```
tests/test_ui_dashboard.py::TestUIDashboard::test_dashboard_shows_election_title     PASSED
tests/test_ui_dashboard.py::TestUIDashboard::test_dashboard_shows_eligible_count     PASSED
tests/test_ui_dashboard.py::TestUIDashboard::test_dashboard_shows_real_npubs         PASSED
tests/test_ui_dashboard.py::TestUIDashboard::test_dashboard_shows_tally              PASSED
tests/test_ui_issuance.py::TestUIIssuance::test_full_issuance_flow                  PASSED
tests/test_ui_voting.py::TestUIVotingStatic::test_vote_page_loads                   PASSED
tests/test_ui_voting.py::TestUIVotingStatic::test_vote_page_shows_no_proof_warning  PASSED
tests/test_ui_voting.py::TestUIVotingWithProof::test_full_voting_flow               PASSED
```

Total runtime: ~2 minutes.

## Prerequisites

- VPS coordinator + mint running
- Eligible voters synced via 38009 event (NOT just file sync — see Bug K below)
- CDK mint with `CDK_MINTD_USE_KEYSET_V2=false` (see Bug G below)
- Chromium installed via playwright

## Run Commands

```bash
# Full suite
pytest tests/test_ui_dashboard.py tests/test_ui_issuance.py tests/test_ui_voting.py \
  -v --timeout=600 --log-cli-level=INFO

# Individual files
pytest tests/test_ui_dashboard.py -v --timeout=120
pytest tests/test_ui_issuance.py -v --timeout=300
pytest tests/test_ui_voting.py -v --timeout=600

# Headed mode (requires X server / display)
pytest tests/test_ui_issuance.py -v --timeout=300 --headed --slowmo=500
```

## Test Architecture

### Fixture Hierarchy

```
browser (session, pytest-playwright)
  └── voter_portal (function) ─ new browser context, goes to BASE_URL
  └── voting_page (function) ─ new browser context, goes to BASE_URL/vote.html
  └── dashboard_page (function) ─ new browser context, goes to BASE_URL/dashboard.html

eligible_voters (session) ─ loads from tg-mint-orchestrator/eligible-voters.json
  └── vps_eligible_synced (session) ─ syncs file + publishes 38009 + restarts coordinator
    └── test_voter_keys (session) ─ generates ephemeral Nostr keypair
      └── test_voter_added (session) ─ adds test voter to eligible list + publishes 38009
        └── voting_voter_key (session) ─ SECOND ephemeral keypair (for voting tests)
          └── voting_voter_added (session) ─ adds second voter to eligible list
```

### Why Two Voter Keys

The issuance test (`test_ui_issuance.py`) consumes the session-scoped `test_voter_added` key to mint a proof. The coordinator only allows one proof per voter per election. The voting tests need their own fresh voter (`voting_voter_added`) to run the issuance flow independently.

### Screenshot on Failure

All Playwright page fixtures capture a full-page screenshot on test failure. Screenshots are saved to `test-screenshots/<test_name>.png`.

### Sequential Steps in Single Tests

Steps that depend on page state (enter nsec -> check eligibility -> request quote -> publish claim -> wait for approval -> mint tokens) are combined into a single test method. Splitting them into separate test methods would give each a fresh `voter_portal` fixture (new browser context, fresh localStorage), losing all prior state.

## Key Design Decisions

1. **`pytest-playwright` provides its own `page` fixture** — custom page fixtures are named `voter_portal`, `voting_page`, `dashboard_page` to avoid conflicts.

2. **Playwright `text=` selectors fail with strict mode violations** when multiple elements match. Use CSS selectors like `h2:has-text('24')` or `p.panel-kicker:has-text('Published')` instead.

3. **`vite-plugin-node-polyfills`** is required because the Cashu JS library uses Node.js `Buffer` which doesn't exist in browsers (Bug H).

4. **Production builds must use `VITE_USE_MOCK=false VITE_COORDINATOR_URL=/api VITE_MINT_URL=/mint`** — building without these env vars causes `MINT_URL` to be `undefined` at runtime.

## Bugs Found During Playwright Testing

| # | Bug | Severity | Status |
|---|-----|----------|--------|
| G | CDK mint keyset version mismatch (01 vs 00) | Critical | Fixed |
| H | `ReferenceError: Buffer is not defined` in browser | Critical | Fixed |
| I | `mintProofs(quoteId)` missing `amount` argument | Critical | Fixed |
| J | `mintProofs` returns "Can not sign locked quote without private key" | Critical | Fixed |
| K | Coordinator reads eligibility from 38009 event, not file | Critical | Fixed |

See `proof-flow-fix-plan.md` for full details on all bugs (A-K).
