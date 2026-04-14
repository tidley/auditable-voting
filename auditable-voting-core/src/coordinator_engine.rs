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
#[serde(rename_all = "snake_case")]
pub enum CoordinatorEngineKind {
    Deterministic,
    OpenMls,
}

impl Default for CoordinatorEngineKind {
    fn default() -> Self {
        Self::Deterministic
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorEngineConfig {
    pub election_id: String,
    pub local_pubkey: String,
    pub coordinator_roster: Vec<String>,
    #[serde(default)]
    pub lead_pubkey: Option<String>,
    #[serde(default)]
    pub engine_kind: CoordinatorEngineKind,
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
    pub engine_kind: CoordinatorEngineKind,
    pub logical_epoch: u64,
    pub latest_round: Option<CoordinatorRoundView>,
    pub rounds: Vec<CoordinatorRoundView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorEngineStatus {
    pub engine_kind: CoordinatorEngineKind,
    pub group_ready: bool,
    pub joined_group: bool,
    pub welcome_applied: Option<bool>,
    pub current_epoch: u64,
    pub snapshot_freshness: CoordinatorSnapshotFreshness,
    pub public_round_visibility: CoordinatorPublicRoundVisibility,
    pub readiness: CoordinatorReadiness,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorSnapshotFreshness {
    Live,
    Restored,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorPublicRoundVisibility {
    NotVisible,
    Draft,
    OpenProposed,
    Open,
    Tallied,
    Published,
    Disputed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorReadiness {
    Ready,
    WaitingForGroupReady,
    WaitingForOwnOpenCommit,
    WaitingForCoordinatorApprovals,
    RoundOpen,
    Published,
    NoRound,
}

pub struct CoordinatorControlEngine {
    config: CoordinatorEngineConfig,
    state: CoordinatorControlState,
    group_engine: Box<dyn CoordinatorGroupEngine>,
    restored_from_snapshot: bool,
}

impl CoordinatorControlEngine {
    pub fn new(config: CoordinatorEngineConfig) -> Result<Self, CoordinatorEngineError> {
        let roster = normalise_roster(&config.coordinator_roster);
        let config = CoordinatorEngineConfig {
            coordinator_roster: roster.clone(),
            ..config
        };

        Ok(Self {
            state: CoordinatorControlState::new(
                config.election_id.clone(),
                config.local_pubkey.clone(),
                roster,
            ),
            group_engine: create_group_engine(&config.engine_kind, &config.local_pubkey)?,
            config,
            restored_from_snapshot: false,
        })
    }

    pub fn restore(snapshot: CoordinatorEngineSnapshot) -> Result<Self, CoordinatorEngineError> {
        let mut engine = Self::new(snapshot.config.clone())?;
        engine.state = snapshot.state;
        engine.group_engine.restore(snapshot.group_engine);
        engine.restored_from_snapshot = true;
        Ok(engine)
    }

    pub fn snapshot(&self) -> CoordinatorEngineSnapshot {
        CoordinatorEngineSnapshot {
            config: self.config.clone(),
            state: self.state.clone(),
            group_engine: self.group_engine.snapshot(),
        }
    }

    pub fn engine_status(&self) -> CoordinatorEngineStatus {
        let group_ready = self.group_engine.is_ready();
        let latest_round = self.state.latest_round();
        let public_round_visibility = match latest_round.map(|round| &round.phase) {
            None => CoordinatorPublicRoundVisibility::NotVisible,
            Some(CoordinatorRoundPhase::Draft) => CoordinatorPublicRoundVisibility::Draft,
            Some(CoordinatorRoundPhase::OpenProposed) => CoordinatorPublicRoundVisibility::OpenProposed,
            Some(CoordinatorRoundPhase::Open) => CoordinatorPublicRoundVisibility::Open,
            Some(CoordinatorRoundPhase::Tallied) => CoordinatorPublicRoundVisibility::Tallied,
            Some(CoordinatorRoundPhase::Published) => CoordinatorPublicRoundVisibility::Published,
            Some(CoordinatorRoundPhase::Disputed) => CoordinatorPublicRoundVisibility::Disputed,
        };
        let local_missing_open_commit = latest_round
            .map(|round| {
                round.coordinator_roster.iter().any(|pubkey| pubkey == &self.config.local_pubkey)
                    && !round
                        .open_commit_event_ids
                        .contains_key(self.config.local_pubkey.as_str())
            })
            .unwrap_or(false);
        let readiness = if latest_round.is_none() {
            if matches!(self.config.engine_kind, CoordinatorEngineKind::OpenMls) && !group_ready {
                CoordinatorReadiness::WaitingForGroupReady
            } else {
                CoordinatorReadiness::NoRound
            }
        } else {
            match latest_round.expect("latest_round checked").phase {
                CoordinatorRoundPhase::Open => CoordinatorReadiness::RoundOpen,
                CoordinatorRoundPhase::Published => CoordinatorReadiness::Published,
                CoordinatorRoundPhase::OpenProposed => {
                    if !group_ready {
                        CoordinatorReadiness::WaitingForGroupReady
                    } else if local_missing_open_commit {
                        CoordinatorReadiness::WaitingForOwnOpenCommit
                    } else {
                        CoordinatorReadiness::WaitingForCoordinatorApprovals
                    }
                }
                _ => {
                    if matches!(self.config.engine_kind, CoordinatorEngineKind::OpenMls) && !group_ready {
                        CoordinatorReadiness::WaitingForGroupReady
                    } else {
                        CoordinatorReadiness::Ready
                    }
                }
            }
        };
        let is_non_lead = self
            .config
            .lead_pubkey
            .as_ref()
            .map(|lead_pubkey| !lead_pubkey.is_empty() && lead_pubkey != &self.config.local_pubkey)
            .unwrap_or(false);

        CoordinatorEngineStatus {
            engine_kind: self.config.engine_kind.clone(),
            group_ready,
            joined_group: group_ready,
            welcome_applied: if matches!(self.config.engine_kind, CoordinatorEngineKind::OpenMls) && is_non_lead {
                Some(group_ready)
            } else {
                None
            },
            current_epoch: self.state.logical_epoch,
            snapshot_freshness: if self.restored_from_snapshot {
                CoordinatorSnapshotFreshness::Restored
            } else {
                CoordinatorSnapshotFreshness::Live
            },
            public_round_visibility,
            readiness: readiness.clone(),
            blocked_reason: match readiness {
                CoordinatorReadiness::WaitingForGroupReady => {
                    Some("Waiting for supervisory group readiness.".to_owned())
                }
                CoordinatorReadiness::WaitingForOwnOpenCommit => {
                    Some("Waiting for this coordinator's round-open commit.".to_owned())
                }
                CoordinatorReadiness::WaitingForCoordinatorApprovals => {
                    Some("Waiting for coordinator approvals.".to_owned())
                }
                _ => None,
            },
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
            engine_kind: self.config.engine_kind.clone(),
            logical_epoch: self.state.logical_epoch,
            latest_round,
            rounds,
        }
    }

    pub fn replay_transport_messages(
        &mut self,
        events: Vec<CoordinatorTransportEvent>,
    ) -> Result<Vec<ReplayAppliedEvent>, CoordinatorEngineError> {
        let applied = replay_transport_events(&mut self.state, self.group_engine.as_mut(), events)
            .map_err(CoordinatorEngineError::from)?;
        if !applied.is_empty() {
            self.restored_from_snapshot = false;
        }
        Ok(applied)
    }

    pub fn apply_transport_message(
        &mut self,
        event: CoordinatorTransportEvent,
    ) -> Result<Vec<ReplayAppliedEvent>, CoordinatorEngineError> {
        self.replay_transport_messages(vec![event])
    }

    pub fn apply_published_local_message(
        &mut self,
        event_id: String,
        local_echo: String,
    ) -> Result<Vec<ReplayAppliedEvent>, CoordinatorEngineError> {
        if self.state.has_processed_event(&event_id) {
            return Ok(Vec::new());
        }

        let envelope = serde_json::from_str::<CoordinatorControlEnvelope>(&local_echo)
            .map_err(|error| CoordinatorEngineError::Serialization(error.to_string()))?;
        let event_type = envelope.payload.event_type();
        let round_id = envelope.round_id.clone();
        let created_at = envelope.created_at;

        self.state.apply_envelope(&event_id, &envelope);
        self.restored_from_snapshot = false;

        Ok(vec![ReplayAppliedEvent {
            event_id,
            event_type,
            round_id,
            created_at,
        }])
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

    pub fn export_supervisory_join_package(&mut self) -> Result<Option<String>, CoordinatorEngineError> {
        self.group_engine
            .export_join_package(&self.config.election_id)
            .map_err(CoordinatorEngineError::from)
    }

    pub fn bootstrap_supervisory_group(
        &mut self,
        member_join_packages: Vec<String>,
    ) -> Result<Option<String>, CoordinatorEngineError> {
        self.group_engine
            .bootstrap_group(&self.config.election_id, member_join_packages)
            .map_err(CoordinatorEngineError::from)
    }

    pub fn join_supervisory_group(
        &mut self,
        welcome_bundle: String,
    ) -> Result<bool, CoordinatorEngineError> {
        self.group_engine
            .join_group(&welcome_bundle)
            .map_err(CoordinatorEngineError::from)
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
        let local_echo =
            serde_json::to_string(&envelope).map_err(|error| CoordinatorEngineError::Serialization(error.to_string()))?;
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
            local_echo,
        })
    }
}

fn create_group_engine(
    engine_kind: &CoordinatorEngineKind,
    local_pubkey: &str,
) -> Result<Box<dyn CoordinatorGroupEngine>, CoordinatorEngineError> {
    match engine_kind {
        CoordinatorEngineKind::Deterministic => {
            Ok(Box::<DeterministicCoordinatorGroupEngine>::default())
        }
        CoordinatorEngineKind::OpenMls => {
            #[cfg(feature = "openmls-engine")]
            {
                Ok(Box::new(
                    crate::openmls_engine::OpenMlsCoordinatorGroupEngine::new_with_identity(
                        local_pubkey,
                    )?,
                ))
            }
            #[cfg(not(feature = "openmls-engine"))]
            {
                Err(CoordinatorEngineError::GroupEngine(
                    GroupEngineError::OpenMlsUnavailable,
                ))
            }
        }
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
