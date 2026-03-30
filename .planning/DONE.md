# DONE

- Initialized `.planning` backlog structure for demo-mode implementation.
- Implemented `VITE_DEMO_MODE` flag and demo vocabulary map in `web/src/config.ts`.
- Added coordinator-assisted issuance client APIs:
  - `startIssuanceTracking`
  - `awaitIssuanceStatus`
- Reworked issuance wait flow in `web/src/App.tsx` to use coordinator-assisted status endpoint (fallback quote check remains for non-demo compatibility).
- Added coordinator endpoints/handlers in `coordinator/voting-coordinator-client.py`:
  - `POST /issuance/start`
  - `GET /issuance/{request_id}`
- Added one-page demo happy-path behavior in `web/src/VotingApp.tsx`:
  - auto submit proof after ballot publish in demo mode
  - retry controls for proof submit and confirmation re-check
- Added ballot completion helper (`isBallotComplete`) and wired usage.
- Added proof submission retry support (`retries`) in `web/src/proofSubmission.ts`.
- Added/updated tests:
  - `web/src/coordinatorApi.test.ts`
  - `web/src/ballot.test.ts`
  - `tests/test_coordinator_issuance_tracking.py`
