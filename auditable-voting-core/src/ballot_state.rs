use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::event::{BallotEvent, EncryptedBallotEvent};
use crate::public_state::{DerivedReceipt, PublicRoundPhase, PublicState};
use crate::validation::{issue, ValidationCode, ValidationIssue};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BallotAcceptanceRule {
    FirstValidWins,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptedBallot {
    pub event_id: String,
    pub round_id: String,
    pub voter_pubkey: String,
    pub request_id: Option<String>,
    pub ticket_id: Option<String>,
    pub choice: String,
    pub token_id: String,
    pub created_at: i64,
    pub receipt_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RejectedBallot {
    pub event_id: String,
    pub round_id: String,
    pub voter_pubkey: String,
    pub choice: String,
    pub created_at: i64,
    pub reason: ValidationIssue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BallotRoundSummary {
    pub round_id: String,
    pub accepted_ballot_count: usize,
    pub rejected_ballot_count: usize,
    pub yes_count: usize,
    pub no_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BallotState {
    pub acceptance_rule: BallotAcceptanceRule,
    pub accepted_ballots: Vec<AcceptedBallot>,
    pub rejected_ballots: Vec<RejectedBallot>,
    pub derived_receipts: Vec<DerivedReceipt>,
    pub round_summaries: Vec<BallotRoundSummary>,
}

#[derive(Debug, Default)]
pub struct BallotStateReducer {
    accepted: Vec<AcceptedBallot>,
    rejected: Vec<RejectedBallot>,
    seen_event_ids: HashSet<String>,
    accepted_token_ids: HashSet<String>,
}

impl BallotStateReducer {
    pub fn apply(&mut self, event: &BallotEvent, public_state: &PublicState) {
        match event {
            BallotEvent::EncryptedBallot(ballot) => self.apply_encrypted_ballot(ballot, public_state),
            BallotEvent::BallotAck(_) | BallotEvent::InclusionProofResponse(_) => {}
        }
    }

    fn apply_encrypted_ballot(&mut self, ballot: &EncryptedBallotEvent, public_state: &PublicState) {
        if !self.seen_event_ids.insert(ballot.event_id.clone()) {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::DuplicateEvent,
                    "duplicate ballot event delivery",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        let Some(round) = public_state.rounds.iter().find(|round| round.round_id == ballot.round_id) else {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::UnknownRound,
                    "ballot references an unknown round",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        };

        if round.phase != PublicRoundPhase::Open && round.phase != PublicRoundPhase::Published {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::RoundNotOpen,
                    "ballot submitted outside an open round",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        if let Some(closed_at) = round.closed_at {
            if ballot.created_at >= closed_at {
                self.rejected.push(RejectedBallot {
                    event_id: ballot.event_id.clone(),
                    round_id: ballot.round_id.clone(),
                    voter_pubkey: ballot.author_pubkey.clone(),
                    choice: ballot.choice.clone(),
                    created_at: ballot.created_at,
                    reason: issue(
                        ValidationCode::RoundClosed,
                        "ballot arrived after round closure",
                        Some(ballot.event_id.clone()),
                    ),
                });
                return;
            }
        }

        if ballot.choice != "Yes" && ballot.choice != "No" {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::InvalidChoice,
                    "ballot choice must be Yes or No",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        let Some(token_id) = ballot.token_id.clone().filter(|value| !value.is_empty()) else {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::MissingTokenId,
                    "ballot is missing a token id",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        };

        let unique_coordinators = ballot
            .coordinator_shares
            .iter()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect::<HashSet<_>>();
        if unique_coordinators.len() < round.threshold_t as usize {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::NotEnoughCoordinatorShares,
                    "ballot does not meet the coordinator threshold",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        if unique_coordinators
            .iter()
            .any(|coordinator| !round.coordinator_roster.contains(coordinator))
        {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::UnauthorizedCoordinatorShare,
                    "ballot includes an unauthorized coordinator share",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        // The acceptance rule for this phase is fixed and global: first valid ballot wins.
        if !self.accepted_token_ids.insert(token_id.clone()) {
            self.rejected.push(RejectedBallot {
                event_id: ballot.event_id.clone(),
                round_id: ballot.round_id.clone(),
                voter_pubkey: ballot.author_pubkey.clone(),
                choice: ballot.choice.clone(),
                created_at: ballot.created_at,
                reason: issue(
                    ValidationCode::DuplicateToken,
                    "ballot reuses a token that has already been accepted",
                    Some(ballot.event_id.clone()),
                ),
            });
            return;
        }

        self.accepted.push(AcceptedBallot {
            event_id: ballot.event_id.clone(),
            round_id: ballot.round_id.clone(),
            voter_pubkey: ballot.author_pubkey.clone(),
            request_id: ballot.request_id.clone(),
            ticket_id: ballot.ticket_id.clone(),
            choice: ballot.choice.clone(),
            token_id: token_id.clone(),
            created_at: ballot.created_at,
            receipt_hash: format!("receipt:{}:{}:{}", ballot.round_id, token_id, ballot.event_id),
        });
    }

    pub fn finalize(self) -> BallotState {
        let mut summaries = BTreeMap::<String, BallotRoundSummary>::new();
        let mut receipts = Vec::new();

        for ballot in &self.accepted {
            let summary = summaries
                .entry(ballot.round_id.clone())
                .or_insert_with(|| BallotRoundSummary {
                    round_id: ballot.round_id.clone(),
                    accepted_ballot_count: 0,
                    rejected_ballot_count: 0,
                    yes_count: 0,
                    no_count: 0,
                });
            summary.accepted_ballot_count += 1;
            if ballot.choice == "Yes" {
                summary.yes_count += 1;
            } else if ballot.choice == "No" {
                summary.no_count += 1;
            }
            receipts.push(DerivedReceipt {
                election_id: String::new(),
                round_id: ballot.round_id.clone(),
                ballot_commitment: ballot.token_id.clone(),
                receipt_hash: ballot.receipt_hash.clone(),
                accepted_at: ballot.created_at,
            });
        }

        for ballot in &self.rejected {
            let summary = summaries
                .entry(ballot.round_id.clone())
                .or_insert_with(|| BallotRoundSummary {
                    round_id: ballot.round_id.clone(),
                    accepted_ballot_count: 0,
                    rejected_ballot_count: 0,
                    yes_count: 0,
                    no_count: 0,
                });
            summary.rejected_ballot_count += 1;
        }

        BallotState {
            acceptance_rule: BallotAcceptanceRule::FirstValidWins,
            accepted_ballots: self.accepted,
            rejected_ballots: self.rejected,
            derived_receipts: receipts,
            round_summaries: summaries.into_values().collect(),
        }
    }
}
