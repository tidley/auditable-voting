use serde::{Deserialize, Serialize};

pub const PROTOCOL_SNAPSHOT_VERSION: u32 = 1;
pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotCompatibilityStatus {
    Compatible,
    IncompatibleVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub snapshot_format_version: u32,
    pub protocol_schema_version: u32,
    pub election_id: String,
    pub event_count: usize,
    pub compatibility: SnapshotCompatibilityStatus,
}

