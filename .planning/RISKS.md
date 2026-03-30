# RISKS

## R1: Oversimplified UI hides critical consent details
- Mitigation: Add concise “How your vote is protected” panel and explicit confirmation checkpoints.

## R2: New issuance endpoint introduces race/idempotency bugs
- Mitigation: request IDs + terminal-state persistence + retries tested.

## R3: Demo mode drifts from production behavior
- Mitigation: keep shared core protocol path; gate only labels/flow orchestration.
