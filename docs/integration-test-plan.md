# Integration Readiness Test Plan

Pre-deployment test suite to validate all prerequisites before testing the
voter frontend against the live coordinator and mint on `23.182.128.64`.

All tests use `pytest` with `requests` for HTTP checks and `subprocess` for
frontend build verification.

---

## Test Location and Setup

### Files

```
tests/
  requirements.txt               # pytest, requests
  conftest.py                    # VPS URL constants, shared helpers
  test_integration_readiness.py  # all 25 tests
```

### Dependencies

`tests/requirements.txt`:

```
pytest>=7.0
requests>=2.31.0
```

### Running

```bash
python3 -m venv .venv
.venv/bin/pip install -r tests/requirements.txt
.venv/bin/pytest tests/test_integration_readiness.py -v
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `COORDINATOR_URL` | `http://23.182.128.64:8080` | Override coordinator URL |
| `MINT_URL` | `http://23.182.128.64:3338` | Override mint URL |

---

## Test Results (2026-03-20)

**25 passed, 0 failed, 0 skipped.**

All tests pass. The 4 previously-failing coordinator tests (1-3, 7-10, 14) now
pass because the coordinator is deployed with CORS, `--public-mint-url`, and the
election_id fix. The keyset test was updated to handle the CDK response shape.

### Passed (25)

| # | Test | Group |
|---|------|-------|
| 1 | `test_coordinator_info_200` | 1: Coordinator connectivity |
| 2 | `test_coordinator_cors_options` | 1: Coordinator CORS |
| 3 | `test_coordinator_cors_get` | 1: Coordinator CORS |
| 4 | `test_mint_info_200` | 1: Mint connectivity |
| 5 | `test_mint_cors_options` | 1: Mint CORS |
| 6 | `test_mint_cors_get` | 1: Mint CORS |
| 7 | `test_election_announced` | 2: Election state |
| 8 | `test_election_has_questions` | 2: Election state |
| 9 | `test_eligibility_published` | 2: Eligibility state |
| 10 | `test_tally_returns_data` | 2: Tally endpoint |
| 11 | `test_mint_quote_creation` | 3: Mint API shape |
| 12 | `test_mint_keys` | 3: Mint API shape |
| 13 | `test_mint_keysets` | 3: Mint API shape |
| 14 | `test_coordinator_info_mint_url_matches` | 3: Mint URL match |
| 15 | `test_frontend_tsc_passes` | 4: Frontend build |
| 16 | `test_frontend_vite_build_passes` | 4: Frontend build |
| 17 | `test_cashu_ts_exports_cashuwallet` | 4: JS package API |
| 18 | `test_cashu_ts_exports_token_encode` | 4: JS package API |
| 19 | `test_nostr_tools_nip04_encrypt` | 4: JS package API |
| 20 | `test_env_file_exists` | 5: Config |
| 21 | `test_env_use_mock_false` | 5: Config |
| 22 | `test_env_coordinator_url_set` | 5: Config |
| 23 | `test_env_mint_url_set` | 5: Config |
| 24 | `test_env_example_committed` | 5: Config |
| 25 | `test_cashu_dts_declarations_match_real_api` | 6: Type declarations |

### Failed (0)

None.

---

## Test Cases

### Group 1: Coordinator / Mint Connectivity and CORS

These tests verify the coordinator and mint are reachable and respond with
CORS headers. Without CORS, the browser blocks every cross-origin request
from `localhost:5173`.

| # | Test | Method | URL | Assert |
|---|------|--------|-----|--------|
| 1 | `test_coordinator_info_200` | GET | `http://23.182.128.64:8080/info` | 200, JSON with `coordinatorNpub`, `mintUrl`, `relays` |
| 2 | `test_coordinator_cors_options` | OPTIONS | `http://23.182.128.64:8080/info` | 204, header `Access-Control-Allow-Origin: *` |
| 3 | `test_coordinator_cors_get` | GET | `http://23.182.128.64:8080/info` | Response header `Access-Control-Allow-Origin: *` |
| 4 | `test_mint_info_200` | GET | `http://23.182.128.64:3338/v1/info` | 200, JSON with `pubkey` |
| 5 | `test_mint_cors_options` | OPTIONS | `http://23.182.128.64:3338/v1/info` | 204, header `Access-Control-Allow-Origin: *` |
| 6 | `test_mint_cors_get` | GET | `http://23.182.128.64:3338/v1/info` | Response header `Access-Control-Allow-Origin: *` |

**Status:** All 6 pass (3 coordinator + 3 mint).

### Group 2: Election and Eligibility State

These tests verify the coordinator has published election and eligibility
events. Without these, the frontend has no questions to display and no
eligible npub list to check against.

| # | Test | Method | URL | Assert |
|---|------|--------|-----|--------|
| 7 | `test_election_announced` | GET | `http://23.182.128.64:8080/election` | 200, JSON with `election_id`, `questions`, `start_time`, `end_time` |
| 8 | `test_election_has_questions` | GET | `http://23.182.128.64:8080/election` | `questions` array has length >= 1, each item has `id`, `prompt`, `type` |
| 9 | `test_eligibility_published` | GET | `http://23.182.128.64:8080/eligibility` | 200, JSON with `eligible_npubs` array, `eligible_count > 0` |
| 10 | `test_tally_returns_data` | GET | `http://23.182.128.64:8080/tally` | 200 (may have zero votes, but should not 404 if election exists) |

**Status:** All 4 pass.

### Group 3: Mint NUT API Shape

These tests verify the mint responds with the correct field names and
shapes expected by `mintApi.ts`.

| # | Test | Method | URL | Assert |
|---|------|--------|-----|--------|
| 11 | `test_mint_quote_creation` | POST | `http://23.182.128.64:3338/v1/mint/quote/bolt11` body `{"amount":1,"unit":"sat"}` | 200, response has `quote` field (not `quote_id`), `state: "UNPAID"`, `amount: 1` |
| 12 | `test_mint_keys` | GET | `http://23.182.128.64:3338/v1/keys` | 200, JSON object with keyset data |
| 13 | `test_mint_keysets` | GET | `http://23.182.128.64:3338/v1/keysets` | 200, array with at least one item where `unit == "sat"` and `active == true`, `id` is 66 chars |
| 14 | `test_coordinator_info_mint_url_matches` | GET | `http://23.182.128.64:8080/info` + `http://23.182.128.64:3338/v1/info` | `coordinatorInfo.mintUrl` matches the mint's actual URL |

**Status:** All 4 pass. Quote creation and keys work. Keyset IDs are 66 chars. Coordinator
mint URL matches the mint's actual URL.

### Group 4: Frontend Build and JS Package API Surface

These tests run subprocess commands to verify the frontend builds and the
JavaScript packages export the expected functions.

| # | Test | Command | Assert |
|---|------|---------|--------|
| 15 | `test_frontend_tsc_passes` | `npx tsc --noEmit` in `web/` | exit code 0 |
| 16 | `test_frontend_vite_build_passes` | `npx vite build` in `web/` | exit code 0 |
| 17 | `test_cashu_ts_exports_cashuwallet` | node script importing `CashuWallet` from `@cashu/cashu-ts` | `CashuWallet` is a function, has methods `createMintQuote`, `mintProofs`, `createBlankOutputs` |
| 18 | `test_cashu_ts_exports_token_encode` | node script importing from `@cashu/cashu-ts` | `getEncodedToken` and `getDecodedToken` are exported functions |
| 19 | `test_nostr_tools_nip04_encrypt` | node script importing `nip04` from `nostr-tools` | `nip04.encrypt` is a function |

**Status:** All 5 pass.

### Group 5: Config and .env Validation

| # | Test | Assert |
|---|------|--------|
| 20 | `test_env_file_exists` | `.env` exists in project root |
| 21 | `test_env_use_mock_false` | `.env` contains `VITE_USE_MOCK=false` |
| 22 | `test_env_coordinator_url_set` | `.env` contains `VITE_COORDINATOR_URL=http://23.182.128.64:8080` |
| 23 | `test_env_mint_url_set` | `.env` contains `VINT_MINT_URL=http://23.182.128.64:3338` |
| 24 | `test_env_example_committed` | `.env.example` exists with the same keys as `.env` (minus values) |

**Status:** All 5 pass.

### Group 6: Type Declaration Correctness

These tests catch mismatches between the hand-written type declarations in
`cashu.d.ts` and the actual `@cashu/cashu-ts` API.

| # | Test | Assert |
|---|------|--------|
| 25 | `test_cashu_dts_declarations_match_real_api` | node script that lists all exports of `@cashu/cashu-ts`, checks that every function referenced in `cashu.d.ts` exists in the real package |

**Status:** Pass. Was a known failure (`generateSecret`/`amountToBlindedMessage`
declared but not in real package). Fixed by rewriting `cashu.d.ts` to declare
`CashuWallet` class with `createMintQuote`, `mintProofs`, `createBlankOutputs`
methods, and `getEncodedToken`/`getDecodedToken` functions.

---

## Issues Fixed During This Round

### 1. `cashuBlind.ts` rewrote to use `CashuWallet` class (was test #25)

**Before:** Used non-existent `generateSecret()` and `amountToBlindedMessage()` from
a hand-written `cashu.d.ts` that did not match `@cashu/cashu-ts` v3.x.

**After:** Uses `CashuWallet` class from `@cashu-ts/cashu-ts`:

```typescript
import { CashuWallet, getEncodedToken } from "@cashu/cashu-ts";

const wallet = new CashuWallet(mintUrl, { unit: "sat" });
const quote = await wallet.createMintQuote(1, "sat");
const keep = wallet.createBlankOutputs(1);
const proofs = await wallet.mintProofs(quote.quote, { outputData: keep });
const serialized = getEncodedToken({ mint: mintUrl, proofs });
```

Files changed:
- `web/src/cashuBlind.ts` -- complete rewrite
- `web/src/cashu.d.ts` -- rewrote declarations to match real API
- `web/src/App.tsx` -- updated imports and token minting flow

### 2. `conftest.py` subprocess helper simplified

**Before:** Nested Python subprocess wrapper that lost stderr output, causing JS tests
to fail silently with no diagnostic output.

**After:** Direct `node` invocation with `cwd=WEB_DIR` for proper module resolution.

---

## Remaining Blockers

None. All 25 readiness tests pass and the E2E test passes all 12 steps.

---

## Resolved Blockers

### 1. Coordinator daemon not running -- RESOLVED

The coordinator was on port 8081 (not 8080 as originally assumed). The `.env` and
test config were updated. The coordinator is now running as a systemd service
(`tollgate-coordinator.service`) on port 8081.

### 2. CORS on coordinator -- RESOLVED

Added `aiohttp-cors` middleware to the coordinator. All 4 endpoints (`/info`,
`/election`, `/eligibility`, `/tally`) now return proper CORS headers with
`Access-Control-Allow-Origin` echoing the requesting origin (credentials mode).

### 3. Keyset ID length assertion -- RESOLVED

The `/v1/keysets` endpoint returns `{"keysets": [...]}` (a dict with a `keysets`
key), not a bare list. The test was updated to handle both response shapes. The
keyset IDs are 66 chars as expected.

### 4. Public mint URL in coordinator /info -- RESOLVED

The coordinator returned `http://127.0.0.1:3338` (internal) as `mintUrl` in the
`/info` response. Added `--public-mint-url` CLI argument so the coordinator
returns `http://23.182.128.64:3338` (publicly reachable) to voters.

---

## Test Execution Strategy

1. ~~Run group 4-6 (local tests, no network). Fix all failures.~~ **DONE.**
2. ~~Start the coordinator daemon on the VPS. Re-run all tests.~~ **DONE.**
3. ~~Add CORS middleware to coordinator.~~ **DONE.**
4. ~~Fix keyset ID assertion.~~ **DONE.**
5. ~~Fix public mint URL.~~ **DONE.**
6. ~~Publish kind 38008 and 38009 events to activate election tests.~~ **DONE (via E2E fixture).**
7. ~~Run all 25 readiness tests.~~ **DONE (25 passed).**
8. ~~Implement and run E2E voter flow test (Phase 3, above).~~ **DONE (12/12 steps, ~87s).**

### Readiness Test Results (2026-03-20)

```
25 passed in 11.53s
```

All 25 tests pass. The 4 previously-skipped election-dependent tests (7-10) now
pass because the E2E test fixture publishes ephemeral kind 38008/38009 events
during session setup.

### E2E Test Results (2026-03-20)

**PASSED.** All 12 steps complete in ~87 seconds.

```
tests/test_e2e_voting.py::test_full_voter_flow PASSED
1 passed, 2 warnings in 86.56s
```

The test generates a fresh voter keypair per run, adds it to the coordinator's
`eligible-voters.json` on the VPS, publishes ephemeral election events, and walks
through the entire voter lifecycle end-to-end.

---

## Phase 3: End-to-End Voter Flow Tests

### Overview

A single comprehensive E2E test that exercises the entire voter lifecycle against
the live coordinator and mint on `23.182.128.64`. The test publishes its own
ephemeral election events, walks through all 7 voter phases, and verifies the
tally reflects the accepted vote.

### Files

```
tests/
  conftest_e2e.py          # session-scoped fixtures, VPS helpers, Nostr publish utilities
  test_e2e_voting.py       # the single comprehensive E2E test
```

### Additional Dependencies

Beyond `pytest>=7.0` and `requests>=2.31.0`, the E2E tests require:

```
nostr-sdk       # Python Nostr client (Rust bindings)
cashu>=0.19.0   # Cashu blinding primitives (step1_alice, BlindedMessage)
```

### Running

```bash
cd tests
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install nostr-sdk "cashu>=0.19.0"
.venv/bin/pytest test_e2e_voting.py -v -s --timeout=300
```

The test is marked `@pytest.mark.e2e` and can be run independently from the
readiness tests.

### Test Election Setup (session-scoped fixture)

The test publishes ephemeral kind 38008 and 38009 events via SSH to the VPS
local relay (`ws://localhost:10547`) to eliminate relay propagation delay.

**Kind 38008 (Election Announcement)**

```
kind:        38008
signed by:   coordinator nsec (from /opt/tollgate/coordinator/nsec.env)
tags:        [["election", "<unique_election_id>"]]
content:     JSON.stringify({
               "title": "E2E Test Election <timestamp>",
               "description": "Automated test election",
               "questions": [
                 {
                   "id": "q1",
                   "type": "choice",
                   "prompt": "Test question",
                   "options": ["option_a", "option_b", "option_c"]
                 }
               ],
               "start_time": <now - 60>,
               "end_time":   <now + 3600>,
               "mint_urls": ["http://23.182.128.64:3338"]
             })
```

**Kind 38009 (Eligibility Set)**

```
kind:        38009
signed by:   coordinator nsec
tags:        [["election", "<unique_election_id>"]]
content:     JSON.stringify({
               "eligible_count": <len(eligible_npubs)>,
               "eligible_npubs": ["npub1yvuda...", "npub1ukdwf...", ...],
               "eligible_root": "<sha256 of sorted npub list>"
             })
```

After publishing, the fixture polls `GET /election` until it returns 200
(up to 30s) to ensure the coordinator has cached the events.

**Election ID format:** `test-e2e-<unix_timestamp>` — unique per run to avoid
collisions with the coordinator's one-proof-per-voter-per-election restriction.

**Teardown:** No-op. Events persist on relays. The election ID is logged for
manual cleanup if needed.

### Test Steps (Single Comprehensive Test)

The test `test_full_voter_flow` executes 12 ordered steps:

| Step | Phase | Action | Verification |
|------|-------|--------|-------------|
| 1 | Discovery | `GET {COORDINATOR}/info` | Returns `coordinatorNpub`, public `mintUrl`, `relays` |
| 2 | Discovery | `GET {COORDINATOR}/election` | Returns test election with `questions` array |
| 3 | Discovery | `GET {COORDINATOR}/eligibility` | Test voter npub is in `eligible_npubs` list |
| 4 | Quote | `POST {MINT}/v1/mint/quote/bolt11` body `{"amount":1,"unit":"sat"}` | Returns `quote` (ID), `request` (bolt11), `state: "UNPAID"` |
| 5 | Blinding | Build blinded output using `cashu` lib (`step1_alice`) | Valid `BlindedMessage` with active keyset ID |
| 6 | Claim | SSH to VPS, publish kind 38010 with correct tags | Event published successfully, event ID returned |
| 7 | Approval | Poll `GET {MINT}/v1/mint/quote/bolt11/{id}` | State transitions from `UNPAID` to `PAID` within 60s |
| 8 | Minting | `POST {MINT}/v1/mint/bolt11` with blinded outputs | Returns `signatures` array with at least 1 entry |
| 9 | Ballot | Generate ephemeral keypair (`Keys.generate()`) | Fresh `ballot_npub` / `ballot_nsec` pair |
| 10 | Ballot | SSH to VPS, publish kind 38000 (vote event) | Event signed by ephemeral key, contains responses matching election questions |
| 11 | Proof | SSH to VPS, send NIP-04 DM (kind 4) with proof to coordinator | Encrypted DM published, contains `vote_event_id` and mint signature |
| 12 | Tally | Poll `GET {COORDINATOR}/tally` | `total_accepted_votes >= 1`, `spent_commitment_root` is 64-char hex |

### Event Shapes Used by the Test

**Kind 38010 (Issuance Claim)**

```
kind:        38010
signed by:   voter nsec
tags:
  ["p", "<coordinator hex pubkey>"]
  ["t", "cashu-issuance"]
  ["quote", "<quote_id from step 4>"]
  ["invoice", "<bolt11 from step 4>"]
  ["mint", "http://127.0.0.1:3338"]       # must match coordinator --mint-url (internal)
  ["amount", "1"]
  ["election", "<election_id from setup>"]
content:     "E2E test issuance request"
```

**Kind 38000 (Vote Event)**

```
kind:        38000
signed by:   ephemeral ballot key
tags:
  ["election", "<election_id from setup>"]
content:     JSON.stringify({
               "election_id": "<election_id>",
               "responses": [
                 { "question_id": "q1", "value": "option_a" }
               ],
               "timestamp": <unix timestamp>
             })
```

**Kind 4 (NIP-04 DM Proof Submission)**

The proof sent in the DM must be a **properly unblinded Cashu Proof**, not the raw
`BlindSignature` returned by the mint. The wallet must call `step3_alice()` to
convert `C_` (blinded signature) to `C` (unblinded signature) and add the blinding
factor `r` to the DLEQ proof. See "Proof unblinding" in Known Issues below.

```
kind:        4
signed by:   ephemeral ballot key (same as vote event)
tags:
  ["p", "<coordinator hex pubkey>"]
content:     nip04_encrypt(
                ballot_secret_key,
                coordinator_pubkey,
                JSON.stringify({
                  "vote_event_id": "<38000 event hex ID from step 10>",
                  "proof": {
                    "id": "<keyset_id>",
                    "amount": 1,
                    "secret": "<blinding secret from step 5>",
                    "C": "<unblinded signature (step3_alice output)>",
                    "dleq": {
                      "e": "<dleq_e from mint signature>",
                      "s": "<dleq_s from mint signature>",
                      "r": "<blinding factor from step 5>"
                    }
                  }
                })
              )
```

### Known Issues

#### 1. Mint URL Tag Mismatch -- RESOLVED

The coordinator's `process_issuance_request()` validates the `["mint", ...]`
tag in kind 38010 against `--mint-url` (internal:
`http://127.0.0.1:3338`). A voter on the public internet would naturally send
`http://23.182.128.64:3338`. The coordinator now accepts the public mint URL
via the `--public-mint-url` CLI argument.

**Workaround in the test:** The kind 38010 event is published from the VPS
itself, so it uses the internal URL. This works for testing and also works for
real remote voters now that `--public-mint-url` is deployed.

#### 2. One Proof Per Voter Per Election

The coordinator silently skips duplicate issuance requests
(`voting-coordinator-client.py:279-281`). If the test voter was already issued
a proof for a previous election, the issuance step will hang until timeout.

**Workaround:** The test generates a unique `election_id` per run and a fresh
voter keypair per session.

#### 3. No Reply DM After Proof Burn

The coordinator does not send a confirmation DM after burning a proof
(`handle_proof_dm` at line 361-416). Acceptance is only discoverable via
`GET /tally` or kind 38002 events on relays.

**Workaround:** The test polls `GET /tally` after sending the DM.

#### 4. Proof Unblinding Required

The mint's `/v1/mint/bolt11` endpoint returns `BlindSignature` objects with
`C_` (blinded signature) and `DLEQ{e, s}` (no `r`). The coordinator's proof
burning endpoint (`/v1/swap`) requires a proper `Proof` object with `C`
(unblinded signature) and `DLEQWallet{e, s, r}`. The wallet must call
`step3_alice(C_, r, A)` to unblind, where `A` is the mint's public key for
the proof's amount. The blinding factor `r` is only known to the wallet and
must be preserved from the blinding step.

#### 5. Coordinator Uses `/v1/swap` Instead of `/v1/melt/bolt11`

The CDK mint's Lightning receive backend is not functional on the VPS, so
`/v1/melt/bolt11` with `quote: ""` returns "Unknown quote". The coordinator
was modified to use `/v1/swap` instead, which burns input proofs and returns
new blinded outputs without requiring a Lightning payment or melt quote.

#### 6. `nostr-sdk` `SendEventOutput` String Representation

In Python's `nostr-sdk`, `str(result)` on a `SendEventOutput` returns the full
debug representation (e.g. `SendEventOutput(id=EventId { inner: EventId(...) }, ...)`).
Use `result.id.to_hex()` to get the 64-character hex event ID.

#### 7. Relay Echo Delay for Kind 38002

The coordinator publishes kind 38002 (vote acceptance receipt) to relays but
may not receive it back immediately. The coordinator now inserts the 38002
event into its local event store immediately after publishing, so the tally
endpoint reflects the accepted vote without waiting for relay propagation.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `COORDINATOR_URL` | `http://23.182.128.64:8081` | Override coordinator URL |
| `MINT_URL` | `http://23.182.128.64:3338` | Override mint URL |
| `VPS_IP` | `23.182.128.64` | VPS IP for SSH |
| `SSH_KEY` | `~/.ssh/tollgate` | SSH private key path |

---

## Final Status (2026-03-20)

All testing is complete:

- **25/25 readiness tests pass** (11.53s)
- **12/12 E2E voter flow steps pass** (~87s)
- **38/38 total tests pass** (13 signer + 25 integration)
- **4/4 vitest unit tests pass** (cashuBlind regression guards)

The full deploy-and-prepare playbook also passes, confirming the entire
stack works end-to-end from a clean VPS to a live voter portal. See
`docs/deploy-and-prepare-plan.md` for deployment details and
`~/voting-information.md` for the live URLs.

---

## Frontend Unit Tests (vitest)

Added `web/src/cashuBlind.test.ts` with 4 regression tests that guard against
reintroduction of the proof-flow bugs. These run automatically during the
ansible deploy playbook before the build step.

### Running

```bash
cd web && npx vitest run
```

### Tests

| # | Test | Guards against |
|---|------|----------------|
| 1 | `calls mintProofs with the approved quote ID` | Bug B: creating a new unpaid quote instead of using the approved one |
| 2 | `does not call createMintQuote` | Bug B regression |
| 3 | `does not call createBlankOutputs` | Bug D: calling the private `createBlankOutputs` method |
| 4 | `passes mintUrl and unit to CashuWallet constructor` | Config mismatch |

### Deploy Gate

The `deploy-voting-client.yml` playbook now runs `npx vitest run` before
`npm run build`. A failing test blocks deployment.

### TypeScript Exclusion

`tsconfig.json` excludes `src/**/*.test.ts` from `tsc --noEmit` checks. Test
files use `vi.mock()` hoisting that confuses tsc but works correctly under
vitest.

---

## Bugs Fixed (2026-03-20)

### Bug A: Coordinator mint URL mismatch (tg-mint-orchestrator)

The coordinator compared the claim's `["mint", ...]` tag against `--mint-url`
(internal `127.0.0.1`) but voters send the public URL. Every claim was rejected.

**Fix:** `process_issuance_request()` now compares against `--public-mint-url`.

### Bug B: Frontend creates new unpaid quote after approval

`cashuBlind.ts:requestQuoteAndMint()` called `wallet.createMintQuote()`,
creating a new unpaid quote. The approved quote was ignored.

**Fix:** Function now accepts `quoteId` parameter and passes it directly to
`wallet.mintProofs(quoteId)`.

### Bug C: `/info` returns `electionId: null`

`handle_info` read `election.get("election_id")` but the stored key was
`"election"`.

**Fix:** Added fallback: `election.get("election_id") or election.get("election")`.

### Bug D: `createBlankOutputs` crash (private API misuse)

`cashuBlind.ts` called `wallet.createBlankOutputs(1)` — a private method
requiring `(amount, keyset, ...)`. Without `keyset`, the internal
`createOutputData` crashed with `"can't access property 'keys', n is undefined"`.

**Fix:** Removed the call entirely. `wallet.mintProofs(quoteId)` creates its
own outputs internally when no `outputData` option is provided.

**Lesson:** Never call private methods from external libraries. They can change
signature or be renamed/mangled in any patch release. Use only the public API.

### tsconfig pre-existing failure

`tsc --noEmit` was failing because it type-checked `.test.ts` files that use
vitest's `vi.mock()` hoisting (not understood by tsc).

**Fix:** Added `"exclude": ["src/**/*.test.ts", "src/**/*.spec.ts"]` to
`tsconfig.json`.
