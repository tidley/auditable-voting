import logging
import re
import time

import pytest
from playwright.sync_api import expect

log = logging.getLogger("ui.issuance")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(300)
class TestUIIssuance:

    def test_full_issuance_flow(self, voter_portal, test_voter_added):
        page = voter_portal

        # Step 1: Coordinator discovery
        page.wait_for_selector("text=Connected to coordinator", timeout=20000)
        expect(page.locator("text=Connected to coordinator")).to_be_visible()
        page.wait_for_timeout(5000)
        body = page.locator("body").inner_text()
        assert "23.182.128.64" in body or "Discovering" not in body, \
            f"Mint URL not found and still discovering. Body: {body[:800]}"
        log.info("Step 1: Coordinator discovery OK")

        # Step 1b: Verify h1 title uses full width (hero-title class)
        h1_box = page.locator("h1.hero-title").bounding_box()
        assert h1_box is not None, "h1.hero-title not found"
        assert h1_box["width"] > 300, \
            f"h1 title too narrow ({h1_box['width']}px), expected >300px with hero-title class"
        log.info("Step 1b: h1 title width %dpx (full width)", h1_box["width"])

        # Step 1b2: Verify hero-copy paragraph uses full width
        hero_copy = page.locator("p.hero-copy").first
        hero_copy_box = hero_copy.bounding_box()
        assert hero_copy_box is not None, "p.hero-copy not found"
        assert hero_copy_box["width"] > 300, \
            f"hero-copy too narrow ({hero_copy_box['width']}px), expected >300px"
        log.info("Step 1b2: hero-copy width %dpx (full width)", hero_copy_box["width"])

        # Step 1c: Verify no separate "Step 1" panel (merged into Signer)
        step1_panel = page.locator("text=Check your npub").first
        step1_heading = page.locator("h2:has-text('Check your npub')")
        assert step1_heading.count() == 0, \
            "Separate 'Check your npub' h2 still exists — should be merged into Signer panel"
        assert step1_panel.count() <= 2, \
            f"Expected 'Check your npub' text only in Signer panel, found {step1_panel.count()} instances"
        log.info("Step 1c: No separate Step 1 panel — merged into Signer")

        # Step 2: Switch to raw signer
        raw_btn = page.locator("button:has-text('Paste nsec')")
        raw_btn.click()
        expect(page.locator("textarea")).to_be_visible(timeout=5000)
        log.info("Step 2: Raw signer mode active")

        # Step 3: Enter nsec and derive npub
        textarea = page.locator("textarea")
        textarea.fill(test_voter_added["nsec"])
        page.wait_for_timeout(1000)
        body_text = page.locator("body").inner_text()
        assert test_voter_added["npub"][:20] in body_text, \
            f"Derived npub not found. Page: {body_text[:500]}"
        log.info("Step 3: Derived npub %s", test_voter_added["npub"][:30])

        # Step 4: Auto eligibility check (triggered on npub derivation)
        page.wait_for_selector("text=Eligible npub confirmed", timeout=15000)
        expect(page.locator("text=Eligible npub confirmed")).to_be_visible()
        log.info("Step 4: Auto eligibility check PASSED")

        # Step 5: Request quote
        request_btn = page.locator("button:has-text('Request quote')")
        expect(request_btn).to_be_enabled(timeout=5000)
        request_btn.click()
        page.wait_for_selector("text=lnbc", timeout=15000)
        expect(page.locator("text=lnbc")).to_be_visible()
        log.info("Step 5: Quote requested")

        # Step 6: Sign and publish claim
        publish_btn = page.locator("button:has-text('Sign and publish claim')")
        expect(publish_btn).to_be_enabled(timeout=5000)
        publish_btn.click()
        page.wait_for_selector("text=Verify this claim event on njump", timeout=30000)
        expect(page.locator("text=Verify this claim event on njump")).to_be_visible()
        njump_link = page.locator("a.notice-link")
        expect(njump_link).to_have_attribute("href", re.compile(r"https://njump\.me/nevent1"))
        log.info("Step 6: Claim published with njump link")

        # Step 7: Wait for quote approval and minting
        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type == "error" else None)

        deadline = time.time() + 120
        approved = False
        while time.time() < deadline:
            body = page.locator("body").inner_text()
            if "Proof received and stored" in body:
                approved = True
                break
            if "Token minting failed" in body or "Could not request quote" in body:
                log.error("Minting FAILED. Console errors: %s", console_errors[-5:])
                pytest.fail(f"Minting failed on page. Body: {body[:1000]}")
            if "UNPAID" in body:
                log.info("Quote still UNPAID, waiting...")
            elif "Approved" in body or "minting" in body.lower():
                log.info("Quote approved, waiting for minting... (%.0fs elapsed)", time.time() - (deadline - 120))
            time.sleep(3)

        if console_errors:
            log.warning("Browser console errors during minting: %s", console_errors[-5:])

        assert approved, \
            f"Quote not approved/minted within 120s. Console errors: {console_errors[-5:]}. Page: {page.locator('body').inner_text()[:1000]}"
        log.info("Step 7: Quote approved and proof minted")

        # Step 8: Proof minted and stored
        expect(page.locator("text=Proof received and stored")).to_be_visible()
        go_to_vote = page.locator("a:has-text('Go To Voting Page')")
        expect(go_to_vote).to_be_visible()
        log.info("Step 8: Proof minted and stored")

        # Step 9: Verify localStorage bundle
        bundle = page.evaluate("""() => {
            const raw = localStorage.getItem('auditable-voting.cashu-proof');
            return raw ? JSON.parse(raw) : null;
        }""")

        assert bundle is not None, "No bundle in localStorage"
        assert bundle.get("proof") is not None, "Bundle has no proof"
        assert bundle.get("election") is not None, "Bundle has no election"
        assert bundle.get("coordinatorNpub"), "Bundle has no coordinatorNpub"
        assert bundle.get("mintUrl"), "Bundle has no mintUrl"

        proof = bundle["proof"]
        assert proof.get("id"), "Proof has no id (keyset)"
        assert proof.get("amount") == 1, f"Proof amount should be 1, got {proof.get('amount')}"
        assert proof.get("secret"), "Proof has no secret"
        assert proof.get("C"), "Proof has no C (unblinded signature)"
        log.info(
            "Step 9: localStorage bundle valid (keyset=%s, amount=%s)",
            proof.get("id", "?")[:16],
            proof.get("amount"),
        )

        # Step 10: Reload page and verify proof survives
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(5000)

        body_after = page.locator("body").inner_text()
        assert "1 proof" in body_after, \
            f"Proof count not shown after reload. Body: {body_after[:500]}"
        log.info("Step 10: After reload, '1 proof' visible in wallet section")

        bundle_after = page.evaluate("""() => {
            const raw = localStorage.getItem('auditable-voting.cashu-proof');
            return raw ? JSON.parse(raw) : null;
        }""")
        assert bundle_after is not None, "Bundle lost from localStorage after reload"
        assert bundle_after.get("proof") is not None, "Proof lost from bundle after reload"
        assert bundle_after["proof"].get("id") == proof["id"], \
            "Proof keyset changed after reload"
        log.info("Step 10: Proof persisted correctly in localStorage after reload")

        # Step 11: Navigate to vote page and verify proof is usable
        page.goto("http://vote.mints.23.182.128.64.sslip.io/vote.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        vote_body = page.locator("body").inner_text()
        assert "No voting proof found" not in vote_body, \
            f"Vote page says no proof. Body: {vote_body[:500]}"
        assert "STORED PROOF" in vote_body or "1 sat" in vote_body, \
            f"Proof not shown on vote page after reload. Body: {vote_body[:500]}"
        log.info("Step 11: Vote page recognizes proof after page reload")

        radio_count = page.locator("input[type='radio']").count()
        assert radio_count >= 2, \
            f"Ballot questions not rendered on vote page (expected >=2 radios, got {radio_count})"
        log.info("Step 11: Ballot questions rendered with %d radio buttons", radio_count)

    def test_eligibility_indicator_shows_checkmark_or_cross(self, voter_portal, test_voter_added):
        page = voter_portal

        page.wait_for_selector("text=Connected to coordinator", timeout=20000)
        log.info("Coordinator discovered")

        raw_btn = page.locator("button:has-text('Paste nsec')")
        raw_btn.click()
        expect(page.locator("textarea")).to_be_visible(timeout=5000)
        log.info("Switched to raw signer mode")

        textarea = page.locator("textarea")

        # Test 1: Eligible npub shows checkmark
        textarea.fill(test_voter_added["nsec"])
        page.wait_for_selector("text=\u2713 Eligible npub confirmed", timeout=15000)
        expect(page.locator("text=\u2713 Eligible npub confirmed")).to_be_visible()
        log.info("Eligible npub shows checkmark: \u2713 Eligible npub confirmed")

        # Test 2: Ineligible npub shows cross
        from nostr_sdk import Keys
        random_keys = Keys.generate()
        random_nsec = random_keys.secret_key().to_bech32()
        textarea.fill(random_nsec)
        page.wait_for_selector("text=\u2717 Not on the eligibility list", timeout=15000)
        expect(page.locator("text=\u2717 Not on the eligibility list")).to_be_visible()
        log.info("Ineligible npub shows cross: \u2717 Not on the eligibility list")
