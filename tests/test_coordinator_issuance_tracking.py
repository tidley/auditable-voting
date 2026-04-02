import pytest
from aiohttp import web
from unittest.mock import patch

ELECTION_ID = "test-election-42"
PUBKEY_A = "aa" * 32
PUBKEY_B = "bb" * 32


@pytest.fixture
def event_store():
    from voting_coordinator_client import EventStore
    return EventStore()


@pytest.fixture
def spent_tree():
    from voting_coordinator_client import SpentCommitmentTree
    return SpentCommitmentTree()


def _make_app(event_store, spent_tree, eligible_set=None):
    from voting_coordinator_client import make_http_handler
    handler = make_http_handler(
        event_store=event_store,
        spent_tree=spent_tree,
        coordinator_npub="npub1test",
        mint_url="http://127.0.0.1:3338",
        mint_pubkey="02test",
        relays=["wss://relay.damus.io"],
        eligible_set=eligible_set or set(),
    )
    app = web.Application()
    for route in handler:
        app.router.add_route(route.method, route.path, route.handler)
    return app


@pytest.fixture
def seeded_event_store(event_store):
    event_store.add_event({
        "id": "abc123",
        "kind": 38008,
        "pubkey": "deadbeef",
        "election": ELECTION_ID,
        "election_id": ELECTION_ID,
        "content": '{"title": "Test", "questions": []}',
        "created_at": 1000000,
    })
    return event_store


class TestIssuanceTrackingEndpoints:
    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_start_rejects_ineligible_voter(self, _mock_norm, aiohttp_client, seeded_event_store, spent_tree):
        app = _make_app(seeded_event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)

        resp = await client.post("/issuance/start", json={
            "npub": PUBKEY_B,
            "quote_id": "q-1",
            "election_id": ELECTION_ID,
        })

        assert resp.status == 403
        data = await resp.json()
        assert data["status"] == "ineligible"

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_start_returns_already_issued(self, _mock_norm, aiohttp_client, seeded_event_store, spent_tree):
        seeded_event_store.add_event({
            "id": "issued-1",
            "kind": 38011,
            "election": ELECTION_ID,
            "p": [PUBKEY_A],
            "created_at": 1000001,
        })
        app = _make_app(seeded_event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)

        resp = await client.post("/issuance/start", json={
            "npub": PUBKEY_A,
            "quote_id": "q-1",
            "election_id": ELECTION_ID,
        })

        assert resp.status == 200
        data = await resp.json()
        assert data["status"] == "already_issued"

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_wait_endpoint_reports_timeout_when_still_pending(self, _mock_norm, aiohttp_client, seeded_event_store, spent_tree):
        app = _make_app(seeded_event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)

        start = await client.post("/issuance/start", json={
            "npub": PUBKEY_A,
            "quote_id": "q-1",
            "election_id": ELECTION_ID,
        })
        request_id = (await start.json())["request_id"]

        resp = await client.get(f"/issuance/{request_id}?timeout_ms=1")
        data = await resp.json()
        assert data["status"] == "timeout"
        assert data["issued"] is False

    @pytest.mark.fast
    @pytest.mark.asyncio
    @patch("voting_coordinator_client.normalize_npub", side_effect=lambda x: x.lower().strip())
    async def test_wait_endpoint_reports_issued(self, _mock_norm, aiohttp_client, seeded_event_store, spent_tree):
        app = _make_app(seeded_event_store, spent_tree, eligible_set={PUBKEY_A})
        client = await aiohttp_client(app)

        start = await client.post("/issuance/start", json={
            "npub": PUBKEY_A,
            "quote_id": "q-1",
            "election_id": ELECTION_ID,
        })
        request_id = (await start.json())["request_id"]

        seeded_event_store.add_event({
            "id": "issued-2",
            "kind": 38011,
            "election": ELECTION_ID,
            "p": [PUBKEY_A],
            "created_at": 1000002,
        })

        resp = await client.get(f"/issuance/{request_id}?timeout_ms=50")
        data = await resp.json()
        assert data["status"] == "issued"
        assert data["issued"] is True
