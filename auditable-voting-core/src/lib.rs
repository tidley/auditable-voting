pub mod ballot_state;
pub mod coordinator_engine;
pub mod coordinator_messages;
pub mod coordinator_state;
pub mod diagnostics;
pub mod error;
pub mod event;
pub mod openmls_engine;
pub mod order;
pub mod public_state;
pub mod replay;
pub mod reducer;
pub mod snapshot;
pub mod types;
pub mod validation;
pub mod versioning;
pub mod wasm;

pub use diagnostics::{ProtocolDiagnostics, ReplayStatus, ValidationIssueCount};
pub use error::ProtocolEngineError;
pub use coordinator_engine::{
    CoordinatorControlEngine, CoordinatorEngineConfig, CoordinatorEngineKind, CoordinatorEngineSnapshot,
    CoordinatorEngineStatus,
    CoordinatorEngineView, CoordinatorRoundView,
};
pub use coordinator_messages::{CoordinatorControlEnvelope, CoordinatorControlPayload};
pub use coordinator_state::{CoordinatorControlState, CoordinatorRoundPhase};
pub use event::{BallotEvent, ProtocolEvent, PublicEvent};
pub use public_state::{PublicRoundPhase, PublicState};
pub use reducer::{AuditableVotingProtocolEngine, DerivedState};
pub use snapshot::ProtocolSnapshot;
pub use types::{
    CoordinatorEventType, CoordinatorTransportEvent, OutboundCoordinatorTransportMessage,
    ReplayAppliedEvent, COORDINATOR_SCHEMA_VERSION,
};
pub use versioning::{
    SnapshotCompatibilityStatus, SnapshotMetadata, PROTOCOL_SCHEMA_VERSION, PROTOCOL_SNAPSHOT_VERSION,
};
pub use wasm::{WasmAuditableVotingProtocolEngine, WasmCoordinatorControlEngine};

#[cfg(test)]
mod tests {
    use crate::ballot_state::BallotAcceptanceRule;
    use crate::coordinator_engine::{
        CoordinatorControlEngine, CoordinatorEngineConfig, CoordinatorEngineKind,
    };
    use crate::event::{
        BallotEvent, CoordinatorControlEvent, ElectionDefinitionEvent, EncryptedBallotEvent,
        ProtocolEvent, PublicEvent, RoundLifecycleEvent,
    };
    use crate::coordinator_messages::{CoordinatorControlEnvelope, CoordinatorControlPayload, RoundDraftPayload};
    use crate::reducer::AuditableVotingProtocolEngine;
    use crate::types::CoordinatorTransportEvent;

    fn create_engine(local_pubkey: &str) -> CoordinatorControlEngine {
        CoordinatorControlEngine::new(CoordinatorEngineConfig {
            election_id: "election-1".to_owned(),
            local_pubkey: local_pubkey.to_owned(),
            coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            engine_kind: CoordinatorEngineKind::Deterministic,
        })
        .unwrap()
    }

    #[test]
    fn deterministic_engine_selection_is_preserved_in_snapshot_and_view() {
        let engine = create_engine("coord-1");
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.config.engine_kind, CoordinatorEngineKind::Deterministic);
        assert_eq!(engine.view().engine_kind, CoordinatorEngineKind::Deterministic);

        let restored = CoordinatorControlEngine::restore(snapshot).unwrap();
        assert_eq!(restored.view().engine_kind, CoordinatorEngineKind::Deterministic);
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn openmls_engine_selection_is_preserved_in_snapshot_and_view() {
        let engine = CoordinatorControlEngine::new(CoordinatorEngineConfig {
            election_id: "election-1".to_owned(),
            local_pubkey: "coord-1".to_owned(),
            coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            engine_kind: CoordinatorEngineKind::OpenMls,
        })
        .unwrap();

        let snapshot = engine.snapshot();
        assert_eq!(snapshot.config.engine_kind, CoordinatorEngineKind::OpenMls);
        assert_eq!(engine.view().engine_kind, CoordinatorEngineKind::OpenMls);

        let restored = CoordinatorControlEngine::restore(snapshot).unwrap();
        assert_eq!(restored.view().engine_kind, CoordinatorEngineKind::OpenMls);
    }

    fn publish_from_engine(
        engine: &mut CoordinatorControlEngine,
        outbound: crate::types::OutboundCoordinatorTransportMessage,
        event_id: &str,
    ) -> CoordinatorTransportEvent {
        let event = CoordinatorTransportEvent {
            event_id: event_id.to_owned(),
            raw_content: outbound.content,
            sender_pubkey: None,
        };
        let _ = engine.apply_transport_message(event.clone()).unwrap();
        event
    }

    #[test]
    fn replays_in_order_round_open_transcript() {
        let mut lead = create_engine("coord-1");
        let round_id = "round-1".to_owned();
        let draft = lead
            .record_round_draft(
                round_id.clone(),
                "Question?".to_owned(),
                2,
                2,
                10,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let proposal = lead
            .propose_round_open(
                round_id.clone(),
                "Question?".to_owned(),
                2,
                2,
                11,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let lead_commit = lead
            .commit_round_open(round_id.clone(), "event-proposal".to_owned(), 12)
            .unwrap();

        let draft_event = publish_from_engine(&mut lead, draft, "event-draft");
        let proposal_event = publish_from_engine(&mut lead, proposal, "event-proposal");
        let lead_commit_event = publish_from_engine(&mut lead, lead_commit, "event-commit-1");

        let mut sub = create_engine("coord-2");
        let _ = sub
            .replay_transport_messages(vec![
                draft_event.clone(),
                proposal_event.clone(),
                lead_commit_event.clone(),
            ])
            .unwrap();
        let commit = sub
            .commit_round_open(round_id.clone(), "event-proposal".to_owned(), 13)
            .unwrap();
        let commit_event = CoordinatorTransportEvent {
            event_id: "event-commit-2".to_owned(),
            raw_content: commit.content,
            sender_pubkey: None,
        };

        let _ = lead
            .replay_transport_messages(vec![commit_event.clone()])
            .unwrap();

        let latest = lead.view().latest_round.unwrap();
        assert_eq!(latest.phase, crate::coordinator_state::CoordinatorRoundPhase::Open);
        assert_eq!(latest.open_committers, vec!["coord-1".to_owned(), "coord-2".to_owned()]);
    }

    fn round_open_event(event_id: &str, created_at: i64) -> ProtocolEvent {
        ProtocolEvent::Public {
            event: PublicEvent::RoundOpen(RoundLifecycleEvent {
                schema_version: 1,
                election_id: "election-1".to_owned(),
                round_id: "round-1".to_owned(),
                created_at,
                author_pubkey: "coord-1".to_owned(),
                event_id: event_id.to_owned(),
                prompt: Some("Should the proposal pass?".to_owned()),
                threshold_t: Some(2),
                threshold_n: Some(2),
                coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            }),
        }
    }

    fn ballot_event(event_id: &str, created_at: i64, token_id: &str, choice: &str) -> ProtocolEvent {
        ProtocolEvent::Ballot {
            event: BallotEvent::EncryptedBallot(EncryptedBallotEvent {
                schema_version: 1,
                election_id: "election-1".to_owned(),
                round_id: "round-1".to_owned(),
                created_at,
                author_pubkey: format!("voter-{event_id}"),
                event_id: event_id.to_owned(),
                choice: choice.to_owned(),
                token_id: Some(token_id.to_owned()),
                coordinator_shares: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            }),
        }
    }

    #[test]
    fn derives_public_round_state_and_ballot_acceptance() {
        let mut engine = AuditableVotingProtocolEngine::new("election-1".to_owned());
        let state = engine
            .replay_all(vec![
                ProtocolEvent::Public {
                    event: PublicEvent::ElectionDefinition(ElectionDefinitionEvent {
                        schema_version: 1,
                        election_id: "election-1".to_owned(),
                        created_at: 1,
                        author_pubkey: "coord-1".to_owned(),
                        event_id: "election-def".to_owned(),
                        title: "Election".to_owned(),
                    }),
                },
                round_open_event("round-open", 10),
                ballot_event("ballot-1", 11, "token-1", "Yes"),
                ballot_event("ballot-2", 12, "token-2", "No"),
            ])
            .unwrap();

        assert_eq!(state.public_state.rounds.len(), 1);
        assert_eq!(state.public_state.rounds[0].phase, crate::public_state::PublicRoundPhase::Open);
        assert_eq!(state.ballot_state.acceptance_rule, BallotAcceptanceRule::FirstValidWins);
        assert_eq!(state.ballot_state.accepted_ballots.len(), 2);
        assert_eq!(state.ballot_state.round_summaries[0].yes_count, 1);
        assert_eq!(state.ballot_state.round_summaries[0].no_count, 1);
    }

    #[test]
    fn rejects_duplicate_token_using_first_valid_wins() {
        let mut engine = AuditableVotingProtocolEngine::new("election-1".to_owned());
        let state = engine
            .replay_all(vec![
                round_open_event("round-open", 10),
                ballot_event("ballot-1", 11, "token-1", "Yes"),
                ballot_event("ballot-2", 12, "token-1", "No"),
            ])
            .unwrap();

        assert_eq!(state.ballot_state.accepted_ballots.len(), 1);
        assert_eq!(state.ballot_state.rejected_ballots.len(), 1);
    }

    #[test]
    fn mixed_replay_is_deterministic_under_reordered_input() {
        let coordinator_envelope = CoordinatorControlEnvelope {
            schema_version: 1,
            election_id: "election-1".to_owned(),
            round_id: Some("round-1".to_owned()),
            created_at: 9,
            sender_pubkey: "coord-1".to_owned(),
            logical_epoch: Some(1),
            payload: CoordinatorControlPayload::RoundDraft(RoundDraftPayload {
                prompt: "Should the proposal pass?".to_owned(),
                threshold_t: 2,
                threshold_n: 2,
                coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            }),
        };
        let input = vec![
            ballot_event("ballot-2", 12, "token-2", "No"),
            ProtocolEvent::Coordinator {
                event: CoordinatorControlEvent {
                    event_id: "coord-1".to_owned(),
                    envelope: coordinator_envelope.clone(),
                },
            },
            round_open_event("round-open", 10),
            ballot_event("ballot-1", 11, "token-1", "Yes"),
        ];

        let mut full = AuditableVotingProtocolEngine::new("election-1".to_owned());
        let mut reordered = AuditableVotingProtocolEngine::new("election-1".to_owned());

        let left = full.replay_all(input.clone()).unwrap();
        let right = reordered
            .replay_all(vec![
                ProtocolEvent::Coordinator {
                    event: CoordinatorControlEvent {
                        event_id: "coord-1".to_owned(),
                        envelope: coordinator_envelope,
                    },
                },
                ballot_event("ballot-1", 11, "token-1", "Yes"),
                round_open_event("round-open", 10),
                ballot_event("ballot-2", 12, "token-2", "No"),
            ])
            .unwrap();

        assert_eq!(left, right);
        assert_eq!(left.coordinator_event_count, 1);
    }

    #[test]
    fn snapshot_and_suffix_replay_match_full_replay() {
        let mut engine = AuditableVotingProtocolEngine::new("election-1".to_owned());
        let prefix = vec![round_open_event("round-open", 10), ballot_event("ballot-1", 11, "token-1", "Yes")];
        let _ = engine.replay_all(prefix).unwrap();
        let snapshot = engine.snapshot().unwrap();

        let suffix = vec![ballot_event("ballot-2", 12, "token-2", "No")];
        let mut restored = AuditableVotingProtocolEngine::restore(snapshot).unwrap();
        let restored_state = restored.apply_events(suffix.clone()).unwrap();

        let mut full = AuditableVotingProtocolEngine::new("election-1".to_owned());
        let full_state = full
            .replay_all(vec![
                round_open_event("round-open", 10),
                ballot_event("ballot-1", 11, "token-1", "Yes"),
                ballot_event("ballot-2", 12, "token-2", "No"),
            ])
            .unwrap();

        assert_eq!(restored_state, full_state);
    }

    #[test]
    fn replays_out_of_order_events_deterministically() {
        let mut lead = create_engine("coord-1");
        let draft = lead
            .record_round_draft(
                "round-1".to_owned(),
                "Question?".to_owned(),
                2,
                2,
                10,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let proposal = lead
            .propose_round_open(
                "round-1".to_owned(),
                "Question?".to_owned(),
                2,
                2,
                11,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let lead_commit = lead
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();
        let commit = create_engine("coord-2")
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();

        let mut replay = create_engine("coord-1");
        let _ = replay
            .replay_transport_messages(vec![
                CoordinatorTransportEvent {
                    event_id: "event-commit-1".to_owned(),
                    raw_content: lead_commit.content,
                    sender_pubkey: None,
                },
                CoordinatorTransportEvent {
                    event_id: "event-commit-2".to_owned(),
                    raw_content: commit.content,
                    sender_pubkey: None,
                },
                CoordinatorTransportEvent {
                    event_id: "event-proposal".to_owned(),
                    raw_content: proposal.content,
                    sender_pubkey: None,
                },
                CoordinatorTransportEvent {
                    event_id: "event-draft".to_owned(),
                    raw_content: draft.content,
                    sender_pubkey: None,
                },
            ])
            .unwrap();

        let latest = replay.view().latest_round.unwrap();
        assert_eq!(latest.phase, crate::coordinator_state::CoordinatorRoundPhase::Open);
    }

    #[test]
    fn ignores_duplicate_relay_deliveries() {
        let mut engine = create_engine("coord-1");
        let proposal = engine
            .propose_round_open(
                "round-1".to_owned(),
                "Question?".to_owned(),
                2,
                2,
                11,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let transport = CoordinatorTransportEvent {
            event_id: "event-proposal".to_owned(),
            raw_content: proposal.content,
            sender_pubkey: None,
        };
        let _ = engine
            .replay_transport_messages(vec![transport.clone(), transport])
            .unwrap();
        assert_eq!(engine.view().rounds.len(), 1);
    }

    #[test]
    fn supports_missing_segment_then_backfill() {
        let mut engine = create_engine("coord-1");
        let proposal = engine
            .propose_round_open(
                "round-1".to_owned(),
                "Question?".to_owned(),
                2,
                2,
                11,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let lead_commit = engine
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();
        let _ = engine
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-proposal".to_owned(),
                raw_content: proposal.content.clone(),
                sender_pubkey: None,
            })
            .unwrap();
        let _ = engine
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-commit-1".to_owned(),
                raw_content: lead_commit.content,
                sender_pubkey: None,
            })
            .unwrap();

        let mut sub = create_engine("coord-2");
        let _ = sub
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-proposal".to_owned(),
                raw_content: proposal.content,
                sender_pubkey: None,
            })
            .unwrap();
        let commit = sub
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();

        let latest_before = engine.view().latest_round.unwrap();
        assert_eq!(
            latest_before.phase,
            crate::coordinator_state::CoordinatorRoundPhase::OpenProposed
        );

        let _ = engine
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-commit-2".to_owned(),
                raw_content: commit.content,
                sender_pubkey: None,
            })
            .unwrap();

        let latest_after = engine.view().latest_round.unwrap();
        assert_eq!(latest_after.phase, crate::coordinator_state::CoordinatorRoundPhase::Open);
    }

    #[test]
    fn restores_snapshot_and_replays_new_events() {
        let mut engine = create_engine("coord-1");
        let proposal = engine
            .propose_round_open(
                "round-1".to_owned(),
                "Question?".to_owned(),
                2,
                2,
                11,
                vec!["coord-1".to_owned(), "coord-2".to_owned()],
            )
            .unwrap();
        let lead_commit = engine
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();
        let _ = engine
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-proposal".to_owned(),
                raw_content: proposal.content.clone(),
                sender_pubkey: None,
            })
            .unwrap();
        let _ = engine
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-commit-1".to_owned(),
                raw_content: lead_commit.content,
                sender_pubkey: None,
            })
            .unwrap();

        let snapshot = engine.snapshot();
        let mut restored = CoordinatorControlEngine::restore(snapshot).unwrap();
        let commit = create_engine("coord-2")
            .commit_round_open("round-1".to_owned(), "event-proposal".to_owned(), 12)
            .unwrap();
        let _ = restored
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "event-commit-2".to_owned(),
                raw_content: commit.content,
                sender_pubkey: None,
            })
            .unwrap();

        assert_eq!(
            restored.view().latest_round.unwrap().phase,
            crate::coordinator_state::CoordinatorRoundPhase::Open
        );
    }

    #[test]
    fn approves_result_after_partial_tally_exchange() {
        let mut lead = create_engine("coord-1");
        let partial = lead
            .submit_partial_tally("round-1".to_owned(), 5, 3, vec!["ballot-1".to_owned()], 20)
            .unwrap();
        let _ = lead
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "partial-1".to_owned(),
                raw_content: partial.content,
                sender_pubkey: None,
            })
            .unwrap();

        let mut sub = create_engine("coord-2");
        let partial_2 = sub
            .submit_partial_tally("round-1".to_owned(), 5, 3, vec!["ballot-1".to_owned()], 21)
            .unwrap();
        let _ = lead
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "partial-2".to_owned(),
                raw_content: partial_2.content,
                sender_pubkey: None,
            })
            .unwrap();

        assert_eq!(
            lead.view().latest_round.unwrap().phase,
            crate::coordinator_state::CoordinatorRoundPhase::Tallied
        );

        let approval = lead
            .approve_result("round-1".to_owned(), "result-hash".to_owned(), 22)
            .unwrap();
        let _ = lead
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "approval-1".to_owned(),
                raw_content: approval.content,
                sender_pubkey: None,
            })
            .unwrap();
        let approval_2 = sub
            .approve_result("round-1".to_owned(), "result-hash".to_owned(), 23)
            .unwrap();
        let _ = lead
            .apply_transport_message(CoordinatorTransportEvent {
                event_id: "approval-2".to_owned(),
                raw_content: approval_2.content,
                sender_pubkey: None,
            })
            .unwrap();

        assert_eq!(
            lead.view().latest_round.unwrap().phase,
            crate::coordinator_state::CoordinatorRoundPhase::Published
        );
    }
}
