import json

import pytest
from aiohttp import web


@pytest.fixture
def event_store():
    from voting_coordinator_client import EventStore
    return EventStore()


@pytest.fixture
def spent_tree():
    from voting_coordinator_client import SpentCommitmentTree
    return SpentCommitmentTree()


def _make_handler(event_store, spent_tree, mint_url="http://127.0.0.1:3338"):
    from voting_coordinator_client import make_http_handler
    return make_http_handler(
        event_store=event_store,
        spent_tree=spent_tree,
        coordinator_npub="npub1test",
        mint_url=mint_url,
        mint_pubkey="02test",
        relays=["wss://relay.damus.io"],
    )


def _add_election(event_store, election_id="test-election-42"):
    event_store.add_event({
        "id": "elec-001",
        "kind": 38008,
        "pubkey": "deadbeef",
        "election": election_id,
        "election_id": election_id,
        "content": json.dumps({
            "title": "Test Election",
            "questions": [
                {"id": "q1", "type": "choice", "prompt": "Pick one", "options": ["A", "B"], "select": "single"},
                {"id": "q2", "type": "scale", "prompt": "Rate", "min": 1, "max": 10, "step": 1},
            ],
            "end_time": 9999999999,
        }),
        "created_at": 1000000,
    })


def _add_vote(event_store, vote_id, election_id, responses, pubkey="voter1"):
    event_store.add_event({
        "id": vote_id,
        "kind": 38000,
        "pubkey": pubkey,
        "election": election_id,
        "content": json.dumps({"responses": responses}),
        "created_at": 2000000,
    })


def _add_acceptance(event_store, accepted_vote_id, election_id):
    event_store.add_event({
        "id": f"accept-{accepted_vote_id}",
        "kind": 38002,
        "pubkey": "deadbeef",
        "election": election_id,
        "e": [accepted_vote_id],
        "created_at": 2000001,
    })


def _make_app(event_store, spent_tree):
    handler = _make_handler(event_store, spent_tree)
    app = web.Application()
    for route in handler:
        app.router.add_route(route.method, route.path, route.handler)
    return app


@pytest.mark.fast
class TestTallyOnlyCountsVerifiedVotes:

    @pytest.mark.asyncio
    async def test_tally_zero_when_no_accepted_votes(self, aiohttp_client, event_store, spent_tree):
        _add_election(event_store)
        _add_vote(event_store, "vote-1", "test-election-42", [{"question_id": "q1", "value": "A"}])
        _add_vote(event_store, "vote-2", "test-election-42", [{"question_id": "q1", "value": "B"}])

        app = _make_app(event_store, spent_tree)
        client = await aiohttp_client(app)
        resp = await client.get("/tally")
        data = await resp.json()

        assert data["total_published_votes"] == 2
        assert data["total_accepted_votes"] == 0
        assert data["results"] == {}

    @pytest.mark.asyncio
    async def test_tally_only_counts_verified_votes(self, aiohttp_client, event_store, spent_tree):
        _add_election(event_store)
        _add_vote(event_store, "vote-1", "test-election-42", [{"question_id": "q1", "value": "A"}])
        _add_vote(event_store, "vote-2", "test-election-42", [{"question_id": "q1", "value": "B"}])
        _add_vote(event_store, "vote-3", "test-election-42", [{"question_id": "q1", "value": "A"}])
        _add_acceptance(event_store, "vote-1", "test-election-42")

        app = _make_app(event_store, spent_tree)
        client = await aiohttp_client(app)
        resp = await client.get("/tally")
        data = await resp.json()

        assert data["total_published_votes"] == 3
        assert data["total_accepted_votes"] == 1
        assert data["results"]["q1"] == {"A": 1}

    @pytest.mark.asyncio
    async def test_tally_counts_multiple_accepted_votes(self, aiohttp_client, event_store, spent_tree):
        _add_election(event_store)
        _add_vote(event_store, "vote-1", "test-election-42", [{"question_id": "q1", "value": "A"}])
        _add_vote(event_store, "vote-2", "test-election-42", [{"question_id": "q1", "value": "B"}])
        _add_vote(event_store, "vote-3", "test-election-42", [{"question_id": "q1", "value": "A"}])
        _add_acceptance(event_store, "vote-1", "test-election-42")
        _add_acceptance(event_store, "vote-2", "test-election-42")
        _add_acceptance(event_store, "vote-3", "test-election-42")

        app = _make_app(event_store, spent_tree)
        client = await aiohttp_client(app)
        resp = await client.get("/tally")
        data = await resp.json()

        assert data["total_published_votes"] == 3
        assert data["total_accepted_votes"] == 3
        assert data["results"]["q1"] == {"A": 2, "B": 1}

    @pytest.mark.asyncio
    async def test_tally_isolates_elections(self, aiohttp_client, event_store, spent_tree):
        _add_election(event_store, election_id="election-alpha")
        _add_vote(event_store, "vote-a1", "election-alpha", [{"question_id": "q1", "value": "A"}])
        _add_vote(event_store, "vote-b1", "election-beta", [{"question_id": "q1", "value": "Z"}])
        _add_acceptance(event_store, "vote-a1", "election-alpha")
        _add_acceptance(event_store, "vote-b1", "election-beta")

        app = _make_app(event_store, spent_tree)
        client = await aiohttp_client(app)
        resp = await client.get("/tally")
        data = await resp.json()

        assert data["election_id"] == "election-alpha"
        assert data["total_published_votes"] == 1
        assert data["total_accepted_votes"] == 1
        assert data["results"]["q1"] == {"A": 1}
        assert "Z" not in str(data["results"])

    @pytest.mark.asyncio
    async def test_tally_no_trust_field(self, aiohttp_client, event_store, spent_tree):
        _add_election(event_store)

        app = _make_app(event_store, spent_tree)
        client = await aiohttp_client(app)
        resp = await client.get("/tally")
        data = await resp.json()

        assert "_trust" not in data
