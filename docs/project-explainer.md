# How auditable voting works

Anonymous voting with public verification, using blind credentials and Nostr relays.

If you are demonstrating the project to a general audience, start with the [plain-English demo guide](./demo-guide.md). It uses everyday language, gives a short action-first walkthrough, and keeps the technical terms out of the first explanation.

This is the short, public-facing explanation. For the protocol and implementation detail, see [`docs/technical-protocol-note.md`](./technical-protocol-note.md). For the questionnaire-specific protocol reference, see [`docs/questionnaire-blind-token-protocol.md`](./questionnaire-blind-token-protocol.md).

## What this system is trying to do

This system separates two things that are usually hard to combine:

1. Eligibility: proving someone is allowed to vote.
2. Privacy: preventing their final vote from being linked back to them.

The organiser can confirm that a voter is allowed to participate, but should not be able to see how they voted.

Observers can independently recompute the result from public data.

## The short version

1. An organiser admits a voter or confirms that a voter is eligible.
2. The voter requests fresh blind ballot credentials for this questionnaire. Current questionnaires use one internal response group, or two credentials for that group when the voter is marked as a proxy voter; large bundles can be compressed before encryption, while small bundles stay plain JSON.
3. The organiser or audit proxy signs the bundle without seeing the final token commitments and returns multi-credential blind signatures plus the public definition hash or event id in one private DM where possible.
4. The voter submits the questionnaire response anonymously; all questions share one proof, like one multi-part question.
5. Anyone can verify that accepted ballots are valid, unique, and correctly tallied.

## Roles

| Voter | Organiser | Observer |
| --- | --- | --- |
| Gets a credential | Confirms eligibility | Recomputes results |
| Submits anonymously | Issues blind credential | Checks public ballots |
| Keeps private keys local | Publishes round metadata | Detects duplicates |

## What problem it solves

Most online voting systems force an uncomfortable tradeoff:

- either the operator can link voters to votes
- or the public cannot independently verify the result

Auditable Voting tries to avoid both failures by separating issuance from submission. The organiser handles eligibility, including an invited-voter roster that can be reused for later questionnaires. Applying that roster publishes one roster-free public announcement for the next questionnaire instead of sending the same questionnaire details to every voter. The public questionnaire definition is the source of truth for organiser, voter, observer, and audit proxy; invite links and DMs carry only a questionnaire ID, organiser npub, relay hints, and a per-voter proxy allowance when needed. The voter fetches and caches that public definition, then requests and spends fresh blind credentials through a fresh response identity. Current questionnaire builds use one internal response group, or two credentials for voters marked as proxy voters, receive issuances with only blind signatures plus a definition hash/event id, and can compress large request/issuance bundles before NIP-17 encryption. The second proxy credential has its own credential index in the signed scope, so it produces a distinct nullifier and is spent as a separate anonymous submission. The final token commitment is never sent in the request or issuance path; it appears only in the anonymous public response proof, where organiser and proxy can verify it but cannot match it to the eligible voter who requested the blinded signature. Observers read the public event stream and recompute the count; they cannot admit voters or start the next questionnaire from the private organiser roster.

## What is public vs private

Public:

- questionnaire definitions and round state
- roster-free public questionnaire announcements
- anonymous public ballot submissions
- organiser accept/reject decisions
- published result summaries
- final result-pack URLs, mirror URLs, sizes, and hashes when Blossom fallback packs are published

Private or local:

- voter and organiser signing keys
- the admitted voter roster and internal voter notes
- helpline message contents, sent as NIP-17 gift-wrapped direct messages between voter and organiser identities
- token secrets and blinding factors
- unspent ballot credentials
- browser-local recovery state

## What observers can verify

Observers can independently check:

- which public ballots were accepted
- whether a credential was spent more than once
- whether an invalid-token-proof rejection is contradicted by a locally verified blind-token proof
- whether rejected ballots were rejected for deterministic reasons, with the published reason shown beside invalid rows
- whether the published tally matches the accepted public ballots
- encrypted answer details automatically in Organiser when the local organiser key is available, or in Observer when the matching organiser `nsec` is deliberately entered

## Trust model

The organiser is trusted to decide who may participate.

The organiser should not learn how an eligible voter voted.

The public does not need to trust the organiser's tally, because observers can recompute the result from public events.

The voter must protect their local keys and browser state.

The current grouped-question design is the pragmatic privacy version: one questionnaire response is one anonymous group. Stronger versions that hide individual answers inside a group, prove encrypted tallies, or split one eligibility credential across unlinkable per-question spends would need zero-knowledge or anonymous-credential proofs. Those are specialist cryptographic systems, not a small UI change; they require audited libraries, circuits, browser proving-time checks, and setup-assumption review.

## Run a test vote

1. Open the app as **Organiser**.
2. Invite voters in **Session** if the same people will answer later questionnaires.
3. Create a questionnaire and publish it.
4. Share invite links from **Session**. The General QR/link opens **Vote** directly and requests a ballot automatically; single-use private links are created and labelled in **Voters**. If a private link has already been used, a different local identity sees an already-used state with **Message organiser**, **Open general invite**, and **Back to Join** actions when available; the same local identity can reopen the link and continue into the questionnaire. **Voters** also includes **Participants**, a searchable roster that combines private invite rows, pending access requests, and received votes/results for the selected questionnaire; pending access rows can be assigned **Ballot** and **Proxy voter** settings before approval. The top questionnaire selector stays visible on **Session** for switching questionnaires, and on **Questionnaire/Add session** it shows the live active draft or published item as the name and Questionnaire ID change; published questionnaire fields stay visible but read-only. For follow-up questionnaires, use **Add session** under **Questionnaire** after at least one voter has **Auto-ballot** ticked; it generates a fresh Questionnaire ID, publishes to those rows, and publishes one public questionnaire announcement that their Vote page can discover.
5. Open the invite as **Voter**, wait for ballot access if needed, fill in the questionnaire, and submit. Opening Voter without an invite starts from a neutral **Join** screen instead of restoring old organiser targets; public questionnaire links scope **Messages** to the active organiser only. Voter **Messages** can send a private helpline DM to the organiser with Enter, while questionnaire-link-only invite DMs are hidden from the voter helpline inbox/unread badge. Voter **Settings** shows **Ballot details** while taking part, so request, credential, submission, and timing fields can be checked if something stalls.
6. Open **Observer** and search for the questionnaire ID, organiser identity, Submission/Response ID, or **Submittor identity** short/full to verify the public result stream. Observer keeps one live subscription for the selected questionnaire and uses **Refresh** for an immediate serial backfill. Voters can publish separate public per-question provisional events from the same anonymous ballot identity while answering; Observer and Organiser show those as muted live chart markers until verified blind-token submissions replace them. If a final summary points to a Blossom CSV result pack because relay detail fetch is incomplete, Observer downloads a mirror only after checking the advertised blob size and SHA-256. Organiser can find received votes in **Voters** -> **Participants**; Observer keeps **Submitted Votes** for audit-side submission filtering and rejected-row diagnostics. Invalid rows show their rejection reason. Organiser results decrypt encrypted answer details automatically when the local organiser key is available; Observer can decrypt them from **Submitted Votes** when the matching organiser `nsec` is supplied.

Questionnaires can mix yes/no, multiple-choice, ranked-choice, and free-text questions. Free-text questions can allow optional voter encryption or require organiser-encrypted responses. Ranked-choice results are counted as points, with the highest total preferred: first choice gets one point per available option, later choices count down from there, and unranked options get `0` points.

## Current limitations

This is experimental software.

Known weak points:

- Every real deployment needs an explicit threat model and operating procedure before the vote opens, including who can admit voters, when eligibility freezes, how disputes are handled, and what fallback is used if browsers, keys, relays, or the proxy fail.
- Public relay reliability can affect delivery and discovery.
- The client uses tag-filtered, paginated public reads, adaptive NIP-17 mailbox recovery, local-key live request-ack/credential subscriptions, capped foreground DM/mailbox read fanout, and consolidated organiser, voter, and observer live questionnaire subscriptions, but relay rate limits can still affect busy demonstrations.
- Public provisional per-question response events improve live chart feedback, but they are not authorised votes and carry no blind token. They use the final anonymous ballot identity so newer hints can replace older hints from the same ballot. The audit result still comes from verified blind-token responses plus public accept/reject decisions.
- A worker can use a dedicated hot relay while drip-feeding handled public responses, submission decisions, close events, and summaries to extra public archive relays at a fixed interval.
- Final result packs can be mirrored to Blossom as public CSV files. Observer verifies the uploaded blob size and hash before showing rows from that fallback, and the file opens directly in spreadsheet tools with response, submittor, answer, nullifier, token commitment, and blind-token proof columns.
- For larger live sessions, such as many rounds or around 100 voters, use the audit proxy/worker for blind issuance and decision publication rather than relying on a single organiser browser tab.
- The audit proxy still follows organiser eligibility: it waits for the organiser's whitelist/private-code config before issuing, fetches the public questionnaire definition from the delegated pointer, refuses blind-signing material that does not match that published definition, recovers from stale definition-hash pointers only when the fetched definition's blind-signing key id matches the configured private key, signs credential `allowedScopes`, and delegated blind request bundles are copied to both organiser and proxy so approval can update the proxy without a second voter request. Current questionnaires use one issued credential whose scope `0` covers general questions and optional scopes `1`-`3` cover restricted cohorts, or two credentials with the same scopes for voters marked **Proxy voter**. The worker verifies every submitted answer's `requiredScope` against the signed credential scopes before accepting it. The organiser browser repairs stale local blind-key metadata before publishing and reuses a matching locally stored blind-signing private key for an already-published questionnaire when it can; if no matching private key is available, the organiser must restore the publishing identity/state or start a new vote. The proxy only scans public submissions for configured questionnaires with a positive expected participant count, verifies public blind-token proofs against the public definition key, rejects duplicate public nullifiers or token commitments, stops scanning once expected accepted completion is reached and no delegated blind request is still waiting for authorisation/configuration, and stays online for later sessions. It accepts plain JSON or compressed request bundles, returns multi-credential issuances in one private DM where possible, compresses large issuance bundles when useful, carries only blind signatures plus a definition hash/event id, never receives final token commitments in request/issuance DMs, and does not create follow-up questionnaires; that remains an organiser action because it depends on the private admitted-voter roster.
- Remote browser voting cannot fully prevent coercion, observation of the voter, or compromise of the voter's device. It is suitable for controlled pilots and small organisations only where those residual risks are accepted or mitigated by procedure.
- Metadata still matters: Nostr identities, relay choices, message timing, IP/network paths, and repeated device/browser use can leak more than the encrypted ballot payload does.
- Browser-held secret material needs careful handling.
- Client supply-chain integrity still needs discipline: signed releases, reproducible builds, dependency review, and clear instructions for voters who want to verify the client they are using.
- If threshold trustees are used, the project needs a documented key ceremony, trustee selection policy, backup/recovery procedure, and public record of trustee actions.
- **Backup** creates an encrypted full-state snapshot for the current app namespace. It includes local questionnaire definitions/drafts, invite and roster state, blind-issuance state, responses, relay/proxy settings, and actor state; restoring replaces the current namespace state on the device.
- Account menus, response rows, and backup filenames show a deterministic three-word label from the BIP39 English word list for matching a profile, anonymous response identity, or backup. It is not a BIP39/NIP-06 recovery mnemonic and cannot restore the private key without the `nsec` or backup file.
- Private invite status is published as an invite-code hash plus a per-code claimed-identity hash, so link holders can detect reuse without publishing the private invite code itself.
- If the organiser changes an answer-bearing question's required scope after credentials exist, voters need a fresh scoped credential.
- The built-in **Messages** view needs a local `nsec` identity to unwrap and send helpline DMs; signer-only sessions should use their external signer or restore a local identity until signer-side NIP-17 wrapping is supported in-app.
- The cryptographic design needs external review before production use.
- Large multi-organiser runs are not yet reliable on the current public relay set.

## Technical details

The technical note covers Nostr event flow, NIP-17 private messages, RSABSSA blind credentials, duplicate-spend handling, audit-proxy delegation, relay behaviour, and current implementation limits.

See [`docs/technical-protocol-note.md`](./technical-protocol-note.md).
