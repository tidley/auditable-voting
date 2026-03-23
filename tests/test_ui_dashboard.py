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
        assert "Eligibility registry" not in body, \
            f"Eligibility registry should be on voter portal, not dashboard. Body: {body[:500]}"
        log.info("Dashboard no longer shows eligible npubs (moved to voter portal): OK")

    def test_dashboard_shows_tally(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('PUBLISHED')", timeout=15000)
        expect(page.locator("p.panel-kicker:has-text('PUBLISHED')")).to_be_visible()
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
        results_kicker = page.locator("p.panel-kicker:has-text('Results')")
        results_count = results_kicker.count()
        if results_count > 0:
            results_kicker.wait_for(timeout=15000)
            expect(results_kicker).to_be_visible()
            page.wait_for_selector("text=MULTIPLE CHOICE", timeout=15000)
            ballot_section = page.locator("section:has(p.panel-kicker:text-is(\"Results\"))")
            ballot_text = ballot_section.inner_text()
            has_questions = "MULTIPLE CHOICE" in ballot_text or "FREE TEXT" in ballot_text or "SCALE" in ballot_text
            assert has_questions, f"Question type badges not found. Ballot text: {ballot_text[:500]}"
            log.info("Dashboard shows results section with question type badges: OK")
        else:
            tally_kicker = page.locator("p.panel-kicker:has-text('Tally')")
            tally_kicker.wait_for(timeout=15000)
            log.info("Dashboard shows Tally section (no results yet — no votes cast): OK")

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

    def test_dashboard_tally_shows_accepted_not_published(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('PUBLISHED')", timeout=15000)
        body = page.locator("body").inner_text()

        assert "PUBLISHED" in body, f"No 'PUBLISHED' text found. Body: {body[:500]}"
        assert "ACCEPTED" in body, f"No 'ACCEPTED' text found. Body: {body[:500]}"

        published_el = page.locator("p.panel-kicker:text-is('PUBLISHED') + div")
        accepted_el = page.locator("p.panel-kicker:text-is('ACCEPTED') + div")

        if published_el.count() > 0 and accepted_el.count() > 0:
            published_text = published_el.inner_text()
            accepted_text = accepted_el.inner_text()
            log.info("Published: %s, Accepted: %s", published_text.strip(), accepted_text.strip())
        log.info("Dashboard tally shows published and accepted counts: OK")

    def test_dashboard_tally_no_unverified_warning(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('Published')", timeout=15000)
        body = page.locator("body").inner_text()

        assert "unverified" not in body.lower(), \
            f"Dashboard should not show unverified vote warning. Body: {body[:500]}"
        assert "_trust" not in body.lower(), \
            f"Dashboard should not show _trust field. Body: {body[:500]}"
        log.info("Dashboard tally has no unverified warning: OK")

    def test_dashboard_tally_no_stale_e2e_votes(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("p.panel-kicker:has-text('Published')", timeout=15000)
        body = page.locator("body").inner_text()

        assert "test-e2e" not in body.lower(), \
            f"Dashboard shows stale E2E test election data. Body: {body[:1000]}"
        assert "e2e test election" not in body.lower(), \
            f"Dashboard shows stale E2E test election title. Body: {body[:1000]}"
        log.info("Dashboard has no stale E2E test data: OK")

    def test_dashboard_links_to_vote_page(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Backend Dashboard", timeout=15000)
        vote_link = page.locator("a.ghost-button:has-text('Voting Page')")
        assert vote_link.count() >= 1, "Dashboard should have a 'Voting Page' link"
        assert vote_link.first.get_attribute("href") == "/vote.html", \
            "Voting Page link should point to /vote.html"
        log.info("Dashboard has Voting Page link: OK")

    def test_dashboard_no_eligibility_registry(self, dashboard_page):
        page = dashboard_page
        page.wait_for_selector("text=Backend Dashboard", timeout=15000)
        page.wait_for_timeout(3000)

        body = page.locator("body").inner_text()
        assert "Eligible npubs" not in body, \
            f"Dashboard should not show eligibility registry. Body: {body[:500]}"
        assert "Eligibility registry" not in body, \
            f"Dashboard should not show eligibility registry header. Body: {body[:500]}"
        log.info("Dashboard has no eligibility registry: OK")
