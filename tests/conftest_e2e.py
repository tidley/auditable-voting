import asyncio
import hashlib
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
    PublicKey,
    RelayUrl,
    Tag,
)

log = logging.getLogger("e2e")

VPS_IP = "23.182.128.64"
COORDINATOR_HTTP = f"http://{VPS_IP}:8081"
MINT_HTTP = f"http://{VPS_IP}:3338"
COORDINATOR_INTERNAL_MINT = "http://127.0.0.1:3338"
LOCAL_RELAY = "ws://localhost:10547"
COORDINATOR_DIR = "/opt/tollgate/coordinator"
COORDINATOR_VENV_PYTHON = f"{COORDINATOR_DIR}/.venv/bin/python3"

VOTER_NSEC = "nsec1yvudafdwu78vl8v2pulcpu4kmdlp0jcfjhphj8rg8jaxztepmawsv6txzp"

SSH_CMD = [
    "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    f"root@{VPS_IP}",
]

PUBLISH_38008_SCRIPT = r'''
import asyncio, json, sys, time
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    nsec = sys.argv[1]
    eid = sys.argv[2]
    content = sys.argv[3]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    await asyncio.sleep(1)
    tags = [Tag.parse(["election", eid])]
    builder = EventBuilder(kind=Kind(38008), content=content).tags(tags)
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(2)
    print(event_id.id.to_hex())

asyncio.run(main())
'''

PUBLISH_38009_SCRIPT = r'''
import asyncio, json, sys
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    nsec = sys.argv[1]
    eid = sys.argv[2]
    content = sys.argv[3]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    await asyncio.sleep(1)
    tags = [Tag.parse(["election", eid])]
    builder = EventBuilder(kind=Kind(38009), content=content).tags(tags)
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(2)
    print(event_id.id.to_hex())

asyncio.run(main())
'''

PUBLISH_38010_SCRIPT = r'''
import asyncio, sys
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    nsec = sys.argv[1]
    coord_hex = sys.argv[2]
    qid = sys.argv[3]
    bolt11 = sys.argv[4]
    mint = sys.argv[5]
    eid = sys.argv[6]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    await asyncio.sleep(1)
    tags = [
        Tag.parse(["p", coord_hex]),
        Tag.parse(["t", "cashu-issuance"]),
        Tag.parse(["quote", qid]),
        Tag.parse(["invoice", bolt11]),
        Tag.parse(["mint", mint]),
        Tag.parse(["amount", "1"]),
        Tag.parse(["election", eid]),
    ]
    builder = EventBuilder(kind=Kind(38010), content="E2E test issuance request").tags(tags)
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(3)
    print(event_id.id.to_hex())

asyncio.run(main())
'''

PUBLISH_38000_SCRIPT = r'''
import asyncio, json, sys, time
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    nsec = sys.argv[1]
    eid = sys.argv[2]
    ballot_content = sys.argv[3]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    await asyncio.sleep(1)
    tags = [Tag.parse(["election", eid])]
    builder = EventBuilder(kind=Kind(38000), content=ballot_content).tags(tags)
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(3)
    print(event_id.id.to_hex())

asyncio.run(main())
'''

SEND_DM_SCRIPT = r'''
import asyncio, json, sys
from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl

async def main():
    sender_nsec = sys.argv[1]
    coord_hex = sys.argv[2]
    payload_path = sys.argv[3]
    coord_npub = sys.argv[4]
    with open(payload_path, "r") as f:
        dm_payload = f.read()
    keys = Keys.parse(sender_nsec)
    signer = NostrSigner.keys(keys)
    try:
        from nostr_sdk import PublicKey
        coord_pk = PublicKey.parse(coord_npub)
    except:
        pass
    client = Client(signer)
    await client.add_relay(RelayUrl.parse("ws://localhost:10547"))
    await client.connect()
    await asyncio.sleep(1)
    encrypted = await signer.nip04_encrypt(coord_pk, dm_payload)
    builder = EventBuilder(kind=Kind(4), content=encrypted).tags(
        [Tag.parse(["p", coord_hex])]
    )
    event_id = await client.send_event_builder(builder)
    await asyncio.sleep(3)
    print(event_id.id.to_hex())

asyncio.run(main())
'''


def ssh_run(cmd: str, check: bool = True, timeout: int = 60) -> subprocess.CompletedProcess:
    full_cmd = SSH_CMD + [cmd]
    return subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout, check=check)


def ssh_run_script(script: str, args: list[str], check: bool = True, timeout: int = 60) -> str:
    import uuid
    remote_path = f"/tmp/e2e_script_{uuid.uuid4().hex[:8]}.py"
    ssh_run(f"cat > {remote_path} << 'PYEOF'\n{script}\nPYEOF", check=True)
    args_str = " ".join(f"'{a}'" for a in args)
    try:
        result = ssh_run(f"{COORDINATOR_VENV_PYTHON} {remote_path} {args_str}", check=check, timeout=timeout)
    finally:
        ssh_run(f"rm -f {remote_path}", check=False)
    return result.stdout.strip()


def derive_keys(nsec: str) -> tuple[str, str, str]:
    keys = Keys.parse(nsec)
    return nsec, keys.public_key().to_bech32(), keys.public_key().to_hex()


def publish_on_vps(script: str, args: list[str], timeout: int = 60) -> str:
    event_id = ssh_run_script(script, args, timeout=timeout)
    assert len(event_id) > 10, f"Failed to publish event on VPS"
    log.info("Published event: %s", event_id[:20])
    return event_id


def get_coordinator_npub() -> str:
    resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
    resp.raise_for_status()
    return resp.json()["coordinatorNpub"]


def get_coordinator_hex_pubkey() -> str:
    nsec = ssh_run(f"cat {COORDINATOR_DIR}/nsec.env").stdout.strip()
    keys = Keys.parse(nsec)
    return keys.public_key().to_hex()


def get_coordinator_nsec() -> str:
    return ssh_run(f"cat {COORDINATOR_DIR}/nsec.env").stdout.strip()


def poll_until(url: str, timeout: int = 30, expect_status: int = 200, interval: float = 2.0) -> requests.Response:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            resp = requests.get(url, timeout=10)
            if resp.status_code == expect_status:
                return resp
            last_error = f"HTTP {resp.status_code}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(interval)
    pytest.fail(f"poll_until({url}) failed after {timeout}s: {last_error}")


def create_mint_quote() -> dict:
    resp = requests.post(f"{MINT_HTTP}/v1/mint/quote/bolt11", json={"amount": 1, "unit": "sat"}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    quote_id = data.get("quote") or data.get("quote_id")
    assert quote_id, f"No quote_id in response: {data}"
    data["quote_id"] = quote_id
    log.info("Created quote: %s", quote_id)
    return data


def poll_quote_paid(quote_id: str, timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = requests.get(f"{MINT_HTTP}/v1/mint/quote/bolt11/{quote_id}", timeout=10)
            if resp.status_code == 200:
                state = resp.json().get("state", "").upper()
                if state == "PAID":
                    return True
                log.info("Quote state: %s", state)
        except requests.RequestException:
            pass
        time.sleep(2)
    return False


def build_blinded_output() -> tuple[dict, str, str]:
    import secrets
    from cashu.core.base import BlindedMessage
    from cashu.core.crypto.b_dhke import step1_alice

    secret = secrets.token_hex(32)
    B_, r = step1_alice(secret)
    B_hex = B_.format(compressed=True).hex()

    resp = requests.get(f"{MINT_HTTP}/v1/keysets", timeout=10)
    resp.raise_for_status()
    keysets = resp.json().get("keysets", [])
    sat_ks = [ks for ks in keysets if ks.get("unit") == "sat" and ks.get("active")]
    assert sat_ks, f"No active sat keyset: {keysets}"
    keyset_id = sat_ks[0]["id"]

    blinded_msg = BlindedMessage(amount=1, id=keyset_id, B_=B_hex, C_=None)
    output_dict = blinded_msg.model_dump(mode="json")
    log.info("Built blinded output (keyset=%s)", keyset_id)
    return output_dict, secret, r.to_hex()


def unblind_signature(blind_sig: dict, secret: str, r_hex: str) -> dict:
    from coincurve import PrivateKey as EcPrivateKey, PublicKey as EcPublicKey
    from cashu.core.crypto.b_dhke import step3_alice

    C_ = EcPublicKey(bytes.fromhex(blind_sig["C_"]))
    r = EcPrivateKey(bytes.fromhex(r_hex))

    resp = requests.get(f"{MINT_HTTP}/v1/keysets", timeout=10)
    keysets_data = resp.json().get("keysets", [])
    ks_id = blind_sig["id"]
    ks_meta = next((k for k in keysets_data if k["id"] == ks_id), None)
    assert ks_meta, f"Keyset {ks_id} not found"

    ks_resp = requests.get(f"{MINT_HTTP}/v1/keys/{ks_id}", timeout=10)
    ks_resp.raise_for_status()
    keys_data = ks_resp.json()
    if isinstance(keys_data, dict):
        ks_entry = keys_data.get("keysets", [keys_data])
        if isinstance(ks_entry, list) and len(ks_entry) > 0:
            pubkeys = ks_entry[0].get("keys", {})
        elif ks_id in keys_data:
            pubkeys = keys_data[ks_id]
        else:
            pubkeys = keys_data
    else:
        pubkeys = keys_data

    amount = blind_sig["amount"]
    A_hex = pubkeys.get(str(amount)) if isinstance(pubkeys, dict) else None
    assert A_hex, f"No public key for amount {amount} in keyset {ks_id}: {pubkeys}"
    A = EcPublicKey(bytes.fromhex(A_hex))

    C = step3_alice(C_, r, A)
    proof = {
        "id": blind_sig["id"],
        "amount": blind_sig["amount"],
        "secret": secret,
        "C": C.format(compressed=True).hex(),
    }
    if blind_sig.get("dleq"):
        proof["dleq"] = {
            "e": blind_sig["dleq"]["e"],
            "s": blind_sig["dleq"]["s"],
            "r": r_hex,
        }
    log.info("Unblinded signature into proof (C=%s...)", proof["C"][:20])
    return proof


def mint_tokens(quote_id: str, blinded_outputs: list[dict]) -> dict:
    resp = requests.post(
        f"{MINT_HTTP}/v1/mint/bolt11",
        json={"quote": quote_id, "outputs": blinded_outputs},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    sigs = data.get("signatures", [])
    assert len(sigs) >= 1, f"No signatures returned: {data}"
    log.info("Minted %d signature(s)", len(sigs))
    return data
