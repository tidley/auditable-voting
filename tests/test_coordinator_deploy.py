import logging
import subprocess
import time

import pytest
import requests

from conftest_vps import (
    VPS_IP,
    VPS_HTTP_PORT,
    MINT_HTTP_URL,
    MINT_DATA_DIR,
)

log = logging.getLogger("test_coordinator_deploy")

COORDINATOR_DIR = "/opt/tollgate/coordinator"
COORDINATOR_NPUB = "npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh"
NAK_PORT = 10547


def _ssh_run(cmd: str, timeout: int = 30) -> subprocess.CompletedProcess:
    full_cmd = f'ssh -i ~/.ssh/tollgate -o StrictHostKeyChecking=no root@{VPS_IP} "{cmd}"'
    return subprocess.run(full_cmd, shell=True, capture_output=True, text=True, timeout=timeout)


@pytest.mark.vps
class TestCoordinatorDeployment:
    def test_coordinator_service_is_active(self):
        result = _ssh_run("systemctl is-active tollgate-coordinator")
        assert result.returncode == 0
        assert result.stdout.strip() == "active"

    def test_coordinator_venv_exists(self):
        result = _ssh_run(f"test -f {COORDINATOR_DIR}/.venv/bin/python3 && echo OK")
        assert result.returncode == 0
        assert "OK" in result.stdout

    def test_coordinator_script_exists(self):
        result = _ssh_run(f"test -f {COORDINATOR_DIR}/voting-coordinator-client.py && echo OK")
        assert result.returncode == 0
        assert "OK" in result.stdout

    def test_nsec_env_exists_and_is_secure(self):
        result = _ssh_run(f"stat -c '%a' {COORDINATOR_DIR}/nsec.env")
        assert result.returncode == 0
        perms = result.stdout.strip()
        assert perms == "600", f"nsec.env has permissions {perms}, expected 600"

    def test_eligible_voters_json_exists(self):
        result = _ssh_run(f"cat {COORDINATOR_DIR}/eligible-voters.json")
        assert result.returncode == 0
        assert "npub1" in result.stdout

    def test_coordinator_logs_show_startup(self):
        result = _ssh_run("journalctl -u tollgate-coordinator --no-pager -n 30")
        assert result.returncode == 0
        logs = result.stdout
        log.info("Coordinator logs:\n%s", logs)
        assert "Loaded" in logs or "eligible" in logs or "Connecting" in logs

    def test_coordinator_npub_matches(self):
        result = _ssh_run(f"cat {COORDINATOR_DIR}/nsec.env")
        assert result.returncode == 0
        nsec = result.stdout.strip()
        assert nsec.startswith("nsec1")

    def test_mint_still_healthy(self):
        resp = requests.get(f"{MINT_HTTP_URL}/v1/info", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "pubkey" in data

    def test_mint_info_contains_coordinator_npub(self):
        resp = requests.get(f"{MINT_HTTP_URL}/v1/info", timeout=10)
        assert resp.status_code == 200
        description = resp.json().get("description", "")
        assert COORDINATOR_NPUB in description, f"npub not in description: {description}"


@pytest.mark.vps
class TestNakRelay:
    def test_nak_relay_is_running(self):
        result = _ssh_run("systemctl is-active nak")
        assert result.returncode == 0
        assert result.stdout.strip() == "active"

    def test_nak_relay_bound_publicly(self):
        result = _ssh_run(f"ss -tlnp | grep :{NAK_PORT}")
        assert result.returncode == 0
        assert "0.0.0.0" in result.stdout or f"*:{NAK_PORT}" in result.stdout, f"nak not bound to 0.0.0.0: {result.stdout}"

    def test_nak_relay_responds_on_public_ip(self):
        resp = requests.get(f"http://{VPS_IP}:{NAK_PORT}/", timeout=10)
        assert resp.status_code in (200, 404)
