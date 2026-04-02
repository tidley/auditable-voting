# Proof Flow Fix Plan

Date: 2026-03-20

Three bugs were identified that prevent voters from receiving proofs after publishing a claim. This document describes the bugs, the fix plan, and the test cases.

---

## Bug Summary

| # | Bug | Severity | Root Cause |
|---|-----|----------|------------|
| A | Coordinator rejects all claims (mint URL mismatch) | Critical | `process_issuance_request` compares claim's `mint` tag against `--mint-url` (internal `127.0.0.1`) instead of `--public-mint-url` (`23.182.128.64`) |
| B | Frontend creates new unpaid quote after approval | Critical | `cashuBlind.ts:requestQuoteAndMint()` calls `wallet.createMintQuote()` instead of using the already-approved quote ID |
| C | `/info` returns `electionId: null` | Minor | `handle_info` reads `election.get("election_id")` but the stored key is `"election"` |
| D | `createBlankOutputs` crash — `"can't access property 'keys', n is undefined"` | Critical | `cashuBlind.ts` calls `wallet.createBlankOutputs(1)` — a **private** method requiring `(amount, keyset, counter?, keepFactory?)`. Called with only `(1)`, `keyset` is `undefined`, causing a crash inside `createOutputData` when it accesses `keyset.keys`. |
| E | Claims never reach coordinator (relay silently drops custom event kinds) | Critical | Public relays (damus, nos.lol, primal) silently discard kind 38010 events. `nostr-tools` `pool.publish()` reports success on WebSocket send, not relay acceptance. Coordinator's passive subscription never receives events. Fixed with active polling loop. |
| F | `this.mint.getKeySets is not a function` | Critical | `cashuBlind.ts` passes a string URL to `new CashuWallet(mintUrl)`, but `@cashu/cashu-ts` v2.5.3 expects a `CashuMint` instance as the first argument. The string gets assigned to `this.mint`, so `this.mint.getKeySets()` fails. |

---

## Bug A: Mint URL Mismatch in Coordinator

### Evidence

Coordinator logs show every claim rejected:

```
SKIP: c3e23eb5e3d00f18... mint=http://23.182.128.64:3338 does not match our mint http://127.0.0.1:3338
```

The flow:
1. Frontend calls `GET /api/info` (proxied to coordinator)
2. Coordinator returns `mintUrl: "http://23.182.128.64.3338"` (from `--public-mint-url`)
3. Frontend includes this URL in the claim event tag: `["mint", "http://23.182.128.64:3338"]`
4. Coordinator receives the claim and compares against `--mint-url http://127.0.0.1:3338`
5. URLs don't match, claim is rejected

### Fix

1. Add `public_mint_url: str | None = None` parameter to `process_issuance_request()`
2. Compare the claim's `mint` tag against `public_mint_url` (not `mint_url`)
3. Fall back to `mint_url` when `public_mint_url` is not set (backward compat)
4. Thread `public_mint_url` through `CoordinatorHandler` → `process_issuance_request()`
5. Also use `public_mint_url` in `_publish_38011()` so the 38011 receipt references the public URL

### Files

- `tg-mint-orchestrator/scripts/voting-coordinator-client.py`
  - `process_issuance_request()` signature + body (line 419)
  - `_publish_38011()` call site (line 478)
  - `CoordinatorHandler.__init__()` (line 748)
  - `CoordinatorHandler.handle()` (line 804)
  - `run_coordinator()` (line 1290)

### Design Decision: Public-First

All mint URL comparisons in the coordinator should use the public mint URL. This ensures the coordinator and mint can run on separate machines without any ansible changes. The internal URL is only used for `verify_quote_on_mint()` and `approve_quote_via_grpc()` (direct server-to-server calls).

---

## Bug B: Frontend Creates New Quote After Approval

### Evidence

In `cashuBlind.ts:32-38`:

```typescript
export async function requestQuoteAndMint(mintUrl: string): Promise<MintResult> {
  const wallet = new CashuWallet(mintUrl, { unit: "sat" });
  const quote = await wallet.createMintQuote(1, "sat");   // BUG: new unpaid quote
  const keep = wallet.createBlankOutputs(1);
  const proofs = await wallet.mintProofs(quote.quote, { outputData: keep });  // uses new quote
  ...
}
```

The flow:
1. Frontend creates quote → state = UNPAID
2. Voter publishes claim with the quote ID
3. Coordinator approves the quote → state = PAID
4. Frontend polls, sees PAID, calls `requestQuoteAndMint(activeMintUrl)`
5. `requestQuoteAndMint` creates a **new** quote (new quote ID, UNPAID)
6. `wallet.mintProofs()` is called with the new unpaid quote ID
7. Mint rejects: quote not paid

### Fix

1. Change `requestQuoteAndMint(mintUrl)` to `requestQuoteAndMint(mintUrl, quoteId)`
2. Remove `wallet.createMintQuote()` call
3. Use the passed `quoteId` in `wallet.mintProofs(quoteId, ...)`
4. Add console logging for debugging

### Files

- `auditable-voting/web/src/cashuBlind.ts`
- `auditable-voting/web/src/App.tsx` (caller: pass `mintQuote.quote`)

---

## Bug C: `electionId: null` in `/info` Response

### Evidence

`GET /info` returns `"electionId": null` despite an active election existing.

The `handle_info` function reads `election.get("election_id")` but `extract_event_data()` stores the election ID under the `"election"` key (extracted from the `["election", ...]` tag). The `handle_election` function correctly uses the fallback: `election.get("election_id") or election.get("election")`.

### Fix

Apply the same fallback pattern in `handle_info`:

```python
"electionId": (election.get("election_id") or election.get("election")) if election else None,
```

### Files

- `tg-mint-orchestrator/scripts/voting-coordinator-client.py` line 911

---

## Test Plan

### A. Unit tests for `process_issuance_request` (tg-mint-orchestrator)

File: `tg-mint-orchestrator/tests/test_coordinator_issuance.py`

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 1 | `test_accepts_public_mint_url` | Claim with `mint` tag = public URL, `public_mint_url` passed | Approves, pubkey in issued_set |
| 2 | `test_accepts_public_mint_url_with_trailing_slash` | Claim `mint` = `http://1.2.3.4:3338/`, `public_mint_url` = `http://1.2.3.4:3338` | Approves (trailing slash stripped) |
| 3 | `test_rejects_wrong_mint_url` | Claim `mint` = completely different URL | Skipped, not in issued_set |
| 4 | `test_rejects_internal_mint_when_public_differs` | Claim `mint` = `http://127.0.0.1:3338`, `public_mint_url` = `http://1.2.3.4:3338` | Skipped (localhost rejected when public URL is set) |
| 5 | `test_no_public_mint_url_falls_back_to_mint_url` | `public_mint_url=None`, claim `mint` = `mint_url` | Approves (backward compat) |
| 6 | `test_38011_publishes_public_mint_url` | After approval, verify `_publish_38011` called with public URL | Called with public URL, not internal |

### B. Unit tests for `/info` endpoint (tg-mint-orchestrator)

File: `tg-mint-orchestrator/tests/test_coordinator_info.py` (new)

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 7 | `test_info_returns_election_id` | Election stored with `"election"` key | `electionId` is non-null |
| 8 | `test_info_returns_none_when_no_election` | No election in store | `electionId` is null |
| 9 | `test_info_returns_public_mint_url` | Both URLs set | `mintUrl` = public URL |
| 10 | `test_info_falls_back_to_mint_url` | `public_mint_url=None` | `mintUrl` = internal URL |

### C. Unit tests for `cashuBlind.ts` (auditable-voting)

File: `auditable-voting/tests/test_cashu_blind.py` (new)

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 11 | `test_uses_provided_quote_id` | Mock CashuWallet, call with quoteId | `mintProofs` called with quoteId, `createMintQuote` not called |
| 12 | `test_mock_mode_returns_proof` | `USE_MOCK=true` | Returns mock proof with correct quote ID |

### D. Integration tests for full flow (tg-mint-orchestrator)

File: `tg-mint-orchestrator/tests/test_coordinator_integration.py`

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 13 | `test_full_flow_with_public_mint_url` | `process_issuance_request` with public URL | Approved, 38011 published with public URL |
| 14 | `test_full_flow_mismatch_rejected` | Internal URL in claim when public differs | Not approved |

### E. VPS integration tests (tg-mint-orchestrator)

File: `tg-mint-orchestrator/tests/test_coordinator_integration_vps.py`

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 15 | `test_full_flow_public_url_vps` | Real mint, `public_mint_url` set | Quote approved on real VPS |

### F. E2E smoke tests (auditable-voting)

File: `auditable-voting/tests/test_e2e_voting.py`

| # | Test name | What it tests | Expected |
|---|-----------|---------------|----------|
| 16 | `test_dashboard_accessible` | `GET /dashboard.html` via Traefik | HTTP 200 |
| 17 | `test_info_returns_election_id` | `GET /api/info` | `electionId` is non-null string |
| 18 | `test_info_mint_url_is_public` | `GET /api/info` | `mintUrl` contains `23.182.128.64` |

---

## Bug D: `createBlankOutputs` Private API Crash

### Evidence

After fixing Bugs A-C, the voter portal shows `"Quote approved! Minting tokens..."` then crashes with:

```
can't access property "keys", n is undefined
```

Browser console shows the error originates inside `mintProofs`.

### Root Cause

`cashuBlind.ts:37` calls `wallet.createBlankOutputs(1)`. In `@cashu/cashu-ts` v2.5.3, `createBlankOutputs` is a **private** method with signature `(amount, keyset, counter?, keepFactory?)`. The `keyset` parameter is required for internal operation — it calls `createOutputData(c.length, keyset, ...)`. When called with only `(1)`, `keyset` is `undefined`, and the subsequent access to `keyset.keys` throws.

Additionally:
- The method is marked `private` in TypeScript declarations, meaning it can be renamed/mangled in any patch release
- `mintProofs` already creates its own outputs internally (line 1864: `h = this.createOutputData(...)`) when no `outputData` option is provided
- Passing pre-created output data is only needed for advanced use cases (e.g., deterministic secrets with a seed)

### Fix

Remove the `createBlankOutputs` call entirely. Let `mintProofs` handle output creation:

```typescript
// BEFORE (broken):
const wallet = new CashuWallet(mintUrl, { unit: "sat" });
const keep = wallet.createBlankOutputs(1);
const proofs = await wallet.mintProofs(quoteId, { outputData: keep });

// AFTER (fixed):
const wallet = new CashuWallet(mintUrl, { unit: "sat" });
const proofs = await wallet.mintProofs(quoteId);
```

### Regression Tests

File: `web/src/cashuBlind.test.ts` (vitest)

| # | Test | Catches regression of |
|---|------|-----------------------|
| 1 | `test_mock_returns_proof_with_correct_quote_id` | Bug B (wrong quote ID returned) |
| 2 | `test_real_calls_mintProofs_with_quote_id` | Bug B (creating new quote instead of using approved one) |
| 3 | `test_real_does_not_call_createBlankOutputs` | Bug D (calling private `createBlankOutputs`) |
| 4 | `test_real_does_not_call_createMintQuote` | Bug B (creating new unpaid quote) |

### Deploy Gate

Added vitest step to `deploy-voting-client.yml` before the build step. A broken `cashuBlind.ts` now blocks deployment.

---

## Bug E: Claims never reach coordinator (relay silently drops custom event kinds)

### Evidence

After fixing Bugs A-D, the voter portal still shows "Waiting for coordinator to approve quote..." indefinitely. The coordinator logs show **zero claim events received** since startup — only dashboard polling.

Direct relay queries confirm the claim event `d63414b48...` is **not on any relay**:
- `wss://relay.damus.io` — EOSE, event not found
- `ws://localhost:10547` — EOSE, event not found

Yet the frontend reported "4 success, 0 failure" for the publish.

### Root Cause

`nostr-tools` `pool.publish(relays, event, { maxWait: 4000 })` reports "success" when the WebSocket send completes. But **public relays (damus, nos.lol, primal) silently discard kind 38010 events** because it's a custom application-specific kind they don't recognize. The event is sent but never stored. The coordinator's passive subscription (via `handle_notifications`) never receives anything.

Additionally, the coordinator's relay list includes `ws://localhost:10547` which the browser cannot reach (it's on the VPS, not the user's machine). So even though the coordinator subscribes to 4 relays, the frontend can only publish to the 3 public ones — and all 3 drop the event.

### Fix: Active Polling

Instead of relying solely on passive relay subscriptions, add an active polling loop that periodically queries relays for recent kind 38010 events. This handles:
- Relays that silently drop custom event kinds
- Relays that are slow to propagate
- Subscriptions that silently disconnect

**File: `tg-mint-orchestrator/scripts/voting-coordinator-client.py`**

Add an `async def poll_claims()` coroutine that runs alongside `handle_notifications`:

```python
async def poll_claims():
    seen_ids: set[str] = set()
    while True:
        await asyncio.sleep(10)
        try:
            since = Timestamp.from_secs(int(time.time()) - 120)
            claim_filter = Filter().kinds([Kind(38010)]).limit(10).since(since)
            events = await nostr_client.fetch_events(claim_filter, timeout=timedelta(seconds=10))
            for event in events.to_vec():
                event_id = event.id().to_hex()
                if event_id not in seen_ids:
                    seen_ids.add(event_id)
                    await handler.handle("poll", "poll", event)
        except Exception as exc:
            log.warning("Claim poll error: %s", exc)
```

Start it as a background task before `handle_notifications`:

```python
asyncio.create_task(poll_claims())
await nostr_client.handle_notifications(handler)
```

### Why `handler.handle()` instead of calling `process_issuance_request()` directly

Reusing `handler.handle()` ensures:
- Election ID filtering is applied (line 797-802)
- Event is stored in `event_store` (line 804)
- Duplicate detection via `issued_set` (handled inside `process_issuance_request`)
- All other kind handlers work (38000, 38002, etc.)

### Regression Test

**File: `tg-mint-orchestrator/tests/test_coordinator_issuance.py`** — add:

| # | Test | Catches regression of |
|---|------|-----------------------|
| 5 | `test_polling_task_processes_new_claim` | Polling loop not running or not dispatching to handler |

### Tradeoffs

- **Polling interval**: 10s means up to 10s delay before a claim is processed. Acceptable for voting (not high-frequency trading).
- **Memory**: `seen_ids` set grows unbounded. For an election with ~100 voters, this is negligible. Could be pruned periodically if needed.
- **Relay load**: One REQ query every 10s to 4 relays is minimal.

---

## Bug F: `this.mint.getKeySets is not a function`

### Evidence

After fixing Bugs A-E, the voter portal shows "Quote approved! Minting tokens..." then crashes with:

```
this.mint.getKeySets is not a function
```

### Root Cause

`cashuBlind.ts:35` creates `new CashuWallet(mintUrl, { unit: "sat" })` where `mintUrl` is a string like `"/mint"`. In `@cashu/cashu-ts` v2.5.3, the `CashuWallet` constructor signature is:

```typescript
constructor(mint: CashuMint, options?: CashuWalletOptions)
```

The first argument must be a `CashuMint` instance, not a string URL. The constructor assigns `this.mint = mint` directly (line 1444 of `cashu-ts.es.js`). When a string is passed, `this.mint` is a string, and any method call on it (`getKeySets`, `mint`, `getKeys`) fails.

This likely worked in an older version of cashu-ts where the constructor accepted a string and created a `CashuMint` internally.

### Fix

```typescript
// BEFORE (broken):
import { CashuWallet, getEncodedToken } from "@cashu/cashu-ts";
const wallet = new CashuWallet(mintUrl, { unit: "sat" });

// AFTER (fixed):
import { CashuWallet, CashuMint, getEncodedToken } from "@cashu/cashu-ts";
const wallet = new CashuWallet(new CashuMint(mintUrl), { unit: "sat" });
```

### Lesson

When upgrading library dependencies, always check the constructor signatures. The `CashuWallet` API changed from accepting a URL string to requiring a `CashuMint` instance. This kind of breaking change is common in early-stage libraries.

### Regression Test

Updated test #4 in `cashuBlind.test.ts` to verify `CashuMint` is passed:

```typescript
expect(CashuWallet).toHaveBeenCalledWith(expect.any(CashuMint), { unit: "sat" });
```

---

## Dashboard Exposure

The dashboard (`web/dashboard.html`) is already built into `web/dist/` and served by nginx. It is accessible at:

```
http://vote.mints.23.182.128.64.sslip.io/dashboard.html
```

No code changes needed. The dashboard already:
- Fetches election info, eligibility, and tally from `/api/` endpoints
- Auto-refreshes every 5 seconds
- Shows per-question results when votes exist
- Shows published/accepted vote counts and spent commitment root

---

## Deployment Steps

1. Fix coordinator code in `tg-mint-orchestrator/scripts/voting-coordinator-client.py`
2. Fix frontend code in `auditable-voting/web/src/cashuBlind.ts` and `App.tsx`
3. Write all tests listed above
4. Run tests and verify all pass
5. Copy fixed coordinator to VPS `/opt/tollgate/coordinator/`
6. Restart coordinator: `systemctl restart tollgate-coordinator`
7. Verify `/info` returns `electionId` (non-null) and public `mintUrl`
8. Build frontend and deploy via ansible
9. Publish new election with fresh keyset via `deploy-and-prepare.yml`
10. Verify dashboard and voter portal are functional

---

## Bug G: CDK Mint Keyset Version Mismatch (01 vs 00 prefix)

### Evidence

Playwright test shows "Approved -- minting tokens" but never transitions to "Proof received and stored". Browser console:

```
Error: No active keyset found
    at nc.getActiveKeyset (cashu-ts.es.js)
    at nc.getKeys
    at async nc.mintProofs
```

Checking the mint's `/v1/keysets` endpoint:

```json
{"keysets":[{"id":"0153cfe6a604c8f99cda...","unit":"sat","active":true}]}
```

### Root Cause

The `@cashu/cashu-ts` library v2.5+ has a hard-coded filter in `getActiveKeyset()`:

```javascript
e = e.filter((r) => r.id.startsWith("00"));
```

Only keysets whose ID starts with `"00"` (version 0) are considered active. Version 1 keysets (`"01"` prefix) are silently ignored.

The CDK mint defaults to `CDK_MINTD_USE_KEYSET_V2=true` (set in `cdk-mintd/src/mint/builder.rs`):

```rust
keyset_id_type: if self.use_keyset_v2.unwrap_or(true) {
    cdk_common::nut02::KeySetVersion::Version01   // "01" prefix
} else {
    cdk_common::nut02::KeySetVersion::Version00   // "00" prefix
}
```

### Fix

Set `CDK_MINTD_USE_KEYSET_V2: "false"` in all mint docker-compose templates:

- `tg-mint-orchestrator/roles/mint_local/templates/docker-compose.yml.j2`
- `tg-mint-orchestrator/roles/mint_voting/templates/docker-compose.yml.j2`
- `tg-mint-orchestrator/roles/mint/templates/docker-compose.yml.j2`

The `deploy-and-prepare.yml` also enforces this env var during keyset rotation, and asserts the new keyset ID starts with `"00"`.

### Ansible Guard

`deploy-and-prepare.yml` now includes:

```yaml
- name: Ensure CDK_MINTD_USE_KEYSET_V2=false in docker-compose.yml
  ansible.builtin.shell: |
    grep -q 'CDK_MINTD_USE_KEYSET_V2' ... || \
      sed -i '/CDK_MINTD_MINT_MANAGEMENT_PORT/a\      CDK_MINTD_USE_KEYSET_V2: "false"' ...
    sed -i 's/CDK_MINTD_USE_KEYSET_V2: "true"/CDK_MINTD_USE_KEYSET_V2: "false"/' ...
```

And the keyset assertion:

```yaml
- name: Verify new keyset differs from old
  ansible.builtin.assert:
    that:
      - mint_keyset_id | regex_search('^00')
```

---

## Bug H: `ReferenceError: Buffer is not defined` in Browser

### Evidence

After fixing keyset version, minting fails with:

```
Error: ReferenceError: Buffer is not defined
    at Cs (main.js)
    at cr (main.js)
    at nc.getKeys
    at async nc.mintProofs
```

### Root Cause

The `@cashu/cashu-ts` library uses Node.js `Buffer` internally (for key derivation, proof serialization). Browsers don't have a global `Buffer` — it's a Node.js API. Vite doesn't polyfill Node.js APIs by default.

### Fix

Add `vite-plugin-node-polyfills` to the build:

```bash
npm install --save-dev vite-plugin-node-polyfills
```

```typescript
// vite.config.ts
import { nodePolyfills } from "vite-plugin-node-polyfills";
export default defineConfig({
  plugins: [react(), nodePolyfills()],
  // ...
});
```

This polyfill is automatically included when ansible runs `npm install && npm run build` in `deploy-voting-client.yml`.

---

## Bug I: `mintProofs()` Missing `amount` Argument

### Evidence

After fixing Buffer polyfill, minting fails with:

```
Error: Can not sign locked quote without private key
    at cc.mintProofs
```

### Root Cause

`@cashu/cashu-ts` v2.5+ changed the `mintProofs` signature:

```typescript
// v2.5+:
mintProofs(amount: number, quote: string, options?: MintProofOptions): Promise<Array<Proof>>;

// What we had:
mintProofs(quote: string, options?: any): Promise<any[]>;  // WRONG
```

Our code called `wallet.mintProofs(quoteId)` — the `quoteId` landed in the `amount` parameter (as a string, becoming `NaN`), and no quote was passed, triggering the "locked quote" error.

### Fix

```typescript
// cashuBlind.ts
const proofs = await wallet.mintProofs(1, quoteId);  // amount=1 sat

// cashu.d.ts
mintProofs(amount: number, quote: string, options?: any): Promise<any[]>;
```

---

## Bug J: Minting Uses Raw IP Instead of Nginx Proxy

### Evidence

The coordinator's `/info` endpoint returns `mintUrl: "http://23.182.128.64:3338"`. The frontend uses this URL for `requestQuoteAndMint()`, bypassing the nginx proxy at `/mint/`. This works when the browser can reach port 3338 directly (CORS is enabled with `access-control-allow-origin: *`), but breaks in locked-down network environments.

### Root Cause

In `App.tsx`:

```typescript
const mintUrl = coordinatorInfo?.mintUrl ?? MINT_URL;  // "http://23.182.128.64:3338"
// ...
const mintResult = await requestQuoteAndMint(activeMintUrl, mintQuote.quote);
```

The coordinator returns its configured `--public-mint-url` which is the raw IP. The frontend uses this for all Cashu operations. Meanwhile, `createMintQuote()` and `checkQuoteStatus()` in `mintApi.ts` correctly use the build-time `MINT_URL` (`/mint`) which goes through nginx.

### Fix

Use the build-time `MINT_URL` (nginx proxy path) for `requestQuoteAndMint`:

```typescript
const mintResult = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), mintQuote.quote);
```

This ensures the Cashu library calls go through nginx, consistent with all other mint API calls.

### Note

The coordinator's `mintUrl` is still used for display purposes and stored in the wallet bundle metadata. Only the actual API call is routed through the proxy.

---

## Bug K: Coordinator Reads Eligibility from 38009 Event, Not File

### Evidence

Playwright test shows "Eligible npub confirmed" passes when run alone but fails when the eligible list was only updated via file sync (without publishing a new 38009 event). The coordinator's `/eligibility` endpoint returns the old list despite the file being updated.

### Root Cause

The coordinator recovers its state from Nostr relay events on startup, specifically from kind 38009 events. The `--eligible` CLI argument (file path) is only used as a fallback if no 38009 event exists. Once a 38009 has been published, the coordinator uses the event's content as the source of truth — updating the file and restarting the coordinator is NOT sufficient.

```python
# Coordinator startup:
# 1. Read eligible-voters.json (used for initial recovery if no 38009)
# 2. Fetch historical events from relays (kinds 38000-38011)
# 3. If a 38009 event exists for the election, use its content
# 4. Future eligibility checks use the in-memory state from step 3
```

### Fix

The test infrastructure (`conftest.py`) now publishes a 38009 event after modifying the eligible list:

```python
def _sync_eligible_on_vps(eligible_voters, also_publish_38009=True):
    _ssh_run(f"echo '{payload}' > {COORDINATOR_DIR}/eligible-voters.json")
    if also_publish_38009:
        _publish_38009_on_vps(eligible_voters)
    _ssh_run("systemctl restart tollgate-coordinator")
```

The `deploy-and-prepare.yml` already publishes a 38009 event as part of its election publication flow, so normal ansible deployments are unaffected.

---

## Summary: All Bugs and Their Ansible Coverage

| Bug | Fix Location | Deployed By |
|-----|-------------|-------------|
| A | Coordinator Python source | `update-coordinator-keep-existing-election.yml` (copies script) |
| B-D | `cashuBlind.ts`, `cashu.d.ts` | `deploy-voting-client.yml` (npm build) |
| E | Coordinator Python source (poll loop) | `update-coordinator-keep-existing-election.yml` (copies script) |
| F | `cashuBlind.ts` (CashuMint wrapper) | `deploy-voting-client.yml` (npm build) |
| G | Mint docker-compose env var | `deploy-and-prepare.yml` (enforces during rotation) |
| H | `vite.config.ts` + `package.json` | `deploy-voting-client.yml` (npm install + build) |
| I | `cashuBlind.ts` + `cashu.d.ts` | `deploy-voting-client.yml` (npm build) |
| J | `App.tsx` (use MINT_URL) | `deploy-voting-client.yml` (npm build) |
| K | Test infrastructure only | N/A (test fixtures publish 38009) |
