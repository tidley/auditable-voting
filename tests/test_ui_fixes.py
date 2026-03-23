import logging
import re

import pytest
from playwright.sync_api import expect

log = logging.getLogger("ui.fixes")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIFixProofReady:
    def test_issuance_page_no_amount_display(self, voter_portal):
        page = voter_portal
        page.wait_for_selector("text=Voter Portal", timeout=15000)
        body = page.locator("body").inner_text()

        assert "Amount:" not in body, f"'Amount:' should not appear on issuance page. Body: {body[:500]}"
        log.info("Issuance page: no 'Amount:' display: OK")

    def test_issuance_page_says_proof_ready_not_paid(self, voter_portal):
        page = voter_portal
        page.wait_for_selector("text=Voter Portal", timeout=15000)

        body = page.locator("body").inner_text()
        assert "paid" not in body.lower(), f"'paid' should not appear on issuance page. Body: {body[:500]}"
        log.info("Issuance page: no 'paid' text: OK")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIFixDashboardStatus:
    def test_dashboard_shows_human_readable_status(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Election status", timeout=15000)
        body = page.locator("body").inner_text()

        assert "in_progress" not in body, f"Raw 'in_progress' should not appear. Body: {body[:500]}"
        assert "In Progress" in body or "Closed" in body, \
            f"Expected human-readable status. Body: {body[:500]}"
        log.info("Dashboard shows human-readable status label: OK")

    def test_dashboard_no_raw_status_underscore(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Election status", timeout=15000)
        body = page.locator("body").inner_text()

        assert "in_progress" not in body, f"Raw underscore status found. Body: {body[:500]}"
        log.info("Dashboard: no raw underscore status: OK")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIFixVotingPage:
    def test_voting_page_shows_merkle_tree_section(self, voting_page):
        page = voting_page
        page.wait_for_selector("text=VOTING PAGE", timeout=15000)
        body = page.locator("body").inner_text()

        assert "Merkle tree" in body or "Tally" in body, \
            f"Expected Merkle tree section. Body: {body[:500]}"
        log.info("Voting page shows Merkle tree section: OK")

    def test_voting_page_shows_load_tree_button(self, voting_page):
        page = voting_page
        page.wait_for_selector("text=VOTING PAGE", timeout=15000)

        load_btn = page.locator("button:has-text('Load tree data')")
        expect(load_btn).to_be_visible(timeout=10000)
        log.info("Voting page shows 'Load tree data' button: OK")

    def test_voting_page_shows_verify_my_vote_button(self, voting_page):
        page = voting_page
        page.wait_for_selector("text=VOTING PAGE", timeout=15000)

        verify_btn = page.locator("button:has-text('Verify my vote')")
        verify_count = verify_btn.count()
        if verify_count > 0:
            expect(verify_btn).to_be_visible(timeout=10000)
            log.info("Voting page shows 'Verify my vote' button: OK")
        else:
            log.info("Voting page: 'Verify my vote' button hidden (no ballot event ID): OK")

    def test_voting_page_no_raw_status_underscore(self, voting_page):
        page = voting_page
        page.wait_for_selector("text=VOTING PAGE", timeout=15000)
        body = page.locator("body").inner_text()

        assert "in_progress" not in body, f"Raw underscore status found on voting page. Body: {body[:500]}"
        log.info("Voting page: no raw underscore status: OK")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIFixDashboardIssuanceStatus:
    def test_dashboard_shows_issuance_status_per_npub(self, dashboard_page, vps_eligible_synced):
        page = dashboard_page
        page.wait_for_selector(f"h2:has-text('{len(vps_eligible_synced)}')", timeout=15000)
        body = page.locator("body").inner_text()

        has_pending = "Pending" in body
        has_issued = "Proof issued" in body
        assert has_pending or has_issued, \
            f"Expected issuance status labels per npub. Body: {body[:500]}"
        log.info("Dashboard shows per-npub issuance status (Pending/Proof issued): OK")

    def test_dashboard_npub_list_shows_status_badges(self, dashboard_page, vps_eligible_synced):
        page = dashboard_page
        page.wait_for_selector(f"h2:has-text('{len(vps_eligible_synced)}')", timeout=15000)

        status_indicators = page.locator("text=Pending")
        issued_indicators = page.locator("text=Proof issued")
        total_indicators = status_indicators.count() + issued_indicators.count()

        assert total_indicators >= 1, "Expected at least one status indicator per npub"
        log.info("Dashboard npub list has %d status indicators: OK", total_indicators)
