# BACKLOG

## Product/UX
- Multi-coordinator demo-mode UX simplification (aggregate status card, no coordinator jargon).
- “What happens behind the scenes” explainability timeline for observers.

## Protocol/Performance
- Investigate server-side mint orchestration options to further compress client roundtrips.
- Evaluate replacing DM confirmation step with optional coordinator pull model (while preserving privacy guarantees).
- Add delayed/batched proof submission with relay separation to reduce timing correlation between ballot publication and proof delivery.
- Publish public burn-receipt ledger keyed by `proof_hash` plus spent-set inclusion proofs, without exposing raw proofs.
- Expose issuance-tree and spent-tree audit endpoints plus downloadable audit bundle for offline verification.
- Ship standalone verifier flow that recomputes tally, issuance root, spent root, and confirmation discrepancies from public artifacts.

## Reliability/Security
- Formal threat-model doc for demo-mode simplifications vs production mode.
- Add explicit rollback toggle to disable demo mode instantly.
- Rework real-mode UI to show counts-only during issuance and only reveal proof hashes after voter submission.
- Tighten confirmation audit output to distinguish missing confirmations, fake confirmations, inflation, and censorship cases.

## Docs
- Demo facilitator script for Green constituent sessions.
- Operator runbook with failure playcards (relay down, mint slow, partial acceptance).
- Concrete implementation plan for privacy, transparency, and auditability hardening across coordinator, voter UI, and dashboard surfaces.
