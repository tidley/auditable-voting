#!/usr/bin/env python3
import argparse
import asyncio
import hashlib
import importlib.util
import json
import logging
import os
import sys
import time
import datetime
import uuid
from datetime import timedelta
from pathlib import Path

import grpc
import requests
from aiohttp import web
import aiohttp_cors
from nostr_sdk import (
    Keys,
    Kind,
    Filter,
    Client,
    NostrSigner,
    HandleNotification,
    RelayUrl,
    EventBuilder,
    Tag,
    PublicKey,
    EventId,
    Timestamp,
)

ROOT_DIR = Path(__file__).resolve().parents[1]
PROTO_PATH = Path(os.environ.get("COORDINATOR_PROTO_PATH", ROOT_DIR / "tools" / "mintctl" / "proto" / "cdk-mint-rpc.proto"))
GEN_DIR = Path(os.environ.get("COORDINATOR_GEN_DIR", ROOT_DIR / "tools" / "mintctl" / "_gen"))

DEFAULT_RELAYS = [
    "ws://localhost:10547",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
]

log = logging.getLogger("coordinator")


def load_grpc_stubs():
    if (GEN_DIR / "cdk_mint_rpc_pb2.py").exists() and (
        GEN_DIR / "cdk_mint_rpc_pb2_grpc.py"
    ).exists():
        pass
    else:
        try:
            from grpc_tools import protoc
        except ImportError as exc:
            raise RuntimeError(
                "grpcio-tools is required to generate gRPC stubs. "
                "Install: pip install -r tools/mintctl/requirements.txt"
            ) from exc

        GEN_DIR.mkdir(parents=True, exist_ok=True)
        args = [
            "grpc_tools.protoc",
            f"-I{PROTO_PATH.parent}",
            f"--python_out={GEN_DIR}",
            f"--grpc_python_out={GEN_DIR}",
            str(PROTO_PATH),
        ]
        if protoc.main(args) != 0:
            raise RuntimeError("Failed to generate gRPC stubs")

    pb2_spec = importlib.util.spec_from_file_location(
        "cdk_mint_rpc_pb2", GEN_DIR / "cdk_mint_rpc_pb2.py"
    )
    pb2_grpc_spec = importlib.util.spec_from_file_location(
        "cdk_mint_rpc_pb2_grpc", GEN_DIR / "cdk_mint_rpc_pb2_grpc.py"
    )

    if not pb2_spec or not pb2_grpc_spec:
        raise RuntimeError("Failed to load gRPC stubs")

    pb2 = importlib.util.module_from_spec(pb2_spec)
    pb2_grpc = importlib.util.module_from_spec(pb2_grpc_spec)

    pb2_spec.loader.exec_module(pb2)
    sys.modules["cdk_mint_rpc_pb2"] = pb2
    pb2_grpc_spec.loader.exec_module(pb2_grpc)

    return pb2, pb2_grpc


CDK_MINT_RPC_PROTOCOL_VERSION = "1.0.0"


def load_json_set(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return {normalize_npub(item) for item in data}
    if isinstance(data, dict) and "npubs" in data:
        return {normalize_npub(item) for item in data["npubs"]}
    raise ValueError(f"Unexpected format in {path}")


def normalize_npub(raw: str) -> str:
    if raw.startswith("npub1"):
        return PublicKey.parse(raw).to_hex()
    return raw.lower().strip()


def hex_to_npub(hex_pubkey: str) -> str:
    return PublicKey.parse(hex_pubkey).to_bech32()


def derive_election_mnemonic(coordinator_nsec: str, election_id: str) -> str:
    from mnemonic import Mnemonic
    mnemo = Mnemonic("english")
    entropy = hashlib.sha256(f"{coordinator_nsec}:{election_id}".encode()).digest()[:16]
    return mnemo.to_mnemonic(entropy)


def approve_quote_via_grpc(grpc_endpoint: str, quote_id: str) -> None:
    pb2, pb2_grpc = load_grpc_stubs()
    channel = grpc.insecure_channel(grpc_endpoint)
    client = pb2_grpc.CdkMintStub(channel)
    client.UpdateNut04Quote(
        pb2.UpdateNut04QuoteRequest(quote_id=quote_id, state="PAID"),
        metadata=[("x-cdk-protocol-version", CDK_MINT_RPC_PROTOCOL_VERSION)],
    )


def verify_quote_on_mint(mint_url: str, quote_id: str) -> dict | None:
    try:
        resp = requests.get(f"{mint_url}/v1/mint/quote/bolt11/{quote_id}", timeout=10)
        if resp.status_code == 200:
            return resp.json()
        log.warning("Quote lookup returned HTTP %d for quote %s", resp.status_code, quote_id)
        return None
    except requests.RequestException as exc:
        log.warning("Failed to verify quote %s on mint: %s", quote_id, exc)
        return None


def extract_tag_value(tags, tag_name: str) -> str | None:
    for i in range(tags.len()):
        tag = tags.get(i)
        vec = tag.as_vec()
        if len(vec) >= 2 and vec[0] == tag_name:
            return vec[1]
    return None


def extract_tag_values(tags, tag_name: str) -> list[str]:
    values = []
    for i in range(tags.len()):
        tag = tags.get(i)
        vec = tag.as_vec()
        if len(vec) >= 2 and vec[0] == tag_name:
            values.append(vec[1])
    return values


def extract_event_data(event) -> dict:
    tags = event.tags()
    return {
        "id": event.id().to_hex(),
        "pubkey": event.author().to_hex(),
        "content": event.content(),
        "created_at": event.created_at().as_secs(),
        "kind": event.kind().as_u16(),
        "quote": extract_tag_value(tags, "quote"),
        "amount": extract_tag_value(tags, "amount"),
        "mint": extract_tag_value(tags, "mint"),
        "election": extract_tag_value(tags, "election"),
        "p": extract_tag_values(tags, "p"),
        "e": extract_tag_values(tags, "e"),
        "commitment": extract_tag_value(tags, "commitment"),
    }


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


class MerkleTree:
    def __init__(self):
        self._leaves: list[str] = []
        self._layers: list[list[str]] = []

    def insert(self, leaf_hash: str) -> None:
        if leaf_hash not in self._leaves:
            self._leaves.append(leaf_hash)
            self._leaves.sort()
            self._rebuild_layers()

    def bulk_load(self, leaf_hashes: list[str]) -> None:
        self._leaves = sorted(set(leaf_hashes))
        self._rebuild_layers()

    def get_root(self) -> str | None:
        if not self._layers:
            return None
        return self._layers[-1][0]

    def get_count(self) -> int:
        return len(self._leaves)

    def get_proof(self, leaf_hash: str) -> dict | None:
        if not self._layers or leaf_hash not in self._leaves:
            return None
        idx = self._leaves.index(leaf_hash)
        path: list[dict] = []
        for layer in self._layers[:-1]:
            if idx % 2 == 1:
                path.append({"position": "left", "hash": layer[idx - 1]})
            elif idx < len(layer) - 1:
                path.append({"position": "right", "hash": layer[idx + 1]})
            else:
                path.append({"position": "right", "hash": layer[idx]})
            idx = idx // 2
        return {"leaf_hash": leaf_hash, "merkle_path": path, "merkle_root": self.get_root()}

    def _rebuild_layers(self) -> None:
        if not self._leaves:
            self._layers = []
            return
        current = list(self._leaves)
        self._layers = [current]
        while len(current) > 1:
            if len(current) % 2 == 1:
                current.append(current[-1])
            next_level: list[str] = []
            for i in range(0, len(current), 2):
                parent = hashlib.sha256((current[i] + current[i + 1]).encode()).hexdigest()
                next_level.append(parent)
            current = next_level
            self._layers.append(current)

    @staticmethod
    def _hash(data: str) -> str:
        return hashlib.sha256(data.encode()).hexdigest()


class EligibleMerkleTree(MerkleTree):
    def __init__(self):
        super().__init__()

    def compute_root_from_npubs(self, npubs_hex: list[str]) -> str | None:
        leaves = sorted(hashlib.sha256(n.encode()).hexdigest() for n in npubs_hex)
        if not leaves:
            return None
        self.bulk_load(leaves)
        return self.get_root()


def compute_eligible_root(npubs_hex: list[str]) -> str | None:
    tree = EligibleMerkleTree()
    return tree.compute_root_from_npubs(npubs_hex)


class SpentCommitmentTree:
    def __init__(self):
        self._tree = MerkleTree()

    def insert(self, commitment: str) -> None:
        self._tree.insert(commitment)

    def bulk_load(self, commitments: list[str]) -> None:
        self._tree.bulk_load(commitments)

    def get_root(self) -> str | None:
        return self._tree.get_root()

    def get_count(self) -> int:
        return self._tree.get_count()

    def get_proof(self, commitment: str) -> dict | None:
        return self._tree.get_proof(commitment)


class VoteMerkleTree:
    def __init__(self):
        self._tree = MerkleTree()

    def insert(self, vote_event: dict) -> None:
        leaf = self._compute_leaf(vote_event)
        self._tree.insert(leaf)

    def bulk_load(self, vote_events: list[dict]) -> None:
        leaves = [self._compute_leaf(e) for e in vote_events]
        self._tree.bulk_load(leaves)

    def get_root(self) -> str | None:
        return self._tree.get_root()

    def get_count(self) -> int:
        return self._tree.get_count()

    def get_proof(self, event_id: str, vote_events: list[dict] | None = None) -> dict | None:
        target = self._find_leaf(event_id, vote_events)
        if target is None:
            return None
        proof = self._tree.get_proof(target)
        if proof is None:
            return None
        proof["nostr_event_id"] = event_id
        return proof

    def _find_leaf(self, event_id: str, vote_events: list[dict] | None = None) -> str | None:
        if vote_events is not None:
            for evt in vote_events:
                if evt.get("id") == event_id or evt.get("event_id") == event_id:
                    return self._compute_leaf(evt)
        return None

    @staticmethod
    def _compute_leaf(vote_event: dict) -> str:
        event_id = vote_event.get("id", vote_event.get("event_id", ""))
        pubkey = vote_event.get("pubkey", "")
        try:
            content = json.loads(vote_event.get("content", "{}"))
        except (json.JSONDecodeError, TypeError):
            content = {}
        responses = content.get("responses", [])
        timestamp = str(vote_event.get("created_at", 0))
        raw = event_id + pubkey + canonical_json(responses) + timestamp
        return hashlib.sha256(raw.encode()).hexdigest()


class IssuanceCommitmentTree:
    def __init__(self):
        self._tree = MerkleTree()

    def insert(self, npub_hex: str) -> None:
        leaf = hashlib.sha256(npub_hex.encode()).hexdigest()
        self._tree.insert(leaf)

    def bulk_load(self, npub_hexes: list[str]) -> None:
        leaves = [hashlib.sha256(n.encode()).hexdigest() for n in npub_hexes]
        self._tree.bulk_load(leaves)

    def get_root(self) -> str | None:
        return self._tree.get_root()

    def get_count(self) -> int:
        return self._tree.get_count()

    def get_proof(self, npub_hex: str) -> dict | None:
        leaf = hashlib.sha256(npub_hex.encode()).hexdigest()
        proof = self._tree.get_proof(leaf)
        if proof is None:
            return None
        proof["npub_hex"] = npub_hex
        return proof


class EventStore:
    def __init__(self):
        self._events: dict[int, list[dict]] = {k: [] for k in (38000, 38002, 38003, 38005, 38006, 38007, 38008, 38009, 38011)}

    def add_event(self, event_data: dict) -> None:
        event_id = event_data.get("id", "")
        kind = event_data.get("kind")
        if kind is None or not isinstance(kind, int):
            return
        if kind not in self._events:
            return
        existing_ids = {e["id"] for e in self._events[kind]}
        if event_id not in existing_ids:
            self._events[kind].append(event_data)

    def get_events(self, kind: int) -> list[dict]:
        return self._events.get(kind, [])

    def get_election(self) -> dict | None:
        events = self._events.get(38008, [])
        if events:
            return max(events, key=lambda e: e.get("created_at", 0))
        return None

    def get_vote_events(self, election_id: str) -> list[dict]:
        return [
            e for e in self._events.get(38000, [])
            if e.get("election") == election_id
        ]

    def get_accepted_event_ids(self, election_id: str) -> set[str]:
        accepted = set()
        for evt in self._events.get(38002, []):
            if evt.get("election") == election_id:
                for eid in evt.get("e", []):
                    accepted.add(eid)
        return accepted

    def get_accepted_vote_events(self, election_id: str) -> list[dict]:
        accepted_ids = self.get_accepted_event_ids(election_id)
        return [
            e for e in self.get_vote_events(election_id)
            if e.get("id") in accepted_ids
        ]

    def get_eligibility(self, election_id: str) -> dict | None:
        events = [
            e for e in self._events.get(38009, [])
            if e.get("election") == election_id
        ]
        if events:
            return max(events, key=lambda e: e.get("created_at", 0))
        return None

    def get_issued_pubkeys(self, election_id: str) -> set[str]:
        issued = set()
        for evt in self._events.get(38011, []):
            if evt.get("election") == election_id:
                p_vals = evt.get("p", [])
                if p_vals:
                    issued.add(normalize_npub(p_vals[0]))
        return issued

    def get_final_result(self, election_id: str) -> dict | None:
        events = [
            e for e in self._events.get(38003, [])
            if e.get("election") == election_id
        ]
        if events:
            return max(events, key=lambda e: e.get("created_at", 0))
        return None

    def get_hard_cap(self, election_id: str) -> dict | None:
        events = [
            e for e in self._events.get(38007, [])
            if e.get("election") == election_id
        ]
        if events:
            return max(events, key=lambda e: e.get("created_at", 0))
        return None


def process_issuance_request(
    event_data: dict,
    eligible_set: set[str],
    issued_set: set[str],
    grpc_endpoint: str,
    mint_url: str,
    nostr_client: Client,
    public_mint_url: str | None = None,
) -> None:
    pubkey = event_data["pubkey"]

    if pubkey not in eligible_set:
        log.info("SKIP: %s... not eligible", pubkey[:16])
        return

    if pubkey in issued_set:
        log.info("SKIP: %s... already issued", pubkey[:16])
        return

    quote_id = event_data.get("quote")
    if not quote_id:
        log.warning("SKIP: %s... missing quote tag", pubkey[:16])
        return

    amount = event_data.get("amount")
    if amount != "1":
        log.info("SKIP: %s... amount=%s, must be 1 sat", pubkey[:16], amount)
        return

    expected_mint = (public_mint_url or mint_url).rstrip("/")
    event_mint = event_data.get("mint")
    if event_mint and event_mint.rstrip("/") != expected_mint:
        log.info(
            "SKIP: %s... mint=%s does not match expected mint %s",
            pubkey[:16], event_mint, expected_mint,
        )
        return

    election_id = event_data.get("election")
    log.info("VERIFYING: npub=%s... quote=%s amount=%s sat", pubkey[:16], quote_id, amount)

    quote_data = verify_quote_on_mint(mint_url, quote_id)
    if not quote_data:
        log.warning("SKIP: %s... quote %s not found on mint", pubkey[:16], quote_id)
        return

    if quote_data.get("state", "").upper() != "UNPAID":
        log.info(
            "SKIP: %s... quote %s state=%s, expected unpaid",
            pubkey[:16], quote_id, quote_data.get("state"),
        )
        return

    log.info("APPROVING: npub=%s... quote=%s", pubkey[:16], quote_id)

    try:
        approve_quote_via_grpc(grpc_endpoint, quote_id)
        issued_set.add(pubkey)
        log.info("DONE: quote %s approved for npub=%s...", quote_id, pubkey[:16])

        try:
            _publish_38011(nostr_client, election_id, pubkey, quote_id, public_mint_url or mint_url)
        except Exception as exc:
            log.error("FAILED to publish 38011 for npub=%s...: %s", pubkey[:16], exc)

    except grpc.RpcError as exc:
        log.error("ERROR: gRPC failed for quote %s: %s", quote_id, exc)


def _publish_38011(
    nostr_client: Client,
    election_id: str | None,
    approved_npub: str,
    quote_id: str,
    mint_url: str,
) -> None:
    content = json.dumps({
        "election_id": election_id,
        "approved_npub": approved_npub,
        "quote_id": quote_id,
        "amount": 1,
        "mint_url": mint_url,
    })

    tags = [
        Tag.parse(["election", election_id or ""]),
        Tag.parse(["p", approved_npub]),
        Tag.parse(["quote", quote_id]),
    ]

    builder = EventBuilder(kind=Kind(38011), content=content).tags(tags)
    try:
        asyncio.run(nostr_client.send_event_builder(builder))
    except Exception:
        pass
    log.info("Published kind 38011 issuance receipt for npub=%s...", approved_npub[:16])


def _publish_nostr_event(nostr_client: Client, kind: int, content: dict, tags: list) -> None:
    content_str = json.dumps(content)
    builder = EventBuilder(kind=Kind(kind), content=content_str).tags(tags)
    try:
        asyncio.run(nostr_client.send_event_builder(builder))
    except Exception:
        pass


def _publish_38007(nostr_client: Client, election_id: str, max_supply: int, start_time: int, end_time: int, confirm_end: int | None = None, eligible_root: str | None = None, eligible_count: int | None = None) -> None:
    content = {
        "election_id": election_id,
        "max_supply": max_supply,
        "vote_start": start_time,
        "vote_end": end_time,
    }
    if confirm_end is not None:
        content["confirm_end"] = confirm_end
    tags = [Tag.parse(["election", election_id])]
    if eligible_root is not None:
        tags.append(Tag.parse(["eligible-root", eligible_root]))
    if eligible_count is not None:
        tags.append(Tag.parse(["eligible-count", str(eligible_count)]))
    _publish_nostr_event(nostr_client, 38007, content, tags)
    log.info("Published kind 38007 join event: max_supply=%d, eligible_root=%s", max_supply, (eligible_root or "")[:16])


def _publish_38009(nostr_client: Client, election_id: str, eligible_root: str, eligible_count: int) -> None:
    content = {
        "election_id": election_id,
        "eligible_root": eligible_root,
        "eligible_count": eligible_count,
    }
    tags = [Tag.parse(["election", election_id])]
    _publish_nostr_event(nostr_client, 38009, content, tags)
    log.info("Published kind 38009 eligibility commitment: root=%s, count=%d", eligible_root[:16], eligible_count)


def _publish_38012(nostr_client: Client, http_api: str, mint_url: str, relays: list[str]) -> None:
    content = {
        "http_api": http_api,
        "mint_url": mint_url,
        "supported_relays": relays,
    }
    tags = [Tag.parse(["t", "coordinator-info"])]
    _publish_nostr_event(nostr_client, 38012, content, tags)
    log.info("Published kind 38012 coordinator info: http_api=%s, mint=%s", http_api, mint_url)


def _publish_38005(nostr_client: Client, election_id: str, issuance_tree: IssuanceCommitmentTree) -> None:
    content = {
        "election_id": election_id,
        "issuance_commitment_root": issuance_tree.get_root(),
        "total_issued": issuance_tree.get_count(),
    }
    tags = [Tag.parse(["election", election_id])]
    _publish_nostr_event(nostr_client, 38005, content, tags)
    log.info("Published kind 38005 issuance root: total_issued=%d", issuance_tree.get_count())


def _publish_38006(nostr_client: Client, election_id: str, spent_tree: SpentCommitmentTree) -> None:
    content = {
        "election_id": election_id,
        "spent_commitment_root": spent_tree.get_root(),
        "total_spent": spent_tree.get_count(),
    }
    tags = [Tag.parse(["election", election_id])]
    _publish_nostr_event(nostr_client, 38006, content, tags)
    log.info("Published kind 38006 spent root: total_spent=%d", spent_tree.get_count())


def _publish_38003(
    nostr_client: Client,
    election_id: str,
    results: dict,
    vote_tree: VoteMerkleTree,
    spent_tree: SpentCommitmentTree,
    issuance_tree: IssuanceCommitmentTree,
    max_supply: int,
) -> None:
    content = {
        "election_id": election_id,
        "total_votes": vote_tree.get_count(),
        "results": results,
        "merkle_root": vote_tree.get_root(),
        "total_proofs_burned": spent_tree.get_count(),
        "issuance_commitment_root": issuance_tree.get_root(),
        "spent_commitment_root": spent_tree.get_root(),
        "max_supply": max_supply,
    }
    tags = [Tag.parse(["election", election_id])]
    _publish_nostr_event(nostr_client, 38003, content, tags)
    log.info("Published kind 38003 final result: total_votes=%d", vote_tree.get_count())


def close_election(
    event_store: EventStore,
    spent_tree: SpentCommitmentTree,
    issuance_tree: IssuanceCommitmentTree,
    vote_tree: VoteMerkleTree,
    nostr_client: Client,
    eligible_set: set[str],
) -> dict | None:
    election = event_store.get_election()
    if not election:
        log.warning("Cannot close: no election announced")
        return None

    election_id = election.get("election_id") or election.get("election", "")
    existing = event_store.get_final_result(election_id)
    if existing:
        log.info("Election %s already closed (event %s)", election_id[:16], existing.get("id", "?")[:16])
        return existing

    accepted_votes = event_store.get_accepted_vote_events(election_id)
    vote_tree.bulk_load(accepted_votes)

    issued_pubkeys = event_store.get_issued_pubkeys(election_id)
    issuance_tree.bulk_load(list(issued_pubkeys))

    max_supply = len(eligible_set)

    results = _compute_results(accepted_votes, election)

    _publish_38005(nostr_client, election_id, issuance_tree)
    _publish_38006(nostr_client, election_id, spent_tree)
    _publish_38003(
        nostr_client, election_id, results, vote_tree,
        spent_tree, issuance_tree, max_supply,
    )

    try:
        result_content = {
            "election_id": election_id,
            "total_votes": vote_tree.get_count(),
            "results": results,
            "merkle_root": vote_tree.get_root(),
            "total_proofs_burned": spent_tree.get_count(),
            "issuance_commitment_root": issuance_tree.get_root(),
            "spent_commitment_root": spent_tree.get_root(),
            "max_supply": max_supply,
        }
        result_id = hashlib.sha256(json.dumps(result_content, sort_keys=True).encode()).hexdigest()[:16]
        event_store.add_event({
            "id": result_id,
            "kind": 38003,
            "election": election_id,
            "content": json.dumps(result_content),
            "created_at": int(time.time()),
        })
    except Exception:
        pass

    log.info("Election %s closed: %d votes, %d burned, %d issued",
             election_id[:16], vote_tree.get_count(), spent_tree.get_count(), issuance_tree.get_count())

    return event_store.get_final_result(election_id)


def handle_proof_dm(
    dm_content: str,
    sender_pubkey: str,
    nostr_client: Client,
    mint_url: str,
    spent_tree: SpentCommitmentTree,
    event_store: EventStore,
) -> None:
    try:
        payload = json.loads(dm_content)
    except json.JSONDecodeError:
        log.warning("DM from %s...: invalid JSON, ignoring", sender_pubkey[:16])
        return

    vote_event_id = payload.get("vote_event_id")
    proof = payload.get("proof")

    if not vote_event_id or not proof:
        log.warning("DM from %s...: missing vote_event_id or proof", sender_pubkey[:16])
        return

    log.info("BURN: received proof for vote %s from %s...", vote_event_id[:16], sender_pubkey[:16])

    try:
        from coincurve import PrivateKey as EcPrivateKey
        from cashu.core.base import BlindedMessage
        from cashu.core.crypto.b_dhke import step1_alice

        secret = hashlib.sha256(f"burn-{vote_event_id}".encode()).hexdigest()
        B_, _r = step1_alice(secret)
        B_hex = B_.format(compressed=True).hex()
        keyset_id = proof.get("id", "")
        blinded_output = BlindedMessage(amount=proof.get("amount", 1), id=keyset_id, B_=B_hex)
        swap_output = blinded_output.model_dump(mode="json")

        resp = requests.post(
            f"{mint_url}/v1/swap",
            json={"inputs": [proof], "outputs": [swap_output]},
            timeout=30,
        )
        if resp.status_code == 200:
            result = resp.json()
            signatures = result.get("signatures", [])
            if signatures:
                log.info("BURN OK: vote %s proof burned via swap (received %d sigs)", vote_event_id[:16], len(signatures))

                commitment = hashlib.sha256(json.dumps(proof, sort_keys=True).encode()).hexdigest()
                spent_tree.insert(commitment)
                merkle_root = spent_tree.get_root()

                election = event_store.get_election()
                election_id = (election.get("election_id") or election.get("election")) if election else None

                try:
                    _publish_38002(
                        nostr_client, election_id,
                        vote_event_id, commitment, spent_tree.get_count(),
                    )
                    event_store.add_event({
                        "kind": 38002,
                        "election": election_id or "",
                        "e": [vote_event_id],
                        "commitment": commitment,
                    })
                except Exception as exc:
                    log.error("FAILED to publish 38002 for vote %s: %s", vote_event_id[:16], exc)
            else:
                log.warning("BURN FAIL: vote %s mint returned: %s", vote_event_id[:16], result)
        elif resp.status_code == 400:
            log.warning("BURN REJECTED: vote %s proof invalid or already spent: %s", vote_event_id[:16], resp.text)
        else:
            log.warning("BURN ERROR: vote %s mint returned HTTP %d: %s", vote_event_id[:16], resp.status_code, resp.text)
    except requests.RequestException as exc:
        log.error("BURN ERROR: vote %s failed to contact mint: %s", vote_event_id[:16], exc)


def _publish_38002(
    nostr_client: Client,
    election_id: str | None,
    vote_event_id: str,
    proof_commitment: str,
    spent_count: int,
) -> None:
    content = json.dumps({
        "election_id": election_id,
        "vote_event_id": vote_event_id,
        "proof_commitment": proof_commitment,
        "spent_count": spent_count,
    })

    tags = [
        Tag.parse(["election", election_id or ""]),
        Tag.parse(["e", vote_event_id]),
        Tag.parse(["commitment", proof_commitment]),
    ]

    builder = EventBuilder(kind=Kind(38002), content=content).tags(tags)
    nostr_client.send_event_builder(builder)
    log.info("Published kind 38002 event (spent_count=%d)", spent_count)


class CoordinatorHandler(HandleNotification):
    def __init__(
        self,
        eligible_set: set[str],
        issued_set: set[str],
        grpc_endpoint: str,
        mint_url: str,
        nostr_client: Client,
        signer: NostrSigner,
        event_store: EventStore,
        spent_tree: SpentCommitmentTree,
        coordinator_pubkey_hex: str,
        issuance_tree: IssuanceCommitmentTree | None = None,
        vote_tree: VoteMerkleTree | None = None,
        active_election_id: str | None = None,
        public_mint_url: str | None = None,
    ):
        self.eligible_set = eligible_set
        self.issued_set = issued_set
        self.grpc_endpoint = grpc_endpoint
        self.mint_url = mint_url
        self.public_mint_url = public_mint_url
        self.nostr_client = nostr_client
        self.signer = signer
        self.event_store = event_store
        self.spent_tree = spent_tree
        self.coordinator_pubkey_hex = coordinator_pubkey_hex
        self.issuance_tree = issuance_tree or IssuanceCommitmentTree()
        self.vote_tree = vote_tree or VoteMerkleTree()
        self.active_election_id = active_election_id

    async def handle(self, relay_url, subscription_id, event):
        kind_val = event.kind().as_u16()

        if kind_val == 4:
            sender = event.author().to_hex()
            if sender == self.coordinator_pubkey_hex:
                return
            sender_pk = event.author()
            dm_content = event.content()
            asyncio.ensure_future(self._handle_dm_async(sender, sender_pk, dm_content))
            return

        if kind_val not in (38000, 38002, 38003, 38005, 38006, 38007, 38008, 38009, 38010, 38011):
            return

        event_data = extract_event_data(event)

        if self.active_election_id:
            event_election = event_data.get("election") or event_data.get("election_id", "")
            if event_election != self.active_election_id:
                log.debug("SKIP: event %s from election %s (active: %s)",
                          event_data.get("id", "?")[:16], event_election[:20], self.active_election_id[:20])
                return

        self.event_store.add_event(event_data)

        if kind_val == 38010:
            await asyncio.to_thread(
                process_issuance_request,
                event_data,
                self.eligible_set,
                self.issued_set,
                self.grpc_endpoint,
                self.mint_url,
                self.nostr_client,
                self.public_mint_url,
            )
        elif kind_val == 38002:
            commitment = event_data.get("commitment")
            if commitment:
                self.spent_tree.insert(commitment)
                log.info("Spent tree updated: count=%d root=%s", self.spent_tree.get_count(), self.spent_tree.get_root())

    async def _handle_dm_async(self, sender: str, sender_pk, dm_content: str) -> None:
        try:
            decrypted = await self.signer.nip04_decrypt(sender_pk, dm_content)
            log.info("DM received from %s...", sender[:16])
            handle_proof_dm(
                decrypted, sender,
                self.nostr_client, self.mint_url,
                self.spent_tree, self.event_store,
            )
        except Exception as exc:
            log.error("Failed to handle DM from %s...: %s", sender[:16], exc)

    async def handle_msg(self, relay_url, msg):
        pass


def _compute_results(vote_events: list[dict], election_config: dict | None = None) -> dict:
    question_types: dict[str, str] = {}
    if election_config:
        for q in election_config.get("questions", []):
            qid = q.get("id", "")
            if qid:
                question_types[qid] = q.get("type", "choice")

    results: dict[str, dict] = {}
    for evt in vote_events:
        try:
            content = json.loads(evt.get("content", "{}"))
        except json.JSONDecodeError:
            continue
        for response in content.get("responses", []):
            qid = response.get("question_id", "unknown")
            if qid not in results:
                results[qid] = {}
            value = response.get("value")
            values = response.get("values")
            q_type = question_types.get(qid, "choice")

            if q_type == "text":
                if isinstance(value, str):
                    results[qid].setdefault("_verbatim", []).append(value)
            elif isinstance(value, (int, float)):
                results[qid].setdefault("_numeric", []).append(value)
            elif isinstance(value, str):
                results[qid][value] = results[qid].get(value, 0) + 1
            elif isinstance(values, list):
                for v in values:
                    results[qid][v] = results[qid].get(v, 0) + 1

    clean: dict[str, dict] = {}
    for qid, data in results.items():
        verbatim = data.pop("_verbatim", None)
        if verbatim is not None:
            clean[qid] = verbatim
            continue
        numeric = data.pop("_numeric", None)
        if numeric:
            clean[qid] = {
                "mean": round(sum(numeric) / len(numeric), 2) if numeric else 0,
                "median": sorted(numeric)[len(numeric) // 2] if numeric else 0,
                "count": len(numeric),
            }
        else:
            clean[qid] = data
    return clean


def make_http_handler(
    event_store: EventStore,
    spent_tree: SpentCommitmentTree,
    coordinator_npub: str,
    mint_url: str,
    mint_pubkey: str,
    relays: list[str],
    public_mint_url: str | None = None,
    issuance_tree: IssuanceCommitmentTree | None = None,
    vote_tree: VoteMerkleTree | None = None,
    eligible_set: set[str] | None = None,
    nostr_client: Client | None = None,
):
    public_url = public_mint_url or mint_url
    _issuance_tree = issuance_tree or IssuanceCommitmentTree()
    _vote_tree = vote_tree or VoteMerkleTree()
    _eligible_set = eligible_set or set()
    _nostr_client = nostr_client
    issuance_requests: dict[str, dict] = {}

    def _issuance_status_for(npub_raw: str, election_id: str) -> tuple[str, bool]:
        npub_hex = normalize_npub(npub_raw)
        if npub_hex not in _eligible_set:
            return "ineligible", False
        if npub_hex in event_store.get_issued_pubkeys(election_id):
            return "issued", True
        return "pending", False

    async def handle_info(request: web.Request) -> web.Response:
        election = event_store.get_election()
        return web.json_response({
            "coordinatorNpub": coordinator_npub,
            "mintUrl": public_url,
            "mintPublicKey": mint_pubkey,
            "relays": relays,
            "electionId": (election.get("election_id") or election.get("election")) if election else None,
            "_trust": {
                "level": "informational",
                "note": "Operational metadata. Verify coordinator identity on Nostr.",
            },
        })

    async def handle_election(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        try:
            content = json.loads(election.get("content", "{}"))
        except json.JSONDecodeError:
            content = {}

        election_id = election.get("election_id") or election.get("election")

        return web.json_response({
            "election_id": election_id,
            "event_id": election.get("id"),
            "title": content.get("title"),
            "description": content.get("description"),
            "questions": content.get("questions"),
            "start_time": content.get("start_time"),
            "end_time": content.get("end_time"),
            "mint_urls": content.get("mint_urls", [mint_url]),
            "created_at": election.get("created_at"),
            "_trust": {
                "level": "cache",
                "warning": "This is a cached copy of the coordinator's kind 38008 Nostr event. It is NOT signed in this HTTP response. A compromised coordinator could serve a different election definition here.",
                "verify_nostr": {
                    "kind": 38008,
                    "filter": {
                        "kinds": [38008],
                        "authors": [normalize_npub(coordinator_npub)],
                        "limit": 1,
                    },
                    "relays": [r for r in relays if r.startswith("wss://")],
                },
            },
        })

    async def handle_tally(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")
        end_time = None
        try:
            content = json.loads(election.get("content", "{}"))
            end_time = content.get("end_time")
        except json.JSONDecodeError:
            pass

        now = int(time.time())
        status = "closed" if end_time and now >= end_time else "in_progress"

        vote_events = event_store.get_vote_events(election_id)
        accepted_ids = event_store.get_accepted_event_ids(election_id)

        total_published = len(vote_events)

        accepted_votes = [v for v in vote_events if v.get("id") in accepted_ids]
        total_accepted = len(accepted_votes)

        results = _compute_results(accepted_votes)

        resp_data = {
            "election_id": election_id,
            "status": status,
            "total_published_votes": total_published,
            "total_accepted_votes": total_accepted,
            "spent_commitment_root": spent_tree.get_root(),
            "results": results,
        }

        return web.json_response(resp_data)

    async def handle_eligibility(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")
        eligibility = event_store.get_eligibility(election_id)
        if not eligibility:
            return web.json_response({"error": "No eligibility set published yet"}, status=404)

        try:
            content = json.loads(eligibility.get("content", "{}"))
        except json.JSONDecodeError:
            content = {}

        return web.json_response({
            "election_id": election_id,
            "eligible_count": content.get("eligible_count"),
            "eligible_npubs": content.get("eligible_npubs"),
            "eligible_root": content.get("eligible_root"),
            "_trust": {
                "level": "cache",
                "warning": "This is a cached copy of the coordinator's kind 38009 Nostr event. Verify on Nostr relays.",
                "verify_nostr": {
                    "kind": 38009,
                    "filter": {"kinds": [38009], "#e": [election_id]},
                    "relays": [r for r in relays if r.startswith("wss://")],
                },
            },
        })

    async def handle_close(request: web.Request) -> web.Response:
        if not _nostr_client:
            return web.json_response({"error": "Nostr client not configured"}, status=500)

        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=400)

        election_id = election.get("election_id") or election.get("election")
        end_time = None
        try:
            content = json.loads(election.get("content", "{}"))
            end_time = content.get("end_time")
        except json.JSONDecodeError:
            pass

        now = int(time.time())
        if end_time and now < end_time:
            return web.json_response({"error": f"Election open until {end_time}, current time {now}"}, status=400)

        existing = event_store.get_final_result(election_id)
        if existing:
            return web.json_response({"status": "already_closed", "event_id": existing.get("id")})

        result = await asyncio.to_thread(
            close_election,
            event_store, spent_tree, _issuance_tree,
            _vote_tree, _nostr_client, _eligible_set,
        )
        if result is None:
            return web.json_response({"error": "Failed to close election"}, status=500)

        return web.json_response({"status": "closed", "event_id": result.get("id")})

    async def handle_result(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")
        final = event_store.get_final_result(election_id)
        if not final:
            return web.json_response({"error": "Election not yet closed"}, status=404)

        try:
            content = json.loads(final.get("content", "{}"))
        except json.JSONDecodeError:
            content = {}

        return web.json_response({
            **content,
            "election_id": election_id,
            "event_id": final.get("id"),
            "closed_at": final.get("created_at"),
            "_trust": {
                "level": "authoritative",
                "note": "This is the final tally. Verify on Nostr relays using kind 38003 from coordinator pubkey.",
                "verify_nostr": {
                    "kind": 38003,
                    "filter": {"kinds": [38003], "authors": [normalize_npub(coordinator_npub)], "#e": [election_id], "limit": 1},
                    "relays": [r for r in relays if r.startswith("wss://")],
                },
            },
        })

    async def handle_inclusion_proof(request: web.Request) -> web.Response:
        event_id = request.query.get("event_id", "")
        if not event_id:
            return web.json_response({"error": "Missing event_id parameter"}, status=400)

        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")

        final = event_store.get_final_result(election_id)
        if not final:
            return web.json_response({"error": "Election not yet closed"}, status=404)

        accepted_votes = event_store.get_accepted_vote_events(election_id)
        proof = _vote_tree.get_proof(event_id, accepted_votes)
        if not proof:
            return web.json_response({"error": f"Event {event_id[:16]}... not found in vote tree"}, status=404)

        return web.json_response(proof)

    async def handle_issuance_status(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")
        issued_pubkeys = event_store.get_issued_pubkeys(election_id)

        voters = {}
        for hex_pubkey in _eligible_set:
            npub = hex_to_npub(hex_pubkey)
            voters[npub] = {
                "eligible": True,
                "issued": hex_pubkey in issued_pubkeys,
            }

        return web.json_response({
            "election_id": election_id,
            "voters": voters,
        })

    async def handle_vote_tree(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")

        final = event_store.get_final_result(election_id)
        if not final:
            return web.json_response({"error": "Election not yet closed"}, status=404)

        accepted_votes = event_store.get_accepted_vote_events(election_id)
        leaves = []
        for evt in accepted_votes:
            eid = evt.get("id", evt.get("event_id", ""))
            leaf_hash = _vote_tree._compute_leaf(evt)
            leaves.append({"hash": leaf_hash, "event_id": eid})

        leaves.sort(key=lambda x: x["hash"])
        for i, leaf in enumerate(leaves):
            leaf["index"] = i

        return web.json_response({
            "merkle_root": _vote_tree.get_root(),
            "total_leaves": len(leaves),
            "leaves": leaves,
            "levels": _vote_tree._tree._layers,
        })

    async def handle_issuance_start(request: web.Request) -> web.Response:
        election = event_store.get_election()
        if not election:
            return web.json_response({"error": "No election announced yet"}, status=404)

        election_id = election.get("election_id") or election.get("election")
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        npub = payload.get("npub", "")
        quote_id = payload.get("quote_id", "")
        requested_election = payload.get("election_id", election_id)

        if requested_election and requested_election != election_id:
            return web.json_response({"error": "Election mismatch", "status": "ineligible", "issued": False}, status=400)

        status, issued = _issuance_status_for(npub, election_id)
        if status == "ineligible":
            return web.json_response({
                "status": status,
                "issued": issued,
                "message": "Voter is not in the eligible set",
            }, status=403)

        if issued:
            return web.json_response({
                "request_id": "",
                "status_url": "",
                "status": "already_issued",
                "issued": True,
                "quote_state": "PAID",
            })

        request_id = uuid.uuid4().hex
        issuance_requests[request_id] = {
            "npub": npub,
            "quote_id": quote_id,
            "election_id": election_id,
            "created_at": int(time.time() * 1000),
        }

        return web.json_response({
            "request_id": request_id,
            "status_url": f"/issuance/{request_id}",
            "status": "pending",
        })

    async def handle_issuance_wait(request: web.Request) -> web.Response:
        request_id = request.match_info.get("request_id", "")
        if request_id not in issuance_requests:
            return web.json_response({"error": "Unknown issuance request"}, status=404)

        req = issuance_requests[request_id]
        timeout_ms = int(request.query.get("timeout_ms", "30000"))
        timeout_ms = max(1, min(timeout_ms, 60000))
        deadline = time.time() + (timeout_ms / 1000)

        while time.time() < deadline:
            status, issued = _issuance_status_for(req["npub"], req["election_id"])
            if status == "ineligible":
                return web.json_response({"request_id": request_id, "status": status, "issued": False, "quote_state": "UNPAID"}, status=403)
            if issued:
                return web.json_response({"request_id": request_id, "status": "issued", "issued": True, "quote_state": "PAID"})
            await asyncio.sleep(0.2)

        return web.json_response({
            "request_id": request_id,
            "status": "timeout",
            "issued": False,
            "quote_state": "UNPAID",
            "retry_after_ms": 1000,
            "message": "Issuance still pending",
        })

    router = web.RouteTableDef()
    router.get("/info")(handle_info)
    router.get("/election")(handle_election)
    router.get("/tally")(handle_tally)
    router.get("/eligibility")(handle_eligibility)
    router.post("/close")(handle_close)
    router.get("/result")(handle_result)
    router.get("/inclusion_proof")(handle_inclusion_proof)
    router.get("/issuance-status")(handle_issuance_status)
    router.post("/issuance/start")(handle_issuance_start)
    router.get("/issuance/{request_id}")(handle_issuance_wait)
    router.get("/vote_tree")(handle_vote_tree)
    return router


def check_dependencies() -> None:
    missing = []
    try:
        import grpc  # noqa: F401
    except ImportError:
        missing.append("grpcio (pip install -r tools/mintctl/requirements.txt)")
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests (pip install requests)")
    try:
        import nostr_sdk  # noqa: F401
    except ImportError:
        missing.append("nostr-sdk (pip install nostr-sdk)")
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        missing.append("aiohttp (pip install aiohttp)")
    if missing:
        for dep in missing:
            print(f"Missing dependency: {dep}", file=sys.stderr)
        raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Voting coordinator: issuance, burn tracking, and HTTP API for election state"
    )
    nsec_group = parser.add_mutually_exclusive_group(required=True)
    nsec_group.add_argument("--nsec", help="Coordinator's Nostr private key (nsec1...)")
    nsec_group.add_argument("--nsec-file", help="Path to file containing coordinator's nsec")
    parser.add_argument(
        "--eligible",
        required=True,
        help="Path to eligible-voters.json (array of npub hex or bech32 strings)",
    )
    parser.add_argument(
        "--grpc-endpoint",
        required=True,
        help="Mint gRPC endpoint (e.g. 23.182.128.64:8086)",
    )
    parser.add_argument(
        "--mint-url",
        required=True,
        help="Mint HTTP URL for internal calls (e.g. http://127.0.0.1:3338)",
    )
    parser.add_argument(
        "--public-mint-url",
        default=None,
        help="Public mint URL exposed to voters via /info (e.g. http://23.182.128.64:3338). Defaults to --mint-url.",
    )
    parser.add_argument(
        "--relays",
        nargs="+",
        default=DEFAULT_RELAYS,
        help="Nostr relay URLs (default: ws://localhost:10547 wss://relay.damus.io wss://nos.lol wss://relay.primal.net)",
    )
    parser.add_argument(
        "--http-port",
        type=int,
        default=8080,
        help="HTTP API port (default: 8080)",
    )
    parser.add_argument(
        "--http-host",
        default="0.0.0.0",
        help="HTTP API bind address (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--election-id",
        default=None,
        help="Election ID to lock this coordinator to. If omitted, coordinator starts without an election filter and auto-discovers elections from relay events.",
    )
    parser.add_argument(
        "--join-election",
        default=None,
        help="Election ID (38008 event ID) to join as a participating coordinator. Coordinator will verify eligible set, publish 38007/38009/38012, then start normal operation.",
    )
    parser.add_argument(
        "--http-api-url",
        default=None,
        help="Public HTTP API URL for this coordinator (used in kind 38012 coordinator info). Example: https://coordinator.example.com:8081",
    )
    return parser.parse_args()


async def recover_state_from_relay(
    nostr_client: Client,
    active_election_id: str | None = None,
) -> tuple[set[str], SpentCommitmentTree, IssuanceCommitmentTree, VoteMerkleTree, EventStore]:
    event_store = EventStore()
    spent_tree = SpentCommitmentTree()
    issuance_tree = IssuanceCommitmentTree()
    vote_tree = VoteMerkleTree()

    log.info("Recovering state from relay (kinds 38000, 38002, 38003, 38005, 38006, 38007, 38008, 38009, 38011)...")

    event_filter = (
        Filter()
        .kinds([Kind(38000), Kind(38002), Kind(38003), Kind(38005), Kind(38006), Kind(38007), Kind(38008), Kind(38009), Kind(38011)])
        .limit(10000)
    )

    events = await nostr_client.fetch_events(event_filter, datetime.timedelta(seconds=30))
    events_vec = events.to_vec()
    log.info("Fetched %d historical events from relay", len(events_vec))

    for event in events_vec:
        event_data = extract_event_data(event)

        if active_election_id:
            event_election = event_data.get("election") or event_data.get("election_id", "")
            if event_election != active_election_id:
                continue

        event_store.add_event(event_data)

        if event_data.get("kind") == 38002:
            commitment = event_data.get("commitment")
            if commitment:
                spent_tree.insert(commitment)

    if active_election_id:
        election_id = active_election_id
    else:
        election = event_store.get_election()
        election_id = (election.get("election_id") or election.get("election")) if election else None

    issued_set = event_store.get_issued_pubkeys(election_id) if election_id else set()

    if election_id:
        issuance_tree.bulk_load(list(issued_set))
        accepted_votes = event_store.get_accepted_vote_events(election_id)
        vote_tree.bulk_load(accepted_votes)

    log.info(
        "State recovered: %d events, %d issued pubkeys, %d spent commitments, merkle_root=%s",
        sum(len(v) for v in event_store._events.values()),
        len(issued_set),
        spent_tree.get_count(),
        spent_tree.get_root(),
    )

    return issued_set, spent_tree, issuance_tree, vote_tree, event_store


async def run_coordinator(
    args,
    keys,
    coordinator_pubkey,
    coordinator_npub,
    coordinator_pubkey_hex,
    eligible_set,
    mint_pubkey: str,
    signer: NostrSigner,
) -> int:
    log.info("Connecting to relays: %s", args.relays)

    nostr_client = Client(signer)
    for relay in args.relays:
        await nostr_client.add_relay(RelayUrl.parse(relay))
    await nostr_client.connect()

    issued_set, spent_tree, issuance_tree, vote_tree, event_store = await recover_state_from_relay(
        nostr_client, active_election_id=args.election_id,
    )

    if args.election_id:
        local_root = compute_eligible_root(list(eligible_set))
        if local_root:
            e38007_events = event_store.get_events(38007)
            for evt in e38007_events:
                evt_election = evt.get("election") or evt.get("election_id", "")
                if evt_election != args.election_id:
                    continue
                evt_author = evt.get("pubkey", "")
                if evt_author == coordinator_pubkey_hex:
                    continue
                evt_root = None
                for tag in evt.get("tags", []):
                    if isinstance(tag, list) and len(tag) >= 2 and tag[0] == "eligible-root":
                        evt_root = tag[1]
                        break
                if evt_root and evt_root != local_root:
                    log.warning("Coordinator %s has different eligible-root: %s (ours: %s)", evt_author[:16], evt_root[:16], local_root[:16])
                elif evt_root:
                    log.info("Coordinator %s eligible-root matches: %s", evt_author[:16], local_root[:16])

    handler = CoordinatorHandler(
        eligible_set=eligible_set,
        issued_set=issued_set,
        grpc_endpoint=args.grpc_endpoint,
        mint_url=args.mint_url,
        nostr_client=nostr_client,
        signer=signer,
        event_store=event_store,
        spent_tree=spent_tree,
        coordinator_pubkey_hex=coordinator_pubkey_hex,
        issuance_tree=issuance_tree,
        vote_tree=vote_tree,
        active_election_id=args.election_id,
        public_mint_url=args.public_mint_url or args.mint_url,
    )

    log.info("Subscribing to kinds 38000, 38002, 38003, 38005, 38006, 38007, 38008, 38009, 38010, 38011 and NIP-04 DMs")

    event_filter = Filter().kinds([Kind(38000), Kind(38002), Kind(38003), Kind(38005), Kind(38006), Kind(38007), Kind(38008), Kind(38009), Kind(38010), Kind(38011)]).limit(0)
    await nostr_client.subscribe(event_filter)

    dm_filter = Filter().kind(Kind(4)).pubkey(coordinator_pubkey).limit(0)
    await nostr_client.subscribe(dm_filter)

    http_routes = make_http_handler(
        event_store, spent_tree, coordinator_npub,
        args.mint_url, mint_pubkey, args.relays,
        args.public_mint_url,
        issuance_tree=issuance_tree,
        vote_tree=vote_tree,
        eligible_set=eligible_set,
        nostr_client=nostr_client,
    )

    app = web.Application()
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods="*",
        )
    })
    for route in http_routes:
        cors.add(app.router.add_route(route.method, route.path, route.handler))
    log.info("CORS enabled for all origins")
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.http_host, args.http_port)
    await site.start()
    log.info("HTTP API listening on %s:%d", args.http_host, args.http_port)

    async def poll_claims():
        seen_ids: set[str] = set()
        while True:
            await asyncio.sleep(10)
            try:
                since = Timestamp.from_secs(int(time.time()) - 120)
                claim_filter = Filter().kinds([Kind(38010)]).limit(10).since(since)
                events = await nostr_client.fetch_events(claim_filter, timeout=timedelta(seconds=10))
                for event in events.to_vec():
                    event_id = event.id().to_hex()
                    if event_id not in seen_ids:
                        seen_ids.add(event_id)
                        log.info("POLL: found new claim %s...", event_id[:16])
                        await handler.handle("poll", "poll", event)
            except Exception as exc:
                log.warning("Claim poll error: %s", exc)

    log.info("Coordinator running. Waiting for Nostr events...")
    asyncio.create_task(poll_claims())
    await nostr_client.handle_notifications(handler)

    return 0


async def async_main() -> int:
    check_dependencies()
    args = parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    eligible_path = Path(args.eligible)
    eligible_set = load_json_set(eligible_path)

    log.info("Loaded %d eligible voters", len(eligible_set))

    nsec = args.nsec
    if args.nsec_file:
        nsec = Path(args.nsec_file).read_text().strip()

    keys = Keys.parse(nsec)
    coordinator_pubkey = keys.public_key()
    coordinator_pubkey_hex = coordinator_pubkey.to_hex()
    coordinator_npub = coordinator_pubkey.to_bech32()
    signer = NostrSigner.keys(keys)

    log.info("Coordinator npub: %s", coordinator_npub)

    try:
        approve_quote_via_grpc(args.grpc_endpoint, "test-connection")
        log.info("gRPC connection to %s OK", args.grpc_endpoint)
    except grpc.RpcError:
        pass

    mint_pubkey = ""
    try:
        resp = requests.get(f"{args.mint_url}/v1/info", timeout=10)
        if resp.status_code == 200:
            info = resp.json()
            mint_pubkey = info.get("pubkey", "")
            log.info("Mint HTTP connection to %s OK (pubkey: %s...)", args.mint_url, mint_pubkey[:16])
        else:
            log.warning("Mint HTTP returned %d for %s", resp.status_code, args.mint_url)
    except requests.RequestException as exc:
        log.warning("Failed to connect to mint at %s: %s", args.mint_url, exc)

    if args.join_election:
        log.info("Joining election %s...", args.join_election[:16])
        nostr_client = Client(signer)
        for relay in args.relays:
            await nostr_client.add_relay(RelayUrl.parse(relay))
        await nostr_client.connect()
        await asyncio.sleep(2)

        election_filter = Filter().kinds([Kind(38008)]).ids([args.join_election]).limit(1)
        events = await nostr_client.fetch_events(election_filter, timeout=timedelta(seconds=15))
        events_vec = events.to_vec()

        if not events_vec:
            log.error("Election event %s not found on relay", args.join_election[:16])
            raise SystemExit(1)

        election_event = events_vec[0]
        election_data = extract_event_data(election_event)
        election_content = json.loads(election_data.get("content", "{}"))
        election_tags = election_data.get("tags", [])

        canonical_root = None
        canonical_count = None
        vote_start = election_content.get("vote_start", election_content.get("start_time", 0))
        vote_end = election_content.get("vote_end", election_content.get("end_time", 0))
        confirm_end = election_content.get("confirm_end", vote_end + 3600)

        for tag in election_tags:
            if isinstance(tag, list) and len(tag) >= 2:
                if tag[0] == "eligible-root":
                    canonical_root = tag[1]
                elif tag[0] == "eligible-count":
                    canonical_count = int(tag[1])

        if not canonical_root:
            log.error("Election event has no eligible-root tag")
            raise SystemExit(1)

        local_root = compute_eligible_root(list(eligible_set))
        if local_root != canonical_root:
            log.error("Eligible root mismatch! Local=%s, Canonical=%s", local_root, canonical_root)
            log.error("Your eligible-voters.json does not match the canonical eligible set.")
            raise SystemExit(1)

        log.info("Eligible root verified: %s", canonical_root[:16])

        max_supply = canonical_count or len(eligible_set)

        _publish_38007(nostr_client, args.join_election, max_supply, vote_start, vote_end, confirm_end, canonical_root, canonical_count)
        await asyncio.sleep(1)
        _publish_38009(nostr_client, args.join_election, canonical_root, max_supply)
        await asyncio.sleep(1)

        http_api_url = args.http_api_url or f"http://{args.http_host}:{args.http_port}"
        _publish_38012(nostr_client, http_api_url, args.public_mint_url or args.mint_url, args.relays)
        await asyncio.sleep(1)

        log.info("Successfully joined election %s", args.join_election[:16])
        log.info("Setting election-id to %s for normal operation", args.join_election[:16])
        args.election_id = args.join_election

        await nostr_client.disconnect()

    return await run_coordinator(
        args, keys, coordinator_pubkey, coordinator_npub, coordinator_pubkey_hex,
        eligible_set, mint_pubkey, signer,
    )


if __name__ == "__main__":
    raise SystemExit(asyncio.run(async_main()))
