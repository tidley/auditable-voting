use serde::{Deserialize, Serialize};

pub const COORDINATOR_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorEventType {
    RoundDraft,
    RoundOpenProposal,
    RoundOpenCommit,
    BallotBatchNotice,
    PartialTally,
    ResultPublishApproval,
    RecoveryCheckpoint,
    DisputeNotice,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutboundCoordinatorTransportMessage {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: Option<String>,
    pub event_type: CoordinatorEventType,
    pub created_at: i64,
    pub sender_pubkey: String,
    pub logical_epoch: Option<u64>,
    pub content: String,
    pub local_echo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorTransportEvent {
    pub event_id: String,
    pub raw_content: String,
    pub sender_pubkey: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayAppliedEvent {
    pub event_id: String,
    pub event_type: CoordinatorEventType,
    pub round_id: Option<String>,
    pub created_at: i64,
}
