use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

use crate::reducer::DerivedState;
use crate::event::ProtocolEvent;
use crate::validation::ValidationCode;
use crate::versioning::{SnapshotCompatibilityStatus, SnapshotMetadata};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidationIssueCount {
    pub code: ValidationCode,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayStatus {
    pub total_events: usize,
    pub unique_events: usize,
    pub duplicate_events: usize,
    pub last_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolDiagnostics {
    pub replay_status: ReplayStatus,
    pub public_issue_counts: Vec<ValidationIssueCount>,
    pub rejected_ballot_count: usize,
    pub accepted_ballot_count: usize,
    pub known_round_ids: Vec<String>,
    pub snapshot_status: SnapshotCompatibilityStatus,
}

pub fn build_replay_status(events: &[ProtocolEvent]) -> ReplayStatus {
    let mut seen = HashSet::new();
    let mut duplicates = 0usize;
    for event in events {
        if !seen.insert(event.event_id().to_owned()) {
            duplicates += 1;
        }
    }

    ReplayStatus {
        total_events: events.len(),
        unique_events: seen.len(),
        duplicate_events: duplicates,
        last_event_id: events.last().map(|event| event.event_id().to_owned()),
    }
}

pub fn build_protocol_diagnostics(
    events: &[ProtocolEvent],
    derived_state: &DerivedState,
    metadata: &SnapshotMetadata,
) -> ProtocolDiagnostics {
    let mut issue_counts = BTreeMap::<ValidationCode, usize>::new();
    for issue in &derived_state.public_state.issues {
        *issue_counts.entry(issue.code.clone()).or_default() += 1;
    }
    for rejected in &derived_state.ballot_state.rejected_ballots {
        *issue_counts.entry(rejected.reason.code.clone()).or_default() += 1;
    }

    let known_round_ids = derived_state
        .public_state
        .rounds
        .iter()
        .map(|round| round.round_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    ProtocolDiagnostics {
        replay_status: build_replay_status(events),
        public_issue_counts: issue_counts
            .into_iter()
            .map(|(code, count)| ValidationIssueCount { code, count })
            .collect(),
        rejected_ballot_count: derived_state.ballot_state.rejected_ballots.len(),
        accepted_ballot_count: derived_state.ballot_state.accepted_ballots.len(),
        known_round_ids,
        snapshot_status: metadata.compatibility,
    }
}
