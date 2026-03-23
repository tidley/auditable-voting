# 25 - Tally Endpoint 500 Bug During E2E Tests

## Date
2026-03-23

## Status
IN PROGRESS

## Summary
The `/tally` HTTP endpoint returns HTTP 500 with `AttributeError: 'str' object has no attribute 'get'` when the coordinator is started with `--election-id` set. This blocks the `test_merkle_tree_e2e.py` E2E test which needs `--election-id` to isolate a test election from the main production election.

## Symptom
- During the E2E test, after the coordinator restarts with `--election-id merkle-test-<timestamp>`, every `/tally` request returns HTTP 500
- The error is: `AttributeError: 'str' object has no attribute 'get'`
- The error persists for the entire 90-second polling window
- Without `--election-id`, `/tally` works correctly (returns 200)

## Key Evidence

### Empty Traceback
Both `traceback.format_exc()` and `traceback.format_exception()` return only the exception message **without any file/line information**. This means `exc.__traceback__` is `None`, which is highly unusual for a normal Python `.get()` failure. This could indicate:
- The exception originates from a descriptor protocol or `__getattr__` override
- The exception is raised in a C extension
- Something is stripping the traceback

### Recovery Loads 949 Events Instead of Filtered
When `--election-id merkle-test-1774232156` is set, the log says:
```
State recovered: 949 events, 3 issued pubkeys, 0 spent commitments, merkle_root=None
```
For a brand-new test election, this should be ~2-4 events (38008 + 38009 + maybe 38010). The 949 count suggests the election-ID filtering in `recover_state_from_relay` (lines 1284-1287) is **not working** — all historical events from all elections are being loaded into the event store.

### The `isinstance` Guard Didn't Fix It
Adding `isinstance(content, dict)` before `content.get("end_time")` on line 984 still results in 500. This means the crash is NOT at that line.

### `_compute_results` Is Not the Culprit
That function only runs when `accepted_votes` is non-empty. A brand-new test election has 0 accepted votes, so the for loop on line 854 never executes.

### Log Format Mismatch
During the test run, the log output matched the **second** version of the error wrapper (`traceback: AttributeError: ...`) rather than the **third** (`format_exception`). This raises the question of whether the coordinator is actually running the latest deployed code during the test. However, the `scp` + `systemctl restart` should ensure the latest code is loaded.

## Code Locations

### Tally Handler
`coordinator/voting-coordinator-client.py` lines 966-1010 (`handle_tally` / `_handle_tally_impl`)

### Recovery Filtering
`coordinator/voting-coordinator-client.py` lines 1284-1287:
```python
if active_election_id:
    event_election = event_data.get("election") or event_data.get("election_id", "")
    if event_election != active_election_id:
        continue
```

### Event Store
`coordinator/voting-coordinator-client.py` lines 345-392:
- `get_election()` returns the latest 38008 event
- `get_vote_events(election_id)` filters 38000 events by election tag
- `get_accepted_event_ids(election_id)` filters 38002 events by election tag

### E2E Test
`tests/test_merkle_tree_e2e.py` — `merkle_test_voters` fixture writes the systemd service file and restarts the coordinator with `--election-id`.

### SSH Write Helper
`tests/conftest_e2e.py` — `ssh_write_file()` pipes content via stdin to avoid shell heredoc interpretation issues.

## Root Cause Hypothesis

### Primary: Recovery Filtering Not Working
The `recover_state_from_relay` function filters events by `event_data.get("election")`. If events don't have an `election` tag (which is true for events from the main production election `sec06-feedback`), then `event_election` is `""` (from `or event_data.get("election_id", "")`). Since `"" != "merkle-test-..."`, these events should be filtered out. But the log shows 949 events recovered, suggesting the filter is not being applied.

**Possible cause**: The `active_election_id` variable might not be set correctly when `recover_state_from_relay` is called. Check how it's passed from `run_coordinator` to the recovery function.

### Secondary: Some Event Has a String Where a Dict Is Expected
With 949 unfiltered events in the store, the tally handler encounters an event whose data is in an unexpected format. For example, a 38002 event's `e` tag might be a string instead of a list (line 377: `for eid in evt.get("e", [])`), or some other field is malformed.

## Debugging Plan (Ordered)

1. **Add a version marker** to the `/info` response (e.g., hash of the source file or a build timestamp) so we can verify the test is running the latest deployed code.

2. **Add defensive type checks** around every `.get()` call in `_handle_tally_impl` and `_compute_results` — not just the `content.get("end_time")` one. Wrap each `.get()` on a potentially-malformed value with `isinstance(x, dict)`.

3. **Fix the recovery filtering** — investigate why 949 events are recovered when `--election-id` is set. Add logging inside the recovery loop to show whether `active_election_id` is set and how many events pass/fail the filter.

4. **Add line-level logging** in the tally handler to narrow down which `.get()` call is crashing:
   ```python
   log.info("tally: election type=%s", type(election).__name__)
   log.info("tally: election_id type=%s value=%s", type(election_id).__name__, repr(election_id)[:50])
   ```

5. **Alternative approach if above fails**: Skip `--election-id` entirely in the E2E test and filter at the test level using a unique question prompt or election title to distinguish test votes.

## Related Files

| File | What Changed |
|------|-------------|
| `coordinator/voting-coordinator-client.py` | Added `handle_tally` wrapper with traceback logging; added `isinstance(content, dict)` guard |
| `tests/conftest_e2e.py` | Added `ssh_write_file()` helper for piping content via SSH stdin |
| `tests/test_merkle_tree_e2e.py` | Uses `ssh_write_file` for service files and DM payloads; polls `total_published_votes` instead of `total_accepted_votes` |

## Previous Discoveries (from session context)

- **SSH heredoc backslash doubling**: Writing systemd service files via `ssh_run` with heredocs caused `\\` instead of `\` in continuation lines. Fixed with `ssh_write_file()` using `Popen` + stdin.
- **gRPC port mismatch**: Coordinator's `--grpc-endpoint` was set to port 3338 (HTTP) instead of 8086 (gRPC). Fixed on VPS and in test templates.
- **Votes DO burn successfully**: Logs show `BURN OK: vote ... proof burned via swap (received 1 sigs)`. The issuance and burning flow works end-to-end.
- **`/tally` only returns data after `/close`**: The `/vote_tree` endpoint requires a kind 38003 (final result) event.
- **Coordinator doesn't accept query params**: `/tally`, `/close`, `/vote_tree` use `event_store.get_election()` internally, not URL query params.
