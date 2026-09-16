# Paper-ballot voter paths

Proposed UI and protocol behaviour; these controls are not claimed to be shipped.
The current resident-number/OTP preview is not an authentication service. Online
entitlement integration below depends on implementing that service.

**This route accepts a lower level of identity assurance so that lack of a phone,
email address, or OTP access does not prevent participation.**

Exclusion is a greater concern than impersonation in this community. Someone may
obtain a credential using another voter's known master number, or copy an issued
credential. Accessible challenges and organiser-controlled recovery address this
accepted risk without promising stronger identity assurance.

## 1. Request and issuance

| Route | Voter action |
| --- | --- |
| **Online** | Enter master number, complete OTP, obtain online authority. |
| **Paper credential** | Request using master number; receive a coordinator-issued ID for public digital submission or a physical ballot. |

The master number identifies a private questionnaire CSV record; it is not secret.
Only the coordinator (organiser) generates IDs in their authenticated interface.
The public page requests issuance; staff can enter non-digital requests there too.

- Generate ten random, case-insensitive Crockford Base32 characters using a CSPRNG,
  plus a check character; offer a QR representation for entry. This gives 50 bits
  of secret entropy. A public commitment permits offline guessing if the master
  number is known; mismatch alerts cannot detect that attack.
- After checking eligibility and existing entitlement, sign registration of:

  ```text
  C = SHA-256(UTF8(JSON.stringify([
    "paper-ballot/v1", organiser-public-key, round-ID, master-number, ballot-ID
  ])))
  ```

  Use canonical lowercase hex for the public key and exact published round ID.
  Trim surrounding master-number whitespace but preserve case and leading zeroes;
  apply the same rule at CSV import. For ballot IDs, remove display spaces/hyphens,
  uppercase, map Crockford aliases, validate and remove the check character before
  hashing. Use Crockford's modulo-37 check-symbol scheme; map `O` to `0` and `I`/`L`
  to `1` in the data portion. Reject other invalid characters, incorrect lengths,
  and duplicate normalised CSV master numbers. Use `crypto.getRandomValues` and
  uniform five-bit symbols; regenerate any ID already issued within the round.
- Retain the ID and private record mapping in protected organiser-local storage
  and encrypted backups for reprinting. Deliver privately or on a printed stub;
  failed delivery retries the same credential. Never silently issue another.
- Put identifiers on an outer envelope/stub, **never the marked inner ballot**.
  Unregistered IDs convey no authority, whoever generated them.

## 2. Public submission and verification

Anyone holding both identifiers may submit a choice through the public page,
including a trusted helper. No organiser login is required. Only authorised staff
may attest to physical envelope receipt. Both routes use the same entitlement.

The initial verifier is the organiser client: public submissions and status queries
travel privately via NIP-17 DMs to its published key. It persists private
credential state, submissions, request results, and failure counters. An offline
client leaves requests **Pending**; relay delivery alone is not acceptance. An
always-on delegated verifier would require a separately specified authority.

The client validates the commitment and current state; the organiser's **Accept**
action signs acceptance of a specific submission and spends its credential.
**Record receipt** only records physical delivery. **Reject** rejects a submission,
not its credential. Status queries require both identifiers and never spend them.

| Record | States |
| --- | --- |
| Credential | Active, spent, cancelled, superseded |
| Submission | Pending, received, accepted, rejected, provisional |
| Challenge | Open, upheld, rejected, unresolved |

Each request has an ID bound to its payload. Identical retries return the saved
result; reuse with a changed payload fails. A different submission cannot spend an
already spent credential. The public page waits for a signed result referencing
its request. Submission identifiers and choices stay out of the public history.

Use a versioned private envelope:

```text
{ type, version: 1, roundId, requestId, masterNumber, ballotId?, payload }
type = paper_request | paper_submit | paper_status
```

Generate `requestId` from 128 CSPRNG bits. Require `ballotId` for submit/status;
`paper_submit.payload` contains the published ballot-definition event ID and
answers validated against that definition. Replies contain `requestId`, status,
and the relevant public transition ID, authenticated by the organiser's Nostr key.
Use a fresh reply identity where possible; a Nostr sender key is transport identity,
not eligibility. Persist a canonical payload digest with each request result;
conflicting reuse must neither overwrite that result nor disclose it to another
sender. Apply input-size limits before parsing or hashing. Do not log identifiers
or answers in telemetry. The organiser can see digital choices and credentials
together: this route does **not** inherit blind-token unlinkability.

## 3. Mismatch alerts

Count distinct failed matches from submissions **and status queries**, per round
and issued master-number record, in persistent private verifier state. Do not count
keystrokes, delivery retries, or matching credentials that are spent/cancelled.
Return generic validation failures without distinguishing unknown identifiers.

On the **fourth mismatch**, flag **Suspected misuse or input errors** in the
organiser panel and queue an encrypted DM to the organiser. Include the private
record reference, count, and first/latest attempt times, never attempted IDs.
Send one initial alert, update the panel count thereafter, and retry failed DM
delivery. **Acknowledge alert** retains history; replacement starts a new alert
window, notifying after another four failures. Retain the lifetime round total.

No automatic cancellation or lockout: correct active credentials remain usable.
Counters and alerts are never public. Optional notices and rate limits must not
make digital access a condition of paper participation.
Count each unique request once; syntactically valid but incorrect IDs increment
the counter, while malformed input fails validation without a credential lookup.
Creating a new request ID constitutes a new attempt. Status requests must not
return registered/spent/cancelled status until both identifiers match.

## 4. Organiser panel and recovery

Provide private lookup by master number, credential/submission history, and:

| Control | Effect |
| --- | --- |
| **Issue / Reprint** | Generate and register an ID, or privately redeliver the existing one. |
| **Record challenge** | Enter an in-person or written request without OTP or the missing ID; retain notes privately and print a case reference. |
| **Cancel and replace** | For an unspent credential, generate a new ID and sign one transition superseding the old commitment and registering the new one. |
| **Hold disputed ballot** | Open review and hold any replacement submission as provisional, outside the tally; do not imply the original has been removed. |
| **Resolve challenge** | Sign an uphold/reject/unresolved decision. If the original can be excluded without revealing its choice, record exclusion and replacement acceptance together; never count both. |
| **Cancel credential** | Cancel an unspent credential with a reason. A spent credential requires a challenge, not ordinary cancellation. |

The organiser key authorises changes; the UI confirms their effect before signing.
Opening a challenge alone changes no voting entitlement. Local recognition or
community attestation can inform decisions. Publish help locations, deadlines,
replacement rules, and appeal arrangements in the app and printed instructions;
print status receipts, decisions, and follow-up instructions on request.

Separate and mix inner ballots before reading choices. After anonymous mixing,
the app cannot remove a physical vote by credential: record the unresolved impact
and remedy, such as a rerun where it could affect the result. Reconcile accepted,
rejected, provisional, excluded, and counted totals. Receipt is not proof that the
marked choice was counted correctly.

## 5. Signed history and consistency

- Publish non-replaceable Nostr events for activation, receipt, acceptance,
  rejection, challenge, resolution, replacement, and cancellation. Corrections
  append events. Include version, round, commitment, action, broad reason code,
  and predecessor references; replacements link old and new commitments.
  Define the payload as `{ protocol: "paper-ballot/v1", roundId, seq, prev,
  action, commitment, nextCommitment?, reasonCode? }`; `seq` increases per round
  and `prev` is the preceding event ID (`null` for genesis). Resolve forks with
  an additional `conflictHeads` array. Fix an unused regular event kind in the
  repository's protocol registry before implementation; use `d`-free round tags
  for discovery, not replaceable-event semantics.
- Verify the signer against the round's organiser authority. Keep raw identifiers,
  private notes, submission request IDs, and links to choices out of events and
  tags. Public challenge events expose status only.
- Use one authoritative writer per round, durably serialising transitions with
  sequence numbers and predecessor event IDs. Other devices submit requests to
  that writer; possessing the same key does not authorise concurrent writing.
  Pause writes during device handover until state is synchronised.
  Enforce one writer across tabs with a browser lock; other devices remain
  read/request-only until explicit handover. Commit state, request result, counter
  changes, and publication outbox entries in one IndexedDB transaction. External
  signing happens before that transaction, with predecessor revalidation at commit;
  discard and rebuild stale unsigned/unpublished transitions.
- Deduplicate replay. A fork blocks affected acceptance until an explicit signed
  resolution references all conflicting heads and establishes the next state;
  timestamps and relay arrival order never choose a winner.
- Show **Saved locally**, **Awaiting publication**, and **Confirmed** distinctly.
  Confirm only a durably recorded transition acknowledged by the round's published
  required relay set; retry publication with the same event. Pending transitions
  reserve state locally so another request cannot spend it again.
  The round configuration pins a non-empty required relay set and acceptance and
  challenge deadlines. Require positive relay acknowledgements from every required
  relay; an outage leaves the transition pending, never rolled back automatically.
  Evaluate deadlines at verifier processing time and display that rule before
  submission; claimed sender timestamps cannot establish timely receipt.
- Replicate events and retain organiser/observer exports. Signed history is
  tamper-evident, but Nostr does not guarantee retention, completeness, or atomic
  spending. It proves organiser-reported actions; distinct-voter eligibility
  still relies on the private register.

`Reject` may reference only an existing submission; mismatch probes produce no
public rejection events. Before mixing physical ballots, retain them sealed and
mapped privately to submissions. Once mixed, mark that batch irreversible locally
so challenge resolution cannot claim individual exclusion. Digital paper-route
submissions can be excluded by their private submission reference before tally
finalisation. Publish aggregate reconciliation, never that private mapping.

## 6. Paper/online entitlement

Reserve the shared entitlement when either credential is issued. Paper-to-online
switching first requires confirmed cancellation of the unspent paper credential;
reserve the switch while online issuance is pending. Never reactivate the old ID.
After an anonymous online credential is issued, ordinary switching to paper is
unavailable until a revocation mechanism is defined; route the request to challenge
handling without automatically granting another vote.

## 7. Implementation checks

Require regression coverage for normalisation/check symbols, organiser-only
issuance, public submit/status authentication, replay versus changed-payload reuse,
fourth-failure alerts and replacement reset, concurrent accept/replace, crash/outbox
recovery, offline pending replies, fork resolution, cross-route entitlement, and
absence of identifiers/choices from public events. Test physical irreversible-batch
handling separately from digital exclusion; acceptance must never imply tally
inclusion without the corresponding reconciliation.

## 8. Implementation issue drafts

Proposed issues for `tidley/auditable-voting`; these have not yet been created on
GitHub. Each issue implements the specification above.

### 1. Define paper-ballot protocol types and deterministic state reducer

Implement the paper-ballot/v1 request, reply, and signed public transition schemas.
Allocate a regular Nostr event kind and define round configuration, canonical
commitment encoding, predecessor validation, and explicit fork resolution.

Acceptance criteria:
- Separate credential, submission, and challenge states with validated transitions.
- Verify organiser authority and reject unsupported versions and malformed payloads.
- Deterministic replay, deduplication, and forks that block affected acceptance.
- Public payloads/tags contain no raw identifiers, choices, private request IDs, or notes.
- Tests cover canonicalisation, invalid transitions, signer checks, and forks.

### 2. Implement coordinator-only paper credential issuance and recovery

Add issuance/reprint controls, CSV eligibility lookup, Crockford Base32 ID generation
and check symbols, signed registration, private delivery, and protected local storage.

Acceptance criteria:
- Only organiser-authorised registrations confer authority; public requests cannot issue.
- Preserve master-number leading zeroes and reject duplicate normalised CSV records.
- Reserve one entitlement; delivery retries reprint the same ID.
- Support private ID recovery via encrypted backup and fresh-ID replacement.
- Test generation, canonical commitment vectors, eligibility, and retry behaviour.

### 3. Implement public paper-credential submission and organiser verifier

Add public request, submission, and status UI using NIP-17 messages to the organiser
client. Validate responses against the pinned ballot definition and return signed results.

Acceptance criteria:
- No organiser login required for submission; require both identifiers for submit/status.
- Offline or unconfirmed requests remain pending; never imply relay delivery is acceptance.
- Persist payload-bound request IDs; identical retries return saved results securely.
- Enforce a single writer and transactional state/outbox updates with crash recovery.
- Distinguish physical receipt from digital submission and organiser acceptance.
- Test concurrent spending, changed-payload retries, deadlines, and publication outages.
- Explain organiser visibility of credential and choice in voter-facing copy.

### 4. Add persistent fourth-mismatch alerts and private organiser notifications

Count failed credential matches from submissions and status queries across sessions.

Acceptance criteria:
- Fourth distinct mismatch flags the panel and queues an encrypted organiser DM.
- Deduplicate retries; exclude malformed inputs and correctly matched spent credentials.
- Notify once per window; replacement resets the window while retaining round totals.
- Acknowledgement preserves history; failed DM delivery retries independently of the flag.
- Generic validation errors and no automatic credential lockout or cancellation.
- Test threshold, restart persistence, replay, privacy, and replacement behaviour.

### 5. Add organiser paper-ballot challenge and resolution controls

Implement private lookup, challenge intake, cancel/replace, provisional replacement,
resolution, cancellation, and printable case/status receipts.

Acceptance criteria:
- Intake works without OTP or a missing ballot ID; notes remain private.
- Confirm signed administrative effects; opening a challenge changes no entitlement.
- Replacement atomically supersedes the old unspent credential and registers the new one.
- Physical batch mixing is irreversible; UI cannot claim individual exclusion afterwards.
- Digital exclusions and replacement acceptance reconcile without counting both votes.
- Test provisional handling, irreversible batches, and rejected/unresolved challenges.

### 6. Integrate paper/online entitlement and auditable reconciliation

Coordinate issuance reservations across both routes, implement explicit switching
rules, and expose public signed history, relay confirmation, and aggregate totals.

Acceptance criteria:
- Online integration waits for a real resident/OTP verifier, not the preview UI.
- Paper-to-online switching confirms cancellation first and reserves pending issuance.
- An issued anonymous online credential cannot trigger automatic paper reissuance.
- Reconcile accepted, rejected, provisional, excluded, and counted submissions.
- Export organiser/observer public histories; distinguish retained evidence from completeness.
- Test pending switches, failed issuance recovery, event privacy, and reconciliation.
- Update README, both project explainers, and presentation with shipped behaviour and limits.
