import hashlib
import json

import pytest

from voting_coordinator_client import (
    MerkleTree,
    SpentCommitmentTree,
    VoteMerkleTree,
    IssuanceCommitmentTree,
    canonical_json,
    _compute_results,
)


class TestCanonicalJson:
    def test_canonical_json_deterministic(self):
        obj = {"b": 2, "a": 1}
        assert canonical_json(obj) == canonical_json(obj)

    def test_canonical_json_sorted_keys(self):
        obj = {"c": 3, "a": 1, "b": 2}
        result = canonical_json(obj)
        assert result.index('"a"') < result.index('"b"') < result.index('"c"')

    def test_canonical_json_no_whitespace(self):
        obj = {"a": 1}
        result = canonical_json(obj)
        assert " " not in result

    def test_canonical_json_nested(self):
        obj = {"z": [{"y": 1}], "a": {"x": 2}}
        result = canonical_json(obj)
        assert '"a":{"x":2}' in result
        assert '"z":[{"y":1}]' in result


def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode()).hexdigest()


class TestMerkleTree:
    def test_merkle_tree_single_leaf(self):
        tree = MerkleTree()
        leaf = "a"
        tree.insert(leaf)
        assert tree.get_root() == leaf
        assert tree.get_count() == 1

    def test_merkle_tree_two_leaves(self):
        tree = MerkleTree()
        a = "a"
        b = "b"
        tree.bulk_load([a, b])
        ab = _sha256(a + b)
        assert tree.get_root() == ab
        assert tree.get_count() == 2

    def test_merkle_tree_odd_count(self):
        tree = MerkleTree()
        a = "a"
        b = "b"
        c = "c"
        tree.bulk_load([a, b, c])
        ab = _sha256(a + b)
        cc = _sha256(c + c)
        expected = _sha256(ab + cc)
        assert tree.get_root() == expected
        assert tree.get_count() == 3

    def test_merkle_tree_get_proof_valid(self):
        tree = MerkleTree()
        a = "leaf_a"
        b = "leaf_b"
        c = "leaf_c"
        d = "leaf_d"
        tree.bulk_load([a, b, c, d])
        proof = tree.get_proof(a)
        assert proof is not None
        assert proof["leaf_hash"] == a
        assert len(proof["merkle_path"]) == 2
        assert proof["merkle_root"] == tree.get_root()

    def test_merkle_tree_get_proof_missing(self):
        tree = MerkleTree()
        tree.insert(_sha256("a"))
        assert tree.get_proof(_sha256("missing")) is None

    def test_merkle_tree_get_proof_verifies(self):
        tree = MerkleTree()
        leaves = [f"leaf{i}" for i in range(5)]
        tree.bulk_load(leaves)
        for leaf in leaves:
            proof = tree.get_proof(leaf)
            assert proof is not None
            current = proof["leaf_hash"]
            for step in proof["merkle_path"]:
                if step["position"] == "left":
                    current = _sha256(step["hash"] + current)
                else:
                    current = _sha256(current + step["hash"])
            assert current == tree.get_root()

    def test_merkle_tree_bulk_load(self):
        tree1 = MerkleTree()
        tree2 = MerkleTree()
        leaves = [f"x{i}" for i in range(10)]
        for l in leaves:
            tree1.insert(l)
        tree2.bulk_load(leaves)
        assert tree1.get_root() == tree2.get_root()

    def test_merkle_tree_deduplication(self):
        tree = MerkleTree()
        leaf = "dup"
        tree.insert(leaf)
        tree.insert(leaf)
        assert tree.get_count() == 1

    def test_merkle_tree_get_count(self):
        tree = MerkleTree()
        assert tree.get_count() == 0
        tree.insert("a")
        tree.insert("b")
        assert tree.get_count() == 2

    def test_merkle_tree_empty(self):
        tree = MerkleTree()
        assert tree.get_root() is None
        assert tree.get_count() == 0
        assert tree.get_proof("x") is None


class TestVoteMerkleTree:
    def _make_vote_event(self, event_id, pubkey="pk1", responses=None, ts=1000):
        return {
            "id": event_id,
            "pubkey": pubkey,
            "content": json.dumps({"responses": responses or [{"question_id": "q1", "value": "A"}]}),
            "created_at": ts,
        }

    def test_vote_merkle_tree_leaf_encoding(self):
        evt = self._make_vote_event("evt1", "pk1", [{"question_id": "q1", "value": "A"}], 1000)
        expected_raw = "evt1" + "pk1" + canonical_json([{"question_id": "q1", "value": "A"}]) + "1000"
        expected_leaf = _sha256(expected_raw)
        tree = VoteMerkleTree()
        tree.insert(evt)
        root = tree.get_root()
        assert root == expected_leaf

    def test_vote_merkle_tree_ordering(self):
        tree = VoteMerkleTree()
        tree.insert(self._make_vote_event("zzz"))
        tree.insert(self._make_vote_event("aaa"))
        tree.insert(self._make_vote_event("mmm"))
        assert tree.get_count() == 3

    def test_vote_merkle_tree_get_proof(self):
        tree = VoteMerkleTree()
        evts = [self._make_vote_event(f"evt{i}", f"pk{i}") for i in range(3)]
        for e in evts:
            tree.insert(e)
        proof = tree.get_proof("evt1", evts)
        assert proof is not None
        assert proof["nostr_event_id"] == "evt1"
        assert proof["merkle_root"] == tree.get_root()

    def test_vote_merkle_tree_get_proof_missing(self):
        tree = VoteMerkleTree()
        assert tree.get_proof("missing", []) is None


class TestIssuanceCommitmentTree:
    def test_issuance_merkle_tree_leaf_encoding(self):
        npub = "aa" * 32
        expected_leaf = _sha256(npub)
        tree = IssuanceCommitmentTree()
        tree.insert(npub)
        root = tree.get_root()
        assert root == expected_leaf

    def test_issuance_merkle_tree_bulk(self):
        tree = IssuanceCommitmentTree()
        npubs = ["a" * 64, "b" * 64, "c" * 64]
        tree.bulk_load(npubs)
        assert tree.get_count() == 3
        assert tree.get_root() is not None

    def test_issuance_merkle_tree_get_proof(self):
        tree = IssuanceCommitmentTree()
        npubs = ["a" * 64, "b" * 64]
        tree.bulk_load(npubs)
        proof = tree.get_proof("a" * 64)
        assert proof is not None
        assert proof["npub_hex"] == "a" * 64
        assert proof["merkle_root"] == tree.get_root()


class TestSpentCommitmentTreeRefactored:
    def test_spent_commitment_tree_root(self):
        tree = SpentCommitmentTree()
        tree.insert(_sha256("secret1"))
        tree.insert(_sha256("secret2"))
        assert tree.get_count() == 2
        assert tree.get_root() is not None

    def test_spent_commitment_tree_get_proof(self):
        tree = SpentCommitmentTree()
        secrets = [_sha256(f"secret{i}") for i in range(3)]
        tree.bulk_load(secrets)
        proof = tree.get_proof(secrets[0])
        assert proof is not None
        assert proof["leaf_hash"] == secrets[0]
        assert proof["merkle_root"] == tree.get_root()


class TestComputeResults:
    def test_compute_results_choice(self):
        votes = [
            {"content": json.dumps({"responses": [{"question_id": "q1", "value": "Alice"}]})},
            {"content": json.dumps({"responses": [{"question_id": "q1", "value": "Alice"}]})},
            {"content": json.dumps({"responses": [{"question_id": "q1", "value": "Bob"}]})},
        ]
        results = _compute_results(votes)
        assert results["q1"]["Alice"] == 2
        assert results["q1"]["Bob"] == 1

    def test_compute_results_numeric(self):
        votes = [
            {"content": json.dumps({"responses": [{"question_id": "q2", "value": 5}]})},
            {"content": json.dumps({"responses": [{"question_id": "q2", "value": 9}]})},
            {"content": json.dumps({"responses": [{"question_id": "q2", "value": 7}]})},
        ]
        results = _compute_results(votes)
        assert results["q2"]["mean"] == 7.0
        assert results["q2"]["median"] == 7
        assert results["q2"]["count"] == 3

    def test_compute_results_text_question(self):
        election_config = {
            "questions": [
                {"id": "q1", "type": "text"},
                {"id": "q2", "type": "choice"},
            ]
        }
        votes = [
            {"content": json.dumps({"responses": [{"question_id": "q1", "value": "Great"}, {"question_id": "q2", "value": "A"}]})},
            {"content": json.dumps({"responses": [{"question_id": "q1", "value": "Bad"}, {"question_id": "q2", "value": "B"}]})},
        ]
        results = _compute_results(votes, election_config)
        assert results["q1"] == ["Great", "Bad"]
        assert results["q2"]["A"] == 1
        assert results["q2"]["B"] == 1

    def test_compute_results_mixed_questions(self):
        election_config = {
            "questions": [
                {"id": "q1", "type": "choice"},
                {"id": "q2", "type": "scale"},
                {"id": "q3", "type": "text"},
            ]
        }
        votes = [
            {"content": json.dumps({"responses": [
                {"question_id": "q1", "value": "X"},
                {"question_id": "q2", "value": 5},
                {"question_id": "q3", "value": "hello"},
            ]})},
        ]
        results = _compute_results(votes, election_config)
        assert results["q1"]["X"] == 1
        assert results["q2"]["mean"] == 5.0
        assert results["q3"] == ["hello"]

    def test_compute_results_empty_votes(self):
        results = _compute_results([])
        assert results == {}
