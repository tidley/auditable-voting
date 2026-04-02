import importlib.util
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
COORDINATOR_SOURCE_DIR = PROJECT_ROOT / "coordinator"

_spec = importlib.util.spec_from_file_location(
    "voting_coordinator_client",
    COORDINATOR_SOURCE_DIR / "voting-coordinator-client.py",
)
if _spec and _spec.loader:
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    sys.modules["voting_coordinator_client"] = _mod
WEB_DIR = PROJECT_ROOT / "web"

COORDINATOR_URL = os.environ.get(
    "COORDINATOR_URL", "http://23.182.128.64:8081"
)
MINT_URL = os.environ.get(
    "MINT_URL", "http://23.182.128.64:3338"
)


def _check_js(script: str) -> tuple[bool, str]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=15,
        cwd=str(WEB_DIR),
    )
    return result.returncode == 0, result.stdout + result.stderr


def _run_in_web(cmd: list[str], timeout: int = 60) -> tuple[bool, str]:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(WEB_DIR),
    )
    return result.returncode == 0, result.stdout + result.stderr


log = logging.getLogger("ui")

VPS_IP = os.environ.get("VPS_IP", "23.182.128.64")
COORDINATOR_HTTP = os.environ.get("COORDINATOR_HTTP", f"http://{VPS_IP}:8081")
COORDINATOR_DIR = "/opt/tollgate/coordinator"
BASE_URL = os.environ.get("BASE_URL", f"http://vote.mints.{VPS_IP}.sslip.io")
VOTING_URL = os.environ.get("VOTING_URL", f"{BASE_URL}/vote.html")
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", f"{BASE_URL}/dashboard.html")

SSH_CMD = [
    "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15",
    f"root@{VPS_IP}",
]

ELIGIBLE_VOTERS_PATH = PROJECT_ROOT / "eligible-voters.json"

COORDINATOR_VENV_PYTHON = f"{COORDINATOR_DIR}/.venv/bin/python3"


def _ssh_run(cmd: str, timeout: int = 30):
    result = subprocess.run(
        SSH_CMD + [cmd], capture_output=True, text=True, timeout=timeout
    )
    return result


def _publish_38009_on_vps(eligible_voters, election_id=None, coordinator_nsec=None):
    import hashlib
    if not election_id:
        resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
        election_id = resp.json().get("electionId", "")
    if not election_id:
        return
    if not coordinator_nsec:
        result = _ssh_run(f"cat {COORDINATOR_DIR}/nsec.env")
        coordinator_nsec = result.stdout.strip()

    eligible_root = hashlib.sha256("\n".join(eligible_voters).encode()).hexdigest()
    elig_content = json.dumps({
        "eligible_count": len(eligible_voters),
        "eligible_npubs": eligible_voters,
        "eligible_root": eligible_root,
    })
    elig_escaped = elig_content.replace("'", "'\\''")
    publish_script = (
        "import asyncio, json\n"
        "from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl\n"
        "async def main():\n"
        f"    nsec = '{coordinator_nsec}'\n"
        f"    eid = '{election_id}'\n"
        f"    content = '{elig_escaped}'\n"
        "    keys = Keys.parse(nsec)\n"
        "    signer = NostrSigner.keys(keys)\n"
        "    client = Client(signer)\n"
        "    await client.add_relay(RelayUrl.parse('ws://localhost:10547'))\n"
        "    await client.connect()\n"
        "    await asyncio.sleep(1)\n"
        "    tags = [Tag.parse(['election', eid])]\n"
        "    builder = EventBuilder(kind=Kind(38009), content=content).tags(tags)\n"
        "    event_id = await client.send_event_builder(builder)\n"
        "    await asyncio.sleep(2)\n"
        "    print(event_id.id.to_hex())\n"
        "asyncio.run(main())\n"
    )
    remote_script = f"/tmp/e2e_38009_{hashlib.md5(elig_content.encode()).hexdigest()[:8]}.py"
    _ssh_run(f"cat > {remote_script} << 'PYEOF'\n{publish_script}\nPYEOF")
    result = _ssh_run(f"{COORDINATOR_VENV_PYTHON} {remote_script}", timeout=30)
    _ssh_run(f"rm -f {remote_script}")
    return result.stdout.strip()


def _poll_until(url: str, timeout: int = 30, expect_status: int = 200):
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
        time.sleep(2)
    pytest.fail(f"poll_until({url}) failed after {timeout}s: {last_error}")


def _sync_eligible_on_vps(eligible_voters, also_publish_38009=True):
    payload = json.dumps(eligible_voters)
    _ssh_run(
        f"echo '{payload}' > {COORDINATOR_DIR}/eligible-voters.json"
    )
    if also_publish_38009:
        _publish_38009_on_vps(eligible_voters)
    _ssh_run("systemctl restart tollgate-coordinator")
    time.sleep(6)
    _poll_until(f"{COORDINATOR_HTTP}/info", timeout=20)


@pytest.fixture(scope="session")
def eligible_voters():
    if not ELIGIBLE_VOTERS_PATH.exists():
        pytest.skip(f"eligible-voters.json not found at {ELIGIBLE_VOTERS_PATH}")
    data = json.loads(ELIGIBLE_VOTERS_PATH.read_text())
    assert isinstance(data, list) and len(data) > 0, f"No eligible voters in {ELIGIBLE_VOTERS_PATH}"
    log.info("Loaded %d eligible voters from %s", len(data), ELIGIBLE_VOTERS_PATH)
    return sorted(data)


@pytest.fixture(scope="session")
def vps_eligible_synced(eligible_voters):
    resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
    resp.raise_for_status()
    current_npubs = sorted(resp.json().get("eligible_npubs", []))

    if current_npubs == eligible_voters:
        log.info("VPS eligible list already in sync (%d npubs)", len(eligible_voters))
    else:
        log.info(
            "Syncing VPS eligible list: %d -> %d npubs",
            len(current_npubs), len(eligible_voters),
        )
        _sync_eligible_on_vps(eligible_voters, also_publish_38009=True)

        resp2 = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
        actual_count = resp2.json().get("eligible_count", 0)
        log.info(
            "VPS coordinator restarted: expected %d eligible, got %d",
            len(eligible_voters), actual_count,
        )

    yield eligible_voters


@pytest.fixture(scope="session")
def test_voter_keys():
    from nostr_sdk import Keys
    keys = Keys.generate()
    nsec = keys.secret_key().to_bech32()
    npub = keys.public_key().to_bech32()
    hex_pub = keys.public_key().to_hex()
    log.info("Generated test voter keypair: %s", npub[:30])
    return {"nsec": nsec, "npub": npub, "pubkey_hex": hex_pub}


@pytest.fixture(scope="session")
def test_voter_added(test_voter_keys, vps_eligible_synced):
    voter_npub = test_voter_keys["npub"]
    resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
    resp.raise_for_status()
    current = resp.json().get("eligible_npubs", [])

    if voter_npub in current:
        log.info("Test voter already in eligible list")
    else:
        updated = sorted(current + [voter_npub])
        _sync_eligible_on_vps(updated, also_publish_38009=True)
        log.info("Added test voter to eligible list (total: %d)", len(updated))

        resp2 = _poll_until(f"{COORDINATOR_HTTP}/eligibility", timeout=30)
        actual_count = resp2.json().get("eligible_count", 0)
        log.info("After adding test voter: expected %d eligible, got %d", len(updated), actual_count)

    yield test_voter_keys

    log.info("Test voter fixture torn down (eligible list persists on VPS)")


@pytest.fixture(scope="session")
def coordinator_hex_pubkey():
    resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
    resp.raise_for_status()
    info = resp.json()
    from nostr_sdk import PublicKey
    npub = info["coordinatorNpub"]
    pk = PublicKey.parse(npub)
    return pk.to_hex()


SCREENSHOT_DIR = PROJECT_ROOT / "test-screenshots"


@pytest.fixture(scope="session")
def deployed_frontend():
    """Build the frontend and deploy to VPS. Runs once per test session."""
    log.info("Cleaning vite cache for a fresh build...")
    subprocess.run(["rm", "-rf", str(WEB_DIR / "dist"), str(WEB_DIR / "node_modules" / ".vite")], timeout=10)

    log.info("Building frontend...")
    build = subprocess.run(
        ["npm", "run", "build"],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(WEB_DIR),
        env={**os.environ, "VITE_USE_MOCK": "false", "VITE_COORDINATOR_URL": "/api", "VITE_MINT_URL": "/mint"},
    )
    if build.returncode != 0:
        pytest.fail(f"Frontend build failed:\n{build.stdout}\n{build.stderr}")
    log.info("Frontend built successfully")

    css_files = list(WEB_DIR.glob("dist/assets/styles-*.css"))
    assert css_files, "No styles CSS file found in dist/assets after build"
    local_css = css_files[0].read_text()
    assert "max-width:none" in local_css.replace(" ", ""), (
        f"Built CSS still has max-width constraint on hero elements. "
        f"Check styles.css for stale max-width values on .hero-card h1 or .hero-copy"
    )
    assert "62ch" not in local_css, (
        "Built CSS still contains '62ch' max-width. "
        "The hero-title and hero-copy should use max-width:none."
    )
    log.info("Local build CSS verified: max-width:none on hero elements")

    dist_tar = "/tmp/voting-dist.tar.gz"
    subprocess.run(
        ["tar", "czf", dist_tar, "-C", str(WEB_DIR / "dist"), "."],
        check=True, timeout=30,
    )

    subprocess.run(
        ["scp", "-o", "StrictHostKeyChecking=no", dist_tar, f"root@{VPS_IP}:/tmp/voting-dist.tar.gz"],
        check=True, timeout=30,
    )

    result = _ssh_run(
        f"rm -rf /opt/auditable-voting/web/dist "
        f"&& mkdir -p /opt/auditable-voting/web/dist "
        f"&& tar xzf /tmp/voting-dist.tar.gz -C /opt/auditable-voting/web/dist "
        f"&& docker restart voting-client "
        f"&& sleep 3 "
        f"&& rm -f /tmp/voting-dist.tar.gz",
        timeout=30,
    )
    subprocess.run(["rm", "-f", dist_tar], timeout=5)

    _poll_until(
        BASE_URL,
        timeout=30,
        expect_status=200,
    )

    remote_css_check = _ssh_run(
        "grep -rl 'max-width:none' /opt/auditable-voting/web/dist/assets/ | head -1",
        timeout=10,
    )
    assert remote_css_check.returncode == 0 and "styles-" in remote_css_check.stdout, (
        f"Deployed CSS on VPS does not contain 'max-width:none'. "
        f"Deploy may be stale. SSH output: {remote_css_check.stdout}"
    )

    stale_check = _ssh_run(
        "grep -rl '62ch' /opt/auditable-voting/web/dist/assets/ 2>/dev/null || true",
        timeout=10,
    )
    if stale_check.stdout.strip():
        pytest.fail(
            f"Deployed CSS on VPS still contains stale '62ch' max-width in: {stale_check.stdout.strip()}"
        )

    log.info("Frontend deployed and verified on VPS (HTTP 200 + CSS content check passed)")

    yield

    log.info("deployed_frontend fixture torn down")


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture
def voter_portal(browser, request, deployed_frontend):
    from playwright.sync_api import Page as _Page
    from playwright.sync_api import Page as _Page
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        bypass_csp=True,
    )
    p = ctx.new_page()
    p.set_default_timeout(15000)
    p.goto(BASE_URL)
    p.wait_for_load_state("networkidle")
    yield p
    failed = getattr(request.node, "rep_call", None) and request.node.rep_call.failed
    if failed:
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(SCREENSHOT_DIR / f"{request.node.name}.png"), full_page=True)
    ctx.close()


@pytest.fixture
def voting_page(browser, request, deployed_frontend):
    from playwright.sync_api import Page as _Page
    from playwright.sync_api import Page as _Page
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        bypass_csp=True,
    )
    p = ctx.new_page()
    p.set_default_timeout(15000)
    p.goto(f"{BASE_URL}/vote.html")
    p.wait_for_load_state("networkidle")
    yield p
    failed = getattr(request.node, "rep_call", None) and request.node.rep_call.failed
    if failed:
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(SCREENSHOT_DIR / f"{request.node.name}.png"), full_page=True)
    ctx.close()


@pytest.fixture
def dashboard_page(browser, request, deployed_frontend):
    from playwright.sync_api import Page as _Page
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        bypass_csp=True,
    )
    p = ctx.new_page()
    p.set_default_timeout(15000)
    p.goto(f"{BASE_URL}/dashboard.html")
    p.wait_for_load_state("networkidle")
    yield p
    failed = getattr(request.node, "rep_call", None) and request.node.rep_call.failed
    if failed:
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(SCREENSHOT_DIR / f"{request.node.name}.png"), full_page=True)
    ctx.close()

ELIGIBLE_PUBKEY_1 = "a" * 64
ELIGIBLE_PUBKEY_2 = "b" * 64
ELIGIBLE_PUBKEY_3 = "c" * 64
QUOTE_ID = "3fcfc7132cdfa0dab05c4f2ac8feb65b"
COORDINATOR_MINT_URL = "http://localhost:8787/test-mint"
COORDINATOR_GRPC_ENDPOINT = "localhost:9999"


@pytest.fixture
def eligible_set():
    return {ELIGIBLE_PUBKEY_1, ELIGIBLE_PUBKEY_2, ELIGIBLE_PUBKEY_3}


@pytest.fixture
def issued_set():
    return set()


@pytest.fixture
def mock_nostr_client():
    return MagicMock()


@pytest.fixture
def event_data_factory():
    def _factory(**overrides):
        defaults = {
            "pubkey": ELIGIBLE_PUBKEY_1,
            "quote": QUOTE_ID,
            "amount": "1",
            "mint": COORDINATOR_MINT_URL,
            "election": "demo-election-1",
        }
        defaults.update(overrides)
        return defaults

    return _factory
