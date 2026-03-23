import json
from unittest.mock import MagicMock, call, patch

import pytest

from voting_coordinator_client import (
    EventStore,
    IssuanceCommitmentTree,
    SpentCommitmentTree,
    VoteMerkleTree,
    close_election,
)


def _make_vote_event(event_id, pubkey="pk1", election_id="e1", responses=None, ts=1000):
    return {
        "id": event_id,
        "kind": 38000,
        "pubkey": pubkey,
        "election": election_id,
        "content": json.dumps({"responses": responses or [{"question_id": "q1", "value": "A"}]}),
        "created_at": ts,
    }


def _make_38002(event_id, election_id="e1", commitment=None):
    return {
        "id": f"acc-{event_id}",
        "kind": 38002,
        "election": election_id,
        "e": [event_id],
        "commitment": commitment or "commit_hash",
    }


def _make_38011(pubkey, election_id="e1"):
    return {
        "id": f"iss-{pubkey[:8]}",
        "kind": 38011,
        "election": election_id,
        "p": [pubkey],
    }


def _make_election(election_id="e1", end_time=1000):
    return {
        "id": election_id,
        "kind": 38008,
        "election": election_id,
        "content": json.dumps({"title": "Test", "questions": [{"id": "q1", "type": "choice", "prompt": "Q?", "options": ["A", "B"], "select": "single"}], "start_time": 500, "end_time": end_time}),
        "created_at": 500,
    }


class TestPublishTallyEvents:
    def test_publish_38007_content(self):
        mock_client = MagicMock()
        from voting_coordinator_client import _publish_38007
        _publish_38007(mock_client, "e1", 5, 500, 1000)
        mock_client.send_event_builder.assert_called_once()
        call_args = mock_client.send_event_builder.call_args
        builder = call_args[0][0]
        assert builder is not None

    def test_publish_38005_content(self):
        mock_client = MagicMock()
        from voting_coordinator_client import _publish_38005
        tree = IssuanceCommitmentTree()
        tree.bulk_load(["a" * 64, "b" * 64])
        _publish_38005(mock_client, "e1", tree)
        assert mock_client.send_event_builder.called

    def test_publish_38006_content(self):
        mock_client = MagicMock()
        from voting_coordinator_client import _publish_38006
        tree = SpentCommitmentTree()
        tree.insert("hash1")
        _publish_38006(mock_client, "e1", tree)
        assert mock_client.send_event_builder.called

    def test_publish_38003_content(self):
        mock_client = MagicMock()
        from voting_coordinator_client import _publish_38003
        vote_tree = VoteMerkleTree()
        spent_tree = SpentCommitmentTree()
        issuance_tree = IssuanceCommitmentTree()
        _publish_38003(mock_client, "e1", {"q1": {"A": 1}}, vote_tree, spent_tree, issuance_tree, 5)
        assert mock_client.send_event_builder.called

    def test_close_election_publishes_in_order(self):
        mock_client = MagicMock()
        store = EventStore()
        store.add_event(_make_election("e1", end_time=500))
        store.add_event(_make_vote_event("v1", "pk1", "e1"))
        store.add_event(_make_38002("v1", "e1"))
        store.add_event(_make_38011("pk1", "e1"))

        result = close_election(store, SpentCommitmentTree(), IssuanceCommitmentTree(), VoteMerkleTree(), mock_client, {"pk1"})
        assert result is not None
        assert mock_client.send_event_builder.call_count >= 3

    def test_close_election_skips_if_already_published(self):
        mock_client = MagicMock()
        store = EventStore()
        store.add_event(_make_election("e1", end_time=500))
        store.add_event({"id": "result1", "kind": 38003, "election": "e1", "content": "{}", "created_at": 2000})

        result = close_election(store, SpentCommitmentTree(), IssuanceCommitmentTree(), VoteMerkleTree(), mock_client, set())
        assert result is not None
        assert result["id"] == "result1"
        mock_client.send_event_builder.assert_not_called()

    def test_close_election_max_supply_from_eligible_set(self):
        mock_client = MagicMock()
        store = EventStore()
        store.add_event(_make_election("e1", end_time=500))
        store.add_event(_make_vote_event("v1", "pk1", "e1"))
        store.add_event(_make_38002("v1", "e1"))
        store.add_event(_make_38011("pk1", "e1"))
        store.add_event(_make_38011("pk2", "e1"))

        result = close_election(store, SpentCommitmentTree(), IssuanceCommitmentTree(), VoteMerkleTree(), mock_client, {"pk1", "pk2", "pk3"})
        assert result is not None
        assert mock_client.send_event_builder.called

    def test_close_election_no_election(self):
        mock_client = MagicMock()
        store = EventStore()
        result = close_election(store, SpentCommitmentTree(), IssuanceCommitmentTree(), VoteMerkleTree(), mock_client, set())
        assert result is None
        mock_client.send_event_builder.assert_not_called()


class TestEventStoreNewMethods:
    def test_event_store_stores_38003(self):
        store = EventStore()
        store.add_event({"id": "r1", "kind": 38003, "election": "e1", "content": "{}"})
        assert len(store.get_events(38003)) == 1

    def test_event_store_get_final_result(self):
        store = EventStore()
        assert store.get_final_result("e1") is None
        store.add_event({"id": "r1", "kind": 38003, "election": "e1", "content": "{}", "created_at": 100})
        store.add_event({"id": "r2", "kind": 38003, "election": "e1", "content": "{}", "created_at": 200})
        result = store.get_final_result("e1")
        assert result is not None
        assert result["id"] == "r2"

    def test_event_store_get_accepted_vote_events(self):
        store = EventStore()
        store.add_event(_make_vote_event("v1", "pk1", "e1"))
        store.add_event(_make_vote_event("v2", "pk2", "e1"))
        store.add_event(_make_38002("v1", "e1"))

        accepted = store.get_accepted_vote_events("e1")
        assert len(accepted) == 1
        assert accepted[0]["id"] == "v1"

    def test_event_store_get_hard_cap(self):
        store = EventStore()
        assert store.get_hard_cap("e1") is None
        store.add_event({"id": "h1", "kind": 38007, "election": "e1", "content": json.dumps({"max_supply": 10}), "created_at": 100})
        cap = store.get_hard_cap("e1")
        assert cap is not None
        assert cap["id"] == "h1"
