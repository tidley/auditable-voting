# STATUS

- Date: 2026-03-30
- Phase: Coverage-lift in progress (partial)
- Focus: Demo-mode component flow tests + issuance tracking API branch coverage + coordinator issuance endpoint edge cases
- Validation:
  - Web targeted tests passing (`vitest`), full web suite passing with coverage
  - Latest web coverage (targeted files):
    - `web/src/App.tsx`: 26.83% statements / 28.26% lines
    - `web/src/VotingApp.tsx`: 45.39% statements / 46.10% lines
    - `web/src/coordinatorApi.ts`: 6.89% statements / 7.74% lines
    - `web/src/ballot.ts`: 20.00% statements / 18.18% lines
    - `web/src/proofSubmission.ts`: 93.93% statements / 93.93% lines
  - Python coverage run remains blocked in this environment (`pytest`/`pip` not available), but new issuance edge-case tests were added in `tests/test_coordinator_issuance_tracking_edges.py`.
- Outcome vs target:
  - `proofSubmission.ts` is near target (just under 95%).
  - Other primary TS targets remain far below 95%; next slices should isolate logic from `App.tsx`/`VotingApp.tsx` into testable pure units and add non-UI API tests across remaining `coordinatorApi.ts` branches.
