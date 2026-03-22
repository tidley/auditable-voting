# Friday Demo Problem: E2E Test Fails at Step 7 (Quote Never Approved)

## Symptom

`test_full_voter_flow` passes steps 1-6 but hangs at step 7 for 60s then fails:

```
INFO === Step 6: Publish kind 38010 (issuance claim) ===
INFO Claim published: 2356a79bfb144bb5...
INFO === Step 7: Poll quote until PAID (timeout=60s) ===
INFO Quote state: UNPAID  (×30)
AssertionError: Quote 8d268b51-... was not approved within 60s
```

## Root Cause

The coordinator **did receive** the kind 38010 event but **rejected** it. Coordinator logs:

```
16:01:34 SKIP: e6ff1b1f... mint=http://127.0.0.1:3338 does not match expected mint http://23.182.128.64:3338
```

The test publishes the 38010 with `["mint", "http://127.0.0.1:3338"]` (the internal VPS address), but the coordinator's `--public-mint-url` flag is set to `http://23.182.128.64:3338`. The coordinator skips any 38010 whose mint tag doesn't match.

## Why It Happens

In `tests/test_e2e_voting.py` line 209:

```python
[voter_nsec, coord_hex, quote_id, bolt11, COORDINATOR_INTERNAL_MINT, election_id]
#                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#                                              "http://127.0.0.1:3338"
```

But the coordinator service file has:

```ini
--public-mint-url http://23.182.128.64:3338
```

The `COORDINATOR_INTERNAL_MINT` constant was correct for an older coordinator version that didn't validate the mint tag. The coordinator now validates it.

## Fix

Use `MINT_HTTP` (`http://23.182.128.64:3338`) instead of `COORDINATOR_INTERNAL_MINT` in the 38010 mint tag. The mint tag in the 38010 event is a *public* identifier for which mint the quote belongs to — it should be the public URL, not the internal Docker address.

## Additional Issue: marshmallow Incompatibility

`environs 9.5.0` checks `marshmallow.__version_info__` which was removed in `marshmallow 4.x`. The `cashu` library transitively depends on `environs`. Fix: pin `marshmallow<4` in `tests/requirements.txt`.
