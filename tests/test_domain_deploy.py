import os
import socket
from datetime import datetime, timezone
from urllib.parse import urlparse

import pytest
import requests

from tests.conftest import BASE_URL, VOTING_URL, DASHBOARD_URL, VPS_IP

pytestmark = pytest.mark.integration


def _require_https():
    if not BASE_URL.startswith("https://"):
        pytest.skip("TLS tests require BASE_URL starting with https:// (set via env)")


class TestDomainDNS:
    def test_dns_resolves_to_vps(self):
        if not BASE_URL.startswith("https://"):
            pytest.skip("DNS test requires BASE_URL starting with https://")
        domain = urlparse(BASE_URL).hostname
        resolved = socket.gethostbyname(domain)
        assert resolved == VPS_IP, f"DNS resolved {domain} to {resolved}, expected {VPS_IP}"


class TestDomainTLS:
    def test_https_redirect(self):
        _require_https()
        domain = urlparse(BASE_URL).hostname
        r = requests.get(f"http://{domain}/", allow_redirects=False, timeout=10)
        assert r.status_code in (301, 302), f"Expected redirect, got {r.status_code}"
        assert r.headers["Location"].startswith("https://"), (
            f"Redirect target not HTTPS: {r.headers['Location']}"
        )

    def test_https_frontend_200(self):
        _require_https()
        r = requests.get(BASE_URL, timeout=10, verify=False)
        assert r.status_code == 200

    def test_https_vote_page_200(self):
        _require_https()
        r = requests.get(VOTING_URL, timeout=10, verify=False)
        assert r.status_code == 200

    def test_https_dashboard_page_200(self):
        _require_https()
        r = requests.get(DASHBOARD_URL, timeout=10, verify=False)
        assert r.status_code == 200

    def test_https_api_proxy(self):
        _require_https()
        r = requests.get(f"{BASE_URL}/api/info", timeout=10, verify=False)
        assert r.status_code == 200
        data = r.json()
        assert "coordinatorNpub" in data
        assert data["coordinatorNpub"].startswith("npub1")

    def test_https_mint_proxy(self):
        _require_https()
        r = requests.get(f"{BASE_URL}/mint/v1/info", timeout=10, verify=False)
        assert r.status_code == 200
        data = r.json()
        assert "pubkey" in data

    def test_https_certificate_valid(self):
        _require_https()
        import ssl
        import subprocess

        domain = urlparse(BASE_URL).hostname
        ctx = ssl.create_default_context()
        conn = ctx.wrap_socket(socket.socket(), server_hostname=domain)
        conn.settimeout(5)
        conn.connect((domain, 443))
        cert = conn.getpeercert()
        conn.close()

        not_after = datetime.strptime(
            cert["notAfter"], "%b %d %H:%M:%S %Y %Z"
        ).replace(tzinfo=timezone.utc)
        assert not_after > datetime.now(timezone.utc), (
            f"Certificate expired on {not_after}"
        )

        for san in cert.get("subjectAltName", ()):
            if san[0] == "DNS" and san[1] == domain:
                return
        pytest.fail(f"Certificate does not match hostname {domain}")
