import hashlib
import json
import logging
import time

import pytest
import requests
from playwright.sync_api import expect
from nostr_sdk import Keys

from conftest_e2e import (
    VPS_IP,
    COORDINATOR_HTTP,
    MINT_HTTP,
    COORDINATOR_DIR,
    PUBLISH_38008_SCRIPT,
    PUBLISH_38009_SCRIPT,
    PUBLISH_38010_SCRIPT,
    PUBLISH_38000_SCRIPT,
    SEND_DM_SCRIPT,
    build_blinded_output,
    create_mint_quote,
    mint_tokens,
    poll_quote_paid,
    publish_on_vps,
    ssh_run,
    ssh_write_file,
    get_coordinator_nsec,
    get_coordinator_hex_pubkey,
    get_coordinator_npub,
    poll_until,
    unblind_signature,
)

log = logging.getLogger("e2e.merkle")

BASE_URL = "http://vote.mints.23.182.128.64.sslip.io"
NUM_VOTERS = 3


def _build_service_content(election_id: str | None = None) -> str:
    eid_line = f"  --election-id {election_id} \\\n" if election_id else ""
    return (
        "[Unit]\n"
        "Description=TollGate Voting Coordinator\n"
        "After=network.target docker.service nak.service\n"
        "Wants=docker.service\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={COORDINATOR_DIR}\n"
        f"ExecStart={COORDINATOR_DIR}/.venv/bin/python3 {COORDINATOR_DIR}/voting-coordinator-client.py \\\n"
        f"  --nsec-file {COORDINATOR_DIR}/nsec.env \\\n"
        f"  --eligible {COORDINATOR_DIR}/eligible-voters.json \\\n"
        f"  --grpc-endpoint 127.0.0.1:8086 \\\n"
        f"  --mint-url http://127.0.0.1:3338 \\\n"
        f"  --public-mint-url http://{VPS_IP}:3338 \\\n"
        f"  --http-port 8081 \\\n"
        f"{eid_line}"
        "  --relays ws://localhost:10547 wss://relay.damus.io wss://nos.lol wss://relay.primal.net\n"
        "Restart=always\n"
        "RestartSec=5\n"
        f"Environment=PYTHONUNBUFFERED=1\n"
        f"Environment=COORDINATOR_PROTO_PATH={COORDINATOR_DIR}/proto/cdk-mint-rpc.proto\n"
        f"Environment=COORDINATOR_GEN_DIR={COORDINATOR_DIR}/_gen\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


def _restart_coordinator(timeout: int = 60) -> str:
    result = ssh_run(
        "systemctl daemon-reload && systemctl restart tollgate-coordinator && "
        "sleep 10 && curl -s http://localhost:8081/info",
        timeout=timeout,
    )
    assert "coordinatorNpub" in result.stdout, \
        f"Coordinator did not restart: {result.stdout[:200]} {result.stderr[:200]}"
    return result.stdout


@pytest.fixture(scope="session")
def merkle_test_election():
    election_id = f"merkle-test-{int(time.time())}"
    now = int(time.time())
    start_time = now - 120
    end_time = now - 60

    election_content = json.dumps({
        "title": "Merkle Tree E2E Test Election",
        "description": "Automated test election for Merkle tree verification",
        "questions": [
            {
                "id": "q1",
                "prompt": "Do you like Merkle trees?",
                "type": "choice",
                "options": ["Yes", "No"],
            },
        ],
        "start_time": start_time,
        "end_time": end_time,
        "mint_urls": [f"http://{VPS_IP}:3338"],
    })

    coord_nsec = get_coordinator_nsec()
    log.info("Publishing test election %s (end_time in the past)...", election_id[:24])
    publish_on_vps(PUBLISH_38008_SCRIPT, [coord_nsec, election_id, election_content], timeout=30)

    time.sleep(3)

    ssh_write_file(
        "/etc/systemd/system/tollgate-coordinator.service",
        _build_service_content(election_id=election_id),
    )
    _restart_coordinator()
    log.info("Coordinator restarted with election-id %s", election_id[:24])

    info_resp = poll_until(f"{COORDINATOR_HTTP}/info", timeout=30)
    info_data = info_resp.json()
    eid = info_data.get("electionId")
    if eid:
        assert eid == election_id, f"Election mismatch: {eid} != {election_id}"
    log.info("Coordinator info confirms election-id: %s", election_id[:24])

    resp = poll_until(f"{COORDINATOR_HTTP}/election?election_id={election_id}", timeout=30)
    data = resp.json()
    assert data.get("election_id") or data.get("election") == election_id, \
        f"Election not cached. Got: {data}"
    log.info("Test election cached: %s", election_id[:24])

    yield election_id


@pytest.fixture(scope="session")
def merkle_test_voters(merkle_test_election):
    voters = []
    voter_npubs = []
    for i in range(NUM_VOTERS):
        keys = Keys.generate()
        nsec = keys.secret_key().to_bech32()
        npub = keys.public_key().to_bech32()
        pubkey_hex = keys.public_key().to_hex()
        voters.append({"nsec": nsec, "npub": npub, "pubkey_hex": pubkey_hex})
        voter_npubs.append(npub)

    existing_eligible_resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
    existing_npubs = existing_eligible_resp.json().get("eligible_npubs", [])
    all_npubs = sorted(set(existing_npubs + voter_npubs))

    log.info("Adding %d test voters to eligibility list (total: %d)", NUM_VOTERS, len(all_npubs))
    eligible_json = json.dumps(all_npubs)
    ssh_run(f"echo '{eligible_json}' > {COORDINATOR_DIR}/eligible-voters.json")

    eligibility_content = json.dumps({
        "eligible_count": len(all_npubs),
        "eligible_npubs": all_npubs,
        "eligible_root": hashlib.sha256("\n".join(all_npubs).encode()).hexdigest(),
    })

    log.info("Publishing 38009 for merkle test election...")
    publish_on_vps(PUBLISH_38009_SCRIPT, [get_coordinator_nsec(), merkle_test_election, eligibility_content], timeout=30)

    orig_election_resp = requests.get(f"{COORDINATOR_HTTP}/election", timeout=10)
    orig_election_id = ""
    if orig_election_resp.status_code == 200:
        orig_election_id = orig_election_resp.json().get("election_id", "")
        log.info("Original election ID: %s", orig_election_id[:24] if orig_election_id else "(none)")

    eid = merkle_test_election
    ssh_write_file(
        "/etc/systemd/system/tollgate-coordinator.service",
        _build_service_content(election_id=eid),
    )
    _restart_coordinator()
    log.info("Coordinator restarted with --election-id %s", merkle_test_election[:24])

    info_resp = poll_until(f"{COORDINATOR_HTTP}/info", timeout=30)
    info_data = info_resp.json()
    if "electionId" in info_data:
        assert info_data["electionId"] == merkle_test_election, \
            f"Coordinator election mismatch: {info_data.get('electionId')} != {merkle_test_election}"
    log.info("Coordinator info confirms election-id: %s", merkle_test_election[:24])

    yield voters

    if orig_election_id:
        log.info("Restoring original election %s...", orig_election_id[:24])
        ssh_write_file(
            "/etc/systemd/system/tollgate-coordinator.service",
            _build_service_content(election_id=None),
        )
        ssh_run(
            "systemctl daemon-reload && systemctl restart tollgate-coordinator && "
            "sleep 10 && curl -s http://localhost:8081/info",
            timeout=60,
            check=False,
        )
        log.info("Original election restored")


@pytest.fixture(scope="session")
def merkle_all_voted(merkle_test_election, merkle_test_voters):
    election_id = merkle_test_election
    coord_hex = get_coordinator_hex_pubkey()
    coordinator_npub = get_coordinator_npub()
    last_ballot_event_id = None
    last_proof = None

    for i, voter in enumerate(merkle_test_voters):
        log.info("=== Voter %d/%d: %s ===", i + 1, NUM_VOTERS, voter["npub"][:20])

        quote_data = create_mint_quote()
        quote_id = quote_data["quote_id"]
        bolt11 = quote_data.get("request", quote_data.get("bolt11", ""))
        log.info("Voter %d: quote %s created", i + 1, quote_id[:16])

        blinded_output, secret, r_hex = build_blinded_output()

        log.info("Voter %d: publishing 38010 claim...", i + 1)
        publish_on_vps(
            PUBLISH_38010_SCRIPT,
            [voter["nsec"], coord_hex, quote_id, bolt11, f"http://{VPS_IP}:3338", election_id],
            timeout=30,
        )

        paid = poll_quote_paid(quote_id, timeout=90)
        assert paid, f"Voter {i + 1}: quote not paid within 90s"
        log.info("Voter %d: quote paid", i + 1)

        mint_data = mint_tokens(quote_id, [blinded_output])
        blind_sig = mint_data["signatures"][0]
        proof = unblind_signature(blind_sig, secret, r_hex)
        log.info("Voter %d: proof minted (keyset=%s)", i + 1, proof["id"][:12])

        ballot_keys = Keys.generate()
        ballot_nsec = ballot_keys.secret_key().to_bech32()
        ballot_npub = ballot_keys.public_key().to_bech32()

        ballot_content = json.dumps({
            "election_id": election_id,
            "responses": {
                "q1": "Yes",
            },
        })

        log.info("Voter %d: publishing 38000 ballot...", i + 1)
        ballot_event_id = publish_on_vps(
            PUBLISH_38000_SCRIPT,
            [ballot_nsec, election_id, ballot_content],
            timeout=30,
        )
        last_ballot_event_id = ballot_event_id
        last_proof = proof

        dm_payload = json.dumps({
            "vote_event_id": ballot_event_id,
            "proof": proof,
        })

        remote_dm_path = f"/tmp/merkle_dm_{i}.json"
        ssh_write_file(remote_dm_path, dm_payload)

        log.info("Voter %d: sending proof DM...", i + 1)
        publish_on_vps(
            SEND_DM_SCRIPT,
            [ballot_nsec, coord_hex, remote_dm_path, coordinator_npub],
            timeout=30,
        )
        ssh_run(f"rm -f {remote_dm_path}", check=False)
        log.info("Voter %d: proof DM sent", i + 1)

    log.info("All %d voters done. Waiting 15s for coordinator to process DMs...", NUM_VOTERS)
    time.sleep(15)

    deadline = time.time() + 120
    last_accepted = 0
    last_published = 0
    while time.time() < deadline:
        try:
            resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
            if resp.status_code != 200:
                log.warning("Tally returned HTTP %d, retrying...", resp.status_code)
                time.sleep(5)
                continue
            data = resp.json()
        except (requests.RequestException, requests.exceptions.JSONDecodeError) as exc:
            log.warning("Tally request failed: %s, retrying...", exc)
            time.sleep(5)
            continue
        last_accepted = data.get("total_accepted_votes", 0)
        last_published = data.get("total_published_votes", 0)
        log.info("Tally: %d accepted, %d published", last_accepted, last_published)
        if last_accepted >= NUM_VOTERS:
            log.info("All %d votes accepted, proceeding to close", last_accepted)
            break
        time.sleep(5)
    else:
        pytest.fail(f"Only {last_accepted}/{NUM_VOTERS} votes accepted after 120s")

    log.info("Closing election %s...", election_id[:24])
    close_resp = requests.post(f"{COORDINATOR_HTTP}/close", timeout=120)
    log.info("Close response: %s %s", close_resp.status_code, close_resp.text[:300])

    time.sleep(3)

    tree_resp = requests.get(f"{COORDINATOR_HTTP}/vote_tree", timeout=10)
    assert tree_resp.status_code == 200, f"vote_tree returned {tree_resp.status_code}: {tree_resp.text[:200]}"
    tree_data = tree_resp.json()
    assert tree_data["total_leaves"] == NUM_VOTERS, \
        f"Expected {NUM_VOTERS} leaves, got {tree_data['total_leaves']}"
    assert tree_data["merkle_root"], "Merkle root is empty"
    log.info("Vote tree: %d leaves, root=%s", tree_data["total_leaves"], tree_data["merkle_root"][:16])

    yield {
        "ballot_event_id": last_ballot_event_id,
        "proof": last_proof,
        "election_id": election_id,
        "tree_data": tree_data,
    }


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(900)
class TestMultiVoterMerkleTree:

    def test_vote_tree_api_returns_correct_leaf_count(self, merkle_all_voted):
        tree_data = merkle_all_voted["tree_data"]
        assert tree_data["total_leaves"] == NUM_VOTERS
        assert len(tree_data["leaves"]) == NUM_VOTERS
        assert len(tree_data["levels"]) >= 2
        assert tree_data["merkle_root"]
        log.info("Vote tree API: %d leaves, %d levels, root=%s",
                 tree_data["total_leaves"], len(tree_data["levels"]), tree_data["merkle_root"][:16])

    def test_merkle_tree_viz_shows_all_leaves(self, browser, deployed_frontend, merkle_all_voted):
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 900},
            bypass_csp=True,
        )
        page = ctx.new_page()
        page.set_default_timeout(15000)

        try:
            election_id = merkle_all_voted["election_id"]
            ballot_event_id = merkle_all_voted["ballot_event_id"]
            proof = merkle_all_voted["proof"]

            bundle = {
                "proof": proof,
                "ballotEventId": ballot_event_id,
                "election": {
                    "electionId": election_id,
                    "title": "Merkle Tree E2E Test Election",
                    "questions": [{"id": "q1", "prompt": "Do you like Merkle trees?", "type": "choice", "options": ["Yes", "No"]}],
                    "start_time": int(time.time()) - 120,
                    "end_time": int(time.time()) - 60,
                },
                "coordinatorNpub": get_coordinator_npub(),
                "mintUrl": f"http://{VPS_IP}:3338",
                "relays": ["ws://localhost:10547"],
            }

            page.goto(f"{BASE_URL}/vote.html")
            page.wait_for_load_state("networkidle")
            page.evaluate("""(bundle) => {
                localStorage.setItem('auditable-voting.cashu-proof', JSON.stringify(bundle));
            }""", bundle)
            page.reload()
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(3000)

            load_btn = page.locator("button:has-text('Load tree data')")
            expect(load_btn).to_be_visible(timeout=10000)
            load_btn.click()

            page.wait_for_selector("text=Full tree", timeout=30000)
            log.info("Tree data loaded, looking for leaf nodes...")

            tree_hash_nodes = page.locator("article.panel.panel-wide span[title]")
            hash_count = tree_hash_nodes.count()
            assert hash_count >= NUM_VOTERS, \
                f"Expected at least {NUM_VOTERS} hash nodes in tree, found {hash_count}"
            log.info("Tree visualization shows %d hash nodes", hash_count)

            root_node = page.locator("article.panel.panel-wide span[style*='border: 2px solid']")
            root_count = root_node.count()
            assert root_count >= 1, "Expected at least 1 root node with border highlight"
            log.info("Root node highlighted: OK (%d root nodes)", root_count)

        finally:
            ctx.close()

    def test_merkle_tree_verify_inclusion_proof(self, browser, deployed_frontend, merkle_all_voted):
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 900},
            bypass_csp=True,
        )
        page = ctx.new_page()
        page.set_default_timeout(15000)

        try:
            election_id = merkle_all_voted["election_id"]
            ballot_event_id = merkle_all_voted["ballot_event_id"]
            proof = merkle_all_voted["proof"]

            bundle = {
                "proof": proof,
                "ballotEventId": ballot_event_id,
                "election": {
                    "electionId": election_id,
                    "title": "Merkle Tree E2E Test Election",
                    "questions": [{"id": "q1", "prompt": "Do you like Merkle trees?", "type": "choice", "options": ["Yes", "No"]}],
                    "start_time": int(time.time()) - 120,
                    "end_time": int(time.time()) - 60,
                },
                "coordinatorNpub": get_coordinator_npub(),
                "mintUrl": f"http://{VPS_IP}:3338",
                "relays": ["ws://localhost:10547"],
            }

            page.goto(f"{BASE_URL}/vote.html")
            page.wait_for_load_state("networkidle")
            page.evaluate("""(bundle) => {
                localStorage.setItem('auditable-voting.cashu-proof', JSON.stringify(bundle));
            }""", bundle)
            page.reload()
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(2000)

            load_btn = page.locator("button:has-text('Load tree data')")
            expect(load_btn).to_be_visible(timeout=10000)
            load_btn.click()
            page.wait_for_selector("text=Full tree", timeout=30000)

            verify_btn = page.locator("button:has-text('Verify my vote')")
            expect(verify_btn).to_be_visible(timeout=10000)
            verify_btn.click()

            page.wait_for_selector("text=Vote verified", timeout=30000)
            expect(page.locator("text=Vote verified")).to_be_visible()
            log.info("Vote verified on Merkle tree: OK")

            proof_heading = page.locator("text=Your inclusion proof path")
            expect(proof_heading).to_be_visible()
            log.info("Inclusion proof path displayed: OK")

            branch_nodes = page.locator("article.panel.panel-wide span[style*='border-left: 4px solid']")
            branch_count = branch_nodes.count()
            assert branch_count >= 1, \
                f"Expected branch path nodes after verification, found {branch_count}"
            log.info("Branch path highlighted: %d nodes with left-border accent", branch_count)

            legend = page.locator("text=Branch path")
            expect(legend).to_be_visible()
            log.info("Legend displayed: OK")

        finally:
            ctx.close()
