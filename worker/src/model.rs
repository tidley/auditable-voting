use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const OPTIONA_WORKER_DELEGATION_KIND: u16 = 31994;
pub const OPTIONA_WORKER_DELEGATION_REVOCATION_KIND: u16 = 31995;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND: u16 = 14124;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION: u16 = 14125;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY: u16 = 14123;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkerCapability {
    IssueBlindTokens,
    VerifyPublicSubmissions,
    PublishSubmissionDecisions,
    PublishResultSummary,
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
    pub coordinator_npub: String,
    pub worker_npub: String,
    pub expected_invitee_count: Option<u64>,
    pub blind_signing_private_key: Option<QuestionnaireBlindPrivateKey>,
    pub definition: Option<serde_json::Value>,
    pub sent_at: String,
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
    pub token_commitment: String,
    pub blind_signing_key_id: String,
    pub client_nonce: String,
    pub created_at: String,
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
pub struct BlindBallotIssuance {
    #[serde(rename = "type")]
    pub message_type: String,
    pub schema_version: u8,
    pub election_id: String,
    pub request_id: String,
    pub issuance_id: String,
    pub invited_npub: String,
    pub token_commitment: String,
    pub blind_signing_key_id: String,
    pub blind_signature: String,
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
pub struct QuestionnaireBlindResponseEvent {
    pub schema_version: u8,
    pub event_type: String,
    pub questionnaire_id: String,
    pub response_id: String,
    pub submitted_at: i64,
    pub author_pubkey: String,
    pub token_nullifier: String,
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
    pub accepted_nullifiers: HashSet<String>,
    #[serde(default)]
    pub published_decisions: HashMap<String, String>,
    #[serde(default)]
    pub seen_blind_request_ids: HashSet<String>,
    #[serde(default)]
    pub accepted_response_authors: HashSet<String>,
    #[serde(default)]
    pub accepted_response_count: u64,
    #[serde(default)]
    pub rejected_response_count: u64,
    #[serde(default)]
    pub expected_invitee_count: Option<u64>,
    #[serde(default)]
    pub summary_published: bool,
    #[serde(default)]
    pub last_result_summary_publish_at: Option<String>,
    #[serde(default)]
    pub blind_signing_private_key: Option<QuestionnaireBlindPrivateKey>,
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
        assert!(state.seen_control_event_ids.is_empty());
    }
}
