# NEXT

## A) Coordinator API hardening + idempotency
- **File touchpoints:**
  - Coordinator issuance handlers/routes
  - `web/src/coordinatorApi.ts`
- Add idempotency keys for issuance start.
- Add retry-safe semantics and clear terminal states.

## B) Demo-safe operations tooling
- **File touchpoints:**
  - `scripts/` (new reset/preflight scripts)
  - `README.md`
  - `docs/` deployment/demo docs
- Add one-command demo reset (eligible set + election window + clear local wallet state guidance).
- Add “ready for demo” health check (coordinator, relay, mint, vote endpoint).

## C) Accessibility + trust messaging pass
- **File touchpoints:**
  - `web/src/App.tsx`
  - `web/src/VotingApp.tsx`
  - shared styles/components
- Plain-language privacy/fairness panel.
- Keyboard and mobile UX pass for live demo reliability.
