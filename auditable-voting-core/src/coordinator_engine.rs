use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::coordinator_messages::{
    BallotBatchNoticePayload, CoordinatorControlEnvelope, CoordinatorControlPayload,
    DisputeNoticePayload, PartialTallyPayload, RecoveryCheckpointPayload,
    ResultPublishApprovalPayload, RoundDraftPayload, RoundOpenCommitPayload,
    RoundOpenProposalPayload,
};
use crate::coordinator_state::{CoordinatorControlState, CoordinatorRoundPhase};
use crate::openmls_engine::{
    CoordinatorGroupEngine, CoordinatorGroupEngineSnapshot, DeterministicCoordinatorGroupEngine,
    GroupEngineError,
};
use crate::replay::replay_transport_events;
use crate::types::{
    CoordinatorTransportEvent, OutboundCoordinatorTransportMessage, ReplayAppliedEvent,
    COORDINATOR_SCHEMA_VERSION,
};

#[derive(Debug, Error)]
pub enum CoordinatorEngineError {
    #[error("Group engine error: {0}")]
    GroupEngine(#[from] GroupEngineError),
    #[error("Serialization error: {0}")]
    Serialization(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorEngineConfig {
    pub election_id: String,
    pub local_pubkey: String,
    pub coordinator_roster: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorEngineSnapshot {
    pub config: CoordinatorEngineConfig,
    pub state: CoordinatorControlState,
    pub group_engine: CoordinatorGroupEngineSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorRoundView {
    pub round_id: String,
    pub prompt: Option<String>,
    pub threshold_t: Option<u32>,
    pub threshold_n: Option<u32>,
    pub coordinator_roster: Vec<String>,
    pub proposal_event_id: Option<String>,
    pub phase: CoordinatorRoundPhase,
    pub open_committers: Vec<String>,
    pub missing_open_committers: Vec<String>,
    pub partial_tally_senders: Vec<String>,
    pub result_approval_senders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorEngineView {
    pub election_id: String,
    pub local_pubkey: String,
    pub coordinator_roster: Vec<String>,
    pub logical_epoch: u64,
    pub latest_round: Option<CoordinatorRoundView>,
    pub rounds: Vec<CoordinatorRoundView>,
}

pub struct CoordinatorControlEngine {
    config: CoordinatorEngineConfig,
    state: CoordinatorControlState,
    group_engine: Box<dyn CoordinatorGroupEngine>,
}

impl CoordinatorControlEngine {
    pub fn new(config: CoordinatorEngineConfig) -> Self {
        let roster = normalise_roster(&config.coordinator_roster);
        let config = CoordinatorEngineConfig {
            coordinator_roster: roster.clone(),
            ..config
        };

        Self {
            state: CoordinatorControlState::new(
                config.election_id.clone(),
                config.local_pubkey.clone(),
                roster,
            ),
            config,
            group_engine: Box::<DeterministicCoordinatorGroupEngine>::default(),
        }
    }

    pub fn restore(snapshot: CoordinatorEngineSnapshot) -> Self {
        let mut engine = Self::new(snapshot.config.clone());
        engine.state = snapshot.state;
        engine.group_engine.restore(snapshot.group_engine);
        engine
    }

    pub fn snapshot(&self) -> CoordinatorEngineSnapshot {
        CoordinatorEngineSnapshot {
            config: self.config.clone(),
            state: self.state.clone(),
            group_engine: self.group_engine.snapshot(),
        }
    }

    pub fn view(&self) -> CoordinatorEngineView {
        let mut rounds = self
            .state
            .rounds
            .values()
            .map(|round| {
                let open_committers = round
                    .open_commit_event_ids
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                let missing_open_committers = round
                    .coordinator_roster
                    .iter()
                    .filter(|pubkey| !round.open_commit_event_ids.contains_key(*pubkey))
                    .cloned()
                    .collect::<Vec<_>>();

                CoordinatorRoundView {
                    round_id: round.round_id.clone(),
                    prompt: round.prompt.clone(),
                    threshold_t: round.threshold_t,
                    threshold_n: round.threshold_n,
                    coordinator_roster: round.coordinator_roster.clone(),
                    proposal_event_id: round.proposal_event_id.clone(),
                    phase: round.phase.clone(),
                    open_committers,
                    missing_open_committers,
                    partial_tally_senders: round.partial_tallies.keys().cloned().collect(),
                    result_approval_senders: round.result_approvals.keys().cloned().collect(),
                }
            })
            .collect::<Vec<_>>();
        rounds.sort_by(|left, right| left.round_id.cmp(&right.round_id));
        let latest_round = self.state.latest_round().map(|round| CoordinatorRoundView {
            round_id: round.round_id.clone(),
            prompt: round.prompt.clone(),
            threshold_t: round.threshold_t,
            threshold_n: round.threshold_n,
            coordinator_roster: round.coordinator_roster.clone(),
            proposal_event_id: round.proposal_event_id.clone(),
            phase: round.phase.clone(),
            open_committers: round.open_commit_event_ids.keys().cloned().collect(),
            missing_open_committers: round
                .coordinator_roster
                .iter()
                .filter(|pubkey| !round.open_commit_event_ids.contains_key(*pubkey))
                .cloned()
                .collect(),
            partial_tally_senders: round.partial_tallies.keys().cloned().collect(),
            result_approval_senders: round.result_approvals.keys().cloned().collect(),
        });

        CoordinatorEngineView {
            election_id: self.config.election_id.clone(),
            local_pubkey: self.config.local_pubkey.clone(),
            coordinator_roster: self.state.coordinator_roster.clone(),
            logical_epoch: self.state.logical_epoch,
            latest_round,
            rounds,
        }
    }

    pub fn replay_transport_messages(
        &mut self,
        events: Vec<CoordinatorTransportEvent>,
    ) -> Result<Vec<ReplayAppliedEvent>, CoordinatorEngineError> {
        replay_transport_events(&mut self.state, self.group_engine.as_mut(), events)
            .map_err(CoordinatorEngineError::from)
    }

    pub fn apply_transport_message(
        &mut self,
        event: CoordinatorTransportEvent,
    ) -> Result<Vec<ReplayAppliedEvent>, CoordinatorEngineError> {
        self.replay_transport_messages(vec![event])
    }

    pub fn record_round_draft(
        &mut self,
        round_id: String,
        prompt: String,
        threshold_t: u32,
        threshold_n: u32,
        created_at: i64,
        coordinator_roster: Vec<String>,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::RoundDraft(RoundDraftPayload {
            prompt,
            threshold_t,
            threshold_n,
            coordinator_roster: normalise_roster(&coordinator_roster),
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn propose_round_open(
        &mut self,
        round_id: String,
        prompt: String,
        threshold_t: u32,
        threshold_n: u32,
        created_at: i64,
        coordinator_roster: Vec<String>,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::RoundOpenProposal(RoundOpenProposalPayload {
            prompt,
            threshold_t,
            threshold_n,
            coordinator_roster: normalise_roster(&coordinator_roster),
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn commit_round_open(
        &mut self,
        round_id: String,
        proposal_event_id: String,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::RoundOpenCommit(RoundOpenCommitPayload {
            proposal_event_id,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn record_ballot_batch_notice(
        &mut self,
        round_id: String,
        accepted_ballot_event_ids: Vec<String>,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::BallotBatchNotice(BallotBatchNoticePayload {
            accepted_ballot_event_ids,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn submit_partial_tally(
        &mut self,
        round_id: String,
        yes_count: u32,
        no_count: u32,
        accepted_ballot_event_ids: Vec<String>,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::PartialTally(PartialTallyPayload {
            yes_count,
            no_count,
            accepted_ballot_event_ids,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn approve_result(
        &mut self,
        round_id: String,
        result_hash: String,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::ResultPublishApproval(ResultPublishApprovalPayload {
            result_hash,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn create_recovery_checkpoint(
        &mut self,
        round_id: String,
        checkpoint_hash: String,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::RecoveryCheckpoint(RecoveryCheckpointPayload {
            checkpoint_hash,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    pub fn dispute_round(
        &mut self,
        round_id: String,
        reason: String,
        related_event_id: Option<String>,
        created_at: i64,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let payload = CoordinatorControlPayload::DisputeNotice(DisputeNoticePayload {
            reason,
            related_event_id,
        });
        self.create_outbound(Some(round_id), created_at, payload)
    }

    fn create_outbound(
        &mut self,
        round_id: Option<String>,
        created_at: i64,
        payload: CoordinatorControlPayload,
    ) -> Result<OutboundCoordinatorTransportMessage, CoordinatorEngineError> {
        let logical_epoch = Some(self.state.logical_epoch.saturating_add(1));
        let event_type = payload.event_type();
        let envelope = CoordinatorControlEnvelope::new(
            self.config.election_id.clone(),
            round_id.clone(),
            created_at,
            self.config.local_pubkey.clone(),
            logical_epoch,
            payload,
        );
        let content = self.group_engine.encode(&envelope)?;
        Ok(OutboundCoordinatorTransportMessage {
            schema_version: COORDINATOR_SCHEMA_VERSION,
            election_id: self.config.election_id.clone(),
            round_id,
            event_type,
            created_at,
            sender_pubkey: self.config.local_pubkey.clone(),
            logical_epoch,
            content,
        })
    }
}

fn normalise_roster(roster: &[String]) -> Vec<String> {
    let mut values = roster
        .iter()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}
