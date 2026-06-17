# Changelog

All notable changes to this project are documented in this file.

## [0.1.91] - 2026-06-17

### Fixed
- Refreshed public questionnaire definitions before delegated blind ballot requests so voters cannot keep resending requests against a stale blind-signing key.
- Refused audit proxy configuration when the organiser's local blind-signing private key does not match the published vote definition, and made the worker reject mismatched configs as a final guard.

### Changed
- Bumped web app package to 0.1.91 and worker package to 0.1.23.
- Updated generated audit proxy launcher minimum-version checks to require worker 0.1.23.

## [0.1.90] - 2026-06-17

### Changed
- Limited the worker release asset workflow to Linux x64 for now, with the other platform targets documented for quick re-enable.
- Bumped web app package to 0.1.90.

## [0.1.89] - 2026-06-17

### Fixed
- Copied delegated blind ballot requests to both organiser and audit proxy so a worker can issue even when the organiser copy is the first route observed.
- Added short audit-proxy debug logs for decrypted control-plane DM metadata without printing encrypted payload blobs.

### Changed
- Bumped web app package to 0.1.89 and worker package to 0.1.22.
- Updated generated audit proxy launcher minimum-version checks to require worker 0.1.22.

## [0.1.88] - 2026-06-17

### Fixed
- Fixed local-key voter ballot waits so request-ack and credential DM subscriptions start before blind requests are published, avoiding a fast-proxy issuance race that could leave later sessions at `2/3 Awaiting ballot`.
- Added local `nsec` live subscriptions for voter request acknowledgements and blind credential issuances, matching the existing recovery fetch path.

### Changed
- Changed the per-question submission identity label to "Identity used for this question".

## [0.1.87] - 2026-06-17

### Fixed
- Hid organiser questionnaire-link-only DMs from the voter helpline inbox and unread/glowing Menu indicator while keeping normal organiser messages visible.
- Added helpline DM regression coverage for questionnaire-link filtering.

## [0.1.86] - 2026-06-17

### Fixed
- Fixed second-round voter ballot recovery so opening an already-pending next questionnaire immediately force-resends the blind ballot request.
- Changed automatic "Awaiting ballot" retries to force-resend after the resend guard, avoiding stale relay ACKs that could leave delegated proxy voters stuck on `2/3 Awaiting ballot`.

## [0.1.85] - 2026-06-17

### Fixed
- Fixed voter ballot requests that could keep using a stale blind-signing key from an invite after the current questionnaire definition/summary had a newer key.
- Added regression coverage for stale invite keys so waiting voters regenerate requests against the current worker/organiser key instead of staying on `2/3 Awaiting ballot`.

## [0.1.84] - 2026-06-17

### Fixed
- Fixed the direct audit proxy launch command so its version check uses shell-safe `awk` quoting.
- Changed the direct Linux/macOS launch command to export worker environment variables before running the binary, avoiding fragile line-continuation paste issues around `WORKER_STATE_DIR`.
- Synced the shareable worker helper HTML shell defaults with the generated launcher source.

## [0.1.83] - 2026-06-17

### Changed
- Made selected ranked-answer rows removable by tapping anywhere on the row while keeping rank movement controls separate.
- Removed duplicate ranked-answer instruction text and the inline voter status update under the answer controls.

## [0.1.82] - 2026-06-16

### Fixed
- Fixed delegated worker ballot issuance gating so voters no longer get stuck on "Awaiting ballot" when stale worker routing state remains after a proxy path changes.
- Added a regression test for stale delegated-worker mode with no active proxy routing (`questionnaireOptionA.runtime.test.ts`).

## [0.1.81] - 2026-06-16

### Changed
- Refined general invite handling so opening a public voter link without private invite metadata generates a fresh voter identity, clears stale session state, and starts a new voter session.
- Added invite-detection tests for general-voter link behavior.

## [0.1.80] - 2026-06-16

### Changed
- Bumped web app package to 0.1.80 and worker package to 0.1.21.

## [0.1.79] - 2026-06-16

### Changed
- Bumped web app package to 0.1.79 and worker package to 0.1.20.
- Refined delegated worker reliability by fixing public blind-response subscription handling and guarding completion publishing from duplicate in-flight runs.

### Fixed
- Fixed delegated worker path that was matching response events against the wrong subscription id.
- Prevented close/summary completion events from being published more than once when response processing and housekeeping overlap.

## [0.1.71] - 2026-06-10

### Added
- Added an organiser free-text setting to require encrypted responses.

### Changed
- Voter free-text responses now stay encrypted when the organiser requires encryption.
- Serialised public questionnaire refresh reads and consolidated organiser, voter, and observer live questionnaire subscriptions to reduce relay-side concurrent `REQ` pressure.
- Updated public documentation, demo guide, technical notes, and presentation copy for required free-text encryption and the reduced relay-load model.

## [0.1.16] - 2026-04-22

### Changed
- Added worker startup logging (version, coordinator, relay source/list, state dir, heartbeat/poll settings).
- Defaulted worker logging to `info` when `RUST_LOG` is not set.

## [0.1.15] - 2026-04-22

### Changed
- Extended worker release CI to publish Raspberry Pi binaries:
  - `auditable-voting-worker-linux-arm64.tar.gz`
  - `auditable-voting-worker-linux-armv7.tar.gz`
- Updated worker download docs to include Raspberry Pi assets.

## [0.1.14] - 2026-04-22

### Changed
- Added a Delegate-tab startup helper to generate worker credentials (`nsec`/`npub`) and copy a launch command using the current coordinator identity.
- Updated Delegate and explainer docs to reflect the dedicated Delegate-tab worker setup flow.

## [0.1.13] - 2026-04-22

### Changed
- Added a Build-page `Configure Worker` shortcut next to questionnaire publish controls.
- Updated delegated worker setup so control relays default to the client relay set when left blank.
- Made delegated worker expiry optional and off by default.
- Extended Delegate downloads to include Windows/macOS worker binaries and checksums.
- Updated worker runtime/docs so `WORKER_RELAYS` is optional with built-in defaults (no placeholder relay domains).

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
