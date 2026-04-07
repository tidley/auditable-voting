use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::coordinator_messages::{
    BallotBatchNoticePayload, CoordinatorControlEnvelope, CoordinatorControlPayload,
    DisputeNoticePayload, PartialTallyPayload, RecoveryCheckpointPayload,
    ResultPublishApprovalPayload, RoundDraftPayload, RoundOpenCommitPayload,
    RoundOpenProposalPayload,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorRoundPhase {
    Draft,
    OpenProposed,
    Open,
    Tallied,
    Published,
    Disputed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartialTallyRecord {
    pub sender_pubkey: String,
    pub yes_count: u32,
    pub no_count: u32,
    pub accepted_ballot_event_ids: Vec<String>,
    pub event_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResultApprovalRecord {
    pub sender_pubkey: String,
    pub result_hash: String,
    pub event_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorRoundRecord {
    pub round_id: String,
    pub prompt: Option<String>,
    pub threshold_t: Option<u32>,
    pub threshold_n: Option<u32>,
    pub coordinator_roster: Vec<String>,
    pub phase: CoordinatorRoundPhase,
    pub draft_event_id: Option<String>,
    pub proposal_event_id: Option<String>,
    pub open_commit_event_ids: BTreeMap<String, String>,
    pub ballot_batch_event_ids: Vec<String>,
    pub partial_tallies: BTreeMap<String, PartialTallyRecord>,
    pub result_approvals: BTreeMap<String, ResultApprovalRecord>,
    pub latest_checkpoint_hash: Option<String>,
    pub latest_dispute_reason: Option<String>,
    pub last_transition_at: Option<i64>,
}

impl CoordinatorRoundRecord {
    pub fn new(round_id: String) -> Self {
        Self {
            round_id,
            prompt: None,
            threshold_t: None,
            threshold_n: None,
            coordinator_roster: Vec::new(),
            phase: CoordinatorRoundPhase::Draft,
            draft_event_id: None,
            proposal_event_id: None,
            open_commit_event_ids: BTreeMap::new(),
            ballot_batch_event_ids: Vec::new(),
            partial_tallies: BTreeMap::new(),
            result_approvals: BTreeMap::new(),
            latest_checkpoint_hash: None,
            latest_dispute_reason: None,
            last_transition_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinatorControlState {
    pub schema_version: u32,
    pub election_id: String,
    pub local_pubkey: String,
    pub coordinator_roster: Vec<String>,
    pub logical_epoch: u64,
    pub processed_event_ids: BTreeSet<String>,
    pub rounds: BTreeMap<String, CoordinatorRoundRecord>,
}

impl CoordinatorControlState {
    pub fn new(election_id: String, local_pubkey: String, coordinator_roster: Vec<String>) -> Self {
        Self {
            schema_version: 1,
            election_id,
            local_pubkey,
            coordinator_roster,
            logical_epoch: 0,
            processed_event_ids: BTreeSet::new(),
            rounds: BTreeMap::new(),
        }
    }

    pub fn record_processed_event(&mut self, event_id: &str, logical_epoch: Option<u64>) {
        self.processed_event_ids.insert(event_id.to_owned());
        self.logical_epoch = self.logical_epoch.max(logical_epoch.unwrap_or(self.logical_epoch));
    }

    pub fn has_processed_event(&self, event_id: &str) -> bool {
        self.processed_event_ids.contains(event_id)
    }

    pub fn round(&self, round_id: &str) -> Option<&CoordinatorRoundRecord> {
        self.rounds.get(round_id)
    }

    pub fn latest_round(&self) -> Option<&CoordinatorRoundRecord> {
        self.rounds.values().max_by(|left, right| {
            left.last_transition_at
                .unwrap_or_default()
                .cmp(&right.last_transition_at.unwrap_or_default())
                .then_with(|| left.round_id.cmp(&right.round_id))
        })
    }

    pub fn apply_envelope(&mut self, event_id: &str, envelope: &CoordinatorControlEnvelope) {
        if self.has_processed_event(event_id) {
            return;
        }

        if self.election_id != envelope.election_id {
            return;
        }

        if let Some(round_id) = envelope.round_id.as_ref() {
            let round = self
                .rounds
                .entry(round_id.clone())
                .or_insert_with(|| CoordinatorRoundRecord::new(round_id.clone()));
            round.last_transition_at = Some(envelope.created_at);

            match &envelope.payload {
                CoordinatorControlPayload::RoundDraft(payload) => {
                    apply_round_draft(round, event_id, payload);
                }
                CoordinatorControlPayload::RoundOpenProposal(payload) => {
                    apply_round_open_proposal(round, event_id, payload);
                }
                CoordinatorControlPayload::RoundOpenCommit(payload) => {
                    apply_round_open_commit(round, event_id, &envelope.sender_pubkey, payload);
                }
                CoordinatorControlPayload::BallotBatchNotice(payload) => {
                    apply_ballot_batch_notice(round, event_id, payload);
                }
                CoordinatorControlPayload::PartialTally(payload) => {
                    apply_partial_tally(round, event_id, &envelope.sender_pubkey, envelope.created_at, payload);
                }
                CoordinatorControlPayload::ResultPublishApproval(payload) => {
                    apply_result_publish_approval(round, event_id, &envelope.sender_pubkey, envelope.created_at, payload);
                }
                CoordinatorControlPayload::RecoveryCheckpoint(payload) => {
                    apply_recovery_checkpoint(round, payload);
                }
                CoordinatorControlPayload::DisputeNotice(payload) => {
                    apply_dispute_notice(round, payload);
                }
            }

            if !round.coordinator_roster.is_empty() {
                self.coordinator_roster = round.coordinator_roster.clone();
            }
        }

        self.record_processed_event(event_id, envelope.logical_epoch);
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

fn apply_round_draft(round: &mut CoordinatorRoundRecord, event_id: &str, payload: &RoundDraftPayload) {
    round.prompt = Some(payload.prompt.clone());
    round.threshold_t = Some(payload.threshold_t);
    round.threshold_n = Some(payload.threshold_n);
    round.coordinator_roster = normalise_roster(&payload.coordinator_roster);
    round.draft_event_id = Some(event_id.to_owned());
    if matches!(round.phase, CoordinatorRoundPhase::Draft) {
        round.phase = CoordinatorRoundPhase::Draft;
    }
}

fn apply_round_open_proposal(
    round: &mut CoordinatorRoundRecord,
    event_id: &str,
    payload: &RoundOpenProposalPayload,
) {
    round.prompt = Some(payload.prompt.clone());
    round.threshold_t = Some(payload.threshold_t);
    round.threshold_n = Some(payload.threshold_n);
    round.coordinator_roster = normalise_roster(&payload.coordinator_roster);
    round.proposal_event_id = Some(event_id.to_owned());
    round.phase = CoordinatorRoundPhase::OpenProposed;
}

fn apply_round_open_commit(
    round: &mut CoordinatorRoundRecord,
    event_id: &str,
    sender_pubkey: &str,
    payload: &RoundOpenCommitPayload,
) {
    if round.proposal_event_id.as_deref() != Some(payload.proposal_event_id.as_str()) {
        return;
    }

    round
        .open_commit_event_ids
        .insert(sender_pubkey.to_owned(), event_id.to_owned());

    let expected_committers = if round.coordinator_roster.is_empty() {
        1
    } else {
        round.coordinator_roster.len()
    };

    if round.open_commit_event_ids.len() >= expected_committers {
        round.phase = CoordinatorRoundPhase::Open;
    }
}

fn apply_ballot_batch_notice(
    round: &mut CoordinatorRoundRecord,
    event_id: &str,
    payload: &BallotBatchNoticePayload,
) {
    if payload.accepted_ballot_event_ids.is_empty() {
        return;
    }
    round.ballot_batch_event_ids.push(event_id.to_owned());
}

fn apply_partial_tally(
    round: &mut CoordinatorRoundRecord,
    event_id: &str,
    sender_pubkey: &str,
    created_at: i64,
    payload: &PartialTallyPayload,
) {
    round.partial_tallies.insert(
        sender_pubkey.to_owned(),
        PartialTallyRecord {
            sender_pubkey: sender_pubkey.to_owned(),
            yes_count: payload.yes_count,
            no_count: payload.no_count,
            accepted_ballot_event_ids: payload.accepted_ballot_event_ids.clone(),
            event_id: event_id.to_owned(),
            created_at,
        },
    );

    let expected = if round.coordinator_roster.is_empty() {
        1
    } else {
        round.coordinator_roster.len()
    };
    if round.partial_tallies.len() >= expected {
        round.phase = CoordinatorRoundPhase::Tallied;
    }
}

fn apply_result_publish_approval(
    round: &mut CoordinatorRoundRecord,
    event_id: &str,
    sender_pubkey: &str,
    created_at: i64,
    payload: &ResultPublishApprovalPayload,
) {
    round.result_approvals.insert(
        sender_pubkey.to_owned(),
        ResultApprovalRecord {
            sender_pubkey: sender_pubkey.to_owned(),
            result_hash: payload.result_hash.clone(),
            event_id: event_id.to_owned(),
            created_at,
        },
    );

    let expected = if round.coordinator_roster.is_empty() {
        1
    } else {
        round.coordinator_roster.len()
    };
    if round.result_approvals.len() >= expected {
        round.phase = CoordinatorRoundPhase::Published;
    }
}

fn apply_recovery_checkpoint(
    round: &mut CoordinatorRoundRecord,
    payload: &RecoveryCheckpointPayload,
) {
    round.latest_checkpoint_hash = Some(payload.checkpoint_hash.clone());
}

fn apply_dispute_notice(round: &mut CoordinatorRoundRecord, payload: &DisputeNoticePayload) {
    round.latest_dispute_reason = Some(payload.reason.clone());
    round.phase = CoordinatorRoundPhase::Disputed;
}
