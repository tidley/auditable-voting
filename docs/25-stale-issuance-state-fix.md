# 25 — Stale Issuance State on Coordinator Restart

## Problem

After a Playwright test run, the coordinator's nak relay contains kind 38011 (issuance receipt) events from previous elections. On redeploy with a new election ID, the coordinator loads these stale events from the relay during `recover_state_from_relay()` and rebuilds the `issued_set` with pubkeys from the old election. Voters are then incorrectly marked "already issued" for the new election.

## Root Cause

A filter logic bug exists in two locations that allows events **without** an `election` tag (or with a mismatched one) to bypass the election ID filter when `--election-id` is set.

### Bug Location 1: `recover_state_from_relay()` (line 1282)

```python
# BUG: when event_election is "" (no tag), `and` short-circuits → event passes
if event_election and event_election != active_election_id:
    continue
```

### Bug Location 2: `CoordinatorHandler.handle()` (line 801)

```python
# BUG: same short-circuit issue in the live event handler
if event_election and event_election != self.active_election_id:
    return
```

In both cases, `event_election` is the result of `event_data.get("election") or event_data.get("election_id", "")`. If an event has no `election` tag, `event_election` is `""`. The truthiness check `if event_election and ...` evaluates to `False` for `""`, so the `continue`/`return` is never reached and the untagged event is processed.

## Why This Happens

1. Playwright tests publish kind 38011 events during issuance flow testing
2. These events persist on the local nak relay (SQLite-backed, no TTL)
3. On redeploy, `deploy-and-prepare.yml` generates a new `election_id` (e.g. `sec06-feedback-1742...`)
4. The coordinator restarts with `--election-id <new-id>`
5. `recover_state_from_relay()` fetches all events from the relay (kinds 38000-38011, limit 10000)
6. The filter bug lets untagged 38011 events (and events from previous elections) through
7. `get_issued_pubkeys(election_id)` then returns stale pubkeys because those events were loaded into the EventStore

## Design Decisions

### Why NOT NIP-09 event deletion

We considered purging stale events from the relay via NIP-09 (kind 5 delete requests) before each deploy. This was rejected because:

1. **Stale quote approval risk**: If old 38010 (issuance claim) events remain on the relay after their corresponding 38011 events are deleted, a coordinator restart could re-approve those quotes. The voter client would no longer be polling for the blind signature, so the approval would be wasted — but the mint state would be mutated (tokens issued against an uncollected quote).
2. **Relay consistency**: NIP-09 deletion is a request, not a guarantee. Some relays may not honor it.
3. **The filter fix is sufficient**: With the bug fixed, events from previous elections are simply ignored during state recovery and live processing. No relay mutation needed.

### Why NOT nak relay DB truncation

Truncating the nak relay SQLite database was considered as a "nuclear" option. Rejected because:

1. Couples deployment to nak internals
2. Destroys voter-authored events (38010 claims) which may be needed for audit
3. The election ID filter is the correct isolation mechanism — it just had a bug

## Fix

Change the filter condition in both locations from:

```python
if event_election and event_election != active_election_id:
    continue
```

To:

```python
if event_election != active_election_id:
    continue
```

This means:
- When `--election-id` is set, **only** events with an explicit `election` tag matching that ID are processed
- Untagged events (`""`) are skipped because `"" != "sec06-feedback-..."` is `True`
- Events from other elections are skipped by the existing inequality check

## Deploy Safety

Added an assertion in `deploy-and-prepare.yml` that verifies `--election-id` is present in the systemd service file after coordinator restart. This prevents silent misconfiguration where the coordinator runs without election filtering (which would make it vulnerable to the original bug with untagged events).

## Tests

Added to `test_coordinator_persistence.py`:

- `test_event_store_filters_untagged_38011` — 38011 without `election` tag returns empty set from `get_issued_pubkeys()`
- `test_event_store_filters_wrong_election_38011` — 38011 with different `election` tag returns empty set
- `test_event_store_accepts_matching_election_38011` — matching events pass through correctly
- `test_event_store_issued_no_election_id_returns_all` — when no election_id is passed to `get_issued_pubkeys()`, untagged events are included (backward compat)
