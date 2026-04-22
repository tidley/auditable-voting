use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const OPTIONA_WORKER_DELEGATION_KIND: u16 = 31994;
pub const OPTIONA_WORKER_DELEGATION_REVOCATION_KIND: u16 = 31995;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND: u16 = 14124;
pub const IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION: u16 = 14125;

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
pub struct QuestionnaireBlindResponseEvent {
    pub schema_version: u8,
    pub event_type: String,
    pub questionnaire_id: String,
    pub response_id: String,
    pub submitted_at: i64,
    pub author_pubkey: String,
    pub token_nullifier: String,
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
    pub election_id: String,
    pub delegation_id: String,
    pub capabilities: Vec<WorkerCapability>,
    pub control_relays: Vec<String>,
    pub revoked: bool,
    pub expires_at: String,
    pub processed_submission_ids: HashSet<String>,
    pub accepted_nullifiers: HashSet<String>,
    pub published_decisions: HashMap<String, String>,
    pub last_blind_issuance_at: Option<String>,
    pub last_vote_verification_at: Option<String>,
    pub last_decision_publish_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkerPersistentState {
    pub coordinator_npub: String,
    pub worker_npub: String,
    pub relays: Vec<String>,
    pub known_delegations: HashMap<String, WorkerDelegationCertificate>,
    pub revocations: HashMap<String, WorkerDelegationRevocation>,
    pub elections: HashMap<String, ElectionRuntimeState>,
    pub last_heartbeat_at: Option<String>,
    pub last_dm_scan_at: Option<String>,
    pub last_public_scan_at: Option<String>,
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
