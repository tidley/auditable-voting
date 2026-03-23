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


def _make_handler(event_store, spent_tree, mint_url="http://127.0.0.1:3338", public_mint_url=None):
    from voting_coordinator_client import make_http_handler
    return make_http_handler(
        event_store=event_store,
        spent_tree=spent_tree,
        coordinator_npub="npub1test",
        mint_url=mint_url,
        mint_pubkey="02test",
        relays=["wss://relay.damus.io"],
        public_mint_url=public_mint_url,
    )


@pytest.fixture
def app(event_store, spent_tree):
    handler = _make_handler(event_store, spent_tree)
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
        "election": "test-election-42",
        "election_id": "test-election-42",
        "content": '{"title": "Test", "questions": []}',
        "created_at": 1000000,
    })
    handler = _make_handler(event_store, spent_tree)
    app = web.Application()
    for route in handler:
        app.router.add_route(route.method, route.path, route.handler)
    return app


class TestInfoEndpoint:
    @pytest.mark.asyncio
    async def test_info_returns_election_id(self, aiohttp_client, app_with_election):
        client = await aiohttp_client(app_with_election)
        resp = await client.get("/info")
        data = await resp.json()
        assert data["electionId"] == "test-election-42"

    @pytest.mark.asyncio
    async def test_info_returns_none_when_no_election(self, aiohttp_client, app):
        client = await aiohttp_client(app)
        resp = await client.get("/info")
        data = await resp.json()
        assert data["electionId"] is None

    @pytest.mark.asyncio
    async def test_info_returns_public_mint_url(self, aiohttp_client, event_store, spent_tree):
        handler = _make_handler(event_store, spent_tree, public_mint_url="http://23.182.128.64:3338")
        app = web.Application()
        for route in handler:
            app.router.add_route(route.method, route.path, route.handler)
        client = await aiohttp_client(app)
        resp = await client.get("/info")
        data = await resp.json()
        assert data["mintUrl"] == "http://23.182.128.64:3338"

    @pytest.mark.asyncio
    async def test_info_falls_back_to_mint_url(self, aiohttp_client, event_store, spent_tree):
        handler = _make_handler(event_store, spent_tree, public_mint_url=None)
        app = web.Application()
        for route in handler:
            app.router.add_route(route.method, route.path, route.handler)
        client = await aiohttp_client(app)
        resp = await client.get("/info")
        data = await resp.json()
        assert data["mintUrl"] == "http://127.0.0.1:3338"
