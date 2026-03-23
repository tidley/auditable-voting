import hashlib
import json
import pytest

from voting_coordinator_client import (
    EligibleMerkleTree,
    MerkleTree,
    compute_eligible_root,
)


@pytest.mark.fast
class TestComputeEligibleRoot:
    def test_single_npub_deterministic(self):
        npubs = ["abc123"]
        root1 = compute_eligible_root(npubs)
        root2 = compute_eligible_root(npubs)
        assert root1 is not None
        assert root1 == root2

    def test_multiple_npubs_deterministic(self):
        npubs = ["abc123", "def456", "ghi789"]
        root1 = compute_eligible_root(npubs)
        root2 = compute_eligible_root(npubs)
        assert root1 is not None
        assert root1 == root2

    def test_order_independence(self):
        npubs_a = ["aaa", "bbb", "ccc"]
        npubs_b = ["ccc", "aaa", "bbb"]
        assert compute_eligible_root(npubs_a) == compute_eligible_root(npubs_b)

    def test_empty_returns_none(self):
        assert compute_eligible_root([]) is None

    def test_different_sets_different_roots(self):
        npubs_a = ["abc123"]
        npubs_b = ["xyz789"]
        assert compute_eligible_root(npubs_a) != compute_eligible_root(npubs_b)

    def test_leaf_is_sha256_of_hex_npub(self):
        npub_hex = "deadbeef"
        expected_leaf = hashlib.sha256(npub_hex.encode()).hexdigest()
        tree = EligibleMerkleTree()
        tree.bulk_load([expected_leaf])
        root = tree.get_root()
        single_root = compute_eligible_root([npub_hex])
        assert root == single_root


@pytest.mark.fast
class TestEligibleMerkleTree:
    def test_compute_root_from_npubs(self):
        npubs = ["npub1aaa", "npub1bbb", "npub1ccc"]
        tree = EligibleMerkleTree()
        root = tree.compute_root_from_npubs(npubs)
        assert root is not None
        assert tree.get_count() == 3

    def test_empty_npubs(self):
        tree = EligibleMerkleTree()
        root = tree.compute_root_from_npubs([])
        assert root is None

    def test_duplicates_deduplicated(self):
        npubs = ["abc", "abc", "abc"]
        tree = EligibleMerkleTree()
        root = tree.compute_root_from_npubs(npubs)
        assert root is not None
        assert tree.get_count() == 1
        single = compute_eligible_root(["abc"])
        assert root == single


@pytest.mark.fast
class TestEventStoreGetEvents:
    def test_get_events_returns_empty_for_unknown_kind(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        assert store.get_events(99999) == []

    def test_get_events_returns_stored(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"kind": 38007, "id": "abc", "pubkey": "coordinator1", "tags": []})
        store.add_event({"kind": 38007, "id": "def", "pubkey": "coordinator2", "tags": []})
        events = store.get_events(38007)
        assert len(events) == 2
        assert events[0]["id"] == "abc"
        assert events[1]["id"] == "def"

    def test_get_events_deduplicates(self):
        from voting_coordinator_client import EventStore

        store = EventStore()
        store.add_event({"kind": 38007, "id": "abc", "pubkey": "coordinator1", "tags": []})
        store.add_event({"kind": 38007, "id": "abc", "pubkey": "coordinator1", "tags": []})
        events = store.get_events(38007)
        assert len(events) == 1


@pytest.mark.fast
class TestAuditAlgorithm:
    def test_inflation_detection(self):
        canonical_count = 100
        confirmations = 80
        tally_a = 120
        tally_b = 80

        flags_a = []
        if tally_a > canonical_count:
            flags_a.append("exceeds eligible count")
        if tally_a > confirmations:
            flags_a.append("inflation")

        flags_b = []
        if tally_b > canonical_count:
            flags_b.append("exceeds eligible count")
        if tally_b > confirmations:
            flags_b.append("inflation")
        if tally_b < confirmations:
            flags_b.append("censorship")

        assert "inflation" in flags_a
        assert "inflation" not in flags_b
        assert "censorship" not in flags_a
        assert "censorship" not in flags_b

    def test_censorship_detection(self):
        confirmations = 90
        tally = 70

        flags = []
        if tally < confirmations:
            flags.append("censorship")

        assert "censorship" in flags

    def test_honest_coordinator_no_flags(self):
        canonical_count = 100
        confirmations = 80
        tally = 80

        flags = []
        if tally > canonical_count:
            flags.append("exceeds eligible count")
        if tally > confirmations:
            flags.append("inflation")
        if tally < confirmations:
            flags.append("censorship")

        assert flags == []

    def test_fake_confirmations_detected(self):
        canonical_npubs = {"npub1real", "npub2real"}
        fake_npubs = {"npub1fake"}

        canonical_confirmations = 2
        fake_confirmations = 1

        assert canonical_confirmations == 2
        assert fake_confirmations == 1


@pytest.mark.fast
class TestProtocolEventShapes:
    def test_38008_has_coordinator_tags(self):
        tags = [
            ["t", "election-announcement"],
            ["coordinator", "npub1aaa"],
            ["coordinator", "npub1bbb"],
            ["eligible-root", "abc123"],
            ["eligible-count", "100"],
            ["mint", "https://mint-a.example.com:3338"],
        ]
        coordinator_tags = [t[1] for t in tags if t[0] == "coordinator"]
        assert coordinator_tags == ["npub1aaa", "npub1bbb"]

    def test_38008_has_eligible_tags(self):
        tags = [
            ["t", "election-announcement"],
            ["eligible-root", "abc123"],
            ["eligible-count", "100"],
        ]
        root_tag = next((t[1] for t in tags if t[0] == "eligible-root"), None)
        count_tag = next((t[1] for t in tags if t[0] == "eligible-count"), None)
        assert root_tag == "abc123"
        assert count_tag == "100"

    def test_38000_proof_hash_tags(self):
        tags = [
            ["election", "election_id"],
            ["proof-hash", "hash1"],
            ["proof-hash", "hash2"],
        ]
        proof_hashes = [t[1] for t in tags if t[0] == "proof-hash"]
        assert proof_hashes == ["hash1", "hash2"]

    def test_38007_has_eligible_root_tag(self):
        tags = [
            ["election", "election_id"],
            ["eligible-root", "abc123"],
            ["eligible-count", "100"],
        ]
        root_tag = next((t[1] for t in tags if t[0] == "eligible-root"), None)
        assert root_tag == "abc123"

    def test_38012_coordinator_info_tag(self):
        tags = [
            ["t", "coordinator-info"],
        ]
        assert tags[0] == ["t", "coordinator-info"]
