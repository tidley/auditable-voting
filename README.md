# Auditable Voting

Static, browser-first questionnaire voting over Nostr relays.

Auditable Voting lets an organiser publish a questionnaire, invite voters for repeated questionnaire rounds, issue fresh blind ballot credentials, accept public blind-token responses, and let observers verify the public result stream. New questionnaire flows publish all questions together; each question may declare a numeric `requiredScope`, and each blind credential signs its `allowedScopes` so the verifier can enforce general and cohort-only questions at submission time. When a voter is marked as a proxy voter, that voter receives two independent credentials with the same allowed scopes and can submit two anonymous responses. It runs as a static web app, with an optional outbound-only Rust audit proxy for organiser-offline issuance, verification, closing, and result publication.

Live site: [npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol](https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/)

GitHub Pages mirror: [tidley.github.io/auditable-voting](https://tidley.github.io/auditable-voting/)

For a non-technical walkthrough, start with the [plain-English demo guide](docs/demo-guide.md). It avoids protocol terms and gives a short action-first flow for publishing a questionnaire, sharing an invite, submitting a response, and checking the result.

For the protocol boundary, trust model, and a proposed (not implemented) configurable proof-of-work design for general invites, read the [voting protocol specification](docs/voting-protocol-specification.md).

## Status

Experimental.

The active product is the client in `web/` plus the optional audit proxy in `worker/`. Public relay behaviour, browser key custody, and live-network convergence remain operational constraints. Do not treat this as production election infrastructure without independent protocol and implementation review.

The practical target is small-organisation and controlled-pilot voting, not high-stakes public elections. Before raising the stakes, define the threat model for the specific electorate, publish the operating procedure, and rehearse recovery, recount, dispute, and fallback paths. Remote browser voting cannot fully solve voter-device compromise or coercion by someone watching the voter; it can only reduce those risks with clear scope, receipt design, re-voting/spoil policy, and non-digital fallback.

## Features

- Browser voter, organiser, and observer flows.
- Nostr-first transport using public events and NIP-17 private control traffic.
- Per-questionnaire relay hints published in questionnaire metadata when the organiser uses a non-default relay set.
- Public questionnaire reads are tag-filtered by questionnaire ID, paginated, and serialised; organiser, voter, and observer live questionnaire subscriptions are consolidated to reduce relay-side concurrent `REQ` pressure.
- Before publishing a definition, the organiser makes a bounded public-relay collision check for its questionnaire ID. A different definition blocks publication and requires a new ID; an exact matching definition signed by the same organiser is treated as an already-published retry. Observer retains the selected questionnaire's discoverable same-ID definition history and offers an explicit selector labelled with creator, event ID, publication time, and question count, including the initial/original definition. The selected variant controls displayed questions and blind-proof verification; if no other variants are discoverable, Observer states the active definition event. Observer URLs pin a variant with `q`, `coordinator` (or `organiser`), and `definition`.
- Browser Nostr reads and writes share a relay health circuit breaker: repeated timeouts, rate limits, policy failures, or browser WebSocket resource errors cool a relay down before the next read, publish, or subscription tries it again.
- NIP-17 mailbox recovery pages backwards until the active request, credential, or submission decision is found, or until a short time budget is reached; local-key voter sessions also subscribe to request-ack and credential DMs through the raw local `nsec` path used by recovery, with foreground browser read fanout capped to avoid WebSocket exhaustion.
- Yes/no, multiple-choice, ranked-choice, and free-text questionnaire questions, including organiser-required encryption for free-text responses.
- Browser-only invite sharing by copied link, native device share actions, General QR links that open Vote directly and request a ballot automatically, personalised links for invited voter npubs, public questionnaire announcements for invited voters, or private code links managed from Voters with notes, share controls, and QR codes. A private link defaults to one voter, or can admit from 1 to 10,000 distinct voters; each claimant receives an independent blind ballot, or the configured two proxy ballots. New private links carry the bearer code only in the URL fragment as `#invite_code=...`; the app immediately removes `invite_code` and its legacy `code` alias from both query and fragment while retaining the normal questionnaire parameters and the code only in the current browser history entry. Previously issued query-string links remain accepted. Full private links show voters a clear unavailable state with Message organiser, Open general invite, and Back to Join actions when available; reopening a private link with the same local identity continues into the questionnaire. Voters includes a Participants subsection where private invites, access requests, and received votes for the selected questionnaire share one searchable roster, and pending access rows can be assigned Ballot and Proxy voter settings before approval. Opening Voter without an invite starts from a neutral Join screen instead of restoring old organiser targets.
- Organiser **Start demo** prepares and publishes a real “Neighbourhood Consultation Demo”, then guides the organiser through the general invite, a private invite, and a local resident-import preview. Resident records remain only in that browser; resident-number access and email OTP delivery are explicitly non-functional until a server-side verification service exists.
- Organiser-local invited voter rosters can be reused across later questionnaires; each row can carry an internal note, and every participant is automatically carried into later questionnaires until removed. Applying the roster to a questionnaire green-lights those voters and publishes one roster-free public questionnaire announcement, while each response still requires a fresh blind credential requested by the voter. The Participants state advances from **Ballot requested** to **Ballot received** only when the voter confirms every credential, including credentials issued by a delegated proxy. That is the terminal identity-linked state: submission IDs, answers, finalisation, and acceptance are never attached to the participant row. The organiser's top questionnaire selector stays visible on Session for switching questionnaires, and on Questionnaire setup pages it shows the live active draft or published item as the name and Questionnaire ID change. After publication, the setup fields remain visible but become read-only. After a questionnaire is published, **Add session** appears under **Questionnaire** when the organiser has at least one invited voter to carry forward; it generates a fresh questionnaire ID from the current setup and publishes directly to invited voters.
- Voter and organiser **Messages** sections for normal NIP-17 gift-wrapped direct messages, so voters can ask for help and organisers can reply without exposing the conversation publicly. Voter Messages opens as a dedicated page while the questionnaire stays mounted and hidden, preserving drafted answers. Enter sends from message windows, Shift+Enter adds a line break, voter public-link sessions scope contacts to the active questionnaire organiser, and questionnaire-link-only invite DMs are hidden from the voter helpline inbox/unread badge.
- Blind credential issuance for invited participants. New questionnaires can define up to 100 named voter groups with stable internal scope IDs; scope `0` covers Main questions and each voter credential adds only that voter's assigned group. Invites carry only the questionnaire ID, organiser npub, relay hints, per-voter allowed scope, and per-voter proxy allowance when needed; voters request scoped blinded messages in one private DM, receive blind signatures plus the matching public definition hash/event id in one private DM where possible, cache the fetched public definition locally, and submit the questionnaire response anonymously. Once received, the credential's signed `allowedScopes` is authoritative for question visibility, so a voter entering through a general public link still sees their assigned group-specific questions. Voters marked **Proxy voter** request two blinded messages with the same allowed scopes, producing two unlinkable credentials that can be spent as two anonymous submissions. Request and issuance DMs never carry the final token commitment that appears in the public response. Large request/issuance bundle DMs can be gzip-compressed before NIP-17 encryption; small bundles remain plain JSON.
- Public blind-token submissions from ephemeral response keys.
- Optional live per-question provisional response events for charts before the final blind-token submission arrives. These are separate public `questionnaire_response_provisional` events, signed by the same anonymous ballot response key that will sign the final submission for that credential; they carry no blind token and are display hints only, not accepted votes.
- Organiser and Observer results derived from public submissions and decisions, including proxy-accepted responses, locally verified blind-token proofs, rejection reasons, provisional live chart markers, and organiser-side automatic decryption of encrypted answer details when the local organiser key is available. Public decisions are the normal acceptance signal; private acceptance DMs are only a recovery path for older/private flows. Final summaries can point to a public Blossom CSV result pack mirrored to at least two servers; Observer verifies the advertised blob size and SHA-256 before using it as a relay readback fallback. The CSV opens directly in spreadsheet tools and includes response IDs, submittor pubkeys, accepted/rejected status, rejection reasons, answers, result-count metadata, nullifiers, token commitments, and blind-token signatures/proofs.
- Observer-local `nsec` entry for decrypting encrypted response details when the organiser key is deliberately supplied.
- Optional audit proxy that can issue credentials, verify submissions, publish decisions, close completed questionnaires, and publish result summaries.
- Coordinator **resident admission** with one-time codes: upload a resident CSV, generate per-resident or batch codes (CSPRNG, salted-hash verification, rate limiting), and verify a 6-digit code. A **delivery** abstraction lets the coordinator pick a channel per election (manual, email-nomail, SMS), export name+code pairs for out-of-band distribution, and import a results CSV to see which residents were reached. Batch email sending runs on the coordinator machine, not in the browser; the manual channel is the recommended fallback.
- Static deployment to GitHub Pages or nsite.

The interface ships in a calm dark theme by default and also offers a bright light theme. A sun/moon toggle in the corner of every screen switches between the two; the choice is remembered on the device, and first visits follow the system colour-scheme preference.

## Repository Layout

```text
auditable-voting/
|-- web/          Static browser app
|-- worker/       Optional Rust audit proxy
|-- docs/         Protocol and project notes
|-- presentation/ Project overview deck
`-- README.md
```

Key web routes:

- `/` - main app shell, defaulting to Observer
- `/vote.html` - voter entry point
- `/dashboard.html` - organiser and auditor dashboard
- `/simple.html` - simplified voter flow
- `/simple-coordinator.html` - simplified organiser flow
- `/demo-guide.html` - plain-English meeting guide
- `/project-explainer.html` - public "How it works" page
- `/technical-details.html` - technical protocol note

## Quick Start

Install dependencies:

```bash
npm --prefix web install
```

Run the web app locally:

```bash
npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Build the static site:

```bash
npm --prefix web run build
```

If rebuilding the WebAssembly blind-signature package directly, install the Rust Wasm target first:

```bash
rustup target add wasm32-unknown-unknown
```

## Tests

```bash
cd web
npm test
npm run test:relay-load
npm run test:rust
npm run verify:simple-blind-shares
npx tsc --noEmit
npm run build
```

Worker tests:

```bash
cargo test --manifest-path worker/Cargo.toml
```

Optional live relay smoke tests:

```bash
cd web
npm run test:live-delegate-coordinator
npm run test:live-rust-helper
npm run test:live-questionnaire-scale
```

These use public relays and can fail because of relay availability, rate limits, proof-of-work requirements, or propagation delays. `test:live-questionnaire-scale` publishes a 30-round/100-voter synthetic questionnaire transcript by default, so run it only when you intentionally want a live public-relay load probe.

## Audit Proxy

The audit proxy is an optional Rust helper. It uses the delegated organiser role to keep a questionnaire moving when the browser organiser is offline.

Questionnaires with delegated issuance require audit proxy version `0.1.50` or later. The proxy verifies the request-bound proof and the configured RSA public components before applying eligibility or issuing a blind credential, and privately sends an authenticated ballot plan to approved proxy voters before issuing their two-credential bundle.

Voters resolve public proxy delegations within the organiser identity named by the invite or questionnaire definition. The delegation payload and its signed Nostr event author must both match that organiser, so another organiser reusing the same questionnaire ID cannot redirect ballot requests.

When an issuer proxy is active, voters send blind ballot requests only to that proxy. The voter and proxy send separate authenticated, privacy-limited status messages to the organiser for live, requested, issued, received, and submitted progress; the blinded request itself is not copied to the organiser. Voter receipt acknowledgements return to the issuing proxy, which retains the exact issuance for reliable replay. Signed public delegations include the proxy's private-DM relay set so fresh voters use relays the proxy actually reads. The organiser publishes this public routing delegation only after the initial private proxy configuration has reached a relay, so a general invite cannot route a voter to an unconfigured proxy. Blind request, issuance, and recovery traffic uses that configured relay set directly and does not consult NIP-65 relay hints.

For larger live sessions, such as dozens of rounds or around 100 voters, treat the audit proxy/worker as the default issuance and verification path. The browser organiser remains the root authority for admitting voters and starting follow-up questionnaires, but the proxy avoids relying on one open browser tab to process every blind request and public submission for a configured questionnaire.

The proxy only issues blind credentials after it has received the organiser's election config for the active delegation. That config carries the current whitelist, per-voter proxy allowances, per-voter scope assignment, private invite-code hashes, blind-signing private key, and a pointer to the public questionnaire definition; the proxy fetches and verifies the public definition before signing. If the config carries a stale definition hash, the proxy may recover only when the fetched public definition's blind-signing key id matches the configured private key, then it stores the fetched hash. The organiser browser repairs stale local public-key state before publishing and, when configuring a proxy for an already-published questionnaire, reuses a matching locally stored blind-signing private key if one is still available; otherwise the organiser must restore the identity/state that published the questionnaire or start a new vote. Proxy-issued credentials preserve signed `allowedScopes`, and the verifier checks each answer's `requiredScope` against those signed scopes before accepting a submission. A voter marked **Proxy voter** may receive a second credential index for the same allowed scopes, so the two submissions use distinct signed messages and nullifiers; other voters are rejected if they request that second credential. Scoped requests and multi-credential issuances are bundled into one private DM per voter/session where possible to reduce relay churn, and issuance replies carry only blind signatures plus the public definition hash/event id. The final token commitments are generated and stored by the voter, then revealed only in public response proofs where they cannot be matched to a request or issuance. Large bundle DMs are accepted either as plain JSON or as a gzip+base64url compressed wrapper that expands back to the original request/issuance bundle before parsing. When proxy routing is active, blind requests are copied to both the organiser and proxy; when the organiser approves a requester, the updated whitelist is synced back to the proxy so the already-sent request can be issued without asking the voter to send a second proxy message. The proxy also waits for the public questionnaire definition and positive expected participant count before scanning public submissions, verifies every public blind-token proof against the definition public key, rejects duplicate public nullifiers or token commitments, scans the newest configured live questionnaire, debug-logs short decrypted DM metadata for received control-plane messages, and stops scanning that round once expected accepted completion is reached and no delegated blind request is still waiting for authorisation/configuration. Worker relay publishes, subscriptions, and archive fanout cool down relays that return rate limits, timeouts, `initialized but not ready`, or similar transient failures. When public archive relays are configured, it copies handled public responses and worker result events to those relays slowly in the background after the primary publish path succeeds. When delegated result summary publishing is enabled, it uploads the CSV result pack to at least two Blossom servers before attaching pack URLs, mirrors, size, and SHA-256 to the result summary. If fewer than two mirrors accept the CSV, it publishes the count summary without a Blossom pack.

Eligible deferred requests are retried by worker housekeeping, and one recipient's relay failure does not stop issuance attempts for the rest of a batch. Voter DM recovery scans a seven-day window and checks fallback relays for the active request; blocked submission and Main-only scope states are shown in the vote page. Organiser participant controls show voter-group selection, saving, approval, and invite progress before slower persistence or relay work begins. Single-use and proxy private links can be assigned a voter group before their link or QR code is created. When an audit proxy is active, the organiser sends the new private-code hash to it before exposing or copying the link and reports a relay failure instead of creating an unusable invite. A published questionnaire also requires its original matching browser-local blind-signing key before another private link can be created. Later worker syncs preserve the exact published definition event ID/hash, and voters acknowledge only credentials that match a retained request and blinding secret; multi-credential participants show **Ballot received** only after every requested credential is acknowledged.

Dynamically added private and delegated relays must complete a bounded readiness check before the worker uses them for subscriptions or publication.

It can:

- receive delegation and questionnaire config over NIP-17 gift-wraps;
- issue blind credentials to eligible voters, including voters who claim a bounded-capacity private invite code;
- verify public blind-token submissions;
- publish accept/reject decisions;
- close the questionnaire after all expected invitees have accepted valid responses;
- publish the result summary;
- stay online for later sessions after currently delegated close and summary publication are complete.

Organiser and Observer show provisional answers as live while a voter is completing the questionnaire. A submitted public ballot is immediately shown as published because the voter cannot change it. A final public result summary remains the auditable closing record.

Run it locally:

```bash
cd worker
WORKER_NSEC="nsec1..." \
COORDINATOR_NPUB="npub1..." \
WORKER_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol,wss://relay.nostr.info,wss://relay.damus.io,wss://relay.primal.net" \
WORKER_DM_RELAYS="wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol" \
WORKER_PUBLIC_ARCHIVE_RELAYS="wss://nos.lol,wss://relay.primal.net,wss://relay.damus.io" \
WORKER_PUBLIC_ARCHIVE_INTERVAL_MS=500 \
cargo run
```

Useful optional environment variables:

- `WORKER_STATE_DIR`; keep it unique to one worker/organiser identity pair. Generated quick-start commands namespace state automatically and the worker resets persisted election state if either identity changes. Ordinary restarts preserve issuance and accepted-vote records; historical public definitions replayed by relays are ignored unless that election is delegated to the worker. Invites and worker configuration reference the latest organiser-signed public definition event and hash its exact published JSON rather than a newer browser-local draft. Configurations are versioned per election delegation; the worker persists its latest version and ignores duplicate or delayed updates.
- `WORKER_HEARTBEAT_SECONDS`
- `WORKER_POLL_SECONDS` (generated launchers set this to `5`)
- `WORKER_RELAYS` for public anonymous-submission relay reads. Worker delegation and questionnaire configuration arrive only through authenticated private DMs.
- `WORKER_DM_RELAYS` for NIP-17/private worker DMs; defaults to `wss://vm-1734.lnvps.cloud/,wss://relay.nostr.net,wss://nos.lol`. Keep relays that reject gift wraps, require unsupported browser read authentication, or reject worker connections out of this list.
- `WORKER_PUBLIC_ARCHIVE_RELAYS` to drip-feed handled public responses, submission decisions, close events, and result summaries to extra public relays after the hot worker relay publish succeeds
- `WORKER_PUBLIC_ARCHIVE_INTERVAL_MS` and `WORKER_PUBLIC_ARCHIVE_QUEUE_SIZE` to tune that best-effort archive fanout
- `WORKER_BLOSSOM_RESULT_PACK_SERVERS` for comma-separated HTTPS Blossom servers used for final CSV result packs; defaults to `https://blossom.nostr.build,https://blossom.primal.net,https://cdn.nostrcheck.me` and requires two successful CSV uploads before a pack reference is attached

The proxy is outbound-only. It does not require inbound ports or a public server endpoint.

## Protocol Summary

1. The organiser publishes a questionnaire definition, optional non-default relay hints, and public expected-voter count. The public definition is the source of truth for organiser, voter, observer, and audit proxy.
2. When an invited-voter roster is applied, the organiser green-lights checked invited voters and publishes one roster-free public questionnaire announcement rather than sending the same questionnaire metadata to every voter.
3. Voters discover the public announcement or receive an invite pointer containing only questionnaire ID, organiser npub, and relay hints, then fetch and cache the public definition locally. Opening a general invite creates one fresh browser-local voter identity, consumes the one-time URL signal, and reuses that identity on refresh. Private links preserve the browser's saved voter identity so the same voter can refresh or reopen the link.
4. Voters request blind credentials over private NIP-17 messages when they answer. Current questionnaires use one scoped blinded message carrying signed `allowedScopes`, or two messages with the same scopes when the voter is marked as a proxy voter. The request does not contain the final token commitment. Issuance replies carry blind signatures plus a definition hash or event id, not the definition body and not the final token commitment. Large request and issuance bundle envelopes may be gzip+base64url wrapped before encryption; plain JSON is the fallback and remains valid.
5. The organiser or audit proxy blind-signs requests from eligible voters without seeing the final credentials, preserving allowed scopes in the issuance and returning multi-credential issuances in one DM when possible.
6. When an answered question has a following question, **Next** advances immediately and quietly retries its public provisional event in the background; proxy ballots do this for each credential. Newer provisional events from the same anonymous key replace older live hints for that question; they only drive live charts and do not contain blind-token proof material.
7. Voters submit public blind-token responses from ephemeral response keys, carrying one scoped proof for the questionnaire response. If a required answer was missed, **Submit** returns to the earliest incomplete required question and ignores unanswered optional questions.
8. The organiser or audit proxy publishes verification decisions and result summaries. Voter, organiser, and observer recovery prefers those public decisions before falling back to private acceptance DMs.
9. Observers can verify public submissions, decisions, counts, and summaries from relay data.

## Deployment

GitHub Pages is built by `.github/workflows/static.yml`.

For a local Pages-compatible build:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
```

The project can also be published to nsite. The current public nsite gateway is [npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol](https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/).

Publish with `nsyte`:

```bash
npm --prefix web run build
set -a && source .secrets/nsite.env && set +a
nsyte deploy web/dist \
  --sec "$NSEC" \
  --publish-server-list \
  --publish-relay-list \
  --publish-profile \
  --skip-secrets-scan \
  --non-interactive \
  --force \
  --verbose
```

`.secrets/nsite.env` should define `NSEC` and `NPUB`. Do not commit it.

### FIPS-hosted mirror

The static app can also be hosted on a FIPS mesh node. The launcher at
`web/public/fips-host/launch-auditable-voting-fips.sh` builds the latest
upstream FIPS daemon, enables Nostr overlay discovery, advertises the node as a
FIPS endpoint, builds this site, and serves it on the node's `fips0` address.
It can also install an optional audit-proxy service template.

From GitHub Pages:

```bash
curl -L https://tidley.github.io/auditable-voting/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
chmod +x launch-auditable-voting-fips.sh
sudo ./launch-auditable-voting-fips.sh
```

From nsite:

```bash
curl -L https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
chmod +x launch-auditable-voting-fips.sh
sudo ./launch-auditable-voting-fips.sh
```

After startup, other FIPS nodes can reach the mirror at
`http://<fips-node-npub>.fips:8080/`. By default the launcher advertises
`udp:nat` via FIPS' Nostr/STUN handoff flow; set `FIPS_PUBLIC_UDP=1` and
`FIPS_EXTERNAL_ADDR=IP:2121` for a stable public UDP endpoint.

If the machine already runs packaged FIPS, for example a Raspberry Pi with
`ExecStart=/usr/bin/fips --config /etc/fips/fips.yaml`, reuse it without
rebuilding FIPS, requiring npm, or replacing the existing FIPS config, service,
or firewall:

```bash
sudo ./launch-auditable-voting-fips.sh --reuse-running-fips
```

When npm is available the launcher builds Vite and installs the complete
`web/dist/` tree as the web root. Reuse mode downloads the published static
site and recursively completes the referenced Vite assets, including dynamic JS
chunks and WASM files, before replacing the live root. This avoids partial
deployments where imported modules receive HTML fallback responses.

To serve under a path prefix instead of the FIPS site root, build from source
and set `WEB_BASE_PATH`, for example:

```bash
sudo WEB_BASE_PATH=/auditable-voting/ ./launch-auditable-voting-fips.sh
```

## Limitations

- Relay support for filters, retention, and rate limits varies.
- The default relay set is intentionally small: public questionnaire relays are separate from private-DM relays, and browser read paths use a tighter subset than publish paths, with per-questionnaire overrides available when needed.
- Browser-local organiser state and keys must be protected by the user.
- **Backup** exports an encrypted full-state snapshot for the current app namespace, including local questionnaire, invite, response, relay, and actor-state records. Restoring it replaces this device's current namespace state.
- Account menus, response rows, and backup filenames show a deterministic three-word label from the BIP39 English word list so voters can match a profile, anonymous response identity, or backup quickly. Those words are not a BIP39/NIP-06 recovery mnemonic and cannot restore the private key without the `nsec` or backup file.
- The audit proxy improves liveness but is still delegated by the organiser.
- Editing an answer-bearing question's required scope after credentials have been issued requires fresh scoped credentials. It reduces friction for AGM-style name-list edits, but it is not a way to silently reinterpret already issued credentials.
- Observer verifies public state; it cannot admit voters or start follow-up questionnaires from the private organiser roster.
- Private invite links default to one use. The organiser can set a limit from 1 to 10,000 distinct voters when creating a link; each successful claimant receives an independent blind ballot (or the configured two proxy ballots). The organiser keeps claimant identities locally, while public status contains only the code hash, aggregate redemption count, and limit until the link is full.
- The built-in **Messages** view needs a local `nsec` identity to unwrap and send helpline DMs; signer-only sessions should use their external signer or restore a local identity until signer-side NIP-17 wrapping is supported in-app.
- Public verification depends on observers fetching the relevant relay events.
- Provisional per-question events are unauthorised live display hints. They can move charts before final submission, but only verified blind-token responses and public accept/reject decisions count for the audit result.
- Decrypting encrypted observer details requires manually entering the matching organiser `nsec`; the key is not a public audit input.
- The protocol and implementation need external review before strong production claims.

## Licence

Auditable Voting is released under the MIT Licence. Anyone may use, copy, modify,
publish, distribute, sublicense, or sell copies of the software without asking
for permission or paying a licence fee, provided the copyright and licence
notice are kept with the software.

See [LICENSE](LICENSE).

## Documentation

- `docs/project-explainer.md`
- `docs/technical-protocol-note.md`
- `web/public/project-explainer.html`
- `web/public/technical-details.html`
- `docs/questionnaire-blind-token-protocol.md`
- `docs/questionnaire-protocol-decisions.md`
- `presentation/project-overview.html`
