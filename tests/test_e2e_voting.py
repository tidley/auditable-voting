import hashlib
import json
import logging
import time
from pathlib import Path

import pytest
import requests
from nostr_sdk import Keys

from conftest_e2e import (
    COORDINATOR_HTTP,
    COORDINATOR_INTERNAL_MINT,
    MINT_HTTP,
    VOTER_NSEC,
    build_blinded_output,
    create_mint_quote,
    derive_keys,
    get_coordinator_hex_pubkey,
    get_coordinator_npub,
    get_coordinator_nsec,
    mint_tokens,
    poll_quote_paid,
    poll_until,
    publish_on_vps,
    PUBLISH_38008_SCRIPT,
    PUBLISH_38009_SCRIPT,
    PUBLISH_38010_SCRIPT,
    PUBLISH_38000_SCRIPT,
    SEND_DM_SCRIPT,
    ssh_run,
    unblind_signature,
)

log = logging.getLogger("e2e")

ELIGIBLE_VOTERS_PATH = Path(__file__).resolve().parents[1] / "eligible-voters.json"


@pytest.fixture(scope="session")
def voter_keys():
    keys = Keys.generate()
    nsec = keys.secret_key().to_bech32()
    npub = keys.public_key().to_bech32()
    hex_pub = keys.public_key().to_hex()
    log.info("Generated fresh voter keypair: %s", npub[:20])
    return {"nsec": nsec, "npub": npub, "pubkey_hex": hex_pub}


@pytest.fixture(scope="session")
def coordinator_keys():
    npub = get_coordinator_npub()
    hex_pub = get_coordinator_hex_pubkey()
    nsec = get_coordinator_nsec()
    log.info("Coordinator npub: %s", npub)
    return {"npub": npub, "pubkey_hex": hex_pub, "nsec": nsec}


@pytest.fixture(scope="session")
def test_election(voter_keys, coordinator_keys):
    election_id = f"test-e2e-{int(time.time())}"
    log.info("Setting up test election: %s", election_id)

    coordinator_nsec = coordinator_keys["nsec"]
    coordinator_npub = coordinator_keys["npub"]
    voter_npub = voter_keys["npub"]

    election_content = json.dumps({
        "title": f"E2E Test Election {int(time.time())}",
        "description": "Automated test election for end-to-end voter flow",
        "questions": [
            {
                "id": "q1",
                "type": "choice",
                "prompt": "Test choice question",
                "options": ["option_a", "option_b", "option_c"],
                "select": "single",
            },
            {
                "id": "q2",
                "type": "scale",
                "prompt": "Test scale question",
                "min": 1,
                "max": 10,
                "step": 1,
            },
        ],
        "start_time": int(time.time()) - 60,
        "end_time": int(time.time()) + 3600,
        "mint_urls": ["http://23.182.128.64:3338"],
    })

    log.info("Publishing kind 38008 (election) on VPS...")
    publish_on_vps(
        PUBLISH_38008_SCRIPT,
        [coordinator_nsec, election_id, election_content],
        timeout=30,
    )

    log.info("Waiting for coordinator to cache election (up to 30s)...")
    resp = poll_until(f"{COORDINATOR_HTTP}/election", timeout=30)
    data = resp.json()

    event_id_hex = data.get("event_id")
    assert event_id_hex, f"No event_id in election response: {list(data.keys())}"

    effective_election_id = data.get("election_id") or election_id
    log.info("Election cached: event_id=%s, election_id=%s", event_id_hex[:16], effective_election_id[:20])

    eligible_npubs = json.loads(ELIGIBLE_VOTERS_PATH.read_text())
    production_eligible = sorted(eligible_npubs)

    eligible_npubs.append(voter_npub)
    log.info("Loaded %d eligible npubs from source, added test voter: %s", len(eligible_npubs) - 1, voter_npub[:20])

    log.info("Updating eligible-voters.json on VPS with fresh voter...")
    eligible_json = json.dumps(sorted(eligible_npubs))
    ssh_run(f"echo '{eligible_json}' > /opt/tollgate/coordinator/eligible-voters.json")
    ssh_run("systemctl restart tollgate-coordinator")
    log.info("Coordinator restarted with updated eligible set")
    time.sleep(6)
    poll_until(f"{COORDINATOR_HTTP}/info", timeout=20)

    sorted_npubs = sorted(eligible_npubs)
    eligible_root = hashlib.sha256("\n".join(sorted_npubs).encode()).hexdigest()

    eligibility_content = json.dumps({
        "eligible_count": len(eligible_npubs),
        "eligible_npubs": eligible_npubs,
        "eligible_root": eligible_root,
    })

    log.info("Publishing kind 38009 (eligibility) on VPS...")
    publish_on_vps(
        PUBLISH_38009_SCRIPT,
        [coordinator_nsec, effective_election_id, eligibility_content],
        timeout=30,
    )

    log.info("Election setup complete: %s", data.get("title"))

    yield {
        "election_id": effective_election_id,
        "event_id": event_id_hex,
        "coordinator_npub": coordinator_npub,
        "coordinator_hex_pubkey": coordinator_keys["pubkey_hex"],
        "eligible_npubs": eligible_npubs,
        "questions": data.get("questions", []),
    }

    log.info("Restoring production eligible-voters.json on VPS teardown...")
    production_json = json.dumps(production_eligible)
    ssh_run(f"echo '{production_json}' > /opt/tollgate/coordinator/eligible-voters.json")
    ssh_run("systemctl restart tollgate-coordinator")
    time.sleep(6)
    try:
        poll_until(f"{COORDINATOR_HTTP}/info", timeout=20)
    except Exception:
        log.warning("Coordinator did not come back after teardown restore")
    log.info("Production eligible list restored (%d npubs), test election events persist on relay (ID=%s)",
             len(production_eligible), effective_election_id)


@pytest.mark.e2e
@pytest.mark.timeout(300)
def test_full_voter_flow(voter_keys, coordinator_keys, test_election):
    election_id = test_election["election_id"]
    coord_hex = test_election["coordinator_hex_pubkey"]
    voter_npub = voter_keys["npub"]
    voter_nsec = voter_keys["nsec"]
    voter_hex = voter_keys["pubkey_hex"]

    # ── Step 1: Discover coordinator ────────────────────────────────────
    log.info("=== Step 1: Discover coordinator ===")
    resp = requests.get(f"{COORDINATOR_HTTP}/info", timeout=10)
    assert resp.status_code == 200
    info = resp.json()
    assert info["coordinatorNpub"].startswith("npub1")
    assert info["mintUrl"] != ""
    assert info["mintUrl"].startswith("http")
    assert "127.0.0.1" not in info["mintUrl"]
    assert len(info["relays"]) > 0
    log.info("Coordinator: %s, Mint: %s", info["coordinatorNpub"][:20], info["mintUrl"])

    # ── Step 2: Verify election is available ─────────────────────────────
    log.info("=== Step 2: Verify election ===")
    resp = requests.get(f"{COORDINATOR_HTTP}/election", timeout=10)
    assert resp.status_code == 200
    election = resp.json()
    assert election.get("event_id") == test_election["event_id"]
    assert len(election.get("questions", [])) >= 1
    log.info("Election: %s (%d questions)", election.get("title"), len(election.get("questions", [])))

    # ── Step 3: Check eligibility ───────────────────────────────────────
    log.info("=== Step 3: Check eligibility ===")
    resp = requests.get(f"{COORDINATOR_HTTP}/eligibility", timeout=10)
    assert resp.status_code == 200
    elig = resp.json()
    assert elig["eligible_count"] > 0
    assert voter_npub in elig["eligible_npubs"], f"Voter {voter_npub} not in eligible list"
    log.info("Eligible: %d voters, voter found", elig["eligible_count"])

    # ── Step 4: Create mint quote ────────────────────────────────────────
    log.info("=== Step 4: Create mint quote ===")
    quote_data = create_mint_quote()
    quote_id = quote_data["quote_id"]
    bolt11 = quote_data.get("request", "")
    assert bolt11, "No bolt11 invoice in quote response"
    log.info("Quote: %s, bolt11: %s...", quote_id[:16], bolt11[:40])

    # ── Step 5: Build blinded output ────────────────────────────────────
    log.info("=== Step 5: Build blinded output ===")
    blinded_output, secret, r_hex = build_blinded_output()
    log.info("Blinded output: keyset=%s, amount=1", blinded_output.get("id", "?"))

    # ── Step 6: Publish kind 38010 (issuance claim) ─────────────────────
    log.info("=== Step 6: Publish kind 38010 (issuance claim) ===")
    claim_event_id = publish_on_vps(
        PUBLISH_38010_SCRIPT,
        [voter_nsec, coord_hex, quote_id, bolt11, MINT_HTTP, election_id],
        timeout=30,
    )
    assert len(claim_event_id) > 10, f"Failed to publish 38010: {claim_event_id}"
    log.info("Claim published: %s", claim_event_id[:20])

    # ── Step 7: Poll quote until PAID ───────────────────────────────────
    log.info("=== Step 7: Poll quote until PAID (timeout=60s) ===")
    paid = poll_quote_paid(quote_id, timeout=60)
    assert paid, f"Quote {quote_id} was not approved within 60s"
    log.info("Quote PAID")

    # ── Step 8: Mint blinded tokens ─────────────────────────────────────
    log.info("=== Step 8: Mint blinded tokens ===")
    mint_result = mint_tokens(quote_id, [blinded_output])
    signatures = mint_result.get("signatures", [])
    assert len(signatures) >= 1, "No signatures returned from mint"
    mint_sig = signatures[0]
    log.info("Minted %d signature(s)", len(signatures))

    # ── Step 9: Generate ephemeral ballot keypair ───────────────────────
    log.info("=== Step 9: Generate ephemeral ballot keypair ===")
    ballot_keys = Keys.generate()
    ballot_nsec_str = ballot_keys.secret_key().to_bech32()
    ballot_npub = ballot_keys.public_key().to_bech32()
    log.info("Ballot key: %s", ballot_npub[:20])

    # ── Step 10: Publish kind 38000 (ballot) ───────────────────────────
    log.info("=== Step 10: Publish kind 38000 (ballot) ===")
    ballot_content = json.dumps({
        "election_id": election_id,
        "responses": [
            {"question_id": "q1", "value": "option_a"},
            {"question_id": "q2", "value": 7},
        ],
        "timestamp": int(time.time()),
    })
    vote_event_id = publish_on_vps(
        PUBLISH_38000_SCRIPT,
        [ballot_nsec_str, election_id, ballot_content],
        timeout=30,
    )
    assert len(vote_event_id) > 10, f"Failed to publish 38000: {vote_event_id}"
    log.info("Ballot published: %s", vote_event_id[:20])

    # ── Step 11: Send NIP-17 gift wrap with proof ─────────────────────
    log.info("=== Step 11: Unblind signature and send NIP-17 gift wrap with proof ===")
    proof = unblind_signature(mint_sig, secret, r_hex)
    dm_payload = json.dumps({
        "vote_event_id": vote_event_id,
        "proof": proof,
    })

    payload_remote_path = "/tmp/e2e_dm_payload.json"
    ssh_run(f"cat > {payload_remote_path} << 'PYEOF'\n{dm_payload}\nPYEOF")
    dm_event_id = publish_on_vps(
        SEND_DM_SCRIPT,
        [ballot_nsec_str, coord_hex, payload_remote_path, coordinator_keys["npub"]],
        timeout=30,
    )
    ssh_run(f"rm -f {payload_remote_path}", check=False)
    assert len(dm_event_id) > 10, f"Failed to send DM: {dm_event_id}"
    log.info("DM sent: %s", dm_event_id[:20])

    # ── Step 12: Verify tally ───────────────────────────────────────────
    log.info("=== Step 12: Verify tally (polling up to 90s) ===")
    deadline = time.time() + 90
    tally_ok = False
    while time.time() < deadline:
        try:
            resp = requests.get(f"{COORDINATOR_HTTP}/tally", timeout=10)
            if resp.status_code == 200:
                tally = resp.json()
                accepted = tally.get("total_accepted_votes", 0)
                root = tally.get("spent_commitment_root")
                published = tally.get("total_published_votes", 0)

                log.info(
                    "Tally: published=%d, accepted=%s, root=%s",
                    published, accepted, root,
                )

                if accepted is not None and accepted >= 1 and root is not None:
                    assert len(root) == 64, f"Expected 64-char root, got {len(root)}"
                    tally_ok = True
                    break

                if published >= 1:
                    log.info("Vote published but not yet accepted, waiting...")
        except requests.RequestException:
            pass
        time.sleep(3)

    assert tally_ok, "Tally did not show accepted vote within 90s"
    log.info("=== E2E TEST PASSED ===")
