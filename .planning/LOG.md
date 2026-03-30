# LOG

- 2026-03-30T12:00:00Z Planned concrete backlog for constituent demo mode.
- Added `.planning/NOW.md`, `.planning/NEXT.md`, `.planning/BACKLOG.md` with exact file touchpoints for `web/src/App.tsx`, `web/src/VotingApp.tsx`, API client layer, and coordinator endpoints.
- 2026-03-30T12:58:00Z TDD slice 1 complete: added failing+passing tests for coordinator issuance tracking client API (`web/src/coordinatorApi.test.ts`) and implemented `startIssuanceTracking` + `awaitIssuanceStatus`.
- 2026-03-30T13:04:00Z TDD slice 2 complete: added coordinator issuance tracking endpoint tests (`tests/test_coordinator_issuance_tracking.py`) and implemented `/issuance/start` + `/issuance/{request_id}` handlers in coordinator HTTP routes.
- 2026-03-30T13:07:00Z TDD slice 3 complete: demo-mode copy/flow updates in `App.tsx` and `VotingApp.tsx`, ballot completeness helper in `ballot.ts`, proof submit retry support in `proofSubmission.ts`, and web test/build validation.
- 2026-03-30T13:27:00Z TDD coverage-lift pass (subagent): added component-level demo stepper tests (`web/src/App.demo.test.tsx`, `web/src/VotingApp.demo.test.tsx`), expanded issuance API client tests (`web/src/coordinatorApi.test.ts`) for default-timeout and error propagation, added proof submission retry/failure tests (`web/src/proofSubmission.test.ts`), and added coordinator issuance edge-case endpoint tests (`tests/test_coordinator_issuance_tracking_edges.py`). Ran web coverage; Python coverage run blocked by missing pytest/pip tooling in this execution environment.
