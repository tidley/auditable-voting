import json
from pathlib import Path
from unittest.mock import patch

import pytest


class TestLoadJsonSet:
    def test_load_json_set_list(self, tmp_path):
        from voting_coordinator_client import load_json_set

        path = tmp_path / "eligible.json"
        path.write_text(json.dumps(["a" * 64, "b" * 64]))

        result = load_json_set(path)
        assert result == {"a" * 64, "b" * 64}

    def test_load_json_set_dict(self, tmp_path):
        from voting_coordinator_client import load_json_set

        path = tmp_path / "eligible.json"
        path.write_text(json.dumps({"npubs": ["a" * 64, "c" * 64]}))

        result = load_json_set(path)
        assert result == {"a" * 64, "c" * 64}

    def test_load_json_set_missing_file(self):
        from voting_coordinator_client import load_json_set

        result = load_json_set(Path("/nonexistent/path.json"))
        assert result == set()

    def test_load_json_set_bad_format(self, tmp_path):
        from voting_coordinator_client import load_json_set

        path = tmp_path / "bad.json"
        path.write_text(json.dumps({"unexpected_key": []}))

        with pytest.raises(ValueError, match="Unexpected format"):
            load_json_set(path)


class TestNormalizeNpub:
    def test_normalize_npub_hex(self):
        from voting_coordinator_client import normalize_npub

        result = normalize_npub("  ABCDEF1234567890  ")
        assert result == "abcdef1234567890"

    def test_normalize_npub_bech32(self):
        from voting_coordinator_client import normalize_npub

        mock_hex = "aa" * 32
        with patch("voting_coordinator_client.PublicKey") as mock_pk_cls:
            mock_pk_instance = mock_pk_cls.parse.return_value
            mock_pk_instance.to_hex.return_value = mock_hex
            result = normalize_npub("npub1fake")
            assert result == mock_hex
            mock_pk_cls.parse.assert_called_once_with("npub1fake")


class TestEventStore:
    def test_add_event_stores_by_kind(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        event_a = {"id": "aaa", "kind": 38011, "election": "e1", "p": ["aa" * 32]}
        event_b = {"id": "bbb", "kind": 38000, "pubkey": "ab" * 32}

        store.add_event(event_a)
        store.add_event(event_b)

        assert len(store.get_events(38011)) == 1
        assert len(store.get_events(38000)) == 1
        assert store.get_events(38011)[0]["id"] == "aaa"

    def test_add_event_ignores_unknown_kind(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "aaa", "kind": 38010, "pubkey": "ab" * 32})

        assert len(store.get_events(38010)) == 0

    def test_add_event_deduplicates_by_id(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "aaa", "kind": 38011, "election": "e1", "p": ["aa" * 32]})
        store.add_event({"id": "aaa", "kind": 38011, "election": "e1", "p": ["aa" * 32]})

        assert len(store.get_events(38011)) == 1

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_get_issued_pubkeys_filters_by_election(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "e1", "kind": 38011, "election": "election-1", "p": ["aa" * 32]})
        store.add_event({"id": "e2", "kind": 38011, "election": "election-2", "p": ["bb" * 32]})

        issued_e1 = store.get_issued_pubkeys("election-1")
        issued_e2 = store.get_issued_pubkeys("election-2")

        assert len(issued_e1) == 1
        assert len(issued_e2) == 1
        assert issued_e1 != issued_e2

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_get_issued_pubkeys_deduplicates(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "e1", "kind": 38011, "election": "e1", "p": ["aa" * 32]})
        store.add_event({"id": "e1", "kind": 38011, "election": "e1", "p": ["aa" * 32]})
        store.add_event({"id": "e2", "kind": 38011, "election": "e1", "p": ["aa" * 32]})

        issued = store.get_issued_pubkeys("e1")
        assert len(issued) == 1

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_event_store_filters_untagged_38011(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "untagged1", "kind": 38011, "p": ["aa" * 32]})
        store.add_event({"id": "untagged2", "kind": 38011, "p": ["bb" * 32]})

        issued = store.get_issued_pubkeys("election-active")
        assert len(issued) == 0

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_event_store_filters_wrong_election_38011(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "old1", "kind": 38011, "election": "sec06-feedback-old", "p": ["aa" * 32]})
        store.add_event({"id": "old2", "kind": 38011, "election": "sec06-feedback-older", "p": ["bb" * 32]})

        issued = store.get_issued_pubkeys("sec06-feedback-new")
        assert len(issued) == 0

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_event_store_accepts_matching_election_38011(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "untagged", "kind": 38011, "p": ["aa" * 32]})
        store.add_event({"id": "wrong", "kind": 38011, "election": "old", "p": ["bb" * 32]})
        store.add_event({"id": "match1", "kind": 38011, "election": "active", "p": ["cc" * 32]})
        store.add_event({"id": "match2", "kind": 38011, "election": "active", "p": ["dd" * 32]})

        issued = store.get_issued_pubkeys("active")
        assert len(issued) == 2
        assert "cc" * 32 in issued
        assert "dd" * 32 in issued

    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    def test_event_store_issued_none_election_id_returns_untagged(self, mock_norm):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"id": "untagged1", "kind": 38011, "p": ["aa" * 32]})
        store.add_event({"id": "tagged1", "kind": 38011, "election": "any", "p": ["bb" * 32]})

        issued = store.get_issued_pubkeys(None)
        assert len(issued) == 1
        assert "aa" * 32 in issued
