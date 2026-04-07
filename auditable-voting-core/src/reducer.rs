use std::cmp::Ordering;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::ballot_state::{BallotState, BallotStateReducer};
use crate::event::{BallotEvent, BallotEventType, ProtocolEvent, PublicEvent, PublicEventType};
use crate::public_state::{PublicState, PublicStateReducer};
use crate::validation::ProtocolError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DerivedState {
    pub election_id: String,
    pub public_state: PublicState,
    pub ballot_state: BallotState,
    pub coordinator_event_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolSnapshot {
    pub schema_version: u32,
    pub election_id: String,
    pub events: Vec<ProtocolEvent>,
    pub derived_state: DerivedState,
}

#[derive(Debug, Default)]
pub struct AuditableVotingProtocolEngine {
    election_id: String,
    events: Vec<ProtocolEvent>,
}

impl AuditableVotingProtocolEngine {
    pub fn new(election_id: String) -> Self {
        Self {
            election_id,
            events: Vec::new(),
        }
    }

    pub fn restore(snapshot: ProtocolSnapshot) -> Self {
        Self {
            election_id: snapshot.election_id,
            events: snapshot.events,
        }
    }

    pub fn replay_all(&mut self, events: Vec<ProtocolEvent>) -> Result<DerivedState, ProtocolError> {
        self.events = events;
        self.derive_state()
    }

    pub fn apply_events(&mut self, mut events: Vec<ProtocolEvent>) -> Result<DerivedState, ProtocolError> {
        self.events.append(&mut events);
        self.derive_state()
    }

    pub fn snapshot(&self) -> Result<ProtocolSnapshot, ProtocolError> {
        Ok(ProtocolSnapshot {
            schema_version: 1,
            election_id: self.election_id.clone(),
            events: self.events.clone(),
            derived_state: self.current_state()?,
        })
    }

    pub fn current_state(&self) -> Result<DerivedState, ProtocolError> {
        derive_state(self.election_id.clone(), self.events.clone())
    }

    fn derive_state(&mut self) -> Result<DerivedState, ProtocolError> {
        let derived = derive_state(self.election_id.clone(), self.events.clone())?;
        self.events.sort_by(compare_protocol_events);
        dedupe_by_event_id(&mut self.events);
        Ok(derived)
    }
}

fn dedupe_by_event_id(events: &mut Vec<ProtocolEvent>) {
    let mut seen = HashSet::new();
    events.retain(|event| seen.insert(event.event_id().to_owned()));
}

fn public_precedence(event_type: &PublicEventType) -> u8 {
    match event_type {
        PublicEventType::ElectionDefinition => 0,
        PublicEventType::RoundDefinition => 1,
        PublicEventType::RoundOpen => 2,
        PublicEventType::BallotReceipt => 5,
        PublicEventType::RoundClose => 6,
        PublicEventType::FinalResult => 7,
        PublicEventType::DisputeRecord => 8,
    }
}

fn ballot_precedence(event_type: &BallotEventType) -> u8 {
    match event_type {
        BallotEventType::EncryptedBallot => 3,
        BallotEventType::BallotAck => 4,
        BallotEventType::InclusionProofResponse => 9,
    }
}

fn precedence(event: &ProtocolEvent) -> u8 {
    match event {
        ProtocolEvent::Public { event } => match event {
            PublicEvent::ElectionDefinition(_) => public_precedence(&PublicEventType::ElectionDefinition),
            PublicEvent::RoundDefinition(_) => public_precedence(&PublicEventType::RoundDefinition),
            PublicEvent::RoundOpen(_) => public_precedence(&PublicEventType::RoundOpen),
            PublicEvent::RoundClose(_) => public_precedence(&PublicEventType::RoundClose),
            PublicEvent::BallotReceipt(_) => public_precedence(&PublicEventType::BallotReceipt),
            PublicEvent::FinalResult(_) => public_precedence(&PublicEventType::FinalResult),
            PublicEvent::DisputeRecord(_) => public_precedence(&PublicEventType::DisputeRecord),
        },
        ProtocolEvent::Ballot { event } => match event {
            BallotEvent::EncryptedBallot(_) => ballot_precedence(&BallotEventType::EncryptedBallot),
            BallotEvent::BallotAck(_) => ballot_precedence(&BallotEventType::BallotAck),
            BallotEvent::InclusionProofResponse(_) => ballot_precedence(&BallotEventType::InclusionProofResponse),
        },
        ProtocolEvent::Coordinator { event } => match event.envelope.payload.event_type() {
            crate::types::CoordinatorEventType::RoundDraft => 1,
            crate::types::CoordinatorEventType::RoundOpenProposal => 2,
            crate::types::CoordinatorEventType::RoundOpenCommit => 2,
            crate::types::CoordinatorEventType::BallotBatchNotice => 3,
            crate::types::CoordinatorEventType::PartialTally => 6,
            crate::types::CoordinatorEventType::ResultPublishApproval => 7,
            crate::types::CoordinatorEventType::RecoveryCheckpoint => 9,
            crate::types::CoordinatorEventType::DisputeNotice => 8,
        },
    }
}

pub fn compare_protocol_events(left: &ProtocolEvent, right: &ProtocolEvent) -> Ordering {
    precedence(left)
        .cmp(&precedence(right))
        .then_with(|| {
            let left_epoch = match left {
                ProtocolEvent::Coordinator { event } => event.envelope.logical_epoch.unwrap_or(0),
                _ => 0,
            };
            let right_epoch = match right {
                ProtocolEvent::Coordinator { event } => event.envelope.logical_epoch.unwrap_or(0),
                _ => 0,
            };
            left_epoch.cmp(&right_epoch)
        })
        .then_with(|| left.created_at().cmp(&right.created_at()))
        .then_with(|| left.event_id().cmp(right.event_id()))
}

pub fn derive_state(
    election_id: String,
    mut events: Vec<ProtocolEvent>,
) -> Result<DerivedState, ProtocolError> {
    for event in &events {
        if event.election_id() != election_id {
            return Err(ProtocolError::WrongElection);
        }
    }
    events.sort_by(compare_protocol_events);

    let mut public_reducer = PublicStateReducer::new(election_id.clone());
    for event in events.iter().filter_map(|event| match event {
        ProtocolEvent::Public { event } => Some(event),
        _ => None,
    }) {
        public_reducer.apply(event);
    }
    let public_state = public_reducer.finalize();

    let mut ballot_reducer = BallotStateReducer::default();
    for event in events.iter().filter_map(|event| match event {
        ProtocolEvent::Ballot { event } => Some(event),
        _ => None,
    }) {
        ballot_reducer.apply(event, &public_state);
    }
    let ballot_state = ballot_reducer.finalize();

    Ok(DerivedState {
        election_id,
        public_state,
        ballot_state,
        coordinator_event_count: events
            .iter()
            .filter(|event| matches!(event, ProtocolEvent::Coordinator { .. }))
            .count(),
    })
}
