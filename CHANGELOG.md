# Changelog

All notable changes to this project are documented in this file.

## [0.1.12] - 2026-04-22

### Changed
- Version bump release.

## [0.1.11] - 2026-04-22

### Changed
- Moved delegated worker setup/download/configuration from Build into a dedicated `Delegate` tab.
- Added the coordinator `Delegate` tab between `Build` and `Invite`.

## [0.1.10] - 2026-04-22

### Changed
- Version bump release.

## [0.1.9] - 2026-04-22

### Added
- Added an optional delegated Rust worker daemon (`worker/`) with outbound-only relay operation, local durable state, heartbeat status, delegation/revocation handling, and delegated public submission-decision publishing.
- Added a downloadable worker helper package (`Linux x64`) exposed from Coordinator Build mode, including checksum and setup notes.
- Added coordinator Build support for delegated worker management (mode selection, worker status, capability-scoped delegation controls).

### Changed
- Updated project documentation and explainer/presentation material to include delegated-worker operation and portability guidance.

## [0.1.8] - 2026-04-22

### Changed
- Applied a single-flight, visibility-aware ballot wait scheduler in the voter flow to reduce overlapping mobile/signer retry loops.
- Paused hidden-tab ballot wait retries and resumed foreground recovery on `focus`/`online`/`visibilitychange`.
- Reduced retry churn while preserving automatic recovery for delayed blind issuance delivery.

## [0.1.7] - 2026-04-22

### Changed
- Reduced Auditor relay churn by favouring kind-only selected-round reads on a small relay subset, with slower questionnaire-list refresh cadence.
- Kept Auditor coordinator filters stable across background refreshes and temporary fetch failures.
- Improved Coordinator Results metadata so `Closing / Closed` reflects actual closed-state timing and clearly labels overdue open rounds.

## [0.1.6] - 2026-04-22

### Changed
- Refined Auditor response styling in Submitted Votes.
- Removed pill styling for `Round phase` and `Valid/Invalid` status labels.
- Switched answer rows to numbered items.
- Updated answer presentation to show white question text and green response text.

## [0.1.5] - 2026-04-21

### Changed
- Refreshed coordinator and auditor results UX.
- Moved questionnaire builder `+`/`-` question controls to the bottom control row.
- Updated Auditor results cards and metadata layout for better readability.

### Fixed
- Coordinator results view now decrypts free-text answers encrypted for coordinator (`enc:nip44v2:`) when coordinator key material is available.

## [0.1.4] - 2026-04-21

### Fixed
- Improved mobile ballot recovery while waiting for blind issuance.
- Reduced cases where ballot state only advanced after manual `Refresh status`.
- Tightened automatic recovery timing to reduce delay and retry churn.

## [0.1.3] - 2026-04-21

### Changed
- Removed invite status copy: `Link generated; browser blocked clipboard copy.`

## [0.1.2] - 2026-04-21

### Changed
- Questionnaire build UX: when only one question remains, pressing `-` clears the question fields instead of removing the final card.

## [0.1.1] - 2026-04-21

### Added
- Optional `Encrypt for coordinator` toggle for free-text responses.

### Changed
- Refined Auditor results layout and response presentation.

## [0.1.0] - 2026-04-21

### Added
- Public-submission questionnaire flow as the default modern protocol path:
  - public questionnaire definition,
  - private blind-token request/issuance handshake,
  - public submission by ephemeral responder identity,
  - public coordinator submission decisions.

### Changed
- Stabilised coordinator processing for the public-submission flow.
- Hardened verifier and auditor parity so accepted/rejected response outcomes align more consistently across views.
