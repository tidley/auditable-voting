use std::cmp::Ordering;

use crate::coordinator_messages::CoordinatorControlEnvelope;
use crate::types::{CoordinatorEventType, CoordinatorTransportEvent};

#[derive(Debug, Clone)]
pub struct OrderedCoordinatorEvent {
    pub transport: CoordinatorTransportEvent,
    pub envelope: CoordinatorControlEnvelope,
}

fn precedence(event_type: &CoordinatorEventType) -> u8 {
    match event_type {
        CoordinatorEventType::RoundDraft => 0,
        CoordinatorEventType::RoundOpenProposal => 1,
        CoordinatorEventType::RoundOpenCommit => 2,
        CoordinatorEventType::BallotBatchNotice => 3,
        CoordinatorEventType::PartialTally => 4,
        CoordinatorEventType::ResultPublishApproval => 5,
        CoordinatorEventType::RecoveryCheckpoint => 6,
        CoordinatorEventType::DisputeNotice => 7,
    }
}

pub fn compare_coordinator_events(
    left: &OrderedCoordinatorEvent,
    right: &OrderedCoordinatorEvent,
) -> Ordering {
    precedence(&left.envelope.payload.event_type())
        .cmp(&precedence(&right.envelope.payload.event_type()))
        .then_with(|| left.envelope.logical_epoch.unwrap_or(0).cmp(&right.envelope.logical_epoch.unwrap_or(0)))
        .then_with(|| left.envelope.created_at.cmp(&right.envelope.created_at))
        .then_with(|| left.transport.event_id.cmp(&right.transport.event_id))
}

pub fn sort_coordinator_events(events: &mut [OrderedCoordinatorEvent]) {
    events.sort_by(compare_coordinator_events);
}
