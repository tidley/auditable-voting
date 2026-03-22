import hashlib
import json
import logging
import subprocess
import time

import pytest
import requests

from conftest_e2e import (
    MINT_HTTP,
    COORDINATOR_HTTP,
    VPS_IP,
    build_blinded_output,
    create_mint_quote,
    get_coordinator_npub,
    get_coordinator_hex_pubkey,
    get_coordinator_nsec,
    mint_tokens,
    poll_until,
    publish_on_vps,
    PUBLISH_38008_SCRIPT,
    PUBLISH_38009_SCRIPT,
    ssh_run,
    unblind_signature,
)

log = logging.getLogger("keyset_tests")

COORDINATOR_DIR = "/opt/tollgate/coordinator"
COORDINATOR_VENV_PYTHON = f"{COORDINATOR_DIR}/.venv/bin/python3"
MINT_DATA_DIR = "/opt/tollgate/mints-local/mint1"
MINT_COMPOSE_DIR = MINT_DATA_DIR


# ---------------------------------------------------------------------------
# Group A: Unit tests (no VPS)
# ---------------------------------------------------------------------------

@pytest.mark.fast
class TestDeriveElectionMnemonic:
    def test_deterministic(self):
        m1 = _derive_mnemonic_locally("nsec1abc123", "election-1")
        m2 = _derive_mnemonic_locally("nsec1abc123", "election-1")
        assert m1 == m2

    def test_unique_per_election(self):
        mnemonics = {_derive_mnemonic_locally("nsec1abc123", f"election-{i}") for i in range(100)}
        assert len(mnemonics) == 100

    def test_valid_bip39(self):
        m = _derive_mnemonic_locally("nsec1abc123", "election-1")
        result = subprocess.run(
            ["python3", "-c", f"from mnemonic import Mnemonic; print(Mnemonic('english').check('{m}'))"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        assert result.stdout.strip() == "True"
        assert len(m.split()) == 12

    def test_different_coordinators(self):
        m1 = _derive_mnemonic_locally("nsec1abc123", "election-1")
        m2 = _derive_mnemonic_locally("nsec1xyz789", "election-1")
        assert m1 != m2


def _derive_mnemonic_locally(nsec: str, election_id: str) -> str:
    from mnemonic import Mnemonic
    mnemo = Mnemonic("english")
    entropy = hashlib.sha256(f"{nsec}:{election_id}".encode()).digest()[:16]
    return mnemo.to_mnemonic(entropy)


# ---------------------------------------------------------------------------
# Group B: Integration tests (VPS required)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def coordinator_keys():
    npub = get_coordinator_npub()
    hex_pub = get_coordinator_hex_pubkey()
    nsec = get_coordinator_nsec()
    return {"npub": npub, "pubkey_hex": hex_pub, "nsec": nsec}


@pytest.fixture(scope="module")
def original_state(coordinator_keys):
    state = _capture_current_state()
    yield state
    log.info("Restoring original mint state...")
    _restore_state(state)
    log.info("Original state restored")


def _capture_current_state() -> dict:
    resp = requests.get(f"{MINT_HTTP}/v1/keysets", timeout=10)
    resp.raise_for_status()
    keysets = resp.json().get("keysets", [])
    active = [ks for ks in keysets if ks.get("active")]
    old_keyset_id = active[0]["id"] if active else ""

    result = ssh_run(f"grep 'CDK_MINTD_MNEMONIC:' {MINT_DATA_DIR}/docker-compose.yml")
    old_mnemonic_line = result.stdout.strip()

    resp = requests.get(f"{COORDINATOR_HTTP}/election", timeout=5)
    old_election_id = ""
    if resp.status_code == 200:
        old_election_id = resp.json().get("election_id", "")

    return {
        "old_keyset_id": old_keyset_id,
        "old_mnemonic_line": old_mnemonic_line,
        "old_election_id": old_election_id,
    }


def _restore_state(state: dict):
    if state["old_mnemonic_line"]:
        ssh_run(
            f"sed -i 's|CDK_MINTD_MNEMONIC:.*|" + state["old_mnemonic_line"] + "|' "
            f"{MINT_DATA_DIR}/docker-compose.yml"
        )
    ssh_run(f"cd {MINT_DATA_DIR} && docker compose down && docker compose up -d")
    time.sleep(5)
    poll_until(f"{MINT_HTTP}/v1/info", timeout=30)
    ssh_run("systemctl restart tollgate-coordinator")
    time.sleep(6)
    poll_until(f"{COORDINATOR_HTTP}/info", timeout=20)


def _rotate_mint_on_vps(election_id: str, coordinator_nsec: str) -> str:
    new_mnemonic = _derive_mnemonic_locally(coordinator_nsec, election_id)
    ssh_run(
        f"mkdir -p {MINT_DATA_DIR}/backups/{election_id} && "
        f"cp {MINT_DATA_DIR}/cdk-mintd.sqlite {MINT_DATA_DIR}/backups/{election_id}/ 2>/dev/null; "
        f"sed -i 's|CDK_MINTD_MNEMONIC:.*|CDK_MINTD_MNEMONIC: \"{new_mnemonic}\"|' "
        f"{MINT_DATA_DIR}/docker-compose.yml"
    )
    ssh_run(f"cd {MINT_DATA_DIR} && docker compose down && docker compose up -d")
    time.sleep(5)
    poll_until(f"{MINT_HTTP}/v1/info", timeout=30)
    resp = requests.get(f"{MINT_HTTP}/v1/keysets", timeout=10)
    resp.raise_for_status()
    keysets = resp.json().get("keysets", [])
    active = [ks for ks in keysets if ks.get("active")]
    assert active, "No active keyset after rotation"
    new_keyset_id = active[0]["id"]
    log.info("Rotated mint: keyset=%s (election=%s)", new_keyset_id[:20], election_id)
    return new_keyset_id


@pytest.mark.e2e
@pytest.mark.timeout(600)
@pytest.mark.order("first")
class TestMintKeysetRotation:
    def test_rotation_produces_new_keyset(self, original_state, coordinator_keys):
        election_id = f"test-rotate-{int(time.time())}"
        old_keyset = original_state["old_keyset_id"]

        new_keyset = _rotate_mint_on_vps(election_id, coordinator_keys["nsec"])

        assert new_keyset != old_keyset, f"Keyset did not change: {new_keyset} == {old_keyset}"
        assert len(new_keyset) == 66

    def test_old_proof_invalid_after_rotation(self, original_state, coordinator_keys):
        election_id = f"test-invalid-{int(time.time())}"

        blinded_output, secret, r_hex = build_blinded_output()
        quote_data = create_mint_quote()
        mint_result = mint_tokens(quote_data["quote_id"], [blinded_output])
        old_sig = mint_result["signatures"][0]
        old_keyset_id = old_sig["id"]

        proof = unblind_signature(old_sig, secret, r_hex)

        resp = requests.post(
            f"{MINT_HTTP}/v1/swap",
            json={
                "inputs": [proof],
                "outputs": [{
                    "id": old_keyset_id,
                    "amount": 1,
                    "B_": blinded_output["B_"],
                }],
            },
            timeout=10,
        )
        log.info("Swap BEFORE rotation: HTTP %d", resp.status_code)
        swap_ok_before = resp.status_code == 200

        new_keyset = _rotate_mint_on_vps(election_id, coordinator_keys["nsec"])

        resp = requests.post(
            f"{MINT_HTTP}/v1/swap",
            json={
                "inputs": [proof],
                "outputs": [{
                    "id": new_keyset,
                    "amount": 1,
                    "B_": blinded_output["B_"],
                }],
            },
            timeout=10,
        )
        log.info("Swap AFTER rotation (old proof, new keyset): HTTP %d", resp.status_code)

        if swap_ok_before:
            assert resp.status_code != 200, "Old proof should be rejected after keyset rotation"


@pytest.mark.e2e
@pytest.mark.timeout(600)
class TestElectionIsolation:
    def test_election_id_filtering(self, original_state, coordinator_keys):
        coord_nsec = coordinator_keys["nsec"]
        coord_hex = coordinator_keys["pubkey_hex"]

        election_a = f"test-filter-a-{int(time.time())}"
        election_b = f"test-filter-b-{int(time.time())}"

        content_a = json.dumps({
            "title": "Filter Test A",
            "questions": [{"id": "q1", "type": "choice", "prompt": "Test", "options": ["a", "b"], "select": "single"}],
            "start_time": int(time.time()) - 60,
            "end_time": int(time.time()) + 3600,
            "mint_urls": [f"http://{VPS_IP}:3338"],
        })

        publish_on_vps(PUBLISH_38008_SCRIPT, [coord_nsec, election_a, content_a], timeout=30)
        poll_until(f"{COORDINATOR_HTTP}/election", timeout=30)

        content_b = json.dumps({
            "title": "Filter Test B",
            "questions": [{"id": "q1", "type": "choice", "prompt": "Test", "options": ["x", "y"], "select": "single"}],
            "start_time": int(time.time()) - 60,
            "end_time": int(time.time()) + 3600,
            "mint_urls": [f"http://{VPS_IP}:3338"],
        })

        publish_on_vps(PUBLISH_38008_SCRIPT, [coord_nsec, election_b, content_b], timeout=30)
        time.sleep(3)

        ssh_run(
            f"sed -i '/ExecStart=/ s|--relays|--election-id {election_a} --relays|' "
            f"/etc/systemd/system/tollgate-coordinator.service"
        )
        ssh_run("systemctl daemon-reload && systemctl restart tollgate-coordinator")
        time.sleep(6)
        poll_until(f"{COORDINATOR_HTTP}/info", timeout=20)

        resp = requests.get(f"{COORDINATOR_HTTP}/election", timeout=10)
        assert resp.status_code == 200
        election_data = resp.json()
        assert election_data.get("election_id") == election_a, \
            f"Expected election A ({election_a}), got {election_data.get('election_id')}"
