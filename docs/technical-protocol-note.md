# Technical protocol note

This is the detailed protocol and implementation note for Auditable Voting. For the shorter public-facing explanation, see [`docs/project-explainer.md`](./project-explainer.md).

This document is written as a technical explainer for readers who want to understand:

- what the system is trying to achieve
- why it uses public relay infrastructure and blind signatures
- how voters, organisers, and observers interact
- what is public, what is private, and what can be verified

It is intended to read more like a protocol note than a product brochure: it describes the design goals, the concrete technologies used in the current implementation, the trust boundaries, and the places where the live system is still operationally weak.

For the questionnaire-first flow specifically, see the formal protocol reference at [`docs/questionnaire-blind-token-protocol.md`](./questionnaire-blind-token-protocol.md).

---

## 1. The Short Version

This project is an **anonymous, publicly auditable voting system**.

The intended model is:

1. A voter is confirmed as eligible by one or more organisers.
2. The voter asks those organisers to blindly sign a round-bound voting token.
3. The organisers return blind signature shares without learning the final token.
4. The voter assembles a usable token locally.
5. The voter publishes a ballot to Nostr using an **ephemeral** key.
6. Anyone can verify:
   - the ballot belongs to a real issued token
   - the token was not spent twice
   - the tally is computed correctly from public data

The main goals are:

- **privacy**: organisers should not be able to deanonymise ballots
- **auditability**: observers should be able to recompute the tally
- **portability**: the client can run as a static web app
- **resilience**: public relays act as the shared event layer (Nostr-compatible in the current implementation)

---


## Quick Start: Run an Auditable Vote in the Browser

This is the practical browser-based flow. The root landing page defaults to **Observer** for public verification; choose **Organiser** when setting up a questionnaire, then use a separate browser profile, private window, or second device for the voter so each role has its own local identity.

### 1. Organiser builds the questionnaire

1. Open the app as **Organiser**.
2. Create or load an organiser identity.
3. In **Setup**, enter the questionnaire name, description, and questions. Supported question types are yes/no, multiple choice, ranked-choice, and free text; free-text questions can also require organiser-encrypted responses. Ranked-choice answers are totalled as points, with the highest score preferred: first choice gets one point per available option, later choices count down from there, and unranked options get `0` points.
4. Use **Generate ID** only when you want a fresh questionnaire ID. Use **Copy ID** beside the Questionnaire ID when sharing the public identifier with observers.
5. Use **Show questionnaire link** if you want a QR/link for the questionnaire.
6. Optionally open **Settings → Relays** to add or remove questionnaire metadata relays before publishing if this round should prefer a non-default relay set.
7. Click **Go Live** when the draft is ready. This publishes the questionnaire definition and opens the round.

### 2. Optional: organiser enables an audit proxy

1. After publishing, click **Set up audit proxy** if this questionnaire should keep processing while the organiser browser is offline.
2. The audit proxy section opens and generates a proxy account.
3. Copy the **Quick start command** and run it on the machine that should host the proxy.
4. Configuration is confirmed automatically when a fresh proxy heartbeat appears. The organiser sends the active delegation and complete questionnaire configuration privately to that proxy; the proxy does not discover configuration from public relay history.
5. Wait for **Audit proxy status** to show the active proxy before relying on it for issuance or verification.

### 3. Organiser invites voters

1. Share the questionnaire link from **Voting** with **Copy link** or **Share**. These actions use the browser/device apps already available; no provider API key or service registration is needed.
2. Use **Create single-use invite link** in **Voters** when the organiser wants a one-use bearer invite. New links carry the private code only in the URL fragment as `#invite_code=...`; the questionnaire, organiser, relay, ballot-request, credential, and group parameters remain in the query. On entry, the browser accepts either fragment aliases or previously issued query-string aliases, then immediately scrubs `invite_code` and `code` from both locations and retains the normalised code only in the current history entry, not local storage or backups. Each invite appears in **Participants** with an internal note, voter status, vote/result status for the selected questionnaire, QR code, and actions. **Mark as used** records manual use and makes an unclaimed link unavailable; clearing it makes the unclaimed link available again. Voter status shows whether the link has been claimed, a ballot has been sent, a vote has been submitted, or the organiser has manually marked it as used. The voter looks up organiser and audit-proxy routing from the public questionnaire metadata on Nostr, then automatically requests a ballot.
3. Add or import voter `npub`s in **Voters** when you want to invite voters once and reuse that eligibility for later questionnaires from the same organiser. Each invited voter can have an internal note, and remains eligible for later questionnaires until removed. Click **Apply to current questionnaire** to project the roster into the active questionnaire whitelist and publish one roster-free public questionnaire announcement. After one questionnaire is published, **Add session** appears under **Questionnaire**, creates a fresh questionnaire ID from the current setup, and offers only **Publish to invited voters**, which publishes and projects the roster in one flow. The roster is organiser-local; it is not published and is not a reusable ballot credential.
4. Use **Copy personalised link** beside an invited/whitelisted voter when the link should carry that invited voter `npub`. The voter must still sign in as that `npub`; the personalised URL reveals the invitee `npub` to whoever sees the link.
5. Send Nostr invite DMs with **Invite** beside each Nostr invite voter. Voters who claimed a private link stay in the private invite cards and are not repeated in the Nostr invite action list.
6. Voters who arrive from a shared link without being whitelisted can still request a ballot. Pending requests appear in **Voters** -> **Participants** on **Voting**, where the organiser can approve and invite them.

### 4. Voter requests and submits

1. Open the invite link as the invited voter, or open the app as **Voter** and click **Check invites**.
2. Open the pending questionnaire.
3. Click **Request ballot** if the blind credential request does not start automatically. Current per-question questionnaires request a bundle with one scoped credential per ballot index, or two per index when that voter is marked as a proxy voter; large request bundles may be compressed before NIP-17 encryption, with plain JSON kept as the fallback.
4. Wait for the ballot credentials to be ready.
5. Answer the visible ballot group and click **Submit**. In per-question questionnaires, questions sharing a ballot index submit together, then Vote moves to the next unanswered ballot index.
6. After submission, Vote keeps submitted answers visible and locks the controls for those questions.
7. When several questionnaires from the organiser are available, Vote labels the selector by round and local status, and **Answer next** opens the next unanswered questionnaire.
8. **Messages** is limited to the organiser target for the active public questionnaire link. With one organiser it opens directly to the thread; Enter sends and Shift+Enter inserts a line break.
9. If no proxy is selected, the organiser browser must stay online long enough to process requests and responses. If a proxy is selected and active, the voter can wait for the proxy instead.

### 5. Organiser or proxy processes responses

1. In the organiser **Voting** tab, **Live Status** and the results dashboard show live accepted-response totals, per-question result bars, and text responses as submissions are processed. **Voters** -> **Participants** shows private invite rows, pending voter requests, and received vote/result details for the selected questionnaire.
2. If delegated, leave the helper running and check its heartbeat/reporting in **Audit proxy status**.
3. Close the questionnaire and publish final results when collection is complete, if you want a fixed final summary.

### 6. Observer verifies

1. Open the app as **Observer**.
2. Search by organiser `npub` or questionnaire ID.
3. Confirm submitted votes, accepted responses, expected participant count, and result percentages from the public events.
4. The observer can show current accepted responses before closure when public response and decision events are available.

### Operational notes

- If a voter sees no invite, confirm they are using the same voter identity that was invited.
- Signed-in voters with no active invite now do a low-rate automatic invite refresh, so new invites should appear without manually pressing `Check invites`.
- A voter should not see unrelated questionnaires unless they have invite/state context for that identity.
- Relay connection failures for one endpoint are common on public infrastructure; retries and other relays should still allow progress.
- Private questionnaire recovery now uses shared websocket inbox subscriptions, duplicate-event suppression before signer decrypt, sticky successful relay subsets, and bounded refreshes on focus/visibility/online instead of relying only on repeated timer-driven resend loops.
- While waiting for a ballot on signer-backed mobile browsers, the client now mostly re-arms DM subscriptions and only falls back to low-rate mailbox refresh reads, reducing Amber bunker/rate-limit churn while still recovering when push delivery is missed. Successful signer DM decrypts are cached per event so repeated recovery scans do not keep re-asking Amber to unwrap the same gift-wrapped message.
- Blind issuance discovery now also performs one broader relay fallback scan when the narrow recipient relay subset is empty, reducing cases where a ballot is visible in another Nostr client before the vote UI notices it.
- In organiser results, free-text values stored as `enc:nip44v2:` can now be decrypted locally when the organiser key is available.
- Organiser `Closing / Closed` metadata now reflects actual close-state timing and marks overdue open rounds as `Past due` to avoid misleading historical timestamps.
- Observer organiser filters are now retained across refresh/fetch churn, and selected-round refreshes use lighter serial kind-only relay reads plus one consolidated live questionnaire subscription to reduce relay notice spam.

---

## 2. What Problem It Solves

Traditional online voting systems often force a tradeoff:

- either the operator knows who voted for what
- or the public cannot independently verify the result

This project tries to avoid both failures.

It separates the process into two parts:

- **issuance**: proving a voter is allowed to vote and giving them a private credential
- **voting**: spending that credential anonymously in public

That split is the reason blind signatures matter.

---

## 3. Core Idea

The key trick is:

- an organiser signs a **blinded** message
- the voter later **unblinds** it
- the final token is valid
- but the organiser should not be able to link the final token back to the specific issuance request

For current questionnaire credentials, that means the blind request contains the blinded message but not the final token commitment, and the blind issuance contains the blind signature but not the final token commitment. The final token commitment appears only when the anonymous response is published, after unblinding in the voter's browser.

That gives the voter a token which is:

- valid
- anonymous
- publicly spendable once

---

## 4. Main Actors

### Voter

The voter:

- has a real long-term Nostr identity
- proves eligibility out of band
- requests blind signatures
- combines enough shares
- votes using an **ephemeral** ballot key

### Organiser

An organiser:

- verifies voter eligibility
- publishes voting rounds
- exchanges round-control messages with other organisers
- issues blind signature shares
- validates ballots
- tallies votes

### Observer / Validator

An observer:

- watches public Nostr events
- verifies ballot validity rules
- rejects duplicates
- recomputes the tally independently

### Nostr Relays

Relays are the shared event layer:

- organiser control carrier events
- public rounds
- public ballots
- public results
- private encrypted mailbox objects for issuance-related traffic

---

## 5. High-Level Architecture

```mermaid
flowchart LR
  V[Voter Browser]
  C1[Organiser A Browser]
  C2[Organiser B Browser]
  N[Nostr Relays]
  O[Observer / Observer]
  B[(IndexedDB / Local State)]

  V --> B
  C1 --> B
  C2 --> B

  V <--> N
  C1 <--> N
  C2 <--> N
  O <--> N
```

### Storage model

The migration direction is:

- **Nostr**: canonical shared state
- **IndexedDB**: local active state and secrets
- **Blossom**: optional public compressed final result packs, plus planned encrypted backup bundles

This matters because the system is trying to move toward a client-side model, not a traditional central server.

### Technologies used in the current implementation

The present web client is built with:

- **React 18** for the voter, organiser, and observer interfaces
- **TypeScript 5** for the browser application logic
- **Vite 5** for local development and static-site bundling
- **`nostr-tools` 2.x** for Nostr keys, event signing, subscriptions, and relay publishing
- **a dedicated organiser-control carrier over Nostr** for round proposals, commits, tally coordination, and recovery checkpoints
- **regular custom Nostr event kinds** for organiser control, live rounds, ballots, and questionnaire transcript events, so relays preserve the full transcript instead of replacing events in Nostr's replaceable ranges
- **NIP-17 gift-wrapped DMs** for follow, roster, MLS welcome, and share-assignment traffic
- **NIP-17 gift-wrapped DMs** for blind ballot requests, blind issuance delivery, ballot submissions, and acceptance results (with local mailbox fallback for same-browser recovery), plus encrypted mailbox objects for legacy ticket delivery, acknowledgement traffic, and history-based recovery, with stable `request_id`, `ticket_id`, and `ack_id` lineages. Large blind request/issuance bundle envelopes can be wrapped as gzip+base64url JSON before encryption; plain JSON remains valid for all decoders.
- **optional NIP-65 relay hints**, disabled by default, for relay discovery experiments
- **per-questionnaire relay hints** in public questionnaire metadata when the organiser uses a non-default relay set; voters cache those hints and prefer them for that questionnaire's public traffic, while NIP-17 private traffic filters out relays known to reject gift wraps
- **`@cloudflare/blindrsa-ts`** for the RSABSSA blind-signature primitive used in the current issuance path
- **Rust compiled to WebAssembly** for deterministic protocol logic, including validation helpers and the new organiser control engine
- **an optional Rust audit proxy runtime** (`worker/`) for election-scoped delegated issuance/verification operations over outbound-only relay connections, with organiser-signed delegation and revocation control
- **adaptive browser mailbox recovery and proxy DM polling with event-id dedupe**. Browser NIP-17 recovery pages backwards until the active request, issuance, or submission acknowledgement is found, or until a short time budget is reached; local-key voter sessions subscribe to request-ack and credential DMs through the same raw `nsec` decrypt path used by recovery. Delegated blind requests go only to the issuer proxy. The voter and proxy separately send authenticated, privacy-limited participant statuses to the organiser, and voter receipt acknowledgements return to the proxy. The proxy uses a broad fixed lookback for delegated blind requests because it runs as a dedicated worker, persists exact issuances for stable replay, publishes status heartbeats back to the organiser, uses active delegation control relays in addition to startup relays, short debug-logs decrypted DM metadata without encrypted payload dumps, decodes compressed request bundles, can redeem one-use private invite-code hashes from the organiser config, can publish a delegated close event plus result summary once all expected invitees have accepted valid responses, stays running for later sessions until stopped from the command line, and separates public/delegation relays from private-DM relays
- **an optional FIPS host launcher** (`web/public/fips-host/launch-auditable-voting-fips.sh`) that builds the upstream FIPS Rust daemon, enables `fips-overlay-v1` Nostr endpoint adverts, installs the complete Vite static build on the host's `fips0` address, opens the chosen mesh web port through the FIPS firewall, and can install the audit proxy as a disabled systemd service
- **a real OpenMLS-backed organiser engine inside the Rust core**, hidden behind a stable Rust abstraction so the browser code does not depend on MLS types directly; the browser organiser path now bootstraps and joins the supervisory MLS group through Nostr carrier events, and the lead waits for sub-organiser welcome acknowledgement only after the non-lead has completed an initial organiser-control backfill pass before opening the first public round in the repaired small live cases
- **a Rust mixed-replay engine for public rounds and ballots**, now used by the voter, organiser, and observer public-state views to derive round state, accepted ballots, and rejection reasons
- **versioned Rust snapshots and replay diagnostics** for the shared protocol engine, so the browser can restore state, validate snapshot compatibility, and surface replay issues without re-implementing protocol rules in TypeScript
- **organiser runtime readiness diagnostics** surfaced in the browser for MLS join, welcome acknowledgement, initial control backfill, auto-approval, round-open safety, blind-key safety, and ticket-plane safety
- **startup control-carrier diagnostics** for exact publish payloads, live/backfill filter shapes, relay write/read overlap, and `kind_only` versus filtered startup probes
- **single-organiser deterministic startup bypass** so `1 organiser` runs do not block on MLS join/group observation paths
- **blind-key publication diagnostics** that classify not-attempted vs publish/observe/apply stalls and expose event/relay evidence
- **private-first questionnaire flow** with organiser/voter UI panels, RSABSSA blind-token issuance, ephemeral response npubs, transport helpers, and relay-harness metrics
- **staged questionnaire organiser builder** (`Questionnaire` -> `Participants` with live results -> `Settings`) with zero default questions and explicit publish readiness checks
- **voter questionnaire vote gating** that only enables Vote after announced questionnaire ids are verified as publicly readable (`definition` present + state `open`/`published`)
- **questionnaire discovery over direct live subscriptions** with one startup backfill plus one bounded retry, and explicit per-voter discovery timing diagnostics for startup visibility failures
- **voter draft preservation** so response fields are not cleared when a blind ballot credential or refreshed definition arrives for the same questionnaire
- **linked invite login and no-service share actions** that open the public questionnaire without scanning old encrypted invite DMs, with roster-free public questionnaire discovery, recent bounded signer DM reads for manual invite checks, and credential-result polling
- **Android signer routing** that prefers Amber through NIP-46 when available, keeping signer-backed questionnaire DM operations on one signer identity
- **gateway Nostr Connect helpers** that present login controls in order (`Signer`/`nsec`, then `NOS2X-FOX`/`Amber`, then a single login action), can generate/copy a `nostrconnect://` URL, show it as a QR code, and expose an Amber-compatible `bunker://` (`nsecbunker`) copy path
- **blind DM relay targeting** so blind request, issuance, and recovery DMs resolve recipient `kind:10050` relay-list hints before the smaller static fallback set; public submission decisions are the normal acceptance signal for protocol-v2 questionnaire responses
- **strict DM delivery confirmation** so blind-request and ballot-submission flows only mark "sent" after at least one relay confirms acceptance, avoiding silent transport failure states
- **clearer voter ballot progress** that labels the per-questionnaire voting identity separately from the signer account and shows request, credential, and response state
- **safer voter tab switching** so `Vote` remains available for browsing current and older invited questionnaires and background invite refresh does not force the UI away from Join/Settings
- **self-copy submission recovery** that sends a best-effort encrypted copy of each ephemeral-key submission to the voter's login identity, so returning voters can recover submitted response markers and answers from their own NIP-17 mailbox
- **organiser self-copy state recovery** that sends organiser questionnaire state snapshots (excluding private blind-signing key material) to the organiser's own NIP-17 mailbox so signed-in organisers can recover state after reload/login
- **relay-copy quorum checks for state backups** so voter/organiser self-state DM snapshots are only marked successful after read-after-write confirmation on at least two relays
- **single-flight organiser queue processing** so automatic request/submission checks do not overlap relay work
- **idempotent ballot resend** so a voter can resend the same blind request, the organiser republishes the existing credential DM, and background loops avoid rebroadcasting already delivered credentials
- **more redundant DM delivery** that mixes recipient NIP-17 relay hints with fallback relays, widens credential publish fanout, and retries issued credentials until submission proves receipt
- **wider bounded signer DM scans** for invite/issuance/acceptance recovery so Amber/signer users are less likely to miss valid envelopes in busy relay histories
- **foreground credential recovery polling** so voters waiting for a blind ballot automatically run the manual status-refresh path every 8 seconds while the page is visible
- **explicit questionnaire phase acknowledgements** for blind request receipt, credential receipt, and anonymous submission receipt, so resend logic can stop once delivery is confirmed instead of inferring success only from later state; only the voter's valid all-credential acknowledgement advances the identity-linked organiser participant state to **Ballot received**, including when a delegated proxy issued the credentials, and no later submission or decision identifier is attached to that participant
- **shared recipient inbox subscriptions + sticky relay preferences** so private questionnaire reads reuse one websocket inbox per recipient, remember recently successful relays per questionnaire, and trigger bounded lifecycle recovery on foreground/network return
- **course-feedback organiser bypass** so legacy live-round / blind-key / ticket queue gating is disabled for questionnaire acceptance paths, with explicit debug assertions for bypass state
- **course-feedback batch orchestration** in the live harness (`LIVE_BATCH_SIZE`, default `5`) so enrolment and submission advance in checkpointed waves instead of all-voter cold-start concurrency
- **questionnaire response observation fallback** that prefers bounded kind-only reads plus local questionnaire-id filtering (and relay probes) when custom tag-indexed reads are unreliable on public relays
- **observer organiser filtering + search** so public round review can be scoped by lead organiser, organiser npub, and free-text query (npub/round ID/prompt), with visible-page polling for selected-round updates plus explicit manual Refresh for immediate reloads
- **observer historic search** so the normal view stays bounded to recent questionnaire data, but observers can explicitly scan a wider historical window when an older published questionnaire or public result payload is missing
- **observer questionnaire discovery** so recent public questionnaire definitions are read by kind-only backfill when no questionnaire ID is selected, with state, replaceable expected-participant count events, live verified response totals, and published response totals shown when available
- **ticket scheduler diagnostics and tunable transport knobs** for first-send prioritisation, resend eligibility reasons, bounded concurrency, and retry-age experimentation during live relay reliability testing
- **observation-plane recovery diagnostics** that separate live vs backfill visibility and classify resend recoveries for published-but-unobserved tickets
- **request-id keyed mailbox reader bindings** with immutable per-request mailbox ids for live/backfill ticket observation, plus explicit read/backfill mailbox-consistency diagnostics
- **IndexedDB** for browser-local active state
- **WebCrypto** for local encryption and passphrase-protected state

That mix matters scientifically because the system is not just a protocol sketch. It is a concrete static web application built from standard browser primitives, a public event network, and a conservative blind-signature library.

---

## 6. What Is Public vs Private

### Public on Nostr

- organiser-control carrier events
- round announcements
- organiser identities
- blind key announcements
- ballots
- tally / result events

### Private or local

- organiser private signing keys
- voter private keys
- blind request secrets
- unspent credential material
- organiser control snapshots and replay checkpoints
- local cache / restore bundles

### Private mailbox traffic

- follow / join coordination
- blind issuance requests
- blind issuance responses sent directly from each organiser to the voter
- ticket acknowledgements
- for initial course-feedback mode (`1 organiser / 25 voters / 1 round`), acknowledgement visibility is best-effort and valid ballot acceptance is treated as delivery confirmation
- automatic retry of unacknowledged ticket delivery with stable logical ids
- periodic history backfill for missed live rounds and mailbox objects

### Organiser control path

The organiser-to-organiser control path is now separate from the voter issuance path.

In the current migration phase:

- organisers publish typed control envelopes to a dedicated Nostr carrier stream
- the browser feeds those events into a Rust/Wasm engine
- the Rust engine applies canonical ordering, replay, and state transitions
- the lead only publishes the public live round after that control state reaches round-open agreement and the supervisory MLS path has confirmed first-round welcome application plus initial non-lead control-plane sync

That means organiser round agreement is no longer inferred ad hoc from UI state or DM arrival order.

### Public replay path

The public round and ballot plane is also moving under Rust protocol control.

In the current migration slice:

- public round-open events and public ballot events are normalised by the browser bridge
- the Rust/Wasm core replays those events under one canonical ordering rule
- ballot acceptance uses one fixed rule, documented in code: **first valid ballot wins**
- accepted ballots now carry stable `request_id` / `ticket_id` lineage through Rust replay for organiser row mapping and harness truth
- the voter, organiser, and observer public-state views now consume that Rust-derived state instead of separate TypeScript reducers

---

## 7. The End-to-End Flow

```mermaid
sequenceDiagram
  participant V as Voter
  participant N as Nostr
  participant L as Lead
  participant C as Sub-organiser
  participant R as Rust/Wasm Organiser Engine
  participant O as Observer

  L->>N: Publish organiser control draft / proposal / commit
  C->>N: Publish organiser control commit
  N->>R: Replay control events canonically
  R->>L: Round open agreed
  L->>N: Publish round announcement
  L->>N: Publish round blind key
  C->>N: Publish sub-organiser blind key
  V->>N: Discover round + organiser keys
  V->>L: Send blinded issuance request (DM)
  V->>C: Send blinded issuance request (DM)
  L->>V: Send lead signature share (DM)
  C->>V: Send sub-signature share (DM)
  V->>V: Unblind and assemble token locally
  V->>N: Publish ballot from ephemeral key
  O->>N: Read ballot stream
  O->>O: Verify token validity + uniqueness
  O->>O: Recompute tally
```

---

## 8. Round Announcement

An organiser publishes a live round. In the simple flow this includes:

- `voting_id`
- prompt / question
- threshold information
- authorised organiser roster

This tells voters:

- which round is active
- which organisers are valid for the round
- how many shares are needed

### Why round-bound matters

Tickets or tokens are tied to a specific `voting_id`.

That prevents a credential issued for round A from being replayed in round B.

---

## 9. Blind Key Announcement

Each organiser publishes a **per-round blind-signing key announcement**.

That key is:

- specific to the round
- signed by the organiser’s stable identity
- used for validating that round’s blind shares

This is important because it avoids using one long-lived blind-signing key for every election forever.

```mermaid
flowchart TD
  I[Stable Organiser Identity]
  K[Per-Round Blind Key]
  R[Round / voting_id]

  I --> K
  K --> R
```

---

## 10. Blind Issuance

The voter never asks the organiser to sign the final token directly.

Instead:

1. The voter creates a token message locally.
2. The voter blinds it.
3. The blinded request is sent to the organiser.
4. The organiser signs the blinded request.
5. The voter unblinds the result locally.

```mermaid
flowchart LR
  M[Token Message]
  B[Blinding]
  BR[Blinded Request]
  S[Organiser Signs]
  BS[Blind Signature Share]
  U[Unblinding]
  T[Usable Token Share]

  M --> B --> BR --> S --> BS --> U --> T
```

If done correctly, the organiser signs *something valid* without learning the final token that will later appear in public voting.

---

## 11. Threshold Model

The target direction is a threshold model:

- multiple organisers may issue shares
- the voter needs enough valid shares to vote

Example:

- 3 organisers exist
- threshold is 2-of-3
- any 2 valid shares are enough

```mermaid
flowchart LR
  C1[Organiser A Share]
  C2[Organiser B Share]
  C3[Organiser C Share]
  T[Threshold Check]
  V[Valid Voting Token]

  C1 --> T
  C2 --> T
  C3 --> T
  T --> V
```

### Important validation rule

Shares must be checked against:

- the round’s authorised organiser roster
- the round’s blind key announcements
- the threshold rule for that round

---

## 12. Ballot Publication

Once the voter has enough valid share material:

- the voter creates an **ephemeral** ballot keypair
- the voter publishes a public ballot to Nostr

The public ballot should expose only what is needed to verify the vote, not what would link it back to issuance. That is where the privacy property from blind issuance either survives or gets lost.

### Public ballot goals

- contains the vote choice
- contains anonymous proof material
- can be validated publicly
- omits issuance-linking fields, so the organiser cannot tie the final ballot back to the original blind request
- includes the final token commitment only as public proof material, never as something previously sent through the eligibility or issuance path

---

## 13. Duplicate Spend Prevention

A valid anonymous vote is still only supposed to count **once**.

That means the system needs deterministic duplicate handling:

- if the same token is spent twice
- everyone must agree which spend counts
- later spends must be rejected

The current direction is:

- first valid spend wins
- ordering must be **canonical**, based on signed Nostr event metadata
- all observers should converge on the same result

```mermaid
flowchart TD
  A[Ballot A with Token X]
  B[Ballot B with Token X]
  O[Canonical Ordering Rule]
  K[Keep First Valid Spend]
  D[Discard Duplicate]

  A --> O
  B --> O
  O --> K
  O --> D
```

This is a correctness problem, not just a UI problem.

---

## 14. Auditability

An outsider should be able to reconstruct the tally from public events.

That means:

- ballots are public
- duplicate rejection is deterministic
- tallying rules are deterministic
- results are reproducible from relay history
- organisers publish a separate parameterised replaceable expected-participant count event, so observers can compare accepted responses with expected turnout without seeing the private invite list

```mermaid
flowchart LR
  E[Nostr Events]
  V[Validate Ballots]
  U[Reject Duplicates]
  T[Compute Tally]
  R[Independent Result]

  E --> V --> U --> T --> R
```

Before a final result summary exists, the Observer view derives a live summary from verified public submissions and separate public per-question provisional response events. Provisional events are signed by the same anonymous ballot identity that will sign the final submission for that credential, so newer hints from that ballot replace older hints. They are muted chart hints only; they contain no blind-token proof and do not count for the audit result. Verified blind-token submissions and public decisions remain the auditable source.

---

## 15. Why Nostr

Nostr gives the project a shared, replayable event layer without requiring one central database.

Benefits:

- multi-relay distribution
- public reproducibility
- portable client architecture
- no single relay is supposed to be the whole truth

In this repo, relay selection can optionally use **NIP-65 inbox/outbox hints** so senders and receivers can better choose where to publish and subscribe.

That path is currently **disabled by default** in the UI, because a tighter curated relay set has been more reliable in practice than always expanding through public relay hints.

The current client also distinguishes between:

- **publish fanout**, which can still send to several relays
- **read/subscription fanout**, which is intentionally kept to a smaller primary subset

That split reduces relay-side `too many concurrent REQs` failures while keeping the write path reasonably redundant.
Automatic voter and organiser actions are also paced with a random `0-30s` delay, slower retry windows, a shorter organiser startup recovery burst, tag-filtered paginated public questionnaire refresh reads, adaptive blind-DM history reads, consolidated organiser/voter/observer questionnaire subscriptions, and a sender-scoped ticket publish queue so many browser actors do not all publish or query into the same public relays at once. The browser caps foreground private-DM reads to two NIP-17 relays and mailbox reads/subscriptions to three relays so Firefox and mobile browsers do not exhaust their WebSocket budget during recovery bursts. The audit proxy defaults and generated helper commands split public/delegation relays from private-DM relays: NIP-17 worker DMs default to vm-1734.lnvps.cloud, relay.nostr.net, and nos.lol. Relays that reject kind `1059`, require unsupported browser read authentication, or reject worker connections are excluded. Signed delegations carry this private relay set to voters. Older persisted delegated relay hints are retained but retried with per-relay exponential backoff when they fail. When delegated, the proxy can close the questionnaire only after the accepted valid response count reaches the expected invitee count; rejected or duplicate submissions do not count. After delegated closure and summary publication complete, the proxy keeps running for later sessions until it is stopped from the command line. Mailbox publishes keep one deterministic anchor relay, rotate secondary relays by recipient, and apply temporary cooldowns when relays return rate-limit/pow/spam/policy failures.

---

## 16. Why Local State Still Exists

Even in a client-side architecture, some things cannot live only on relays:

- private keys
- blind request secrets
- pending local voting state
- restore data

That is why IndexedDB matters.

The browser stores:

- local identities
- cached round state
- blind request state
- received shares
- organiser private material

Planned backup direction:

- export encrypted bundles
- optional upload to Blossom
- restore on a new device

Final result summaries can also reference a public Blossom CSV result pack. The pack is mirrored to at least two Blossom servers when upload succeeds. Clients verify the uploaded blob size and SHA-256 from the summary before displaying rows. The same CSV can be opened directly in spreadsheet tools and includes response IDs, submittor pubkeys, accepted/rejected status, rejection reasons, answers, nullifiers, token commitments, and blind-token signatures/proofs.

---

## 17. Security Goals

The intended security properties are:

### Ballot privacy

Organisers should not be able to tell which final ballot belongs to which issuance request. The protocol enforces this by never giving organisers or proxies the final token commitment during request or issuance. They can store request ids, invitee identities, blinded messages, scopes, blind signatures, public nullifiers, and public commitments, but there is no shared value that bridges the eligibility request to the anonymous response.

### One-person-one-vote

Only eligible voters should receive valid voting credentials.

### No double voting

A token should only count once.

### Public verifiability

Anyone should be able to recompute the tally.

### No single organiser trust anchor

Threshold issuance means one organiser alone should not define the whole system.

---

## 18. Current State of the Repo

The repository now focuses on the client-side web app only:

- `/` now opens a login + role gateway instead of forcing voter mode
- role selection is explicit in the UI; compatibility URLs still use `role=coordinator` for Organiser
- signer login now tolerates delayed NIP-07 injection and `nostr:ready` signalling for Firefox/Android-style signer bridges
- `simple.html` is the main client-side shell
- voter flows use `Join`, `Vote`, and `Settings` tabs; organiser flows use `Questionnaire`, `Participants`, and `Settings`
- organiser round-open agreement now goes through a Rust/Wasm organiser-control service
- organiser control messages are replayed deterministically from Nostr history instead of being inferred from relay arrival order
- the voter, organiser, and observer public-state views now use shared Rust-derived replay state
- adding an organiser in the voter flow immediately starts the follow/notify DM path
- the lead organiser now auto-sends share indexes to sub-organisers
- each organiser sends its own ticket share directly to the voter
- non-lead ticket sends are slightly staggered by share index to reduce same-recipient relay bursts
- automatic follow, blind-request, ticket, and acknowledgement sends are randomly delayed by up to `30s` to better match real participants and reduce relay rate limiting
- invited voters now receive active questionnaire ids (`open`/`published`) through one roster-free public organiser announcement, so voter questionnaire selection can auto-populate without per-voter metadata DMs
- voter questionnaire submissions now spend blind-signed credentials from a fresh ephemeral response npub; current per-question questionnaires request one credential per ballot index, or two per index for voters marked as proxy voters, and spend one scoped credential with each submitted ballot group
- organiser follower rows expose per-ticket relay publish diagnostics
- Nostr is the shared state layer
- blind-share issuance is in the simple flow
- NIP-65 relay hints are optional and disabled by default
- live reads and subscriptions are capped to a small primary relay subset, public questionnaire refresh reads and blind-DM history reads are serialized, organiser/voter/observer questionnaire subscriptions are consolidated, and publishes can still fan out more broadly
- local browser state is used for active session data
- voter questionnaire participation history is kept in local browser state and carried inside voter backup/restore bundles

The older backend-oriented stack has been removed from this repository.
The client-only architecture is in place, but live relay reliability and recovery behaviour still need hardening.
Current live evidence is mixed: `1 organiser / 2 voters / 2 rounds` has completed cleanly in recent local-preview tests, while larger public-relay runs can still expose rate limiting and delayed convergence in the private ticket/ack path. The live harness now waits for the lead organiser to be visibly ready before firing round 1, organiser pages expose explicit runtime-readiness phases, failed live harness runs carry protocol-layer classification plus organiser/voter readiness snapshots, and automatic follow/request/ticket/ack sends are spread with random human-style delays plus longer retry windows. That improves diagnosis and reduces relay bursts, but repeated multi-organiser reliability at larger scale is still not signed off.

### Migration seam status

The current organiser-control seam is intentionally incremental:

- the voter issuance path still uses the existing blind-signature DM flow
- the public ballot and observer path still use public Nostr events, but the observer’s reducer logic is now Rust-owned
- the organiser control path and the observer’s public replay path now run behind the Rust/Wasm replay engine

That keeps the user-facing flow largely intact while moving the most order-sensitive organiser logic out of React components.

---

## 19. Current Risks and Hard Problems

The interesting parts of this project are also the risky parts.

### 1. Privacy can be broken by bad ballot design

If the public ballot includes issuance-linking fields, organiser-to-ballot anonymity is lost.

### 2. Duplicate handling must be canonical

If different observers disagree about which spend was first, the tally is not stable.

### 3. Organiser key custody matters

If organiser signing keys are exposed in browser storage, an attacker can mint fake voting rights.

### 4. Relay delivery is messy in the real world

Live relay behavior is probabilistic, so follow requests, announcements, blind requests, and tickets all need recovery and reconciliation logic.
The current app now does better at small scale by limiting live read fanout, widening organiser-control and ticket/ack traffic slightly beyond ordinary DM reads, backfilling both live rounds and ticket traffic from history, gating the first multi-organiser round on MLS welcome acknowledgement after non-lead control-plane sync, waiting in the live harness until the lead is visibly ready before firing round 1, queueing DM publishes per sender-recipient conversation instead of per recipient only, serialising one organiser's mailbox ticket publishes through a sender-scoped queue, keeping one deterministic mailbox anchor relay while rotating secondary relays by recipient, temporarily cooling down relays that return rate-limit/pow/spam/policy failures, adding random `0-30s` human-style delays before automatic follow/request/ticket/ack sends, increasing retry windows, preserving prior ticket attempt identifiers so later acknowledgements are not lost when a resend replaces the latest tracked response, and keeping shard-request ids stable end to end instead of letting the DM envelope and blind request disagree about the logical request id. That is enough to make the failure mode much clearer and to reduce relay-rate bursts, but it is still not enough to make large committee runs production-grade on public relays: the latest trustworthy `5 / 10 / 3` run before this request-id fix was getting materially through round 1, then timing out later under a mixed send/ack bottleneck, with acknowledgement visibility still worse than send-side delivery.

The live harness now also classifies failures at the protocol layer, not just the browser or harness layer. A failed run is labelled as `startup`, `dm_pipeline`, or `mixed`, and the timeout dump includes organiser readiness summaries plus per-voter round-visibility snapshots so the failure can be analysed without relying only on screenshots.

### 5. Cryptography must be conservative

Blind-signature code is not a place for “close enough”.

---

## 20. Mental Model for Teaching

A useful way to explain the system is:

> “A voter gets a private stamp of eligibility without revealing the final ballot token, then spends that token publicly once, and everyone can verify the tally.”

Or even shorter:

> “Private issuance, public spending, public audit.”

---

## 21. Teaching Diagram: The Whole Story

```mermaid
flowchart TD
  A[Eligible Voter]
  B[Blind Issuance Request]
  C[Organiser Blind Signature Shares]
  D[Local Token Assembly]
  E[Ephemeral Ballot Publication]
  F[Public Verification]
  G[Deterministic Tally]

  A --> B
  B --> C
  C --> D
  D --> E
  E --> F
  F --> G
```

---

## 22. Suggested Audience-Specific Summary

### For non-technical audiences

This project aims to let people vote anonymously online while still allowing everyone to verify the final count.

### For developers

This is a Nostr-based anonymous voting system using blind threshold issuance, ephemeral ballot identities, deterministic duplicate rejection, and replayable public tallying.

### For security-minded audiences

The project is attempting to separate voter eligibility from public ballot identity, so organisers can help issue voting credentials without being able to deanonymise the final vote.

---

## 23. One-Sentence Summary

**Auditable Voting is an attempt to combine anonymous credential issuance, public Nostr ballot publication, and independent tally verification in a client-heavy architecture.**

---

## 24. Questionnaire Runtime (Current Tranche)

The voter questionnaire now uses a single entry path:

- the questionnaire runtime is the default voter questionnaire path
- no `qflow` / `questionnaire_flow` URL gate is required for normal use

The questionnaire runtime currently provides:

- signer-based login entry points in voter/organiser questionnaire headers
- organiser admission roster, per-questionnaire whitelist projection, roster-free public questionnaire announcements, and invite actions
- organiser public-link sharing through copy and the native browser share sheet without API keys or external service accounts, plus one-use private code links with per-code share controls, per-invited-voter personalised links carrying legacy `coordinator` and `invited` URL parameters, and roster-free public announcements for repeated questionnaire sessions
- invite delivery over NIP-17 gift-wrapped DMs (`kind 1059` with `kind 13` seal / `kind 14` rumor), with bounded recent relay-history invite discovery on manual voter checks
- published questionnaire definitions that include the blind-signing public key and any non-default questionnaire relay hints, plus local definition caching and pointer-only invites, so voters can render linked questionnaires, prefer the organiser-selected relay set, and request ballots even when the signer cannot read historical invite DMs
- public-definition refreshes that do not clear drafted response fields
- RSABSSA blind request creation from a voter-held token secret
- organiser blind issuance processing over a blinded token message
- local unblinding and verification before ballot submission
- per-question ballot slots, where edited answer semantics bump the slot version and require a fresh scoped credential for that ballot index group
- fresh ephemeral response npubs for ballot submission, instead of using the invited voter npub as the response identity
- scoped accepted submission accounting with duplicate protection per credential/nullifier
- local resume keyed by election id and signer `npub`
- invite-link signer login opens the voter Vote tab directly, completes the signer-backed voter login, and can auto-prepare/send the first blind request once login is verified
- invited voters are stored in an organiser-local roster for repeated questionnaire sessions; when a questionnaire is active, the roster can be copied into that questionnaire's whitelist, the organiser publishes one roster-free public questionnaire announcement, the voter page discovers it and shows multiple questionnaires in a top selector with **Answer next**, and active audit proxies receive the per-questionnaire whitelist privately in their election-config DM
- private code links open the questionnaire directly, keep all `npub`s out of the URL, resolve organiser and audit-proxy routing from public questionnaire metadata, automatically request a ballot, store only a code hash in organiser state, redeem the first matching blind request into a normal whitelist entry, and admit that claimant for future questionnaires once the organiser sees the claim; active audit proxies receive the same hash registry in their election-config DM
- Android Amber NIP-46 sessions now request `sign_event`, `nip04_encrypt/decrypt`, and `nip44_encrypt/decrypt` up front during connect so later flow steps do not trigger capability escalation prompts
- invite/login npubs and local voter/responder npubs may differ; the invite can be opened against the current local voter identity, then the organiser either auto-issues for whitelisted voters or manually authorises unexpected requesters
- invites are durable and can remain idle indefinitely; ballot request retries preserve the same request id and re-queue until the organiser issues a credential, and credential issuances carry the public definition hash/event id as a recovery and verification hint. Large blind request and issuance bundles may be compressed before encryption, while small bundles stay plain JSON for compatibility.
- delegated blind-token routing is cached in the invite and election summary, and the voter still re-checks the public delegation before falling back to that cached audit proxy `npub`
- accepted DM submissions feed the same organiser response summaries as public questionnaire response events
- after a response is submitted, the voter Vote page shows the responder marker with its coloured pattern and expandable QR
