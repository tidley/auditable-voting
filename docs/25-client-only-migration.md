# 25. Client-Only Migration Plan

This document defines the migration from the current mixed frontend/backend architecture to a client-only runtime with:

- `Nostr` as canonical shared state
- `IndexedDB` as local active state
- `Blossom` as encrypted backup/restore storage

The target runtime is:

- static frontend hosted anywhere, including GitHub Pages
- coordinator logic running in the browser as an active client
- no authoritative HTTP coordinator API
- no Cashu mint HTTP dependency in the final design

## Storage Contract

### Nostr

Canonical public state:

- coordinator registrations
- round announcements
- sub-coordinator joins
- share-index assignments
- voter join/follow requests
- blind issuance requests
- blind issuance responses / receipts
- ballots
- spent markers
- round results
- validator audit reports

### IndexedDB

Local active state:

- voter and coordinator identities
- coordinator signing shares
- unspent and spent local voting credentials
- cached round state
- relay sync checkpoints
- imported backup bundles
- local UI/session preferences

### Blossom

Encrypted durable backups:

- identity-only bundles
- full voter state bundles
- full coordinator state bundles
- validator review bundles

Blossom is not canonical protocol state.

## Current Frontend File Map

### Simple UI runtime to keep and evolve

- [web/src/SimpleAppShell.tsx](/home/tom/code/auditable-voting/web/src/SimpleAppShell.tsx)
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)
- [web/src/SimpleIdentityPanel.tsx](/home/tom/code/auditable-voting/web/src/SimpleIdentityPanel.tsx)
- [web/src/SimpleCollapsibleSection.tsx](/home/tom/code/auditable-voting/web/src/SimpleCollapsibleSection.tsx)
- [web/src/TokenFingerprint.tsx](/home/tom/code/auditable-voting/web/src/TokenFingerprint.tsx)
- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
- [web/src/simpleVotingSession.ts](/home/tom/code/auditable-voting/web/src/simpleVotingSession.ts)
- [web/src/simpleShardCertificate.ts](/home/tom/code/auditable-voting/web/src/simpleShardCertificate.ts)
- [web/src/simpleVoteValidation.ts](/home/tom/code/auditable-voting/web/src/simpleVoteValidation.ts)

### New client-only support modules

- [web/src/simpleLocalState.ts](/home/tom/code/auditable-voting/web/src/simpleLocalState.ts)
- `web/src/simpleBlossomBackup.ts` (planned)
- `web/src/simpleBlindIssuance.ts` (planned)
- `web/src/simpleRoundState.ts` (planned)

### Existing full-app modules to retire only after cutover

- [web/src/coordinatorApi.ts](/home/tom/code/auditable-voting/web/src/coordinatorApi.ts)
- [web/src/mintApi.ts](/home/tom/code/auditable-voting/web/src/mintApi.ts)
- [web/src/cashuMintApi.ts](/home/tom/code/auditable-voting/web/src/cashuMintApi.ts)
- [web/src/cashuBlind.ts](/home/tom/code/auditable-voting/web/src/cashuBlind.ts)
- [web/src/cashuWallet.ts](/home/tom/code/auditable-voting/web/src/cashuWallet.ts)
- [web/src/proofSubmission.ts](/home/tom/code/auditable-voting/web/src/proofSubmission.ts)
- [web/src/App.tsx](/home/tom/code/auditable-voting/web/src/App.tsx)
- [web/src/VotingApp.tsx](/home/tom/code/auditable-voting/web/src/VotingApp.tsx)
- [web/src/DashboardApp.tsx](/home/tom/code/auditable-voting/web/src/DashboardApp.tsx)

These are not obsolete today. They only become obsolete once the corresponding client-only replacements exist.

## Phased Plan

### Phase 1. Local Active State Foundation

Goal:

- replace simple-page `sessionStorage` identity persistence with a shared local state layer
- add export/import of local backup bundles

Primary files:

- [web/src/simpleLocalState.ts](/home/tom/code/auditable-voting/web/src/simpleLocalState.ts)
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)
- [web/src/SimpleIdentityPanel.tsx](/home/tom/code/auditable-voting/web/src/SimpleIdentityPanel.tsx)

Status:

- implemented

What lands here:

- IndexedDB-backed actor persistence
- role-specific backup bundle download
- local backup restore

Files not yet obsolete:

- all backend/coordinator files remain in use

### Phase 2. Nostr-First Round Cache

Goal:

- move simple round/session cache into IndexedDB
- keep current UI responsive across reloads without treating browser storage as authoritative

Primary files:

- [web/src/simpleVotingSession.ts](/home/tom/code/auditable-voting/web/src/simpleVotingSession.ts)
- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
- `web/src/simpleRoundState.ts`
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)

What lands here:

- local cached rounds
- local cached followers/tickets/votes
- relay sync cursors
- deterministic rehydrate-from-cache then reconcile-from-Nostr flow

Status:

- partially implemented

What is implemented now:

- simple voter/coordinator local cache persists through the shared IndexedDB layer
- local backup bundles now include cached simple round/ticket/follower/vote state

What remains:

- dedicated relay sync cursor/checkpoint tracking
- explicit cache reconciliation module instead of component-local save/restore

Files not yet obsolete:

- backend/coordinator HTTP stack
- Cashu issuance stack

### Phase 3. Nostr-Native Coordinator State Machine

Goal:

- make coordinator join/registration/share-index assignment entirely Nostr-native and locally persistent

Primary files:

- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)
- [web/src/simpleVoteValidation.ts](/home/tom/code/auditable-voting/web/src/simpleVoteValidation.ts)

What lands here:

- stable per-round coordinator membership
- stable share-index assignments
- rebuild coordinator state from Nostr + IndexedDB only

Files that start becoming obsolete after this phase:

- backend coordinator orchestration paths used only for round/control state
- specifically [web/src/coordinatorApi.ts](/home/tom/code/auditable-voting/web/src/coordinatorApi.ts) for simple runtime needs

### Phase 4. Replace Cashu Mint Issuance with Direct Blind-Signature Issuance

Goal:

- remove the dependency on the Cashu mint for the simple runtime
- use browser-held coordinator signing shares directly

Primary files:

- `web/src/simpleBlindIssuance.ts`
- [web/src/simpleShardCertificate.ts](/home/tom/code/auditable-voting/web/src/simpleShardCertificate.ts)
- [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)

What lands here:

- blinded issuance request events
- blind-signature share response events
- client-side unblinding and share aggregation
- locally stored round-bound voting credentials

Status:

- partially implemented in the simple runtime

What is implemented now:

- dedicated round reconciliation via [web/src/simpleRoundState.ts](/home/tom/code/auditable-voting/web/src/simpleRoundState.ts)
- blinded issuance requests over NIP-17 in [web/src/simpleShardDm.ts](/home/tom/code/auditable-voting/web/src/simpleShardDm.ts)
- real blind-signature share objects in [web/src/simpleShardCertificate.ts](/home/tom/code/auditable-voting/web/src/simpleShardCertificate.ts)
- client-side unblinding in [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- a runtime verification script at [web/scripts/verify-simple-blind-shares.ts](/home/tom/code/auditable-voting/web/scripts/verify-simple-blind-shares.ts)

What remains:

- threshold aggregation beyond per-coordinator blind shares
- promoting the simple shell to the only shipped frontend path across every route
- removing legacy frontend entrypoints from the build once the remaining review/audit flow is ported

Files that become obsolete after this phase:

- [web/src/mintApi.ts](/home/tom/code/auditable-voting/web/src/mintApi.ts)
- [web/src/cashuMintApi.ts](/home/tom/code/auditable-voting/web/src/cashuMintApi.ts)
- [web/src/cashuBlind.ts](/home/tom/code/auditable-voting/web/src/cashuBlind.ts)
- [web/src/cashuWallet.ts](/home/tom/code/auditable-voting/web/src/cashuWallet.ts)
- [coordinator/voting-request-proof.py](/home/tom/code/auditable-voting/coordinator/voting-request-proof.py)

Current frontend cutover status:

- `index.html`, `vote.html`, and `dashboard.html` now mount the simple client-only shell
- the legacy backend-oriented React apps remain in-source but are no longer the primary shipped frontend routes

### Phase 5. Nostr-Native Ballot Spend and Tally

Goal:

- replace proof DM plus backend acceptance logic with Nostr-native spent markers and tally rules

Primary files:

- [web/src/simpleVotingSession.ts](/home/tom/code/auditable-voting/web/src/simpleVotingSession.ts)
- [web/src/simpleVoteValidation.ts](/home/tom/code/auditable-voting/web/src/simpleVoteValidation.ts)
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)

What lands here:

- spent-marker events
- canonical conflict handling
- deterministic first-valid-spend rules
- round result events

Files that become obsolete after this phase:

- [web/src/proofSubmission.ts](/home/tom/code/auditable-voting/web/src/proofSubmission.ts)
- [coordinator/voting-coordinator-client.py](/home/tom/code/auditable-voting/coordinator/voting-coordinator-client.py)
- [src/voterServer.ts](/home/tom/code/auditable-voting/src/voterServer.ts)
- [src/cli.ts](/home/tom/code/auditable-voting/src/cli.ts)
- [src/nostrClient.ts](/home/tom/code/auditable-voting/src/nostrClient.ts)
- [src/voterConfig.ts](/home/tom/code/auditable-voting/src/voterConfig.ts)

### Phase 6. Blossom Backup/Restore

Goal:

- add encrypted cloud-portable backups without making Blossom authoritative

Primary files:

- `web/src/simpleBlossomBackup.ts`
- [web/src/simpleLocalState.ts](/home/tom/code/auditable-voting/web/src/simpleLocalState.ts)
- [web/src/SimpleIdentityPanel.tsx](/home/tom/code/auditable-voting/web/src/SimpleIdentityPanel.tsx)
- [web/src/SimpleUiApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleUiApp.tsx)
- [web/src/SimpleCoordinatorApp.tsx](/home/tom/code/auditable-voting/web/src/SimpleCoordinatorApp.tsx)

What lands here:

- encrypted bundle export
- Blossom upload
- restore by Blossom pointer
- Nostr pointer events for backup references

Files not yet obsolete:

- validator and legacy dashboard code, until replaced

### Phase 7. Validator/Review Mode

Goal:

- provide a read-only client that rebuilds rounds from Nostr and optionally accelerates restore from Blossom bundles

Primary files:

- [web/src/SimpleAppShell.tsx](/home/tom/code/auditable-voting/web/src/SimpleAppShell.tsx)
- `web/src/SimpleValidatorApp.tsx`
- [web/src/simpleVotingSession.ts](/home/tom/code/auditable-voting/web/src/simpleVotingSession.ts)
- [web/src/simpleVoteValidation.ts](/home/tom/code/auditable-voting/web/src/simpleVoteValidation.ts)

Files that become obsolete after this phase:

- [web/src/DashboardApp.tsx](/home/tom/code/auditable-voting/web/src/DashboardApp.tsx)
- [web/src/App.tsx](/home/tom/code/auditable-voting/web/src/App.tsx)
- [web/src/VotingApp.tsx](/home/tom/code/auditable-voting/web/src/VotingApp.tsx)

## Obsolescence Summary

### Obsolete only after full client-only cutover

Backend/coordinator code:

- [coordinator/voting-coordinator-client.py](/home/tom/code/auditable-voting/coordinator/voting-coordinator-client.py)
- [coordinator/voting-request-proof.py](/home/tom/code/auditable-voting/coordinator/voting-request-proof.py)
- [src/voterServer.ts](/home/tom/code/auditable-voting/src/voterServer.ts)
- [src/cli.ts](/home/tom/code/auditable-voting/src/cli.ts)
- [src/nostrClient.ts](/home/tom/code/auditable-voting/src/nostrClient.ts)
- [src/voterConfig.ts](/home/tom/code/auditable-voting/src/voterConfig.ts)

Legacy frontend paths:

- [web/src/coordinatorApi.ts](/home/tom/code/auditable-voting/web/src/coordinatorApi.ts)
- [web/src/mintApi.ts](/home/tom/code/auditable-voting/web/src/mintApi.ts)
- [web/src/cashuMintApi.ts](/home/tom/code/auditable-voting/web/src/cashuMintApi.ts)
- [web/src/cashuBlind.ts](/home/tom/code/auditable-voting/web/src/cashuBlind.ts)
- [web/src/cashuWallet.ts](/home/tom/code/auditable-voting/web/src/cashuWallet.ts)
- [web/src/proofSubmission.ts](/home/tom/code/auditable-voting/web/src/proofSubmission.ts)
- [web/src/App.tsx](/home/tom/code/auditable-voting/web/src/App.tsx)
- [web/src/VotingApp.tsx](/home/tom/code/auditable-voting/web/src/VotingApp.tsx)
- [web/src/DashboardApp.tsx](/home/tom/code/auditable-voting/web/src/DashboardApp.tsx)

These remain necessary until their client-only equivalents are in place.
