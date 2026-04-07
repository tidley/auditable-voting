use serde::{Deserialize, Serialize};

use crate::coordinator_messages::CoordinatorControlEnvelope;

pub const PUBLIC_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicEventType {
    ElectionDefinition,
    RoundDefinition,
    RoundOpen,
    RoundClose,
    BallotReceipt,
    FinalResult,
    DisputeRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BallotEventType {
    EncryptedBallot,
    BallotAck,
    InclusionProofResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ElectionDefinitionEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundDefinitionEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub prompt: String,
    pub threshold_t: u32,
    pub threshold_n: u32,
    pub coordinator_roster: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundLifecycleEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub prompt: Option<String>,
    pub threshold_t: Option<u32>,
    pub threshold_n: Option<u32>,
    pub coordinator_roster: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BallotReceiptEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub ballot_commitment: String,
    pub receipt_hash: String,
    pub accepted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinalResultEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub yes_count: u32,
    pub no_count: u32,
    pub tally_input_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisputeRecordEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: Option<String>,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum PublicEvent {
    ElectionDefinition(ElectionDefinitionEvent),
    RoundDefinition(RoundDefinitionEvent),
    RoundOpen(RoundLifecycleEvent),
    RoundClose(RoundLifecycleEvent),
    BallotReceipt(BallotReceiptEvent),
    FinalResult(FinalResultEvent),
    DisputeRecord(DisputeRecordEvent),
}

impl PublicEvent {
    pub fn created_at(&self) -> i64 {
        match self {
            PublicEvent::ElectionDefinition(event) => event.created_at,
            PublicEvent::RoundDefinition(event) => event.created_at,
            PublicEvent::RoundOpen(event) => event.created_at,
            PublicEvent::RoundClose(event) => event.created_at,
            PublicEvent::BallotReceipt(event) => event.created_at,
            PublicEvent::FinalResult(event) => event.created_at,
            PublicEvent::DisputeRecord(event) => event.created_at,
        }
    }

    pub fn event_id(&self) -> &str {
        match self {
            PublicEvent::ElectionDefinition(event) => &event.event_id,
            PublicEvent::RoundDefinition(event) => &event.event_id,
            PublicEvent::RoundOpen(event) => &event.event_id,
            PublicEvent::RoundClose(event) => &event.event_id,
            PublicEvent::BallotReceipt(event) => &event.event_id,
            PublicEvent::FinalResult(event) => &event.event_id,
            PublicEvent::DisputeRecord(event) => &event.event_id,
        }
    }

    pub fn election_id(&self) -> &str {
        match self {
            PublicEvent::ElectionDefinition(event) => &event.election_id,
            PublicEvent::RoundDefinition(event) => &event.election_id,
            PublicEvent::RoundOpen(event) => &event.election_id,
            PublicEvent::RoundClose(event) => &event.election_id,
            PublicEvent::BallotReceipt(event) => &event.election_id,
            PublicEvent::FinalResult(event) => &event.election_id,
            PublicEvent::DisputeRecord(event) => &event.election_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedBallotEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub choice: String,
    pub token_id: Option<String>,
    pub coordinator_shares: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BallotAckEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub ballot_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InclusionProofResponseEvent {
    pub schema_version: u32,
    pub election_id: String,
    pub round_id: String,
    pub created_at: i64,
    pub author_pubkey: String,
    pub event_id: String,
    pub ballot_event_id: String,
    pub proof_reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum BallotEvent {
    EncryptedBallot(EncryptedBallotEvent),
    BallotAck(BallotAckEvent),
    InclusionProofResponse(InclusionProofResponseEvent),
}

impl BallotEvent {
    pub fn created_at(&self) -> i64 {
        match self {
            BallotEvent::EncryptedBallot(event) => event.created_at,
            BallotEvent::BallotAck(event) => event.created_at,
            BallotEvent::InclusionProofResponse(event) => event.created_at,
        }
    }

    pub fn event_id(&self) -> &str {
        match self {
            BallotEvent::EncryptedBallot(event) => &event.event_id,
            BallotEvent::BallotAck(event) => &event.event_id,
            BallotEvent::InclusionProofResponse(event) => &event.event_id,
        }
    }

    pub fn election_id(&self) -> &str {
        match self {
            BallotEvent::EncryptedBallot(event) => &event.election_id,
            BallotEvent::BallotAck(event) => &event.election_id,
            BallotEvent::InclusionProofResponse(event) => &event.election_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorControlEvent {
    pub event_id: String,
    pub envelope: CoordinatorControlEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "plane", rename_all = "snake_case")]
pub enum ProtocolEvent {
    Public { event: PublicEvent },
    Ballot { event: BallotEvent },
    Coordinator { event: CoordinatorControlEvent },
}

impl ProtocolEvent {
    pub fn event_id(&self) -> &str {
        match self {
            ProtocolEvent::Public { event } => event.event_id(),
            ProtocolEvent::Ballot { event } => event.event_id(),
            ProtocolEvent::Coordinator { event } => &event.event_id,
        }
    }

    pub fn created_at(&self) -> i64 {
        match self {
            ProtocolEvent::Public { event } => event.created_at(),
            ProtocolEvent::Ballot { event } => event.created_at(),
            ProtocolEvent::Coordinator { event } => event.envelope.created_at,
        }
    }

    pub fn election_id(&self) -> &str {
        match self {
            ProtocolEvent::Public { event } => event.election_id(),
            ProtocolEvent::Ballot { event } => event.election_id(),
            ProtocolEvent::Coordinator { event } => &event.envelope.election_id,
        }
    }
}
