# Paper-ballot voter paths

Proposed UI and protocol behaviour, not a claim that these controls are shipped.

**This route accepts a lower level of identity assurance so that lack of a phone,
email address, or OTP access does not prevent participation.**

In this community, exclusion is a greater concern than impersonation. A guessable
master number lets somebody else activate and use a paper credential first; the
system accepts that risk and provides organiser-controlled challenges and recovery.

## 1. Entry and registration

| Route | Voter action |
| --- | --- |
| **Vote online** | Enter master number, complete OTP, obtain online voting authority. |
| **Request/use a paper ballot** | Enter master number, generate a ballot ID, print or complete the paper template. |

The master number identifies an eligible record in the organiser's questionnaire
CSV; it is not a secret. OTP offers stronger protection against impersonation.
An organiser can also register a paper ballot through their interface for a voter
without digital access.

- Generate ten random, case-insensitive Base32 characters using a CSPRNG; any
  check character is additional. Keep the ballot ID private.
- Put the master number and ballot ID on an outer envelope or detachable stub,
  **never on the marked inner ballot**.
- Register a public commitment:

  ```text
  C = SHA-256(encode(protocol-version, round-ID, master-number, ballot-ID))
  ```

  Define an unambiguous encoding and consistent input normalisation, preserving
  meaningful master-number characters such as leading zeroes.
- Registration must check eligibility and existing entitlement; a fresh ID must
  not create another entitlement for the same voter. The organiser's authorised
  signature confirms registration, including requests made from the public page.

## 2. Receipt and status

The organiser enters or scans both identifiers, and the app recomputes `C`.
**Record receipt** records delivery; **Accept** spends a registered, active
credential; **Reject** records a reason without counting a vote. Receipt alone
does not prove that the marked choice was counted correctly.

The voter can check status using both identifiers. The organiser can look up the
private eligibility record and print a status receipt for someone without digital
access. Separate and mix inner ballots before reading choices; reconcile accepted,
rejected, provisional, and counted totals.

## 3. Organiser challenge and recovery controls

Add a **Paper ballots** panel to the organiser interface, with private lookup by
master number, credential history, and these actions:

| Control | Required system behaviour |
| --- | --- |
| **Record challenge** | Open a case for unexpected activation/use, a missing ballot, or a lost ID. Allow staff to enter an in-person or written request without OTP or the missing ID. Keep the account private; print a case reference and follow-up instructions. |
| **Cancel and replace** | For an unspent credential, sign one transition cancelling the old commitment and registering a fresh one. Print the new stub; reject subsequent use of the old credential. |
| **Hold disputed ballot** | Flag an accepted credential for review and record any replacement ballot as provisional, excluded from the tally pending resolution. |
| **Resolve challenge** | Sign an uphold/reject decision with a procedural reason. If the original can still be excluded without exposing its choice, authorise its exclusion and accept the replacement together. Otherwise record the unresolved counting impact; never automatically count both. |
| **Cancel credential** | Sign a cancellation with a reason; retain its complete history. Cancellation after acceptance is a dispute, not evidence that a physical vote has been removed. |

The organiser's key authorises these actions; the UI must confirm their effect
before signing. A challenge does not itself cancel or replace anything. Local
recognition or community attestation can inform the organiser's decision without
requiring digital authentication. Publish help locations, deadlines, replacement
rules, and appeal arrangements in the app and printed instructions.

Once an inner ballot is anonymously mixed, the app cannot reliably remove it by
credential. Show that limit explicitly and record the chosen remedy, such as a
reported unresolved dispute or a rerun if it could affect the outcome.

## 4. Signed public history on Nostr

- Publish signed, non-replaceable events for **activation, receipt, acceptance,
  rejection, challenge, resolution, replacement, and cancellation**. Corrections
  append events rather than edit history.
- Include protocol version, round, commitment, action, procedural reason code,
  and preceding event references. Replacement links old and new commitments.
  Verify the signer against the round's authorised organiser key(s).
- Never publish master numbers, ballot IDs, private case notes, or links to marked
  choices, including in event tags. Public challenge events reveal only case
  status; linked commitments reveal credential history.
- Derive status from valid signed transitions, deduplicate retries, and flag
  conflicting decisions. Define a shared ordering rule before implementation;
  relay arrival order and timestamps alone cannot enforce single spending.
- Replicate across relays and retain organiser/observer exports. Nostr supports
  an immutable signed event history, but does not itself guarantee retention,
  completeness, or atomic updates.

Paper and online issuance must share an entitlement check. Route switching must
not issue a second vote; an already issued anonymous online credential cannot be
assumed revocable by master number. Optional notices and rate limits can help
detect misuse, but must not make digital access a condition of paper participation.
