use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::event::{
    BallotReceiptEvent, DisputeRecordEvent, ElectionDefinitionEvent, FinalResultEvent, PublicEvent,
    RoundDefinitionEvent, RoundLifecycleEvent,
};
use crate::validation::{issue, ValidationCode, ValidationIssue};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicRoundPhase {
    Draft,
    Open,
    Closed,
    Tallied,
    Published,
    Disputed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DerivedReceipt {
    pub election_id: String,
    pub round_id: String,
    pub ballot_commitment: String,
    pub receipt_hash: String,
    pub accepted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedResult {
    pub event_id: String,
    pub yes_count: u32,
    pub no_count: u32,
    pub tally_input_hash: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicRoundState {
    pub round_id: String,
    pub prompt: String,
    pub threshold_t: u32,
    pub threshold_n: u32,
    pub coordinator_roster: Vec<String>,
    pub phase: PublicRoundPhase,
    pub defined_at: i64,
    pub opened_at: Option<i64>,
    pub closed_at: Option<i64>,
    pub receipts: Vec<DerivedReceipt>,
    pub final_result: Option<PublishedResult>,
    pub disputes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PublicState {
    pub election_id: String,
    pub election_title: Option<String>,
    pub rounds: Vec<PublicRoundState>,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Default)]
pub struct PublicStateReducer {
    election_id: String,
    election_title: Option<String>,
    rounds: BTreeMap<String, PublicRoundState>,
    issues: Vec<ValidationIssue>,
}

impl PublicStateReducer {
    pub fn new(election_id: String) -> Self {
        Self {
            election_id,
            ..Self::default()
        }
    }

    pub fn apply(&mut self, event: &PublicEvent) {
        match event {
            PublicEvent::ElectionDefinition(definition) => self.apply_election_definition(definition),
            PublicEvent::RoundDefinition(definition) => self.apply_round_definition(definition),
            PublicEvent::RoundOpen(open) => self.apply_round_open(open),
            PublicEvent::RoundClose(close) => self.apply_round_close(close),
            PublicEvent::BallotReceipt(receipt) => self.apply_ballot_receipt(receipt),
            PublicEvent::FinalResult(result) => self.apply_final_result(result),
            PublicEvent::DisputeRecord(dispute) => self.apply_dispute(dispute),
        }
    }

    fn apply_election_definition(&mut self, definition: &ElectionDefinitionEvent) {
        self.election_title = Some(definition.title.clone());
    }

    fn apply_round_definition(&mut self, definition: &RoundDefinitionEvent) {
        let round = self
            .rounds
            .entry(definition.round_id.clone())
            .or_insert_with(|| PublicRoundState {
                round_id: definition.round_id.clone(),
                prompt: definition.prompt.clone(),
                threshold_t: definition.threshold_t,
                threshold_n: definition.threshold_n,
                coordinator_roster: definition.coordinator_roster.clone(),
                phase: PublicRoundPhase::Draft,
                defined_at: definition.created_at,
                opened_at: None,
                closed_at: None,
                receipts: Vec::new(),
                final_result: None,
                disputes: Vec::new(),
            });
        round.prompt = definition.prompt.clone();
        round.threshold_t = definition.threshold_t;
        round.threshold_n = definition.threshold_n;
        round.coordinator_roster = definition.coordinator_roster.clone();
        round.defined_at = round.defined_at.min(definition.created_at);
    }

    fn apply_round_open(&mut self, open: &RoundLifecycleEvent) {
        let round = self.rounds.entry(open.round_id.clone()).or_insert_with(|| PublicRoundState {
            round_id: open.round_id.clone(),
            prompt: open.prompt.clone().unwrap_or_default(),
            threshold_t: open.threshold_t.unwrap_or(1),
            threshold_n: open.threshold_n.unwrap_or(open.coordinator_roster.len().max(1) as u32),
            coordinator_roster: open.coordinator_roster.clone(),
            phase: PublicRoundPhase::Draft,
            defined_at: open.created_at,
            opened_at: None,
            closed_at: None,
            receipts: Vec::new(),
            final_result: None,
            disputes: Vec::new(),
        });
        if let Some(closed_at) = round.closed_at {
            self.issues.push(issue(
                ValidationCode::ContradictoryRoundState,
                "round opened after closure",
                Some(open.event_id.clone()),
            ));
            if open.created_at >= closed_at {
                return;
            }
        }
        if let Some(prompt) = &open.prompt {
            round.prompt = prompt.clone();
        }
        if let Some(threshold_t) = open.threshold_t {
            round.threshold_t = threshold_t;
        }
        if let Some(threshold_n) = open.threshold_n {
            round.threshold_n = threshold_n;
        }
        if !open.coordinator_roster.is_empty() {
            round.coordinator_roster = open.coordinator_roster.clone();
        }
        round.phase = PublicRoundPhase::Open;
        round.opened_at = Some(round.opened_at.map_or(open.created_at, |current| current.min(open.created_at)));
    }

    fn apply_round_close(&mut self, close: &RoundLifecycleEvent) {
        let Some(round) = self.rounds.get_mut(&close.round_id) else {
            self.issues.push(issue(
                ValidationCode::UnknownRound,
                "round close references an unknown round",
                Some(close.event_id.clone()),
            ));
            return;
        };
        round.phase = PublicRoundPhase::Closed;
        round.closed_at = Some(round.closed_at.map_or(close.created_at, |current| current.min(close.created_at)));
    }

    fn apply_ballot_receipt(&mut self, receipt: &BallotReceiptEvent) {
        let Some(round) = self.rounds.get_mut(&receipt.round_id) else {
            self.issues.push(issue(
                ValidationCode::UnknownRound,
                "receipt references an unknown round",
                Some(receipt.event_id.clone()),
            ));
            return;
        };
        round.receipts.push(DerivedReceipt {
            election_id: receipt.election_id.clone(),
            round_id: receipt.round_id.clone(),
            ballot_commitment: receipt.ballot_commitment.clone(),
            receipt_hash: receipt.receipt_hash.clone(),
            accepted_at: receipt.accepted_at,
        });
    }

    fn apply_final_result(&mut self, result: &FinalResultEvent) {
        let Some(round) = self.rounds.get_mut(&result.round_id) else {
            self.issues.push(issue(
                ValidationCode::UnknownRound,
                "result references an unknown round",
                Some(result.event_id.clone()),
            ));
            return;
        };
        round.phase = PublicRoundPhase::Published;
        round.final_result = Some(PublishedResult {
            event_id: result.event_id.clone(),
            yes_count: result.yes_count,
            no_count: result.no_count,
            tally_input_hash: result.tally_input_hash.clone(),
            created_at: result.created_at,
        });
    }

    fn apply_dispute(&mut self, dispute: &DisputeRecordEvent) {
        if let Some(round_id) = &dispute.round_id {
            if let Some(round) = self.rounds.get_mut(round_id) {
                round.phase = PublicRoundPhase::Disputed;
                round.disputes.push(dispute.reason.clone());
                return;
            }
        }
        self.issues.push(issue(
            ValidationCode::UnknownRound,
            "dispute references an unknown round",
            Some(dispute.event_id.clone()),
        ));
    }

    pub fn finalize(self) -> PublicState {
        let mut rounds = self.rounds.into_values().collect::<Vec<_>>();
        rounds.sort_by(|left, right| {
            right
                .opened_at
                .or(right.closed_at)
                .unwrap_or(right.defined_at)
                .cmp(&left.opened_at.or(left.closed_at).unwrap_or(left.defined_at))
                .then_with(|| left.round_id.cmp(&right.round_id))
        });
        PublicState {
            election_id: self.election_id,
            election_title: self.election_title,
            rounds,
            issues: self.issues,
        }
    }
}
