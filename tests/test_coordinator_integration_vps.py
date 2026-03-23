import logging
import subprocess
import time
from unittest.mock import MagicMock

import grpc
import pytest
import requests

from conftest_vps import (
    VPS_IP,
    VPS_HTTP_PORT,
    VPS_GRPC_PORT,
    VPS_SSH_KEY,
    VPS_SSH_USER,
    MINT_HTTP_URL,
    MINT_GRPC_LOCAL_PORT,
    MINT_DATA_DIR,
)

from voting_coordinator_client import (
    approve_quote_via_grpc,
    verify_quote_on_mint,
    process_issuance_request,
)

log = logging.getLogger("vps_tests")

ELIGIBLE_PUBKEY = "a" * 64
WRONG_MINT_URL = "http://23.182.128.64:3339"

SSH_CMD = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "-i", VPS_SSH_KEY,
    f"{VPS_SSH_USER}@{VPS_IP}",
]


def _ssh_run(cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    full_cmd = SSH_CMD + [cmd]
    return subprocess.run(full_cmd, capture_output=True, text=True, timeout=60, check=check)


@pytest.fixture(scope="session")
def ssh_tunnel():
    log.info("Opening SSH tunnel: localhost:%d -> %s:%d", MINT_GRPC_LOCAL_PORT, VPS_IP, VPS_GRPC_PORT)
    proc = subprocess.Popen(
        [
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ExitOnForwardFailure=yes",
            "-L", f"{MINT_GRPC_LOCAL_PORT}:127.0.0.1:{VPS_GRPC_PORT}",
            "-N",
            "-i", VPS_SSH_KEY,
            f"{VPS_SSH_USER}@{VPS_IP}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    time.sleep(2)
    if proc.poll() is not None:
        _, stderr = proc.communicate()
        pytest.exit(f"SSH tunnel failed to start: {stderr.decode().strip()}", returncode=1)

    yield

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    log.info("SSH tunnel closed")


@pytest.fixture(autouse=True)
def fresh_mint(ssh_tunnel):
    log.info("Resetting mint (per-test clean state)...")
    _ssh_run(
        f"cd {MINT_DATA_DIR} "
        "&& docker compose down -v 2>/dev/null "
        "&& find . -mindepth 1 "
        "   ! -name 'docker-compose.yml' "
        "   ! -name 'mnemonic.txt' "
        "   -delete "
        "&& docker compose up -d"
    )

    for attempt in range(20):
        try:
            resp = requests.get(f"{MINT_HTTP_URL}/v1/info", timeout=3)
            if resp.status_code == 200:
                log.info("Mint healthy after reset (attempt %d)", attempt + 1)
                yield
                return
        except requests.ConnectionError:
            pass
        time.sleep(1)

    pytest.exit("Mint did not become healthy after reset", returncode=1)


@pytest.fixture
def fresh_quote():
    resp = requests.post(
        f"{MINT_HTTP_URL}/v1/mint/quote/bolt11",
        json={"amount": 1, "unit": "sat"},
        timeout=10,
    )
    assert resp.status_code in (200, 201), f"Failed to create quote: {resp.text}"
    data = resp.json()
    quote_id = data.get("quote_id") or data.get("quote")
    assert quote_id, f"No quote_id/quote in response: {data}"
    log.info("Created fresh quote: %s", quote_id)
    data["quote_id"] = quote_id
    return data


@pytest.fixture
def grpc_endpoint():
    return f"localhost:{MINT_GRPC_LOCAL_PORT}"


@pytest.fixture
def mock_nostr_client_vps():
    return MagicMock()


@pytest.mark.vps
class TestVerifyQuoteOnMint:
    def test_verify_quote_on_mint_real(self, fresh_quote):
        result = verify_quote_on_mint(MINT_HTTP_URL, fresh_quote["quote_id"])
        assert result is not None
        assert result["state"].upper() == "UNPAID"
        assert result["amount"] == 1

    def test_verify_nonexistent_quote_returns_none(self):
        result = verify_quote_on_mint(MINT_HTTP_URL, "nonexistent_quote_id")
        assert result is None


@pytest.mark.vps
class TestApproveQuoteViaGrpc:
    def test_approve_quote_via_grpc_real(self, fresh_quote, grpc_endpoint):
        approve_quote_via_grpc(grpc_endpoint, fresh_quote["quote_id"])
        resp = requests.get(
            f"{MINT_HTTP_URL}/v1/mint/quote/bolt11/{fresh_quote['quote_id']}",
            timeout=10,
        )
        assert resp.status_code == 200
        assert resp.json()["state"].upper() == "PAID"

    def test_approve_nonexistent_quote_fails(self, grpc_endpoint):
        with pytest.raises(grpc.RpcError):
            approve_quote_via_grpc(grpc_endpoint, "nonexistent_quote_id")


@pytest.mark.vps
class TestProcessIssuanceRequest:
    def test_full_flow(self, fresh_quote, grpc_endpoint, mock_nostr_client_vps):
        issued_set = set()

        event_data = {
            "pubkey": ELIGIBLE_PUBKEY,
            "quote": fresh_quote["quote_id"],
            "amount": "1",
            "mint": MINT_HTTP_URL,
            "election": "test-election",
        }

        process_issuance_request(
            event_data,
            {ELIGIBLE_PUBKEY},
            issued_set,
            grpc_endpoint,
            MINT_HTTP_URL,
            mock_nostr_client_vps,
        )

        assert ELIGIBLE_PUBKEY in issued_set
        resp = requests.get(
            f"{MINT_HTTP_URL}/v1/mint/quote/bolt11/{fresh_quote['quote_id']}",
            timeout=10,
        )
        assert resp.json()["state"].upper() == "PAID"

    def test_rejects_wrong_mint_url(self, fresh_quote, grpc_endpoint, mock_nostr_client_vps):
        issued_set = set()

        event_data = {
            "pubkey": ELIGIBLE_PUBKEY,
            "quote": fresh_quote["quote_id"],
            "amount": "1",
            "mint": WRONG_MINT_URL,
            "election": "test-election",
        }

        process_issuance_request(
            event_data,
            {ELIGIBLE_PUBKEY},
            issued_set,
            grpc_endpoint,
            MINT_HTTP_URL,
            mock_nostr_client_vps,
        )

        assert ELIGIBLE_PUBKEY not in issued_set

    def test_rejects_already_issued(self, fresh_quote, grpc_endpoint, mock_nostr_client_vps):
        issued_set = {ELIGIBLE_PUBKEY}

        event_data = {
            "pubkey": ELIGIBLE_PUBKEY,
            "quote": fresh_quote["quote_id"],
            "amount": "1",
            "mint": MINT_HTTP_URL,
            "election": "test-election",
        }

        process_issuance_request(
            event_data,
            {ELIGIBLE_PUBKEY},
            issued_set,
            grpc_endpoint,
            MINT_HTTP_URL,
            mock_nostr_client_vps,
        )

        resp = requests.get(
            f"{MINT_HTTP_URL}/v1/mint/quote/bolt11/{fresh_quote['quote_id']}",
            timeout=10,
        )
        assert resp.json()["state"].upper() == "UNPAID"
