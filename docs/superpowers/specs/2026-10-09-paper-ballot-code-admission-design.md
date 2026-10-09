# Paper Ballot Code Admission

## Goal

Control printed ballot access without linking a submitted anonymous ballot to a
master-list record.

## Code Lifecycle

The organiser creates one unique ten-character uppercase alphanumeric code for
election ID, master-list number, expiry, and unused status. It never stores the
plain code after printing.

The paper ballot shows the code and clear conditional instructions. A dependent
question states which preceding answer makes it applicable and says to leave it
blank otherwise.

## Admission

The voter enters the paper code and master-list number at the ballot-access
screen. The configured issuer, either the organiser browser or delegated Linux
worker, verifies the code hash, election, master-list binding, expiry, and
unused status. It atomically marks the code consumed and immediately returns a
fresh blind credential.

The voter then submits answers using that credential. The ballot submission
does not contain the paper code or master-list number. No further organiser
action is required after admission.

## Failure Rules

- A code is valid for only one election and one master-list number.
- A consumed, expired, or unmatched code does not issue a credential.
- If credential delivery fails after consumption, the issuer retains the exact
  issuance record for encrypted receipt/recovery, rather than issuing a second
  credential.

## Verification

Tests cover code format and hashing, master-list and election mismatch,
expiry, single use, immediate credential issuance, recovery after delivery
failure, and absence of paper identifiers from anonymous ballot payloads.
