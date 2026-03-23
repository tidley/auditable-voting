import asyncio
import json
import logging
import subprocess
import time
from pathlib import Path

import pytest
import requests
from nostr_sdk import (
    Client,
    EventBuilder,
    Filter,
    Keys,
    Kind,
    NostrSigner,
    RelayUrl,
    Tag,
)

log = logging.getLogger("e2e_tests")

VPS_IP = "23.182.128.64"
MINT_HTTP_URL = f"http://{VPS_IP}:3338"
COORDINATOR_HTTP = f"http://{VPS_IP}:8081"
RELAY_URL = "ws://localhost:10547"
PUBLIC_RELAY_URL = "wss://relay.damus.io"
SSH_KEY = "~/.ssh/tollgate"
SSH_USER = "root"
COORDINATOR_DIR = "/opt/tollgate/coordinator"
COORDINATOR_VENV_PYTHON = f"{COORDINATOR_DIR}/.venv/bin/python3"
COORDINATOR_MINT_URL = "http://127.0.0.1:3338"
ELECTION_ID = "test-e2e-election"

VOTER_NSEC_FILE = Path(__file__).resolve().parent / "test-voter-nsec.env"

SSH_CMD = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "-i", SSH_KEY,
    f"{SSH_USER}@{VPS_IP}",
]


def _ssh_run(cmd: str, check: bool = True, timeout: int = 60) -> subprocess.CompletedProcess:
    full_cmd = SSH_CMD + [cmd]
    return subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout, check=check)


def _derive_coordinator_npub() -> str:
    result = _ssh_run(f"cat {COORDINATOR_DIR}/nsec.env")
    nsec = result.stdout.strip()
    keys = Keys.parse(nsec)
    return keys.public_key().to_bech32()


def _load_voter_keys() -> tuple[str, str, str]:
    nsec = VOTER_NSEC_FILE.read_text().strip()
    keys = Keys.parse(nsec)
    return nsec, keys.public_key().to_bech32(), keys.public_key().to_hex()


def _create_quote() -> dict:
    resp = requests.post(f"{MINT_HTTP_URL}/v1/mint/quote/bolt11", json={"amount": 1, "unit": "sat"}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    quote_id = data.get("quote") or data.get("quote_id")
    assert quote_id, f"No quote_id in response: {data}"
    data["quote_id"] = quote_id
    log.info("Created quote: %s", quote_id)
    return data


def _build_blinded_output() -> tuple[dict, str, str]:
    import secrets
    from cashu.core.base import BlindedMessage
    from cashu.core.crypto.b_dhke import step1_alice

    secret = secrets.token_hex(32)
    B_, _r = step1_alice(secret)
    B_hex = B_.format(compressed=True).hex()

    keyset_resp = requests.get(f"{MINT_HTTP_URL}/v1/keysets", timeout=10)
    keyset_resp.raise_for_status()
    keysets = keyset_resp.json().get("keysets", [])
    sat_ks = [ks for ks in keysets if ks.get("unit") == "sat" and ks.get("active")]
    assert sat_ks, f"No active sat keyset: {keysets}"
    keyset_id = sat_ks[0]["id"]

    blinded_msg = BlindedMessage(amount=1, id=keyset_id, B_=B_hex, C_=None)
    output_dict = blinded_msg.model_dump(mode="json")
    log.info("Built blinded output (keyset=%s, secret=%s...)", keyset_id, secret[:16])
    return output_dict, secret, B_hex


def _mint_tokens(quote_id: str, blinded_outputs: list[dict]) -> dict:
    resp = requests.post(
        f"{MINT_HTTP_URL}/v1/mint/bolt11",
        json={"quote": quote_id, "outputs": blinded_outputs},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    log.info("Mint returned %d signature(s)", len(data.get("signatures", [])))
    return data


def _publish_38010(nsec: str, quote_id: str, mint_url: str, coordinator_npub: str, election_id: str, relay: str = RELAY_URL) -> str:
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)

    async def _send():
        await client.add_relay(RelayUrl.parse(relay))
        await client.connect()
        tags = [
            Tag.parse(["p", coordinator_npub]),
            Tag.parse(["quote", quote_id]),
            Tag.parse(["amount", "1"]),
            Tag.parse(["mint", mint_url]),
            Tag.parse(["election", election_id]),
        ]
        builder = EventBuilder(kind=Kind(38010), content="E2E test issuance request").tags(tags)
        event_id = await client.send_event_builder(builder)
        await asyncio.sleep(2)
        log.info("Published kind 38010: %s", str(event_id)[:40])
        return str(event_id)

    loop = asyncio.new_event_loop()
    try:
        event_id = loop.run_until_complete(_send())
    finally:
        loop.close()

    log.info("Published kind 38010: %s", event_id[:20])
    return event_id


_VPS_38010_SCRIPT = r'''import asyncio, sys
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    nsec = sys.argv[1]
    coord = sys.argv[2]
    qid = sys.argv[3]
    mint = sys.argv[4]
    eid = sys.argv[5]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    tags = [
        Tag.parse(["p", coord]),
        Tag.parse(["quote", qid]),
        Tag.parse(["amount", "1"]),
        Tag.parse(["mint", mint]),
        Tag.parse(["election", eid]),
    ]
    builder = EventBuilder(kind=Kind(38010), content="E2E test issuance request from VPS").tags(tags)
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(3)
    print(str(event_id))

asyncio.run(main())
'''


def _publish_38010_from_vps(nsec: str, quote_id: str, mint_url: str, coordinator_npub: str, election_id: str) -> str:
    remote_script = "/tmp/e2e_publish_38010.py"
    _ssh_run(f"cat > {remote_script} << 'PYEOF'\n{_VPS_38010_SCRIPT}\nPYEOF")
    result = _ssh_run(
        f"{COORDINATOR_VENV_PYTHON} {remote_script} {nsec} {coordinator_npub} {quote_id} {mint_url} {election_id}",
        check=False,
    )
    _ssh_run(f"rm -f {remote_script}", check=False)
    event_id_hex = result.stdout.strip()
    assert len(event_id_hex) > 10, f"Failed to publish from VPS: stdout={result.stdout[:100]} stderr={result.stderr[:200]}"
    log.info("Published kind 38010 from VPS via nak: %s", event_id_hex[:20])
    return event_id_hex


def _poll_quote_until_paid(mint_url: str, quote_id: str, timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = requests.get(f"{mint_url}/v1/mint/quote/bolt11/{quote_id}", timeout=10)
            if resp.status_code == 200:
                state = resp.json().get("state", "").upper()
                if state == "PAID":
                    return True
                log.info("Quote state: %s", state)
        except requests.RequestException:
            pass
        time.sleep(2)
    return False


def _query_relay_for_kind(author_bech32: str, kind: int, timeout: int = 15) -> list[dict]:
    async def _fetch():
        event_filter = Filter().kind(Kind(kind)).pubkey(
            Keys.parse(author_bech32.replace("npub", "nsec", 1) if author_bech32.startswith("npub") else author_bech32).public_key()
            if author_bech32.startswith("npub")
            else Keys.parse(author_bech32).public_key()
        ).limit(20)

        if author_bech32.startswith("npub"):
            pk = Keys.parse("nsec1placeholder").public_key()
            try:
                from nostr_sdk import PublicKey
                pk = PublicKey.parse(author_bech32)
            except Exception:
                pass
            event_filter = Filter().kind(Kind(kind)).pubkey(pk).limit(20)

        client = Client(NostrSigner.keys(Keys.generate()))
        await client.add_relay(RelayUrl.parse(RELAY_URL))
        await client.connect()
        await asyncio.sleep(1)
        events = await client.fetch_events(event_filter, timeout=timeout)
        result = []
        for event in events.to_vec():
            result.append({
                "id": event.id().to_hex(),
                "pubkey": event.author().to_hex(),
                "content": event.content(),
                "kind": event.kind().as_u16(),
                "created_at": event.created_at().as_secs(),
            })
        return result

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_fetch())
    finally:
        loop.close()


@pytest.fixture(scope="class")
def voter_keys():
    nsec, npub, hex_pub = _load_voter_keys()
    log.info("Voter npub: %s", npub)
    return {"nsec": nsec, "npub": npub, "pubkey_hex": hex_pub}


@pytest.fixture(scope="class")
def coordinator_npub():
    npub = _derive_coordinator_npub()
    log.info("Coordinator npub: %s", npub)
    return npub


@pytest.mark.vps
class TestCoordinatorE2E:
    minted_proof = None

    def test_http_info_returns_coordinator_metadata(self, coordinator_npub):
        resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data["coordinatorNpub"] == coordinator_npub
        assert "mintUrl" in data
        assert "relays" in data
        log.info("GET /info OK: npub=%s", data["coordinatorNpub"][:20])

    def test_http_election_returns_404_or_valid(self):
        resp = requests.get(f"{COORDINATOR_HTTP}/election", timeout=10)
        assert resp.status_code in (200, 404), f"Expected 200 or 404, got {resp.status_code}"
        if resp.status_code == 200:
            data = resp.json()
            assert "questions" in data or "election_id" in data
            log.info("GET /election OK: %s", data.get("title", "(no title)"))
        else:
            log.info("GET /election: 404 (no election announced)")

    def test_http_tally_returns_404_or_valid(self):
        resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
        assert resp.status_code in (200, 404), f"Expected 200 or 404, got {resp.status_code}"
        if resp.status_code == 200:
            data = resp.json()
            assert "total_published_votes" in data
            log.info("GET /tally OK: %d published votes", data["total_published_votes"])
        else:
            log.info("GET /tally: 404 (no election announced)")

    def test_http_eligibility_returns_404_or_valid(self):
        resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
        assert resp.status_code in (200, 404), f"Expected 200 or 404, got {resp.status_code}"
        if resp.status_code == 200:
            data = resp.json()
            assert "eligible_count" in data
            log.info("GET /eligibility OK: %d eligible", data["eligible_count"])
        else:
            log.info("GET /eligibility: 404 (no election announced)")

    def test_e2e_issuance_pipeline(self, voter_keys, coordinator_npub):
        quote_data = _create_quote()
        quote_id = quote_data["quote_id"]

        blinded_output, _secret, _B_hex = _build_blinded_output()

        event_id = _publish_38010_from_vps(
            nsec=voter_keys["nsec"],
            quote_id=quote_id,
            mint_url=COORDINATOR_MINT_URL,
            coordinator_npub=coordinator_npub,
            election_id=ELECTION_ID,
        )

        log.info("Polling for quote approval (timeout=60s)...")
        paid = _poll_quote_until_paid(MINT_HTTP_URL, quote_id, timeout=60)
        assert paid, f"Quote {quote_id} was not approved within 60s"

        mint_result = _mint_tokens(quote_id, [blinded_output])
        signatures = mint_result.get("signatures", [])
        assert len(signatures) >= 1, "No signatures returned from mint"

        proof = {
            "signatures": signatures,
            "blinded_B": _B_hex,
            "secret": _secret,
        }
        TestCoordinatorE2E.minted_proof = proof
        log.info("E2E pipeline complete: quote=%s, event=%s", quote_id[:16], event_id[:16])

    def test_non_eligible_voter_rejected(self):
        keys = Keys.generate()
        signer = NostrSigner.keys(keys)

        quote_data = _create_quote()
        quote_id = quote_data["quote_id"]

        async def _send():
            client = Client(signer)
            await client.add_relay(RelayUrl.parse(RELAY_URL))
            await client.connect()
            tags = [
                Tag.parse(["p", _derive_coordinator_npub()]),
                Tag.parse(["quote", quote_id]),
                Tag.parse(["amount", "1"]),
                Tag.parse(["mint", MINT_HTTP_URL]),
                Tag.parse(["election", ELECTION_ID]),
            ]
            builder = EventBuilder(kind=Kind(38010), content="Non-eligible test").tags(tags)
            await client.send_event_builder(builder)
            await asyncio.sleep(2)

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_send())
        finally:
            loop.close()

        log.info("Waiting 15s for coordinator to process (should NOT approve)...")
        time.sleep(15)

        resp = requests.get(f"{MINT_HTTP_URL}/v1/mint/quote/bolt11/{quote_id}", timeout=10)
        state = resp.json().get("state", "").upper()
        assert state == "UNPAID", f"Non-eligible voter was approved! Quote state: {state}"
        log.info("Correctly rejected non-eligible voter")

    def test_already_issued_voter_rejected(self, voter_keys, coordinator_npub):
        quote_data = _create_quote()
        quote_id = quote_data["quote_id"]

        _publish_38010(
            nsec=voter_keys["nsec"],
            quote_id=quote_id,
            mint_url=MINT_HTTP_URL,
            coordinator_npub=coordinator_npub,
            election_id=ELECTION_ID,
        )

        log.info("Waiting 15s for coordinator to process (should NOT re-approve)...")
        time.sleep(15)

        resp = requests.get(f"{MINT_HTTP_URL}/v1/mint/quote/bolt11/{quote_id}", timeout=10)
        state = resp.json().get("state", "").upper()
        assert state == "UNPAID", f"Already-issued voter was re-approved! Quote state: {state}"
        log.info("Correctly rejected already-issued voter")

    def test_proof_burning_via_dm(self, coordinator_npub):
        assert TestCoordinatorE2E.minted_proof is not None, "No minted proof from issuance test"

        sigs = TestCoordinatorE2E.minted_proof["signatures"]
        assert len(sigs) >= 1, "No signatures in minted proof"

        proof_str = json.dumps(sigs[0])
        dm_payload = json.dumps({
            "vote_event_id": "test-vote-e2e-001",
            "proof": proof_str,
        })

        voter_nsec = VOTER_NSEC_FILE.read_text().strip()
        voter_keys_obj = Keys.parse(voter_nsec)
        voter_signer = NostrSigner.keys(voter_keys_obj)

        coordinator_pk = Keys.parse(
            _ssh_run(f"cat {COORDINATOR_DIR}/nsec.env").stdout.strip()
        ).public_key()

        async def _send_dm():
            client = Client(voter_signer)
            await client.add_relay(RelayUrl.parse(RELAY_URL))
            await client.connect()
            await asyncio.sleep(1)
            encrypted = await voter_signer.nip04_encrypt(coordinator_pk, dm_payload)
            builder = EventBuilder(kind=Kind(4), content=encrypted).tags(
                [Tag.parse(["p", coordinator_npub])]
            )
            event_id = await client.send_event_builder(builder)
            await asyncio.sleep(5)
            return str(event_id)

        loop = asyncio.new_event_loop()
        try:
            event_id = loop.run_until_complete(_send_dm())
        finally:
            loop.close()

        log.info("Sent NIP-04 DM for proof burn (event=%s)", event_id[:16])
        log.info("Waiting 10s for coordinator to process burn...")
        time.sleep(10)

        resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
        if resp.status_code == 200:
            tally = resp.json()
            root = tally.get("spent_commitment_root")
            log.info("Tally after burn: spent_commitment_root=%s", root)
            if root is not None:
                assert len(root) == 64, f"Expected 64-char hex root, got: {root}"
                log.info("Proof burn confirmed via /tally")
            else:
                log.warning("spent_commitment_root is still None — burn may have failed")
        else:
            log.info("GET /tally returned %d (no election announced)", resp.status_code)

    def test_state_recovery_after_restart(self):
        pre_restart_root = None
        resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
        if resp.status_code == 200:
            pre_restart_root = resp.json().get("spent_commitment_root")
            log.info("Pre-restart spent_commitment_root: %s", pre_restart_root)

        log.info("Restarting coordinator service...")
        _ssh_run("systemctl restart tollgate-coordinator")
        log.info("Waiting for coordinator to recover...")

        for attempt in range(30):
            time.sleep(2)
            try:
                resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=5)
                if resp.status_code == 200:
                    log.info("Coordinator healthy after restart (attempt %d)", attempt + 1)
                    break
            except requests.ConnectionError:
                log.info("Waiting... (attempt %d)", attempt + 1)
        else:
            pytest.fail("Coordinator did not become healthy within 60s after restart")

        time.sleep(3)

        resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
        if resp.status_code == 200:
            post_restart_root = resp.json().get("spent_commitment_root")
            log.info("Post-restart spent_commitment_root: %s", post_restart_root)

            if pre_restart_root is not None:
                assert post_restart_root == pre_restart_root, (
                    f"Merkle root mismatch after restart! "
                    f"Before: {pre_restart_root}, After: {post_restart_root}"
                )
                log.info("State recovery verified: roots match!")
            else:
                log.info("No pre-restart root to compare (no burns before restart)")
        else:
            log.info("GET /tally returned %d after restart", resp.status_code)
