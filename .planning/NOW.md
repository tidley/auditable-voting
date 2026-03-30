# NOW

## Objective
Prepare a constituent-friendly demo mode for auditable-voting that hides protocol complexity while preserving verifiable behavior.

## 1) Demo mode shell + language abstraction (UI)
- **Outcome:** Voter-facing UI uses plain language (no npub/nsec/Cashu/mint jargon) and a simple 3-4 step flow.
- **File touchpoints:**
  - `web/src/App.tsx`
  - `web/src/VotingApp.tsx`
  - `web/src/config.ts`
  - `web/index.html`, `web/vote.html` (copy/title/meta)
- **Implementation notes:**
  - Add `VITE_DEMO_MODE` feature flag.
  - Add vocabulary mapping (e.g. “voting pass” instead of “proof”).
  - Keep technical terms behind expandable “advanced details” panel.
- **Tests (TDD):**
  - UI tests for demo copy (no restricted terms visible in primary panels).
  - Existing flow tests still pass in non-demo mode.

## 2) Reduce issuance roundtrips (replace browser polling)
- **Outcome:** Remove client-side quote polling loop; use coordinator-assisted issuance status flow.
- **File touchpoints:**
  - `web/src/coordinatorApi.ts`
  - `web/src/App.tsx`
  - `coordinator/voting_coordinator_client.py` (or coordinator HTTP module handling issuance)
  - Coordinator route definitions for new endpoint(s)
- **Implementation notes:**
  - Add endpoint, e.g. `POST /api/issuance/start` and `GET /api/issuance/:id` (long-poll) **or** SSE stream.
  - Client performs: start -> await final status -> mint once.
  - Preserve audit event publication in backend path.
- **Tests (TDD):**
  - Coordinator endpoint unit tests (eligible/ineligible/already-issued/timeout).
  - Frontend integration tests for no polling loop in demo mode.

## 3) One-page voter happy path
- **Outcome:** In demo mode, voter can go from eligibility to vote confirmation in one linear flow.
- **File touchpoints:**
  - `web/src/App.tsx`
  - `web/src/VotingApp.tsx`
  - `web/src/proofSubmission.ts`
  - `web/src/ballot.ts`
- **Implementation notes:**
  - Merge issuance + ballot flow under a single stepper.
  - Auto-trigger proof submission in happy path after ballot publish.
  - Keep explicit “manual submit/retry” as fallback only.
- **Tests (TDD):**
  - E2E demo path test: verify -> get pass -> vote -> accepted.
