# Auditable Voting Protocol Specification

Version: `0.1-draft`
Status: describes the shipped browser client unless a section is marked **Proposed**.

## 1. Purpose and scope

Auditable Voting is a browser-first questionnaire voting protocol using Nostr relays for public records and NIP-17 direct messages for private eligibility and credential delivery.

It separates:

1. eligibility, decided by an organiser or delegated audit proxy;
2. anonymous ballot submission, made with a one-use blind credential; and
3. public verification, performed from published questionnaire, ballot, decision, and result events.

This document is an architectural specification. The normative event fields and validation rules are in [Questionnaire Blind-Token Protocol](./questionnaire-blind-token-protocol.md).

## 2. Roles and trust boundaries

| Role | Responsibilities | Does not learn by design |
| --- | --- | --- |
| Organiser | Defines a questionnaire, decides eligibility, issues or delegates credentials, publishes state and results. | The final credential commitment and the voter-to-ballot link. |
| Voter | Controls a Nostr identity for eligibility and a browser-local token secret and blinding factor for the ballot. | Other voters' credentials or private invite codes. |
| Audit proxy | Optional organiser-authorised helper for credential issuance, verification, decisions, closing, and summaries. | The final credential commitment during issuance. |
| Observer | Reads public records, verifies proofs, duplicate prevention, decisions, and tally. | Voter eligibility identities, private invite codes, and encrypted answers without the relevant key. |
| Relay | Stores and forwards Nostr events and NIP-17 envelopes. | Plaintext NIP-17 content, assuming the cryptography and endpoints are trustworthy. |

The organiser is trusted to apply eligibility fairly. Relays, observers, and the public do not need to trust the organiser's reported tally because they can recompute it from public accepted ballots.

## 3. Current protocol

### 3.1 Questionnaire publication

The organiser creates and signs a public questionnaire definition. It includes a stable questionnaire ID, organiser public keys, open and close times, questions, response visibility, eligibility mode, blind-signing public key material, and optional voter-group scope metadata.

The organiser publishes public questionnaire state transitions: `draft`, `open`, `closed`, and `results_published`. The latest valid signed state is authoritative.

### 3.2 Admission and invites

The client supports these admission paths:

- **General invite:** a shareable link opens Vote, creates a fresh browser-local voter identity, and requests a ballot. The organiser may approve the resulting request.
- **Personalised invite:** a link names an expected Nostr public key; the voter must use that identity.
- **Private one-use invite:** a bearer URL contains a high-entropy code. Newly generated links place it only in the URL fragment as `#invite_code=...`; the browser immediately scrubs `invite_code` and `code` from both query and fragment and retains the normalised code only in the current history entry. Previously issued query-string links remain accepted. The protocol transmits and records only a hash of the code, never the raw code in public records.
- **Organiser roster:** a browser-local roster can be applied to a questionnaire as eligibility input without publishing the roster itself.

Admission binds an eligibility identity to the right to receive a credential. It must not bind that identity to a submitted ballot.

### 3.3 Blind credential issuance

1. The voter creates a random token secret and a random blinding factor locally.
2. The voter constructs a message committing to the questionnaire ID, protocol version, token-secret commitment, and any permitted ballot scope.
3. The voter blinds that message and sends only the blinded message, eligibility identity, nonce, and necessary scope/invite-code-hash data in a NIP-17 request.
4. The organiser or audit proxy verifies eligibility and blind-signs the request.
5. The voter unblinds the signature locally and stores the resulting credential, token secret, and blinding factor in browser-local state.

The issuer must never receive the final unblinded token commitment. This is the privacy boundary that prevents it from matching credential issuance to a later public response.

Proxy voters may receive two independently blinded credentials. Each credential has a distinct credential index and produces a distinct nullifier when spent.

### 3.4 Anonymous ballot submission

The voter submits a public blind-token response from a fresh response identity. The response contains answers or an encrypted answer payload, the token commitment and blind signature proof, and a nullifier derived from the token secret and ballot scope.

The verifier checks:

1. the questionnaire definition and submission shape;
2. the blind signature against the published blind-signing key;
3. the questionnaire ID, protocol version, and allowed ballot scope embedded in the credential;
4. answer validity and required scopes; and
5. that every submitted nullifier has not already been accepted.

Accepted nullifiers are public one-use markers. They prevent a credential being spent twice without exposing the voter identity or token secret.

### 3.5 Deterministic decisions and audit

Valid response candidates are ordered by Nostr `created_at`, then event ID. The first valid response using a nullifier is accepted; later responses using it are rejected as duplicates. The organiser or audit proxy publishes public accept/reject decisions and, once closed, a result summary.

Observers independently verify public proofs, apply the deterministic duplicate rule, and recompute result counts. Public provisional response events, where enabled, are display hints only and never count as votes.

## 4. Privacy and security properties

The protocol aims to provide:

- eligibility enforcement without publishing the eligible-voter roster;
- unlinkability between a correctly blinded issuance and a later valid ballot proof;
- one accepted use per credential/nullifier;
- public verification of accepted ballots and tally; and
- explicit scope limits for voter groups and proxy credentials.

It does not solve:

- coercion, vote selling, or a voter voluntarily sharing their credential;
- compromise of the voter device, browser, or local browser state;
- traffic analysis from Nostr identity use, timing, relay selection, or network metadata;
- dishonest eligibility decisions by the organiser; or
- availability failures of relays, browsers, or an optional audit proxy.

This is experimental software and requires independent cryptographic and implementation review before high-stakes use.

## 5. General-invite proof of work

### 5.1 Current status

**Implemented in the browser and audit proxy worker 0.1.43 or later.** A questionnaire definition can set `generalInvitePowDifficulty` from 0 to 24 leading zero SHA-256 bits. The browser mines a request-bound proof for non-private-code blind-ballot requests; browser organisers and compatible delegated workers verify it before recording an eligible general request or signing it. Private one-use invite-code requests are exempt. A relay may independently require Nostr event PoW; that remains relay policy rather than this admission rule.

### 5.2 Objective

Configurable PoW could make automated general-invite ballot requests more expensive before they reach organiser approval. It is an anti-spam control, not voter authentication, eligibility proof, or Sybil-proof admission.

Private and personalised invites should not require general-invite PoW by default because their secret/code or identity binding already provides a different admission control.

### 5.3 Shipped configuration

A questionnaire definition carries:

```json
{
  "generalInvitePowDifficulty": 0
}
```

- `generalInvitePowDifficulty: 0` means disabled and preserves today's behaviour.
- The value is the required number of leading zero bits in a SHA-256 digest, limited to 0 through 24.

### 5.4 Shipped challenge and verification

The voter derives the challenge from immutable public and request-bound data:

```
["auditable-voting-general-invite-pow:v1", electionId, requestId, invitedNpub, blindSigningKeyId, blindedMessage, clientNonce, nonce]
```

The voter searches for a decimal `nonce` whose SHA-256 digest meets the configured difficulty, then includes it as `generalInvitePow.nonce` in the private blind-credential request.

The browser organiser or compatible delegated worker verifies that:

1. the request has no private invite-code claim;
2. the canonical fields and nonce reproduce the claimed digest; and
3. the digest satisfies the configured difficulty.

Binding work to the request ID, voter identity, signing key, blinded message, and client nonce prevents one solved puzzle being copied to many distinct requests. The blinded message does not reveal the final token commitment.

The current request format cannot cryptographically prove that a voter arrived through a particular general-link URL. Therefore, when enabled, the browser enforces the proof for every request without a private invite-code claim, including a personalised-link request. This is stricter than general-link-only enforcement and prevents a client from bypassing PoW by falsely labelling its request as personalised.

### 5.5 Design constraints

- PoW verification must occur before signing and before an audit proxy records the request as eligible.
- Difficulty must be published in the signed definition; it must not be supplied only by the invite URL or a relay.
- Existing definitions without `generalInvitePowDifficulty` remain disabled.
- The browser UI discloses that it mines before the request is sent.
- Difficulty should be conservative and measured on mobile devices. Excessive difficulty excludes low-power devices and is not a substitute for an eligibility policy.
- The verifier must use a fixed canonical byte encoding. String concatenation shown above is explanatory, not a final wire encoding.
- There is currently no expiry window, so a proof remains valid for its exact request. A future expiry design requires a protocol revision and test vectors.
- Delegated `issue_blind_tokens` workers must be version 0.1.43 or later when this setting is non-zero. Older workers do not verify this proof and must not be delegated for those questionnaires.

## 6. Compatibility and evolution

Protocol additions must be versioned, optional where practical, and ignored safely by older clients when they do not affect verification. A definition requiring PoW is an exception: an old issuer that does not enforce it must not be used for that questionnaire. The current client permits delegated blind-token issuance for it only with worker 0.1.43 or later.

Changes to signature payloads, scope canonicalisation, nullifier derivation, or event kinds require a version bump, test vectors, migration policy, and public documentation update.

## 7. Related documents

- [Questionnaire Blind-Token Protocol](./questionnaire-blind-token-protocol.md): event shapes and detailed validation rules.
- [Technical Protocol Note](./technical-protocol-note.md): implementation and operational detail.
- [Project explainer](./project-explainer.md): public-facing overview and limitations.
