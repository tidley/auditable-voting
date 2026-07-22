# Changelog

All notable changes to this project are documented in this file.

## [0.1.158] - 2026-07-22

### Fixed
- Preserved active audit proxy delegations when changing coordinator views instead of briefly resetting them to browser-only mode.
- Shared the selected proxy delegation with voter approval so each approval forces a configuration update containing the newly admitted voter.
- Reported unavailable proxy configuration explicitly instead of silently continuing as browser-only processing.

### Changed
- Bumped the web app package to `0.1.158`.

## [0.1.157] - 2026-07-22

### Fixed
- Prevented a delayed proxy setup task from assigning a newer config version to a stale pre-approval whitelist snapshot.
- Reset worker config version state when replacing a delegation so the new delegation can apply config version 1.
- Added deterministic race coverage and a public-relay deferred-request approval and issuance check.

### Changed
- Raised generated proxy launcher minimums to audit proxy `0.1.48`.
- Bumped the web app package to `0.1.157` and audit proxy package to `0.1.48`.

## [0.1.156] - 2026-07-22

### Fixed
- Allowed same-origin and Blob workers in the browser CSP so proof-of-work mining can run in Chrome without being blocked.

### Changed
- Bumped the web app package to `0.1.156` and audit proxy package to `0.1.47`.

## [0.1.155] - 2026-07-22

### Fixed
- Made proxy configuration versions and approved-voter whitelist snapshots atomic, so deferred proxy ballot requests become eligible after approval.
- Added worker config logs for version, whitelist, proxy-voter, and ballot-group counts.

### Changed
- Bumped the web app package to `0.1.155` and audit proxy package to `0.1.46`.

## [0.1.154] - 2026-07-21

### Fixed
- Proxy configuration now uses the current coordinator whitelist when voters are admitted or invitations are resent.
- Proof-of-work mining now runs in a browser worker so Chrome can render real progress updates.

## [0.1.153] - 2026-07-21

### Fixed
- Automatically synchronise a complete election configuration to an available selected audit proxy without repeatedly republishing its delegation.
- Added visible proxy CLI confirmation when a ballot plan or blind issuance bundle reaches voter relays.

### Changed
- Bumped the web app package to `0.1.153` and audit proxy package to `0.1.45`.

## [0.1.152] - 2026-07-19

### Changed
- Delegated proxy voters now receive an authenticated issuer-to-voter ballot plan after their first request. The coordinator no longer discloses the proxy allowance in voter invites; the worker holds the first request, validates the planned second request, and returns both signatures in one issuance bundle.
- Bumped the web app package to `0.1.152` and worker package to `0.1.44`.

## [0.1.151] - 2026-07-19

### Added
- Added configurable general-invite proof of work to questionnaire definitions, voter request mining progress, and organiser difficulty guidance.
- Added audit proxy worker `0.1.43` support for canonical proof verification before eligibility mutation or blind credential issuance.

### Changed
- Restored delegated proxy issuance for PoW questionnaires when the worker meets the new `0.1.43` minimum version.
- Bumped the web app package to `0.1.151` and worker package to `0.1.43`.

## [0.1.105] - 2026-06-18

### Changed
- Restyled the account/profile menu with flat filled surfaces, role/action icons, a wider identity tile layout, and separate Colour ID/QR actions.
- Changed the new-identity confirmation modal to use flat fills and a clearer key-refresh icon.
- Moved questionnaire question actions into compact icon buttons in the question header and kept reorder controls explicit instead of showing a drag handle.
- Split the ballot-index stepper arrows outside the number input so the arrow targets are larger without widening the control.
- Added questions now inherit the ballot index from the previous question, while duplicated questions keep the source question's ballot group.
- Bumped the web app package to 0.1.105.

## [0.1.104] - 2026-06-18

### Changed
- Updated voter and organiser UI polish: the voter profile menu now carries the voter short identity, submitted identity cards use a compact two-panel Colour ID/QR layout, and the new-identity confirmation uses the refined in-app modal copy.
- Split Colour ID and QR preview actions so each opens only the selected identity view.
- Changed new questionnaire questions to default to ballot index 1 instead of auto-incrementing, while preserving ballot grouping on duplicated questions.
- Added larger custom ballot-index stepper arrows and a transient `Submitting...` state for voter response submission.
- Renamed organiser `New round` copy to `Add session` across app copy and docs.
- Bumped the web app package to 0.1.104.

## [0.1.102] - 2026-06-18

### Changed
- Added regression coverage for proxy configuration using the just-published questionnaire definition instead of stale cached definition state.
- Added audit proxy public-definition intake tests for normal loads, matching-hash loads, stale-hash recovery, wrong-key rejection, and wrong-author rejection.
- Hardened audit proxy public-definition intake to ignore definition events not signed by the configured organiser.
- Raised generated launcher minimum-version checks to audit proxy 0.1.31.
- Bumped the web app package to 0.1.102 and audit proxy package to 0.1.31.

## [0.1.101] - 2026-06-18

### Fixed
- Fixed audit proxy configuration immediately after publishing so it uses the just-published questionnaire definition and event id instead of stale React state for the definition hash.
- The audit proxy now recovers from a stale expected public-definition hash when the fetched public definition's blind-signing key id matches the configured private key, then stores the fetched definition hash for later issuances.
- Raised generated launcher minimum-version checks to audit proxy 0.1.30.
- Bumped the web app package to 0.1.101 and audit proxy package to 0.1.30.

## [0.1.100] - 2026-06-18

### Changed
- Bumped the audit proxy to 0.1.29 and raised generated launcher minimum-version checks to 0.1.29.
- Wrapped the pasted Linux Direct command-line launch in a shell function so setup/version failures return to the current shell instead of closing an SSH session.
- Bumped the web app package to 0.1.100.

## [0.1.99] - 2026-06-18

### Changed
- Added gzip+base64url compressed bundle envelopes for large blind request and blind issuance bundle DMs, with automatic plain JSON fallback for small or non-beneficial payloads.
- Organiser, voter, and audit proxy intake now decode compressed bundle wrappers before parsing the original bundle envelope.
- The audit proxy now compresses large bundled issuance replies while preserving plain JSON replies for small bundles.
- Added web and worker tests for compressed bundle decoding and fallback behaviour.
- Raised the generated audit proxy launcher minimum version to worker 0.1.28 for compressed bundle handling.
- Bumped web app package to 0.1.99 and worker package to 0.1.28.

## [0.1.98] - 2026-06-18

### Changed
- Added organiser ballot index controls so multiple questions can share one ballot credential while others keep independent credentials.
- Voter per-question flow now renders and submits all questions in the active ballot index group together, using one scoped proof for the group.
- Runtime, coordinator, and audit proxy scope matching now treat `slotIndex + version` as the live ballot scope key.
- Updated protocol docs and public explainers for grouped ballot-index credentials.
- Raised the generated audit proxy launcher minimum version to worker 0.1.27 for grouped ballot-index scope handling.
- Bumped web app package to 0.1.98 and worker package to 0.1.27.

## [0.1.97] - 2026-06-18

### Changed
- Public questionnaire definitions are now the source of truth for organisers, voters, observers, and audit proxies.
- Invite links, invite DMs, and audit proxy election-config DMs now carry questionnaire pointers and relay hints instead of embedding questionnaire definitions.
- Blind credential issuance DMs now carry only credential/signature data plus a public-definition hash or event id, reducing bundled issuance payload size and relay churn.
- Voters cache fetched public definitions locally for offline rendering, retry, and submission.
- Raised the generated audit proxy launcher minimum version to worker 0.1.26 for definition-reference credential issuance.
- Bumped web app package to 0.1.97 and worker package to 0.1.26.

## [0.1.96] - 2026-06-18

### Changed
- Compact blind issuance bundle DMs now carry the shared questionnaire definition once at bundle level instead of repeating it inside every credential.
- Raised the generated audit proxy launcher minimum version to worker 0.1.25 because older workers repeat the questionnaire definition in bundled issuance DMs.
- Bumped web app package to 0.1.96 and worker package to 0.1.25.

## [0.1.95] - 2026-06-18

### Changed
- Bundled per-question blind ballot requests into one voter-to-organiser/proxy DM per session request.
- Bundled multi-credential blind issuances into one organiser/proxy-to-voter DM per recipient.
- Raised the generated audit proxy launcher minimum version to worker 0.1.24 because older workers do not understand bundled request DMs.
- Bumped web app package to 0.1.95 and worker package to 0.1.24.

## [0.1.94] - 2026-06-17

### Fixed
- Shared in-flight voter ballot requests across runtime instances for the same questionnaire and voter, preventing duplicate request IDs for one per-question ballot scope.
- Preserved per-question blind request, token-secret, and issuance maps in voter self-state recovery so new session runtimes reuse the original credential request instead of starting a second one.

### Changed
- Bumped web app package to 0.1.94.

## [0.1.93] - 2026-06-17

### Fixed
- Reused the latest live audit proxy status for new delegated questionnaire setup instead of leaving later sessions pointed at an unstarted generated proxy account.
- Cleared stale generated proxy secrets when selecting or typing a different audit proxy npub, so the launch command and delegated proxy target cannot silently disagree.

### Changed
- Bumped web app package to 0.1.93.

## [0.1.92] - 2026-06-17

### Fixed
- Repaired organiser blind-signing key drift before publishing new questionnaire definitions, so voters do not request ballots against a stale public key.
- Recovered matching locally stored blind-signing private keys when configuring an audit proxy for an already-published questionnaire.
- Updated SimpleRound coverage for the current questionnaire/session UI after removal of legacy live-round ticket controls.

### Changed
- Bumped web app package to 0.1.92.

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
