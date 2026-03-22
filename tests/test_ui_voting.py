import json
import logging
import re
import time

import pytest
import requests
from playwright.sync_api import expect

log = logging.getLogger("ui.voting")

COORDINATOR_HTTP = "http://23.182.128.64:8081"
VPS_IP = "23.182.128.64"
BASE_URL = "http://vote.mints.23.182.128.64.sslip.io"
COORDINATOR_DIR = "/opt/tollgate/coordinator"
COORDINATOR_VENV_PYTHON = f"{COORDINATOR_DIR}/.venv/bin/python3"
SSH_CMD = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15", f"root@{VPS_IP}"]


def _ssh_run(cmd, timeout=30):
    import subprocess
    return subprocess.run(SSH_CMD + [cmd], capture_output=True, text=True, timeout=timeout)


@pytest.fixture(scope="session")
def voting_voter_key():
    from nostr_sdk import Keys
    keys = Keys.generate()
    return {
        "nsec": keys.secret_key().to_bech32(),
        "npub": keys.public_key().to_bech32(),
        "pubkey_hex": keys.public_key().to_hex(),
    }


@pytest.fixture(scope="session")
def voting_voter_added(voting_voter_key, vps_eligible_synced):
    import hashlib
    voter_npub = voting_voter_key["npub"]
    resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
    current = resp.json().get("eligible_npubs", [])

    if voter_npub in current:
        log.info("Voting test voter already eligible")
    else:
        updated = sorted(current + [voter_npub])
        payload = json.dumps(updated)
        _ssh_run(f"echo '{payload}' > {COORDINATOR_DIR}/eligible-voters.json")

        elig_content = json.dumps({
            "eligible_count": len(updated),
            "eligible_npubs": updated,
            "eligible_root": hashlib.sha256("\n".join(updated).encode()).hexdigest(),
        })
        elig_escaped = elig_content.replace("'", "'\\''")
        publish_script = (
            "import asyncio, json\n"
            "from nostr_sdk import Keys, Kind, NostrSigner, Client, EventBuilder, Tag, RelayUrl\n"
            "async def main():\n"
            f"    nsec = '{_ssh_run(f'cat {COORDINATOR_DIR}/nsec.env').stdout.strip()}'\n"
            f"    eid = '{requests.get(f'{COORDINATOR_HTTP}/info', timeout=10).json().get('electionId', '')}'\n"
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
        import tempfile, os
        script_path = f"/tmp/e2e_voting_voter_{hashlib.md5(payload.encode()).hexdigest()[:8]}.py"
        _ssh_run(f"cat > {script_path} << 'PYEOF'\n{publish_script}\nPYEOF")
        result = _ssh_run(f"{COORDINATOR_VENV_PYTHON} {script_path}", timeout=30)
        _ssh_run(f"rm -f {script_path}")
        log.info("Published 38009 for voting voter: %s", result.stdout.strip()[:20])

        _ssh_run("systemctl restart tollgate-coordinator")
        time.sleep(6)
        resp2 = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
        resp2.raise_for_status()
        log.info("Coordinator restarted with voting voter eligible (total: %d)", len(updated))

    yield voting_voter_key


@pytest.fixture
def seeded_voting_page(voter_portal, voting_voter_added):
    page = voter_portal
    raw_btn = page.locator("button:has-text('Paste nsec')")
    if not page.locator("textarea").is_visible():
        raw_btn.click()
    textarea = page.locator("textarea")
    textarea.fill(voting_voter_added["nsec"])
    page.wait_for_timeout(500)

    page.wait_for_selector("text=Eligible npub confirmed", timeout=15000)

    request_btn = page.locator("button:has-text('Request quote')")
    request_btn.click(timeout=10000)
    page.wait_for_selector("text=lnbc", timeout=15000)

    publish_btn = page.locator("button:has-text('Sign and publish claim')")
    publish_btn.click(timeout=10000)

    deadline = time.time() + 120
    while time.time() < deadline:
        body = page.locator("body").inner_text()
        if "Proof received and stored" in body:
            break
        time.sleep(3)
    else:
        pytest.fail("Proof not minted within 120s during seeded fixture setup")

    page.goto(f"{BASE_URL}/vote.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    return page


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIVotingStatic:
    def test_vote_page_loads(self, voting_page):
        page = voting_page
        body = page.locator("body").inner_text()
        assert "VOTING PAGE" in body
        assert "Submit ballot" in body
        log.info("Voting page loads: OK")

    def test_vote_page_shows_no_proof_warning(self, voting_page):
        page = voting_page
        body = page.locator("body").inner_text()
        assert "No voting proof found" in body, f"Expected no-proof warning. Page: {body[:500]}"
        log.info("No-proof warning visible: OK")

    def test_vote_page_hero_full_width(self, voting_page):
        page = voting_page

        h1_box = page.locator("h1.hero-title").bounding_box()
        assert h1_box is not None, "h1.hero-title not found on vote page"
        assert h1_box["width"] > 300, \
            f"Vote page h1 too narrow ({h1_box['width']}px), expected >300px"
        log.info("Vote page h1 width: %dpx", h1_box["width"])

        hero_copy = page.locator("p.hero-copy").first
        hero_copy_box = hero_copy.bounding_box()
        assert hero_copy_box is not None, "p.hero-copy not found on vote page"
        assert hero_copy_box["width"] > 300, \
            f"Vote page hero-copy too narrow ({hero_copy_box['width']}px), expected >300px"
        log.info("Vote page hero-copy width: %dpx", hero_copy_box["width"])


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(600)
class TestUIVotingWithProof:
    def test_full_voting_flow(self, seeded_voting_page):
        page = seeded_voting_page

        page.wait_for_selector("input[type='radio']", timeout=10000)
        radio_count = page.locator("input[type='radio']").count()
        assert radio_count >= 2, f"Expected >=2 radio buttons, got {radio_count}"
        log.info("Step 1: Ballot rendered with %d radio buttons", radio_count)

        radio_names = page.evaluate("""() => {
            return [...new Set(Array.from(document.querySelectorAll('input[type=\"radio\"]')).map(r => r.name))];
        }""")
        for name in radio_names:
            page.locator(f"input[type='radio'][name='{name}']").first.check(timeout=3000)
        radios_checked = page.locator("input[type='radio']:checked").count()
        log.info("Step 2a: Checked %d radios across %d question groups", radios_checked, len(radio_names))

        range_inputs = page.locator("input[type='range']").all()
        for ri in range_inputs:
            ri.fill("3")
        if range_inputs:
            log.info("Step 2b: Set %d scale slider(s) to 3", len(range_inputs))

        textareas = page.locator("textarea").all()
        for ta in textareas:
            ta.fill("test response from e2e")
        log.info("Step 2: Filled %d textareas + %d radios + %d sliders", len(textareas), radios_checked, len(range_inputs))

        page.wait_for_timeout(500)

        submit_btn = page.locator("button:has-text('Submit ballot')")
        if not submit_btn.is_enabled():
            radios_checked = page.locator("input[type='radio']:checked").count()
            range_vals = page.evaluate("""() => {
                const ranges = document.querySelectorAll('input[type=\"range\"]');
                return Array.from(ranges).map(r => r.value);
            }""")
            ta_filled = sum(1 for ta in page.locator("textarea").all() if ta.input_value())
            log.warning(
                "Submit still disabled: radios_checked=%d/%d, ranges=%s, textareas_filled=%d/%d",
                radios_checked, radio_count, range_vals, ta_filled, len(textareas),
            )

        expect(submit_btn).to_be_enabled(timeout=5000)
        submit_btn.click()

        page.wait_for_selector("text=Verify this ballot event on njump", timeout=30000)
        njump_link = page.locator("a.notice-link")
        expect(njump_link).to_have_attribute("href", re.compile(r"https://njump\.me/nevent1"))
        log.info("Step 3: Ballot published with njump link")

        proof_btn = page.locator("button:has-text('Submit proof')")
        expect(proof_btn).to_be_enabled(timeout=10000)
        proof_btn.click()

        page.wait_for_selector("text=Proof sent", timeout=30000)
        expect(page.locator("text=Proof sent")).to_be_visible()
        log.info("Step 4: Proof submitted to coordinator")

        tally_btn = page.locator("button:has-text('Check tally')")
        tally_btn.click(timeout=5000)

        deadline = time.time() + 30
        accepted = False
        while time.time() < deadline:
            body = page.locator("body").inner_text()
            if "Accepted" in body:
                accepted = True
                break
            time.sleep(2)

        assert accepted, f"Tally should show accepted votes within 30s. Page: {page.locator('body').inner_text()[:500]}"
        log.info("Step 5: Tally shows accepted vote")
