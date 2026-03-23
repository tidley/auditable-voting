import pytest
from aiohttp import web
from unittest.mock import patch


ELECTION_ID = "test-election-42"
PUBKEY_A = "aa" * 32
PUBKEY_B = "bb" * 32
PUBKEY_C = "cc" * 32


@pytest.fixture
def event_store():
    from voting_coordinator_client import EventStore
    return EventStore()


@pytest.fixture
def spent_tree():
    from voting_coordinator_client import SpentCommitmentTree
    return SpentCommitmentTree()


def _make_handler(event_store, spent_tree, eligible_set=None):
    from voting_coordinator_client import make_http_handler
    return make_http_handler(
        event_store=event_store,
        spent_tree=spent_tree,
        coordinator_npub="npub1test",
        mint_url="http://127.0.0.1:3338",
        mint_pubkey="02test",
        relays=["wss://relay.damus.io"],
        eligible_set=eligible_set or set(),
    )


def _make_app(event_store, spent_tree, eligible_set=None):
    handler = _make_handler(event_store, spent_tree, eligible_set)
    app = web.Application()
    for route in handler:
        app.router.add_route(route.method, route.path, route.handler)
    return app


@pytest.fixture
def app_with_election(event_store, spent_tree):
    event_store.add_event({
        "id": "abc123",
        "kind": 38008,
        "pubkey": "deadbeef",
        "election": ELECTION_ID,
        "election_id": ELECTION_ID,
        "content": '{"title": "Test", "questions": []}',
        "created_at": 1000000,
    })
    return _make_app(event_store, spent_tree, eligible_set={PUBKEY_A, PUBKEY_B})


class TestIssuanceStatusEndpoint:
    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    async def test_returns_npub_keys_not_hex(self, mock_hex2npub, aiohttp_client, event_store, spent_tree):
        event_store.add_event({
            "id": "abc123",
            "kind": 38008,
            "pubkey": "deadbeef",
            "election": ELECTION_ID,
            "election_id": ELECTION_ID,
            "content": '{"title": "Test", "questions": []}',
            "created_at": 1000000,
        })
        app = _make_app(event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)
        resp = await client.get("/issuance-status")
        data = await resp.json()
        voters = data["voters"]
        for key in voters:
            assert key.startswith("npub1"), f"Key '{key}' does not start with npub1"
            assert len(key) < 64, f"Key '{key}' looks like hex, not bech32"

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_issued_true_when_38011_exists(self, mock_norm, mock_hex2npub, aiohttp_client, event_store, spent_tree):
        event_store.add_event({
            "id": "abc123",
            "kind": 38008,
            "pubkey": "deadbeef",
            "election": ELECTION_ID,
            "election_id": ELECTION_ID,
            "content": '{"title": "Test", "questions": []}',
            "created_at": 1000000,
        })
        event_store.add_event({
            "id": "issue-001",
            "kind": 38011,
            "election": ELECTION_ID,
            "p": [PUBKEY_A],
            "created_at": 1000001,
        })
        app = _make_app(event_store, spent_tree, eligible_set={PUBKEY_A, PUBKEY_B})
        client = await aiohttp_client(app)
        resp = await client.get("/issuance-status")
        data = await resp.json()

        voter_a_key = f"npub1{PUBKEY_A[:8]}"
        voter_b_key = f"npub1{PUBKEY_B[:8]}"
        assert data["voters"][voter_a_key]["issued"] is True
        assert data["voters"][voter_b_key]["issued"] is False

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_issued_false_when_no_38011(self, mock_norm, mock_hex2npub, aiohttp_client, app_with_election):
        client = await aiohttp_client(app_with_election)
        resp = await client.get("/issuance-status")
        data = await resp.json()
        for voter_info in data["voters"].values():
            assert voter_info["issued"] is False

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    async def test_all_eligible_voters_in_response(self, mock_hex2npub, aiohttp_client, app_with_election):
        client = await aiohttp_client(app_with_election)
        resp = await client.get("/issuance-status")
        data = await resp.json()
        assert len(data["voters"]) == 2
        assert f"npub1{PUBKEY_A[:8]}" in data["voters"]
        assert f"npub1{PUBKEY_B[:8]}" in data["voters"]

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_filters_38011_by_election_id(self, mock_norm, mock_hex2npub, aiohttp_client, event_store, spent_tree):
        event_store.add_event({
            "id": "abc123",
            "kind": 38008,
            "pubkey": "deadbeef",
            "election": ELECTION_ID,
            "election_id": ELECTION_ID,
            "content": '{"title": "Test", "questions": []}',
            "created_at": 1000000,
        })
        event_store.add_event({
            "id": "issue-wrong",
            "kind": 38011,
            "election": "other-election-99",
            "p": [PUBKEY_A],
            "created_at": 1000001,
        })
        app = _make_app(event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)
        resp = await client.get("/issuance-status")
        data = await resp.json()

        voter_a_key = f"npub1{PUBKEY_A[:8]}"
        assert data["voters"][voter_a_key]["issued"] is False

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.hex_to_npub", side_effect=lambda h: f"npub1{h[:8]}")
    async def test_404_when_no_election(self, mock_hex2npub, aiohttp_client, event_store, spent_tree):
        app = _make_app(event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)
        resp = await client.get("/issuance-status")
        assert resp.status == 404
