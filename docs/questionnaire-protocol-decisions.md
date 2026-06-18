# Questionnaire Protocol Decisions

Date: `2026-04-14`
Status: `active`

This record freezes the implementation decisions for the questionnaire-first blind-token path.

## 1. Blind proof message domain

- Domain: `auditable-voting/questionnaire-blind-token/v1`
- Hash: `sha256(canonical_json(payload))`
- Payload fields:
  - `questionnaire_id`
  - `token_secret_commitment`
  - `response_mode = blind_token`
  - `schema_version = 1`
  - optional `ballot_scope` (`question_id`, `slot_id`, `slot_index`, `version`) for per-question credentials

## 2. Nullifier derivation

- Domain: `auditable-voting/questionnaire-nullifier/v1`
- Nullifier:
  - `sha256(canonical_json({ domain, questionnaire_id, token_secret, ballot_scope? }))`
- Legacy questionnaire-scoped credentials omit `ballot_scope`; per-question credentials include the same scope used in the blind proof message.

## 3. Issuance transport

- Reuses the existing private mailbox/envelope transport model.
- Public questionnaire objects remain on public questionnaire event kinds.
- Request and issuance bundle DMs keep plain JSON as the canonical fallback. Large `optiona_blind_request_bundle_dm` and `optiona_blind_issuance_bundle_dm` payloads may be wrapped as `optiona_compressed_bundle_dm` using gzip+base64url before NIP-17 encryption; decoders unwrap the bundle before normal envelope parsing.

## 4. Mode authority

- `responseMode = blind_token` is authoritative for new questionnaire definitions.
- `ballotCredentialMode = per_question` means the voter requests one credential per current ballot index. Questions sharing the same `slot_index` and `version` are shown/submitted as one group with one scoped proof; questions with different indices spend independent credentials.
- Changing answer-bearing question semantics bumps that ballot index group's slot `version`; old scoped credentials are not reinterpreted for the edited group.
- Legacy objects default to compatibility mode:
  - `responseMode = legacy_private_envelope` when field is missing.

## 5. Event kind policy

- Implementation kinds remain regular custom events:
  - `6420..6425`
- Spec target kinds documented but not yet migrated:
  - `34500..34503`

## 6. Organiser model

- Single-signer questionnaire token model in current repo version.

## 7. Encrypted payload boundary

- Publicly verifiable: admission-level checks (shape/nullifier/event consistency).
- Organiser-only verifiable: decrypted answer validation.

## 8. Result hash

- Domain: `auditable-voting/questionnaire-result-hash/v1`
- Hash over canonical summary payload:
  - `questionnaire_id`
  - `accepted_response_count`
  - `rejected_response_count`
  - `accepted_nullifier_count`
  - canonicalized `question_summaries`

## 9. State precedence

1. Latest explicit questionnaire state event wins when present.
2. If absent, infer from definition window:
  - before `openAt` => `draft`
  - `openAt <= now < closeAt` => `open`
  - `now >= closeAt` => `closed`

## 10. Migration boundary

- Historical questionnaire objects are not silently reinterpreted.
- Missing `responseMode` is treated as legacy compatibility mode.
