# Questionnaire Blind-Token Protocol

Version: `1.1-draft`

## 1. Scope

This protocol defines the questionnaire-first path used by the client:

- public questionnaire definition and state
- private eligibility and blind issuance transport
- one blind-token response per submitted ballot index in per-question mode
- optional per-question blind credentials for current ballot-index slots
- deterministic duplicate handling by token nullifier, including scoped per-question nullifiers
- public result summary publication

The response payload mode can be:

- `public` (answers in cleartext)
- `encrypted` (answers encrypted, public admission still verifiable)

## 2. Canonical event kinds (current implementation)

- `6420` - questionnaire definition (`questionnaire_definition`)
- `6421` - questionnaire state (`questionnaire_state`)
- `6422` - encrypted private response envelope (`questionnaire_response_private`)
- `6423` - questionnaire result summary (`questionnaire_result_summary`)
- `6424` - blind-token response submission (`questionnaire_response_blind`)
- `6425` - public submission decision (`questionnaire_submission_decision`)

## 3. Questionnaire definition

Shape (camelCase in the shipped client):

- `schemaVersion: 1`
- `eventType: "questionnaire_definition"`
- `questionnaireId`
- `title`
- `description?`
- `createdAt`, `openAt`, `closeAt`
- `coordinatorPubkey` (current schema field for the organiser public key)
- `coordinatorEncryptionPubkey` (current schema field for the organiser encryption key)
- `responseVisibility: "public" | "private"`
- `eligibilityMode: "open" | "allowlist"`
- `allowMultipleResponsesPerPubkey: boolean`
- `ballotCredentialMode?: "questionnaire" | "per_question"`
- `questions[]` (`yes_no`, `multiple_choice`, `rank`, `free_text`; free text may set `encryptResponses: true`)
- each question may carry `ballotSlot: { slotId, slotIndex, version }` when `ballotCredentialMode` is `per_question`; questions with the same `slotIndex` and `version` share one ballot credential
- `credentialsPerVoter` may be present in legacy definitions, but current proxy voting is per voter: the organiser stores the allowance in the whitelist/invite metadata, sends `credentialsPerVoter: 2` only to that voter, and includes the proxy-voter npub list in worker config so other voters cannot receive a second credential

Tags:

- `["t", "questionnaire_definition"]`
- `["questionnaire-id", "<id>"]`
- `["state", "draft"]`

Validation rules include:

- `questionnaireId` present
- `openAt < closeAt`
- unique `questionId`
- unique `optionId` within each multiple-choice and rank question
- valid positive live ballot slot indices and versions when per-question credentials are used; duplicate `slotIndex:v<version>` groups are intentional and spend one shared credential
- ranked-choice questions use internal type `rank` and may set `minimumRanked` from `0` up to the option count
- required organiser keys present

When an answer-bearing question changes after credentials have been issued, the client keeps the question identity but bumps the slot `version` for that ballot index group. New blind-token requests for that group are then bound to the new slot version; old scoped credentials remain unspendable for the edited slot.

## 4. Questionnaire state

Shape:

- `schemaVersion: 1`
- `eventType: "questionnaire_state"`
- `questionnaireId`
- `state: "draft" | "open" | "closed" | "results_published"`
- `createdAt`
- `coordinatorPubkey` (current schema field for the organiser public key)
- optional delegated close provenance:
  - `closedBy: "audit_proxy"`
  - `delegationId`
  - `workerPubkey`

Tags:

- `["t", "questionnaire_state"]`
- `["questionnaire-id", "<id>"]`
- `["state", "<state>"]`

Latest valid state for a questionnaire is authoritative. A delegated audit proxy may publish `state: "closed"` only when its organiser-signed delegation includes close authority and the accepted valid response count has reached the expected invitee count.

## 5. Response submission modes

### 5.1 Private encrypted envelope (`6422`)

Used in the currently shipped questionnaire panel:

- `eventType: "questionnaire_response_private"`
- encrypted payload (`nip44v2`)
- `payloadHash` integrity check

### 5.2 Blind-token response (`6424`)

Blind-token admission object:

- `eventType: "questionnaire_response_blind"`
- `questionnaireId`
- `responseId`
- `submittedAt`
- `authorPubkey` (ephemeral response key expected)
- `tokenNullifier`
- `tokenProof` (`tokenCommitment`, `questionnaireId`, `signature`)
- optional `tokenNullifiers[]` for scoped responses, each carrying `questionId?`, `tokenNullifier`, and `ballotScope?`; current per-question submissions carry one scoped entry per submitted ballot index
- optional `tokenProofs[]` for scoped responses, each carrying `tokenCommitment`, `questionnaireId`, `signature`, `questionId?`, and `ballotScope?`; current per-question submissions carry one scoped entry per submitted ballot index
- `answers` (public mode) or `encryptedPayload` + `payloadHash` (encrypted mode)

`ballotScope` canonical fields are `questionId`, `slotId`, `slotIndex`, `version`, and optional `credentialIndex`. The live scope key is `slotIndex + version + credentialIndex`; `questionId` and `slotId` remain descriptive/canonical fields. `credentialIndex` is omitted for the first credential and included as `credential_index` for proxy credential `2`. The signed blind-token message includes the canonical scope when present:

- `questionnaire_id`
- `response_mode = blind_token`
- `schema_version = 1`
- `token_secret_commitment`
- optional `ballot_scope`

The token nullifier is also derived over the same optional `ballot_scope`. Legacy single-credential submissions omit the arrays and continue to use `tokenProof` and `tokenNullifier`.

The final `tokenCommitment` is response-side proof material. It must not be included in blind request DMs, blind request bundle DMs, blind issuance DMs, or blind issuance bundle DMs. Issuers receive only the voter identity used for eligibility, the blinded message, key id, nonce, optional invite-code hash, and optional ballot scope. Issuance replies contain the blind signature, key id, request id, voter delivery identity, scope, and public definition reference. That means the organiser or proxy can authorise and sign but cannot later match a public `tokenCommitment` back to the eligible voter who requested the signature.

Tags:

- `["t", "questionnaire_response_blind"]`
- `["questionnaire", "<id>"]`
- `["schema", "1"]`
- `["etype", "questionnaire_response_blind"]`
- `["nullifier", "<tokenNullifier>"]`
- `["e", "<questionnaire_definition_event_id>"]`
- optional `["payload-mode", "encrypted"]`

## 6. Result summary

Shape:

- `schemaVersion: 1`
- `eventType: "questionnaire_result_summary"`
- `questionnaireId`
- `createdAt`
- `coordinatorPubkey` (current schema field for the organiser public key)
- `acceptedResponseCount`
- `rejectedResponseCount`
- `questionSummaries[]`

Ranked-choice summaries use total points per option, where higher is better. A ranked answer stores ordered `rankedOptionIds`; first choice receives one point per available option, later choices count down from there, and unranked options receive `0` points. If a ranked-choice question has `minimumRanked: 0` and a voter leaves it blank, every option receives `0` points for that response.

Tags:

- `["t", "questionnaire_result_summary"]`
- `["questionnaire-id", "<id>"]`

## 7. Deterministic admission rule

Blind responses are evaluated in canonical order:

1. `event.created_at` ascending
2. `event.id` ascending

Then:

- first valid response for a `tokenNullifier` is accepted
- for bundled responses, every listed `tokenNullifier` is reserved by the accepted response
- later valid responses with any already accepted `tokenNullifier` are rejected as `duplicate_nullifier`

This rule is implemented in the client transport layer and covered by regression tests.

## 8. Verifier expectations

Public verifier should be able to check:

- questionnaire existence and shape
- response object shape
- every proof in a bundled response verifies against the questionnaire id, token commitment, and optional ballot scope
- deterministic duplicate-nullifier and duplicate-token-commitment rejection
- summary/accounting consistency

Organiser-side verification (especially in encrypted mode) additionally checks:

- payload decryption
- answer schema validity
- required answers
- option validity, rank minimums, and free-text length limits

## 9. Private bundle transport

Blind request and blind issuance DMs are ordinary JSON envelopes by default. Large bundled envelopes may be wrapped before NIP-17 encryption as:

- `type: "optiona_compressed_bundle_dm"`
- `schemaVersion: 1`
- `encoding: "gzip+base64url"`
- `innerType: "optiona_blind_request_bundle_dm" | "optiona_blind_issuance_bundle_dm"`
- `payload` containing the gzip-compressed inner JSON envelope encoded as unpadded base64url
- `originalLength`, `compressedLength`, and `sentAt`

Decoders must accept both the plain JSON bundle envelope and the compressed wrapper. After decompression, the inner envelope is parsed exactly as if it had been received directly, and the inner `type` must match `innerType`. Compression is applied only to the private JSON envelope before gift wrapping; encrypted NIP-17 events are not recompressed.

## 10. Relay compatibility notes

For reliability on public relays:

- do not rely only on tag-index filters
- use broad kind fetch with local `questionnaireId` reconciliation fallback where required
- keep transcript-carrying questionnaire kinds outside Nostr replaceable and parameterised-replaceable ranges; current implementation kinds are regular custom events so repeated rounds and submissions are not displaced by newer events from the same organiser or voter key

## 11. Normative summary

1. Questionnaire definition must be public.
2. Response admission must be deterministic.
3. At most one accepted response per `tokenNullifier`; bundled responses reserve every nullifier in the bundle.
4. Earliest canonical valid response per nullifier wins.
5. Result summaries must be derived from accepted responses only.
