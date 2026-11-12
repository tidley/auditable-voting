# Resident invitation delivery implementation plan

**Goal:** Deliver issue #41 without changing anonymous ballot verification or unrelated MLS work.

**Architecture:** CSV contacts receive existing single-use bearer invitations, registered through the organiser runtime. One resident delivery panel owns the contact-to-invitation mapping; redemption and issuance remain authoritative in the existing runtime. A coordinator-only Node CLI consumes a private JSON batch and emits non-secret delivery results. A locked durable ledger reserves monthly quota before each SMTP attempt and stops on uncertain outcomes.

**Implementation order**

1. Write and run failing tests for the batch sender: TLS configuration, input validation, duplicate identity/content conflicts, locked ledger, quota exhaustion, interrupted sends, authentication failure, bounded pre-DATA retries and secret-free results. Implement `web/scripts/smtpDelivery.mjs` and `web/scripts/otp-send-email.mjs` using Nodemailer only in coordinator tooling.
2. Write failing resident delivery tests for a single CSV, hidden/revealable private invitation, exact registered URL export, failure-safe generation, conflicting CSV replacement and lifecycle labels. Replace the disconnected active preview components with one `DeliveryPanel`, backed by real runtime bearer invitations. Keep admission and anonymous ballot state separate.
3. Add visible post-publication guidance for Guardian setup/check, invitations and issuance monitoring. Never describe configuration or an old heartbeat as current verified readiness.
4. Update `.env.example`, `docs/email-delivery.md`, README, both explainers and presentation. Explain private batch custody, baseline quota including the two authorised test sends, retries, restart recovery and the distinction between provider acceptance and delivery.
5. Verify with Node sender tests, relevant Vitest tests, TypeScript, blind-share checks and the full unit suite. Inspect CI/workflow state before any production build. Request two parallel independent read-only reviews, fix demonstrated findings and rerun verification. Do not commit, push, deploy or send live email without additional authority.

**Commands:** `node --test web/scripts/smtpDelivery.test.mjs`; from `web/`, `npx vitest run src/otpDelivery --maxWorkers=2`, `npx tsc --noEmit`, `npx vitest run --maxWorkers=2`, `npm run verify:simple-blind-shares`.

**Scope constraints:** Work directly on `experiment/mls-guardian`. Preserve pre-existing edits. No SMTP passwords in public configuration, diagnostics, Git, browser imports or Nostr. No MDK work in this issue. Reuse supported central build-storage adapters and require mounted `/mnt/fastbuild`.
