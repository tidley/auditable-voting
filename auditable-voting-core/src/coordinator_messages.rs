use serde::{Deserialize, Serialize};

use crate::types::{CoordinatorEventType, COORDINATOR_SCHEMA_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundDraftPayload {
    pub prompt: String,
    pub threshold_t: u32,
    pub threshold_n: u32,
    pub coordinator_roster: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundOpenProposalPayload {
    pub prompt: String,
    pub threshold_t: u32,
    pub threshold_n: u32,
    pub coordinator_roster: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundOpenCommitPayload {
    pub proposal_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BallotBatchNoticePayload {
    pub accepted_ballot_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartialTallyPayload {
    pub yes_count: u32,
    pub no_count: u32,
    pub accepted_ballot_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResultPublishApprovalPayload {
    pub result_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecoveryCheckpointPayload {
    pub checkpoint_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisputeNoticePayload {
    pub reason: String,
    pub related_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum CoordinatorControlPayload {
    RoundDraft(RoundDraftPayload),
    RoundOpenProposal(RoundOpenProposalPayload),
    RoundOpenCommit(RoundOpenCommitPayload),
    BallotBatchNotice(BallotBatchNoticePayload),
    PartialTally(PartialTallyPayload),
    ResultPublishApproval(ResultPublishApprovalPayload),
    RecoveryCheckpoint(RecoveryCheckpointPayload),
    DisputeNotice(DisputeNoticePayload),
}

impl CoordinatorControlPayload {
    pub fn event_type(&self) -> CoordinatorEventType {
        match self {
            Self::RoundDraft(_) => CoordinatorEventType::RoundDraft,
            Self::RoundOpenProposal(_) => CoordinatorEventType::RoundOpenProposal,
            Self::RoundOpenCommit(_) => CoordinatorEventType::RoundOpenCommit,
            Self::BallotBatchNotice(_) => CoordinatorEventType::BallotBatchNotice,
            Self::PartialTally(_) => CoordinatorEventType::PartialTally,
            Self::ResultPublishApproval(_) => CoordinatorEventType::ResultPublishApproval,
            Self::RecoveryCheckpoint(_) => CoordinatorEventType::RecoveryCheckpoint,
            Self::DisputeNotice(_) => CoordinatorEventType::DisputeNotice,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorControlEnvelope {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: Option<String>,
    pub created_at: i64,
    pub sender_pubkey: String,
    pub logical_epoch: Option<u64>,
    #[serde(flatten)]
    pub payload: CoordinatorControlPayload,
}

impl CoordinatorControlEnvelope {
    pub fn new(
        election_id: String,
        round_id: Option<String>,
        created_at: i64,
        sender_pubkey: String,
        logical_epoch: Option<u64>,
        payload: CoordinatorControlPayload,
    ) -> Self {
        Self {
            schema_version: COORDINATOR_SCHEMA_VERSION,
            election_id,
            round_id,
            created_at,
            sender_pubkey,
            logical_epoch,
            payload,
        }
    }
}
