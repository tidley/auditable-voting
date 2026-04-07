use serde::{Deserialize, Serialize};

use crate::reducer::DerivedState;
use crate::event::ProtocolEvent;
use crate::versioning::{
    SnapshotCompatibilityStatus, SnapshotMetadata, PROTOCOL_SCHEMA_VERSION, PROTOCOL_SNAPSHOT_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolSnapshot {
    pub schema_version: u32,
    pub election_id: String,
    pub events: Vec<ProtocolEvent>,
    pub derived_state: DerivedState,
}

impl ProtocolSnapshot {
    pub fn metadata(&self) -> SnapshotMetadata {
        SnapshotMetadata {
            snapshot_format_version: self.schema_version,
            protocol_schema_version: PROTOCOL_SCHEMA_VERSION,
            election_id: self.election_id.clone(),
            event_count: self.events.len(),
            compatibility: if self.schema_version == PROTOCOL_SNAPSHOT_VERSION {
                SnapshotCompatibilityStatus::Compatible
            } else {
                SnapshotCompatibilityStatus::IncompatibleVersion
            },
        }
    }
}

