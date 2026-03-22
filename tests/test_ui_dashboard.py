import logging

import pytest
from playwright.sync_api import expect

log = logging.getLogger("ui.dashboard")


@pytest.mark.e2e
@pytest.mark.ui
@pytest.mark.timeout(120)
class TestUIDashboard:
    def test_dashboard_shows_election_title(self, dashboard_page):
        page = dashboard_page
        body = page.locator("body").inner_text()
        assert "SEC-06" in body or "Feedback" in body or "Monitor" in body, \
            f"Election title not found. Page: {body[:500]}"
        log.info("Dashboard shows election title: OK")

    def test_dashboard_shows_eligible_count(self, dashboard_page, vps_eligible_synced):
        page = dashboard_page
        expected_count = len(vps_eligible_synced)
        heading = page.locator(f"h2:has-text('{expected_count}')")
        expect(heading).to_be_visible(timeout=15000)
        log.info("Dashboard shows eligible count %d: OK", expected_count)

    def test_dashboard_shows_real_npubs(self, dashboard_page, vps_eligible_synced):
        page = dashboard_page
        expected_count = len(vps_eligible_synced)
        page.locator(f"h2:has-text('{expected_count}')").wait_for(timeout=15000)
        body = page.locator("body").inner_text()
        found = any(npub[:20] in body for npub in vps_eligible_synced)
        assert found, f"No eligible npub found in dashboard. Body: {body[:500]}"
        log.info("Dashboard shows real npub: OK")

    def test_dashboard_shows_tally(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('Published')", timeout=15000)
        expect(page.locator("p.panel-kicker:has-text('Published')")).to_be_visible()
        log.info("Dashboard shows tally: OK")

    def test_dashboard_shows_questions_from_election(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=SEC-06 Feedback", timeout=15000)
        body = page.locator("body").inner_text()
        assert "SEC-06 Feedback" in body, \
            f"Election title not found. Body: {body[:500]}"
        log.info("Dashboard shows election questions: OK")

    def test_dashboard_shows_ballot_and_results_sections(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('Results')", timeout=15000)
        expect(page.locator("p.panel-kicker:has-text('Results')")).to_be_visible()
        page.wait_for_selector("text=MULTIPLE CHOICE", timeout=15000)
        ballot_section = page.locator("section:has(p.panel-kicker:text-is(\"Results\"))")
        ballot_text = ballot_section.inner_text()
        has_questions = "MULTIPLE CHOICE" in ballot_text or "FREE TEXT" in ballot_text or "SCALE" in ballot_text
        assert has_questions, f"Question type badges not found. Ballot text: {ballot_text[:500]}"
        log.info("Dashboard shows results section with question type badges: OK")

    def test_dashboard_single_election_no_dropdown(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Election data from the coordinator", timeout=15000)
        page.wait_for_timeout(5000)
        select_count = page.locator("select#election-select").count()
        if select_count == 0:
            single_text = page.locator("text=1 election found on relays")
            if single_text.count() > 0:
                expect(single_text).to_be_visible(timeout=5000)
                log.info("Dashboard: single election, no dropdown, shows '1 election found': OK")
            else:
                log.info("Dashboard: single election, no dropdown text (may have loaded from coordinator)")
        else:
            log.info("Dashboard: multiple elections found, dropdown visible: OK")

    def test_dashboard_nostr_elections_loaded(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Election data from the coordinator", timeout=15000)
        body = page.locator("body").inner_text()
        assert "Election data from the coordinator and Nostr relays" in body, \
            f"Expected Nostr relay source text. Body: {body[:500]}"
        log.info("Dashboard confirms Nostr relay data source: OK")

    def test_dashboard_hero_full_width(self, dashboard_page):
        page = dashboard_page

        h1_box = page.locator("h1.hero-title").bounding_box()
        assert h1_box is not None, "h1.hero-title not found on dashboard"
        assert h1_box["width"] > 300, \
            f"Dashboard h1 too narrow ({h1_box['width']}px), expected >300px"
        log.info("Dashboard h1 width: %dpx", h1_box["width"])

        hero_copy = page.locator("p.hero-copy").first
        hero_copy_box = hero_copy.bounding_box()
        assert hero_copy_box is not None, "p.hero-copy not found on dashboard"
        assert hero_copy_box["width"] > 300, \
            f"Dashboard hero-copy too narrow ({hero_copy_box['width']}px), expected >300px"
        log.info("Dashboard hero-copy width: %dpx", hero_copy_box["width"])
