# RISKS

## R1: Oversimplified UI hides critical consent details
- Mitigation: Add concise “How your vote is protected” panel and explicit confirmation checkpoints.

## R2: New issuance endpoint introduces race/idempotency bugs
- Mitigation: request IDs + terminal-state persistence + retries tested.

## R3: Demo mode drifts from production behavior
- Mitigation: keep shared core protocol path; gate only labels/flow orchestration.

## R4: Ballot and proof timing remain linkable by coordinators or relay observers
- Mitigation: add randomized/delayed proof submission, separate relay sets for public ballots vs private proof DMs, and persist delayed-send jobs across reloads.

## R5: Public audit surface is too weak to independently verify coordinator behavior
- Mitigation: publish burn receipts keyed by `proof_hash`, expose spent-tree and issuance-tree inclusion proofs, and ship downloadable audit bundles plus offline verifier tooling.
