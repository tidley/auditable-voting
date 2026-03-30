# Debug Session: demo-receipt-root-stall

## Symptoms

- Demo auto-play completed confirmation and audit steps, but step 5 `38002 receipt published` and step 6 `Spent tree rebuilt` stayed pending.
- Verifier panel showed `Commitment root` and `Spent-tree` as unavailable.
- Server logs showed invoice/proof issuance, but no `POST /api/debug/ballot-log` activity in the failing runs.

## Root Cause

The frontend was masking proof-delivery failures.

`submitProofsToAllCoordinators()` returns a synthetic fallback result when proof submission fails for a coordinator:

- `eventId: ""`
- `successes: 0`
- `failures: 1`

The demo and voter UIs treated the mere presence of a `dmResults` entry as successful delivery. That made step 4 look complete and let the sequence continue to confirmation/audit even when no relay had accepted the NIP-17 gift wrap.

When delivery never actually succeeded, the mock coordinator never learned about the proof receipt, so `/api/tally` and `/api/result` stayed empty and step 5/6 could not advance.

## Evidence

- `web/src/proofSubmission.ts` catches coordinator delivery failures and still returns a synthetic result object.
- `web/src/DemoApp.tsx` previously used `dmResults.length > 0` to mark:
  - step 4 as done
  - submission status as `ACCEPTED`
  - step 5 as "now waiting for receipt"
- `web/src/VotingApp.tsx` previously showed `Proof sent` whenever `dmResult` existed, regardless of whether any relay had accepted the delivery.
- The mock backend receipt path itself works when called directly:
  - `POST /api/debug/ballot-log` records a receipt
  - `GET /api/tally` returns non-zero accepted votes and `spent_commitment_root`
  - `GET /api/result` returns the same root

## Fix Applied

- Aligned the frontend mock coordinator `npub` with the mock server coordinator identity.
- Updated demo and voter UIs to treat proof delivery as successful only when at least one relay accepts the NIP-17 gift wrap.
- Auto-play now aborts with a concrete error if proof delivery had zero relay successes, instead of pretending step 4 succeeded.

## Result

If proof delivery really succeeds, step 5/6 can now progress from real receipt-backed state.

If proof delivery fails, the UI now shows the actual blocker instead of a false "proof delivered" state.
