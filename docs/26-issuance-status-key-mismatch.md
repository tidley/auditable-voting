# 26 — Issuance Status Key Format Mismatch

## Problem

The dashboard eligibility registry always shows "Pending" for all voters, even those who have received a proof and spent it. The `/issuance-status` API returns all `issued: false`.

## Investigation

### Step 1: Compare the two endpoint responses

Fetched live data from both endpoints:

**`/eligibility`** returns:
```json
{
  "eligible_npubs": [
    "npub1c03rad0r6q833vh57kyd3ndu2jry30nkr0wepqfpsm05vq7he25slryrnw",
    ...
  ]
}
```

**`/issuance-status`** returns:
```json
{
  "voters": {
    "c30b8de8f3c5518fc59d85aeab284bd8527538e294975868b0c8113a987b7dfb": {
      "eligible": true,
      "issued": false
    },
    ...
  }
}
```

Keys are **hex** in `/issuance-status` but **npub bech32** in `/eligibility`.

### Step 2: Trace the key mismatch through the code

**Eligibility path** (`handle_eligibility`, line 999):
1. Calls `event_store.get_eligibility(election_id)` which returns the kind 38009 event
2. The 38009 content was published by `_publish_38009_on_vps()` in conftest.py, which sets `eligible_npubs` to the original npub bech32 strings from `eligible-voters.json`
3. Handler returns `eligible_npubs: content.get("eligible_npubs")` — **npub bech32 strings**

**Issuance-status path** (`handle_issuance_status`, line 1117):
1. Iterates `_eligible_set` (the `eligible_set` parameter passed to `make_http_handler`)
2. `_eligible_set` is loaded by `load_json_set()` in `async_main()` which calls `normalize_npub()` on every entry
3. `normalize_npub("npub1...")` converts to **hex** via `PublicKey.parse(raw).to_hex()`
4. Handler builds `voters[npub]` where `npub` is actually the **hex** pubkey (variable name is misleading)
5. Response keys are **hex**

**Dashboard lookup** (`DashboardApp.tsx`, line 403):
```tsx
const voterInfo = issuanceStatus?.voters?.[npub];
```
Here `npub` comes from `eligibility.eligibleNpubs` (bech32). Looking up a bech32 key in a hex-keyed dict → always `undefined` → `issued` defaults to `false`.

### Step 3: Why is `issued` also false on the backend?

Even in the raw JSON, all voters show `issued: false`. This is because `get_issued_pubkeys()` scans `EventStore._events[38011]` for events matching the election ID. If no kind 38011 events were recovered from the relay on startup (or they weren't published), the set is empty.

This is a separate state recovery issue (the coordinator may have restarted without recovering 38011 events). The key format fix is necessary regardless — even when 38011 events exist, the dashboard can't match them.

## Root Cause

`handle_issuance_status()` uses `_eligible_set` (hex pubkeys) as dict keys, but the frontend consumes these keys using npub bech32 values from `/eligibility`. The two formats never match.

## Fix

### Backend: `/issuance-status` must return npub bech32 keys

1. Add a `hex_to_npub()` helper that converts hex back to bech32
2. In `handle_issuance_status()`, convert hex keys to npub bech32 before building the response

The eligible set is already in hex (normalized by `load_json_set`). We convert it back to npub for the response so the frontend can cross-reference with `/eligibility` npubs.

### Frontend: No changes needed

`DashboardApp.tsx` already does `issuanceStatus?.voters?.[npub]` where `npub` comes from `eligibility.eligibleNpubs` (bech32). Once the backend returns bech32 keys, this lookup will work correctly.

## Tests

New file `tests/test_coordinator_issuance_status.py` with 6 tests using aiohttp test client:

| Test | Verifies |
|------|----------|
| `test_returns_npub_keys_not_hex` | Response `voters` dict keys start with `npub1` |
| `test_issued_true_when_38011_exists` | Voter with matching 38011 event shows `issued: true` |
| `test_issued_false_when_no_38011` | Voter without 38011 event shows `issued: false` |
| `test_all_eligible_voters_in_response` | All members of eligible_set appear |
| `test_filters_38011_by_election_id` | Wrong election's 38011 doesn't affect result |
| `test_404_when_no_election` | No 38008 event returns HTTP 404 |
