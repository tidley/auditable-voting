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
2. The voter requests a fresh blind ballot credential for this questionnaire.
3. The organiser signs it without seeing the final credential.
4. The voter submits a public ballot anonymously.
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

Auditable Voting tries to avoid both failures by separating issuance from submission. The organiser handles eligibility, including an admitted voter roster that can be reused for later questionnaires. Applying that roster publishes one public announcement for the next questionnaire instead of sending the same questionnaire details to every voter. The voter still requests and spends a fresh blind credential for each questionnaire through a fresh response identity. Observers read the public event stream and recompute the count.

## What is public vs private

Public:

- questionnaire definitions and round state
- anonymous public ballot submissions
- organiser accept/reject decisions
- published result summaries

Private or local:

- voter and organiser signing keys
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

## Run a test vote

1. Open the app as **Organiser**.
2. Admit voters in **Voting** if the same people will answer later questionnaires.
3. Create a questionnaire and publish it.
4. Share invite links from **Voting**. The General QR/link opens **Vote** directly and requests a ballot automatically; single-use private links also show a QR code. For already admitted voters, **Apply to current questionnaire** publishes one public questionnaire announcement that their Vote page can discover.
5. Open the invite as **Voter**, wait for ballot access if needed, fill in the questionnaire, and submit. Voter **Settings** shows **Ballot details** while taking part, so request, credential, submission, and timing fields can be checked if something stalls.
6. Open **Observer** and search for the questionnaire ID, organiser identity, Submission/Response ID, or **Submittor identity** short/full to verify the public result stream. Observer refreshes the selected questionnaire automatically while the page is visible; use **Refresh** for an immediate reload. In **Submitted Votes**, use the same submission filters to find a specific public submission. Invalid rows show their rejection reason. Organiser results decrypt encrypted answer details automatically when the local organiser key is available; Observer can decrypt them from **Submitted Votes** when the matching organiser `nsec` is supplied.

Questionnaires can mix yes/no, multiple-choice, ranked-choice, and free-text questions. Ranked-choice results are counted as points, with the highest total preferred: first choice gets one point per available option, later choices count down from there, and unranked options get `0` points.

## Current limitations

This is experimental software.

Known weak points:

- Public relay reliability can affect delivery and discovery.
- Browser-held secret material needs careful handling.
- The cryptographic design needs external review before production use.
- Large multi-organiser runs are not yet reliable on the current public relay set.

## Technical details

The technical note covers Nostr event flow, NIP-17 private messages, RSABSSA blind credentials, duplicate-spend handling, audit-proxy delegation, relay behaviour, and current implementation limits.

See [`docs/technical-protocol-note.md`](./technical-protocol-note.md).
