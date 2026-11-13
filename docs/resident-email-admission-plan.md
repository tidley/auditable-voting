# Resident email admission implementation plan

## Goal

Deliver one focused contribution that lets an organiser upload a resident contact CSV, generate existing paper-ballot admission credentials, send those exact credentials by email from the coordinator's computer, and verify delivery without weakening ballot privacy.

## Scope

- One resident-contact upload control and one resident admission workspace.
- Reuse the existing ten-character paper-ballot code creation, admission registry, voter redemption and worker synchronisation.
- Download a sensitive email-delivery bundle containing each resident's name, email address, master-list number, exact generated code, expiry and normal public questionnaire link.
- Keep plaintext codes hidden by default in the coordinator UI; allow deliberate per-resident reveal and copy.
- Adapt `scripts/otp-send-email.mjs` to send pre-generated admission bundles without generating or substituting codes.
- Keep email delivery on the coordinator's machine, with dry-run support, resumable sends, concise delivery results and no secret values in logs, ledgers or result files.
- Update tests, operator documentation and product copy.

## Non-goals

- Coordinator npub rotation, BIP85, multiple coordinators or a global advanced mode.
- A new OTP protocol, browser-side email credentials, SMS or a generic SMTP abstraction.
- Changes to blind-signature issuance, public event formats or worker admission rules.
- Committing, pushing, deploying or opening the upstream PR before manual validation and explicit approval.

## Checklist

### Discovery and design

- [x] Compare the upstream and fork and select current `tidley/main` as the implementation base.
- [x] Confirm that paper-ballot admission supports independent devices and worker redemption.
- [x] Identify duplicate resident upload surfaces and the unbound six-digit email OTP flow.
- [x] Maintain the implementation plan and remaining-work checklist in this file.

### Web implementation

- [x] Consolidate resident email admission into one upload/questionnaire-specific workspace.
- [x] Generate and register paper-compatible admissions for imported residents.
- [x] Hide codes by default and add deliberate reveal/copy actions.
- [x] Export a correctly escaped email-delivery bundle with expiry and voter URL.
- [x] Import coordinator-sender results without storing credentials in the UI.

### Resident admission table refinement

- [x] Remove the duplicated visible heading caused by the parent disclosure and inner heading.
- [x] Replace the two Browse controls with one **Import** action that detects roster, delivery-results and rejected bundle CSV files.
- [x] Render imported resident CSV records as an editable table with add/remove-row controls.
- [x] Add **Set defaults** to apply a 24-hour future batch expiry without deleting residents or statuses.
- [x] Add one context-sensitive **Export** action: resident CSV before code generation, sensitive exact-code bundle afterwards.
- [x] Lock identity fields and roster replacement after code generation; keep results import available.
- [x] Fold delivery results into the resident table as a Delivery column.
- [x] Make copy and disclosures concise while preserving privacy, reload and sensitive-export warnings.
- [x] Update component, browser-harness, accessibility and CSV-helper tests for the revised interaction.
- [x] Re-run focused and full verification after the refinement.

### Email sender

- [x] Consume exact pre-generated codes from a bundle; do not generate replacement OTPs.
- [x] Produce clear email text with master-list number, formatted code, expiry and voter URL.
- [x] Validate malformed bundles and reject unsafe or ambiguous resume attempts.
- [x] Keep retries idempotent and credentials/email addresses out of ledgers, results and console output.
- [x] Preserve offline tests and the explicit opt-in live-send boundary.

### Local sender companion and in-UI delivery

- [x] Extract reusable admission-bundle, email-composition, ledger and result logic from the CLI.
- [x] Add SMTP transport with environment-only credentials and one message per recipient.
- [x] Keep the cashu.email transport and its payment-token handling.
- [x] Add a loopback-only local companion that serves the built app and same-origin sender API.
- [x] Enforce local Host/Origin checks, request limits and redacted logs/status.
- [x] Add a Send emails UI that detects the local companion, shows progress/status and updates Delivery rows.
- [x] Include clear instructions, public voter link, number, code and expiry in both text and HTML email bodies.
- [x] Preserve Export as the sensitive fallback and use an idempotent ledger for retries.
- [x] Add offline tests for SMTP, cashu, companion security and Send UI.
- [x] Add an opt-in live delivery test and document coordinator setup for both transports.
- [x] Run focused/full tests, TypeScript, production build and a manual local UI check.

### Automated verification

- [x] Add or update component tests for upload, masking, reveal/copy, export and status import.
- [x] Add or update sender tests for exact-code delivery, dry-run, resume, validation and redaction.
- [x] Run focused Vitest and Node test suites.
- [x] Run TypeScript checking.
- [x] Run the production web build after final documentation edits.
- [x] Run the full web test suite and existing worker tests.

### Documentation and manual acceptance

- [x] Align `README.md`, operator documentation, project explainer and presentation copy where relevant.
- [ ] Run the manual coordinator/send/retry/status checklist with fictional contacts and controlled inboxes.
- [ ] Redeem an emailed code in a separate browser/device, submit a ballot and test wrong-code, expiry and replay rejection.
- [ ] Verify public events, local storage, logs, ledgers and results do not expose resident contact details or codes.
- [ ] Produce a preview URL or runsheet for the exact tested revision and request approval before any upstream PR.

## Manual acceptance evidence

Record the tested revision, preview URL, test addresses, send/retry results, recipient-device result and any observed limitation here before considering the work ready to surface upstream. No real resident contact data or secrets may be added to this file.

### Automated evidence — 13 November 2026

Base revision: `a3246c03` (upstream `main` at checkout), with the present uncommitted feature diff.

- Exact-code sender: **19/19 passing** Node tests across the sender, companion and opt-in live smoke, including:
  - exact generated codes and recipient instructions in text/HTML;
  - mocked cashu.email transport and a real local SMTP socket;
  - cookie/payment-token scoping and partial/unknown-delivery resume;
  - loopback Host/Origin rejection and redacted health/API responses;
  - same-origin companion → SMTP delivery.
- Revised admission/CSV components: **21/21 passing** focused Vitest tests, covering one Import control, editable/add/remove rows, 24-hour defaults, context-sensitive Export, generated-code masking, integrated delivery results, roster locking and companion-backed **Send emails**.
- Browser integration harness: **3/3 passing** Playwright tests (production UI/code generation/export, result import and mocked local sender submission; not a relay/real-email test).
- Full web suite: **82 test files, 742/742 tests passing**.
- TypeScript `npx tsc --noEmit`: clean.
- Production `npm run build`: successful.
- Worker suite: **108 passing, 3 ignored, 0 failed** (worker code unchanged).
- Manual local UI check: companion health appeared through the development proxy, SMTP was selected, and **Send emails** became visible after admission generation.
- Desktop/mobile table screenshots inspected; the single Import, compact sender control and readable locked fields rendered correctly.

### Acceptance still outstanding

Local preview: `http://127.0.0.1:5174/dashboard.html?role=coordinator`; dev-only component harness: `http://127.0.0.1:5174/e2e/resident-email-harness.html`. These URLs serve the current working tree, not an immutable upstream build.

Start the sender with `npm --prefix web run email:sender` after configuring SMTP/cashu.email in `.env`. The built companion then serves `http://127.0.0.1:4319/dashboard.html?role=coordinator`; the running Vite preview can also reach its API through the configured proxy after a reload.

Real inboxes, SMTP/cashu credentials, a public/accessible preview of a pinned commit and separate-device relay admission have not been exercised in this checkout. A local SMTP socket accepted and received the generated message in automated tests, but external inbox placement cannot be proven without a controlled destination. Nothing has been committed, pushed, deployed or proposed upstream. Do not change this section to “tested” on the basis of offline mocks alone.

