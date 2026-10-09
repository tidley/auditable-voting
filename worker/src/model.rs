use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[cfg(test)]
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION: u16 = 6420;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE: u16 = 6421;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND: u16 = 6424;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION: u16 = 6425;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY: u16 = 6423;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkerCapability {
    IssueBlindTokens,
    VerifyPublicSubmissions,
    PublishSubmissionDecisions,
    CloseQuestionnaire,
    PublishResultSummary,
    QueuePrivateSubmissions,
    ReportPrivateProgress,
    ReleaseSubmissionBatches,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDelegationCertificate {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub delegation_id: String,
    pub election_id: String,
    pub coordinator_npub: String,
    pub worker_npub: String,
    pub capabilities: Vec<WorkerCapability>,
    pub control_relays: Vec<String>,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDelegationRevocation {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub delegation_id: String,
    pub election_id: String,
    pub coordinator_npub: String,
    pub worker_npub: String,
    pub revoked_at: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatusSnapshot {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub worker_npub: String,
    pub coordinator_npub: String,
    pub worker_version: String,
    pub state: String,
    pub heartbeat_at: String,
    pub active_election_id: Option<String>,
    pub delegation_id: Option<String>,
    pub delegation_state: Option<String>,
    pub last_blind_issuance_at: Option<String>,
    pub last_vote_verification_at: Option<String>,
    pub last_decision_publish_at: Option<String>,
    pub supported_capabilities: Vec<WorkerCapability>,
    pub advertised_relays: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatusEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub snapshot: WorkerStatusSnapshot,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDelegationEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub delegation: WorkerDelegationCertificate,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRevocationEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub revocation: WorkerDelegationRevocation,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerElectionConfigSnapshot {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub delegation_id: String,
    pub config_version: u64,
    pub coordinator_npub: String,
    pub worker_npub: String,
    pub expected_invitee_count: Option<u64>,
    #[serde(default)]
    pub whitelist_npubs: Option<Vec<String>>,
    #[serde(default)]
    pub proxy_voter_npubs: Option<Vec<String>>,
    #[serde(default)]
    pub ballot_groups_by_npub: Option<HashMap<String, String>>,
    #[serde(default)]
    pub bearer_invite_codes: Option<Vec<BearerInviteCodeEntry>>,
    #[serde(default)]
    pub eligibility_required: Option<bool>,
    pub blind_signing_private_key: Option<QuestionnaireBlindPrivateKey>,
    #[serde(default)]
    pub definition_reference: Option<QuestionnaireDefinitionReference>,
    #[serde(default)]
    pub definition: Option<serde_json::Value>,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateBallotSubmission {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub submission_id: String,
    pub submission: PrivateBallotSubmissionPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateBallotSubmissionPayload {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub submission_id: String,
    pub invited_npub: String,
    #[serde(default)]
    pub response_npub: Option<String>,
    pub token_commitment: String,
    pub blind_signing_key_id: String,
    pub credential: String,
    pub nullifier: String,
    #[serde(default)]
    pub credential_bundle: Option<Vec<PrivateBallotCredentialProof>>,
    pub payload: PrivateBallotPayload,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateBallotCredentialProof {
    #[serde(default)]
    pub question_id: Option<String>,
    pub token_commitment: String,
    pub blind_signing_key_id: String,
    pub credential: String,
    pub nullifier: String,
    #[serde(default)]
    pub ballot_scope: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateBallotPayload {
    pub election_id: String,
    pub responses: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateBallotReceipt {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub submission_id: String,
    pub accepted: bool,
    pub received_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateQueueProgress {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub accepted_count: u64,
    pub rejected_count: u64,
    pub queued_count: u64,
    pub batch_threshold: u64,
    pub submission_deadline: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateQueuedSubmissionPublication {
    pub batch_id: String,
    pub created_at: i64,
    #[serde(default)]
    pub delegation_id: String,
    #[serde(default)]
    pub definition_hash: String,
    pub attempts: u32,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    /// Fully signed Nostr event JSON saved before relay publication for crash-safe retries.
    #[serde(default)]
    pub prepared_event_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivateBatchReleaseReason {
    Threshold,
    Deadline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateBatchPublication {
    pub batch_id: String,
    pub release_reason: PrivateBatchReleaseReason,
    pub count: u64,
    pub attempts: u32,
    #[serde(default)]
    pub prepared_event_json: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuestionnaireDefinitionReference {
    pub questionnaire_id: String,
    #[serde(default)]
    pub coordinator_npub: Option<String>,
    #[serde(default)]
    pub relays: Option<Vec<String>>,
    #[serde(default)]
    pub definition_hash: Option<String>,
    #[serde(default)]
    pub definition_event_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BearerInviteCodeEntry {
    pub election_id: String,
    pub code_hash: String,
    pub created_at: String,
    pub state: String,
    #[serde(default)]
    pub credentials_per_voter: Option<u8>,
    #[serde(default)]
    pub max_redemptions: Option<usize>,
    #[serde(default)]
    pub ballot_group: Option<String>,
    #[serde(default)]
    pub redeemed_at: Option<String>,
    #[serde(default)]
    pub redeemed_npub: Option<String>,
    #[serde(default)]
    pub redeemed_npubs: Vec<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerElectionConfigEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub snapshot: WorkerElectionConfigSnapshot,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionnaireBlindPrivateKey {
    pub scheme: String,
    pub key_id: String,
    pub jwk: serde_json::Value,
    pub private_jwk: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub request_id: String,
    pub invited_npub: String,
    pub blinded_message: String,
    pub blind_signing_key_id: String,
    pub client_nonce: String,
    pub created_at: String,
    #[serde(default)]
    pub invite_code_hash: Option<String>,
    #[serde(default)]
    pub general_invite_pow: Option<GeneralInvitePowProof>,
    #[serde(default)]
    pub ballot_scope: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralInvitePowProof {
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotRequestEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub request: BlindBallotRequest,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotRequestBundleEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub requests: Vec<BlindBallotRequest>,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressedBundleEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub encoding: String,
    pub inner_type: String,
    pub payload: String,
    pub original_length: usize,
    pub compressed_length: usize,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotIssuance {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub request_id: String,
    pub issuance_id: String,
    pub invited_npub: String,
    pub blind_signing_key_id: String,
    pub blind_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_event_id: Option<String>,
    #[serde(default)]
    pub ballot_scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<serde_json::Value>,
    pub issued_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotIssuanceEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub issuance: BlindBallotIssuance,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotIssuanceBundleEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<serde_json::Value>,
    pub issuances: Vec<BlindBallotIssuance>,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotPlan {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub plan_id: String,
    pub election_id: String,
    pub invited_npub: String,
    pub issuer_npub: String,
    pub initial_request_id: String,
    pub blind_signing_key_id: String,
    pub definition_hash: Option<String>,
    pub definition_event_id: Option<String>,
    pub credential_count: u8,
    pub ballot_scopes: Vec<serde_json::Value>,
    pub issued_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindBallotPlanEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub plan: BlindBallotPlan,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OptionAParticipantStatusState {
    BallotRequested,
    BallotIssued,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptionAParticipantStatus {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub invited_npub: String,
    pub source: String,
    pub state: OptionAParticipantStatusState,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptionAParticipantStatusEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub status: OptionAParticipantStatus,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlindIssuanceAck {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub request_id: String,
    pub issuance_id: String,
    pub invited_npub: String,
    pub acked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlindIssuanceAckEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub ack: BlindIssuanceAck,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindTokenProof {
    pub token_commitment: String,
    pub questionnaire_id: String,
    pub signature: String,
    #[serde(default)]
    pub question_id: Option<String>,
    #[serde(default)]
    pub ballot_scope: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindTokenNullifier {
    #[serde(default)]
    pub question_id: Option<String>,
    pub token_nullifier: String,
    #[serde(default)]
    pub ballot_scope: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionnaireBlindResponseEvent {
    pub schema_version: u8,
    pub event_type: String,
    pub questionnaire_id: String,
    pub response_id: String,
    pub submitted_at: i64,
    pub author_pubkey: String,
    pub token_nullifier: String,
    #[serde(default)]
    pub token_nullifiers: Vec<BlindTokenNullifier>,
    pub token_proof: BlindTokenProof,
    #[serde(default)]
    pub token_proofs: Vec<BlindTokenProof>,
    #[serde(default)]
    pub answers: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionnaireSubmissionDecisionEvent {
    pub schema_version: u8,
    pub event_type: String,
    pub questionnaire_id: String,
    pub submission_id: String,
    pub token_nullifier: String,
    pub accepted: bool,
    pub reason: String,
    pub decided_at: i64,
    pub coordinator_pubkey: String,
    pub delegation_id: Option<String>,
    pub worker_pubkey: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionnairePublishedResponseRef {
    pub response_id: String,
    pub author_pubkey: String,
    pub submitted_at: i64,
    pub accepted: bool,
    #[serde(default)]
    pub answers: Vec<serde_json::Value>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ElectionRuntimeState {
    #[serde(default)]
    pub election_id: String,
    #[serde(default)]
    pub delegation_id: String,
    #[serde(default)]
    pub capabilities: Vec<WorkerCapability>,
    #[serde(default)]
    pub control_relays: Vec<String>,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub processed_submission_ids: HashSet<String>,
    #[serde(default)]
    pub private_queued_submissions: HashMap<String, PrivateBallotSubmission>,
    #[serde(default)]
    pub private_submission_publications: HashMap<String, PrivateQueuedSubmissionPublication>,
    #[serde(default)]
    pub private_batch_publications: HashMap<String, PrivateBatchPublication>,
    #[serde(default)]
    pub accepted_nullifiers: HashSet<String>,
    #[serde(default)]
    pub accepted_token_commitments: HashSet<String>,
    #[serde(default)]
    pub published_decisions: HashMap<String, String>,
    #[serde(default)]
    pub published_response_refs: Vec<QuestionnairePublishedResponseRef>,
    #[serde(default)]
    pub seen_blind_request_ids: HashSet<String>,
    #[serde(default)]
    pub deferred_blind_request_ids: HashSet<String>,
    #[serde(default)]
    pub deferred_blind_requests: HashMap<String, BlindBallotRequest>,
    /// First proxy requests held until the voter returns the plan's additional request.
    #[serde(default)]
    pub planned_blind_requests: HashMap<String, BlindBallotRequest>,
    #[serde(default)]
    pub blind_ballot_plans_by_voter: HashMap<String, BlindBallotPlan>,
    #[serde(default)]
    pub issued_invited_npubs: HashSet<String>,
    #[serde(default)]
    pub issued_invited_scope_keys: HashSet<String>,
    #[serde(default)]
    pub issued_issuances_by_request_id: HashMap<String, BlindBallotIssuance>,
    #[serde(default)]
    pub whitelist_npubs: HashSet<String>,
    #[serde(default)]
    pub proxy_voter_npubs: HashSet<String>,
    #[serde(default)]
    pub ballot_groups_by_npub: HashMap<String, String>,
    #[serde(default)]
    pub bearer_invite_codes: HashMap<String, BearerInviteCodeEntry>,
    #[serde(default)]
    pub eligibility_configured: bool,
    #[serde(default)]
    pub eligibility_required: bool,
    #[serde(default)]
    pub accepted_response_authors: HashSet<String>,
    #[serde(default)]
    pub accepted_response_count: u64,
    #[serde(default)]
    pub rejected_response_count: u64,
    #[serde(default)]
    pub expected_invitee_count: Option<u64>,
    #[serde(default)]
    pub last_election_config_sent_at: Option<String>,
    #[serde(default)]
    pub last_election_config_version: u64,
    #[serde(default)]
    pub summary_published: bool,
    #[serde(default)]
    pub last_result_summary_publish_at: Option<String>,
    #[serde(default)]
    pub questionnaire_close_published: bool,
    #[serde(default)]
    pub last_questionnaire_close_publish_at: Option<String>,
    #[serde(default)]
    pub blind_signing_private_key: Option<QuestionnaireBlindPrivateKey>,
    #[serde(default)]
    pub definition_hash: Option<String>,
    #[serde(default)]
    pub definition_event_id: Option<String>,
    #[serde(default)]
    pub definition_relays: Vec<String>,
    #[serde(default)]
    pub definition: Option<serde_json::Value>,
    #[serde(default)]
    pub last_blind_issuance_at: Option<String>,
    #[serde(default)]
    pub last_vote_verification_at: Option<String>,
    #[serde(default)]
    pub last_decision_publish_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkerPersistentState {
    #[serde(default)]
    pub coordinator_npub: String,
    #[serde(default)]
    pub worker_npub: String,
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(default)]
    pub known_delegations: HashMap<String, WorkerDelegationCertificate>,
    #[serde(default)]
    pub revocations: HashMap<String, WorkerDelegationRevocation>,
    #[serde(default)]
    pub elections: HashMap<String, ElectionRuntimeState>,
    #[serde(default)]
    pub last_heartbeat_at: Option<String>,
    #[serde(default)]
    pub last_dm_scan_at: Option<String>,
    #[serde(default)]
    pub last_public_scan_at: Option<String>,
    #[serde(default)]
    pub seen_control_event_ids: HashMap<String, String>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn is_expired(iso_time: &str) -> bool {
    match DateTime::parse_from_rfc3339(iso_time) {
        Ok(parsed) => parsed.with_timezone(&Utc) <= Utc::now(),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_state_loads_legacy_runtime_state_without_new_fields() {
        let raw = r#"{
            "coordinator_npub": "npub1coordinator",
            "worker_npub": "npub1worker",
            "relays": ["wss://relay.nostr.net"],
            "known_delegations": {},
            "revocations": {},
            "elections": {
                "q_legacy": {
                    "election_id": "q_legacy",
                    "delegation_id": "delegation_legacy",
                    "capabilities": [],
                    "control_relays": ["wss://relay.nostr.net"],
                    "revoked": false,
                    "expires_at": "2036-01-01T00:00:00Z",
                    "processed_submission_ids": [],
                    "accepted_nullifiers": [],
                    "published_decisions": {},
                    "accepted_response_authors": [],
                    "accepted_response_count": 0,
                    "rejected_response_count": 0,
                    "expected_invitee_count": null,
                    "summary_published": false,
                    "last_result_summary_publish_at": null,
                    "blind_signing_private_key": null,
                    "definition": null,
                    "last_blind_issuance_at": null,
                    "last_vote_verification_at": null,
                    "last_decision_publish_at": null
                }
            },
            "last_heartbeat_at": null,
            "last_dm_scan_at": null,
            "last_public_scan_at": null
        }"#;

        let state: WorkerPersistentState = serde_json::from_str(raw).unwrap();
        let election = state.elections.get("q_legacy").unwrap();

        assert!(election.seen_blind_request_ids.is_empty());
        assert!(election.deferred_blind_request_ids.is_empty());
        assert!(election.deferred_blind_requests.is_empty());
        assert!(election.issued_invited_npubs.is_empty());
        assert!(election.issued_invited_scope_keys.is_empty());
        assert!(election.issued_issuances_by_request_id.is_empty());
        assert!(election.whitelist_npubs.is_empty());
        assert!(election.bearer_invite_codes.is_empty());
        assert!(!election.eligibility_required);
        assert!(election.last_election_config_sent_at.is_none());
        assert!(state.seen_control_event_ids.is_empty());
    }

    #[test]
    fn participant_status_and_ack_use_web_json_schema() {
        let status = OptionAParticipantStatusEnvelope {
            message_type: "optiona_participant_status_dm".to_string(),
            schema_version: 1,
            status: OptionAParticipantStatus {
                message_type: "participant_status".to_string(),
                schema_version: 1,
                election_id: "election_1".to_string(),
                invited_npub: "npub1voter".to_string(),
                source: "issuer_proxy".to_string(),
                state: OptionAParticipantStatusState::BallotIssued,
                observed_at: "2026-07-15T12:00:00Z".to_string(),
                request_id: Some("request_1".to_string()),
                issuance_id: Some("issuance_1".to_string()),
            },
            sent_at: "2026-07-15T12:00:01Z".to_string(),
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["type"], "optiona_participant_status_dm");
        assert_eq!(value["status"]["type"], "participant_status");
        assert_eq!(value["status"]["state"], "ballot_issued");
        assert_eq!(value["status"]["source"], "issuer_proxy");
        assert_eq!(value["status"]["requestId"], "request_1");
        assert!(value["status"].get("submissionId").is_none());

        let ack: BlindIssuanceAckEnvelope = serde_json::from_value(serde_json::json!({
            "type": "optiona_blind_issuance_ack_dm",
            "schemaVersion": 1,
            "ack": {
                "type": "blind_ballot_issuance_ack",
                "schemaVersion": 1,
                "electionId": "election_1",
                "requestId": "request_1",
                "issuanceId": "issuance_1",
                "invitedNpub": "npub1voter",
                "ackedAt": "2026-07-15T12:00:02Z"
            },
            "sentAt": "2026-07-15T12:00:03Z"
        }))
        .unwrap();
        assert_eq!(ack.ack.issuance_id, "issuance_1");
    }

    #[test]
    fn private_queue_messages_use_web_json_schema() {
        let submission = serde_json::to_value(PrivateBallotSubmission {
            message_type: "private_ballot_submission".to_string(),
            schema_version: 1,
            election_id: "election_1".to_string(),
            submission_id: "submission_1".to_string(),
            submission: PrivateBallotSubmissionPayload {
                message_type: "ballot_submission".to_string(),
                schema_version: 1,
                election_id: "election_1".to_string(),
                submission_id: "submission_1".to_string(),
                invited_npub: "npub1voter".to_string(),
                response_npub: None,
                token_commitment: "token_1".to_string(),
                blind_signing_key_id: "key_1".to_string(),
                credential: "credential_1".to_string(),
                nullifier: "nullifier_1".to_string(),
                credential_bundle: None,
                payload: PrivateBallotPayload {
                    election_id: "election_1".to_string(),
                    responses: vec![],
                },
                submitted_at: "2026-10-08T12:00:00Z".to_string(),
            },
        })
        .unwrap();
        assert_eq!(submission["type"], "private_ballot_submission");
        assert_eq!(submission["schemaVersion"], 1);
        assert_eq!(submission["electionId"], "election_1");
        assert_eq!(submission["submissionId"], "submission_1");

        let receipt = serde_json::to_value(PrivateBallotReceipt {
            message_type: "private_ballot_receipt".to_string(),
            schema_version: 1,
            election_id: "election_1".to_string(),
            submission_id: "submission_1".to_string(),
            accepted: true,
            received_at: "2026-10-08T12:00:00Z".to_string(),
            reason: None,
        })
        .unwrap();
        assert_eq!(receipt["receivedAt"], "2026-10-08T12:00:00Z");
        assert!(receipt.get("reason").is_none());
        let receipt_without_reason: PrivateBallotReceipt = serde_json::from_value(receipt).unwrap();
        assert!(receipt_without_reason.reason.is_none());

        let progress = serde_json::to_value(PrivateQueueProgress {
            message_type: "private_queue_progress".to_string(),
            schema_version: 1,
            election_id: "election_1".to_string(),
            accepted_count: 4,
            rejected_count: 1,
            queued_count: 3,
            batch_threshold: 10,
            submission_deadline: "2026-10-09T12:00:00Z".to_string(),
        })
        .unwrap();
        assert_eq!(progress["acceptedCount"], 4);
        assert_eq!(progress["rejectedCount"], 1);
        assert_eq!(progress["queuedCount"], 3);
        assert_eq!(progress["batchThreshold"], 10);
        assert_eq!(progress["submissionDeadline"], "2026-10-09T12:00:00Z");
        assert!(progress.get("submissionId").is_none());
        let mut incomplete_progress = progress;
        incomplete_progress
            .as_object_mut()
            .unwrap()
            .remove("queuedCount");
        assert!(serde_json::from_value::<PrivateQueueProgress>(incomplete_progress).is_err());

        let mut unexpected_progress = serde_json::to_value(PrivateQueueProgress {
            message_type: "private_queue_progress".to_string(),
            schema_version: 1,
            election_id: "election_1".to_string(),
            accepted_count: 4,
            rejected_count: 1,
            queued_count: 3,
            batch_threshold: 10,
            submission_deadline: "2026-10-09T12:00:00Z".to_string(),
        })
        .unwrap();
        unexpected_progress.as_object_mut().unwrap().insert(
            "submissionId".to_string(),
            serde_json::json!("submission_1"),
        );
        assert!(serde_json::from_value::<PrivateQueueProgress>(unexpected_progress).is_err());

        assert!(
            serde_json::from_value::<PrivateBallotSubmission>(serde_json::json!({
                "type": "private_ballot_submission",
                "schemaVersion": 1,
                "electionId": "election_1",
                "submissionId": "submission_1",
                "submission": {
                    "type": "ballot_submission",
                    "schemaVersion": 1,
                    "electionId": "election_1",
                    "submissionId": "submission_1",
                    "invitedNpub": "npub1voter",
                    "tokenCommitment": "token_1",
                    "blindSigningKeyId": "key_1",
                    "credential": "credential_1",
                    "nullifier": "nullifier_1",
                    "payload": { "electionId": "election_1", "responses": [] },
                    "submittedAt": "2026-10-08T12:00:00Z",
                    "unexpected": true
                }
            }))
            .is_err()
        );
    }
}
