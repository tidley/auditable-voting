use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ValidationCode {
    InvalidStructure,
    WrongElection,
    UnknownRound,
    RoundNotOpen,
    RoundClosed,
    InvalidChoice,
    MissingTokenId,
    NotEnoughCoordinatorShares,
    UnauthorizedCoordinatorShare,
    DuplicateToken,
    DuplicateEvent,
    ContradictoryRoundState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: ValidationCode,
    pub detail: String,
    pub event_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("Failed to decode protocol event: {0}")]
    InvalidEvent(String),
    #[error("Protocol event belongs to wrong election")]
    WrongElection,
}

pub fn issue(code: ValidationCode, detail: impl Into<String>, event_id: Option<String>) -> ValidationIssue {
    ValidationIssue {
        code,
        detail: detail.into(),
        event_id,
    }
}
