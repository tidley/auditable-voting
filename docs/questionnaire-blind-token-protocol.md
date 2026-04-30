# Questionnaire Blind-Token Protocol

Version: `1.0-draft`

## 1. Scope

This protocol defines the questionnaire-first path used by the client:

- public questionnaire definition and state
- private eligibility and blind issuance transport
- one blind-token response bundle per voter
- deterministic duplicate handling by token nullifier
- public result summary publication

The response payload mode can be:

- `public` (answers in cleartext)
- `encrypted` (answers encrypted, public admission still verifiable)

## 2. Canonical event kinds (current implementation)

- `14120` - questionnaire definition (`questionnaire_definition`)
- `14121` - questionnaire state (`questionnaire_state`)
- `14122` - encrypted private response envelope (`questionnaire_response_private`)
- `14123` - questionnaire result summary (`questionnaire_result_summary`)
- `14124` - blind-token response submission (`questionnaire_response_blind`)

## 3. Questionnaire definition

Shape (camelCase in the shipped client):

- `schemaVersion: 1`
- `eventType: "questionnaire_definition"`
- `questionnaireId`
- `title`
- `description?`
- `createdAt`, `openAt`, `closeAt`
- `coordinatorPubkey`
- `coordinatorEncryptionPubkey`
- `responseVisibility: "public" | "private"`
- `eligibilityMode: "open" | "allowlist"`
- `allowMultipleResponsesPerPubkey: boolean`
- `questions[]` (`yes_no`, `multiple_choice`, `free_text`)

Tags:

- `["t", "questionnaire_definition"]`
- `["questionnaire-id", "<id>"]`
- `["state", "draft"]`

Validation rules include:

- `questionnaireId` present
- `openAt < closeAt`
- unique `questionId`
- unique `optionId` within each multiple-choice question
- required coordinator keys present

## 4. Questionnaire state

Shape:

- `schemaVersion: 1`
- `eventType: "questionnaire_state"`
- `questionnaireId`
- `state: "draft" | "open" | "closed" | "results_published"`
- `createdAt`
- `coordinatorPubkey`
- optional delegated close provenance:
  - `closedBy: "audit_proxy"`
  - `delegationId`
  - `workerPubkey`

Tags:

- `["t", "questionnaire_state"]`
- `["questionnaire-id", "<id>"]`
- `["state", "<state>"]`

Latest valid state for a questionnaire is authoritative. A delegated audit proxy may publish `state: "closed"` only when its coordinator-signed delegation includes close authority and the accepted valid response count has reached the expected invitee count.

## 5. Response submission modes

### 5.1 Private encrypted envelope (`14122`)

Used in the currently shipped questionnaire panel:

- `eventType: "questionnaire_response_private"`
- encrypted payload (`nip44v2`)
- `payloadHash` integrity check

### 5.2 Blind-token response (`14124`)

Blind-token admission object:

- `eventType: "questionnaire_response_blind"`
- `questionnaireId`
- `responseId`
- `submittedAt`
- `authorPubkey` (ephemeral response key expected)
- `tokenNullifier`
- `tokenProof` (`tokenCommitment`, `questionnaireId`, `signature`)
- `answers` (public mode) or `encryptedPayload` + `payloadHash` (encrypted mode)

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
- `coordinatorPubkey`
- `acceptedResponseCount`
- `rejectedResponseCount`
- `questionSummaries[]`

Tags:

- `["t", "questionnaire_result_summary"]`
- `["questionnaire-id", "<id>"]`

## 7. Deterministic admission rule

Blind responses are evaluated in canonical order:

1. `event.created_at` ascending
2. `event.id` ascending

Then:

- first valid response for a `tokenNullifier` is accepted
- later valid responses with the same `tokenNullifier` are rejected as `duplicate_nullifier`

This rule is implemented in the client transport layer and covered by regression tests.

## 8. Verifier expectations

Public verifier should be able to check:

- questionnaire existence and shape
- response object shape
- deterministic duplicate-nullifier rejection
- summary/accounting consistency

Coordinator-side verification (especially in encrypted mode) additionally checks:

- payload decryption
- answer schema validity
- required answers
- option validity and free-text length limits

## 9. Relay compatibility notes

For reliability on public relays:

- do not rely only on tag-index filters
- use broad kind fetch with local `questionnaireId` reconciliation fallback where required

## 10. Normative summary

1. Questionnaire definition must be public.
2. Response admission must be deterministic.
3. At most one accepted response per `tokenNullifier`.
4. Earliest canonical valid response per nullifier wins.
5. Result summaries must be derived from accepted responses only.
