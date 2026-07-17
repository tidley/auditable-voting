# Questionnaire voting acceptance specification

Status: authoritative target behaviour for the active product.

This document defines the questionnaire lifecycle, role boundaries, privacy
properties, recovery behaviour, and verification gates. Existing behaviour that
conflicts with this document is a defect, not a compatibility requirement.

## Principles

1. A questionnaire is identified by the hash of its signed, immutable,
   canonically encoded definition. Human-readable identifiers are lookup hints.
2. The browser UI is a thin client. A shared Rust core owns protocol state,
   canonical encoding, validation, transport policy, and persistence semantics.
3. Identity-linked admission ends at confirmation that the voter has received
   every ballot grant. Voting activity after that boundary is anonymous.
4. Retry never creates a new logical request, credential, ballot identity,
   nullifier, provisional response, or final submission.
5. Public signed events provide the audit trail. Local state improves usability
   but is not authoritative evidence.
6. Legacy voting formats are available only through a separate, read-only
   observer path. They cannot create or mutate active rounds.

## Roles

### Coordinator

The coordinator defines and publishes the questionnaire, chooses the issuer,
controls admission, optionally freezes admission, closes voting, and publishes
signed results.

### Voter

The voter uses one stable identity per coordinator for admission and messaging.
Anonymous ballot grants are independent of that identity and of one another.

### Audit proxy

The audit proxy is an optional, recommended issuer. It receives delegated blind
credential requests, issues the exact persisted response on every retry, and
does not learn ballot answers or anonymous ballot identities.

### Observer

The observer reads public questionnaire, response, closure, and result events.
It may validate the complete audit trail on demand. It never needs coordinator,
voter, or issuer secrets.

## Questionnaire definition

Before publication the coordinator defines all immutable fields, including:

- title, description, questions, answer types, ordering, and constraints
- admission methods and general-admission proof-of-work requirement
- voting and admission deadlines
- closure policy
- issuer and delegation policy
- free-text encryption mode
- result and attachment mirror policy
- protocol and canonical encoding versions

Publication signs the canonical definition. Any change creates a different
questionnaire and definition hash.

The coordinator must acknowledge and export a recovery backup before the first
public definition is published.

## Coordinator lifecycle

The accepted lifecycle is:

1. Create, import, or connect the coordinator identity.
2. Define and review the complete immutable questionnaire.
3. Acknowledge and export the coordinator recovery backup.
4. Publish the signed questionnaire definition.
5. Select and verify the issuer.
6. Share admission links and admit voters while voting may proceed.
7. Optionally freeze admission.
8. Close manually, at the deadline, or when all admitted voters have received
   grants and all anonymous grants have finalised.
9. Publish signed closure, aggregate, and result events automatically.

Sharing any admission link locks the selected issuer. Issuer handover is an
exceptional, explicit, signed operation with clear warnings and recovery rules.

Admission freeze is optional. It is required for all-finalised automatic
closure, but not for deadline closure.

Closure is irreversible. Late provisional responses and finalisations are
rejected according to the signed closure event.

## Admission

The coordinator may enable any combination of:

### General public link

- A voter requests admission using their stable identity for this coordinator.
- The coordinator may approve, revoke, or mute the voter.
- The immutable questionnaire definition may require configurable proof-of-work.
- The general link may be disabled without changing already granted ballots.

### Private one-use link

- Possession automatically admits its first valid claimant.
- Plaintext claim material exists only in the browser tab session.
- It is displayed once, removed when claimed, and excluded from backups.
- Public or persisted records contain only the minimum non-reusable commitment.

### Named Nostr identity

- The named identity is automatically admitted after proving control.
- A named invitation cannot be claimed by another identity.

The voter identity and admission request ID must remain stable for the same
coordinator and questionnaire. Reloading, retrying, or recovering must not
generate replacements.

## Issuance and delivery

The coordinator browser is the default issuer. A separately operated audit
proxy is recommended.

Each answer authority is represented by an independent ballot grant with its
own credential, anonymous ballot identity, scope, and nullifier. A proxy voter
therefore receives separate grants rather than one credential that exposes the
relationship between authorities.

The request flow is:

1. The voter persists the blinded request before sending it.
2. The voter retries the same request ID with exponential backoff until a signed
   `Request received` acknowledgement arrives.
3. The issuer persists the exact issuance before publishing it.
4. A repeated request receives the exact persisted issuance.
5. The voter validates and persists all grants, then sends a signed `Ballot
   received` acknowledgement.

When a proxy is selected, credential requests and issuances travel only between
the voter and proxy. The proxy reports identity-linked progress to the
coordinator only through `Request received` and `Ballot issued`. The voter is
the authority for `Ballot received`.

The coordinator participant view may show only:

- invited or awaiting request
- request received
- ballot issued
- ballot received
- revoked or muted admission state

`Ballot received` is set only after all grants assigned to that admitted voter
have been received. It is the terminal identity-linked voting status.

## Anonymity boundary

No voter, proxy, issuer, or coordinator message or record may link an admitted
identity to any of the following:

- submission ID
- anonymous ballot identity
- credential serial or nullifier
- answers or answer event IDs
- provisional response activity
- finalisation activity
- acceptance or rejection decision
- result inclusion

There is no identity-linked `vote submitted`, `finalised`, `accepted`, or
equivalent participant status. Diagnostics, logs, backups, and exports obey the
same boundary.

## Answering and provisional responses

The voter may answer locally while admission and issuance are in progress.
Nothing is published until a valid ballot grant is available.

Each grant has a stable anonymous ballot identity. A provisional response:

- is signed by that anonymous identity
- includes a monotonic sequence number
- proves possession and scope of its valid credential
- replaces earlier valid provisional state for that grant
- contains the questionnaire definition hash
- is rejected if malformed, out of scope, duplicated, or published after closure

Public provisional events reconstruct the latest published answer state.
Unpublished local edits are intentionally not recoverable.

## Finalisation

Finalisation does not duplicate answer content. It publishes a signed manifest
containing the selected provisional event IDs and their combined canonical hash.

`Finalise all ready ballots` independently submits every complete grant. Failure
of one grant must not block another.

The client persists each exact signed finalisation event before publishing it.
Retries republish that event unchanged until a public signed acceptance or
rejection decision is observed.

Acceptance validates the grant, scope, nullifier, manifest, provisional event
set, closure timing, and absence of prior accepted finalisation. Decisions are
public, deterministic, signed, and unlinkable to the admitted identity.

## Closure and results

Closure may be triggered by:

- an explicit coordinator action
- the immutable deadline policy
- all-finalised automation after admission is frozen

After closure, the coordinator publishes a compact signed aggregate and result
without waiting for optional mirrors. Publishing to configured mirrors retries
independently and never blocks signed result availability.

The default is two configurable Blossom mirrors.

## Free-text responses

Each free-text question chooses one immutable mode:

- no encryption
- voter-controlled encryption, default off
- encryption required

Encrypted responses remain private permanently. Public results expose only
participation counts for those responses. The UI must not imply that an
observer can later reveal or validate encrypted text content.

## Observer behaviour

Before closure, the observer may read credential-proved provisional responses
and must warn that totals are incomplete and subject to replacement.

After closure, the observer loads the signed compact aggregate immediately.
Full event-by-event verification occurs only when the user selects `Validate
votes`. A successful validation is cached for the exact result and event set.
`Validate again` is explicitly presented as a potentially slow operation.

Legacy formats are behind a separate `Legacy` control. Their parser and viewer
are lazy-loaded, read-only, and excluded from active questionnaire creation,
admission, voting, issuance, and result code paths.

## Recovery

Once every ballot grant has arrived, the voter sends an encrypted self-DM with
the minimum credential and unblinding recovery material. It excludes private
invite plaintext and unnecessary identity-linked metadata.

Recovery combines:

- encrypted self-DM material for grants
- public provisional events for the latest published answer state
- local browser state when available

A grant cannot be requested again after issuance. Unpublished edits cannot be
recovered.

Coordinator and issuer backups use versioned, encrypted formats defined by the
shared Rust core. Restore validates the questionnaire definition hash and never
silently migrates incompatible protocol state.

## Transport

The active protocol is Nostr-first. Browser WebSocket, signing, time, randomness,
and storage are ports consumed by the Rust core rather than independent protocol
implementations.

Transport policy defines relay selection, authenticated sender checks,
deduplication, retry schedules, terminal decisions, and event query bounds.
Every role must tolerate duplicate, delayed, reordered, and partially delivered
events without changing logical identifiers.

Default direct-message relays are:

- `wss://vm-1734.lnvps.cloud/`
- `wss://relay.nostr.net`
- `wss://nos.lol`

The user-owned `wss://vm-1734.lnvps.cloud/` relay is supported and must not be
classified as incompatible merely because it is privately operated.

## Shared core boundary

One Rust core must own:

- protocol models and state transitions
- canonical encoding, hashing, validation, and tallying
- retry, deduplication, query, and relay-selection policy
- persistence schemas, migrations, encryption, and backup formats
- blind credential interfaces and implementations

React may render core state and invoke core commands. React code must not read or
write voting-state storage directly or independently decide protocol outcomes.

The native issuer and browser WASM package consume the same core. Standard
library-backed RSABSSA is exposed through a versioned `BlindCredentialScheme`
interface. No active TypeScript or second Rust implementation may duplicate the
same protocol rules.

## Diagnostics

Diagnostics are local and export-only. Their schema excludes secrets, admitted
identities, answers, claim codes, recovery material, and linkable ballot
identifiers by construction. There is no remote telemetry requirement.

## Verification gates

Every state transition is developed with a failing test first. Required gates
are:

- Rust unit tests for each role and transition
- property tests for canonical encoding, retry idempotence, deduplication,
  ordering, and invariant preservation
- fuzz tests for parsers and untrusted event inputs
- local multi-relay failure-injection tests
- public-relay end-to-end tests using the shipped browser and native issuer
- Chromium, Firefox, WebKit, and real Safari on macOS
- production build and blind-credential verification

The full GitHub suite starts when a pull request becomes ready for review. Merge
and deployment are permitted only for the exact commit that passed every
mandatory gate. Draft development iterations may omit GitHub CI.

## Deferred work

The following items are explicitly outside the first shared-core migration:

- simplify proxy discovery, setup, and handover UX
- add m-of-n sharded blind Schnorr issuers behind `BlindCredentialScheme`
- optionally encrypt questionnaire definition distribution

These items must not introduce speculative abstractions into the initial core.
