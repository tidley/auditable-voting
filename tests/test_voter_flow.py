import importlib.util
import logging
import sys
from pathlib import Path

import pytest
import requests

COORDINATOR_DIR = Path(__file__).resolve().parents[1] / "coordinator"
ROOT_DIR = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "voting_request_proof", COORDINATOR_DIR / "voting-request-proof.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

from conftest_voter import MINT_URL

log = logging.getLogger("test_voter_flow")


@pytest.mark.voter
class TestVoterBlinding:
    def test_build_blinded_output_returns_valid_json(self):
        output, secret = _mod.build_blinded_output("test_keyset_id", amount=1)
        import json

        data = json.loads(output)
        assert data["amount"] == 1
        assert data["id"] == "test_keyset_id"
        assert data["B_"].startswith("02") or data["B_"].startswith("03")
        assert len(secret) == 64

    def test_build_blinded_output_different_secrets(self):
        output1, secret1 = _mod.build_blinded_output("test_keyset_id", amount=1)
        output2, secret2 = _mod.build_blinded_output("test_keyset_id", amount=1)
        assert secret1 != secret2


@pytest.mark.voter
class TestVoterQuotePolling:
    def test_poll_timeout_on_unpaid_quote(self):
        create_resp = requests.post(
            f"{MINT_URL}/v1/mint/quote/bolt11",
            json={"amount": 1, "unit": "sat"},
            timeout=10,
        )
        quote_id = create_resp.json().get("quote") or create_resp.json().get("quote_id")
        assert quote_id

        result = _mod.poll_quote_until_paid(MINT_URL, quote_id, timeout=3)
        assert result is False


@pytest.mark.voter
class TestVoterQuoteCreation:
    def test_create_quote_response_format(self):
        quote = _mod.create_quote(MINT_URL)
        assert "quote_id" in quote
        assert len(quote["quote_id"]) > 0
        assert quote.get("amount") == 1


@pytest.mark.voter
class TestVoterKeyset:
    def test_get_keyset_id_returns_sat_keyset(self):
        keyset_id = _mod.get_keyset_id(MINT_URL)
        assert len(keyset_id) >= 4
        assert all(c in "0123456789abcdef" for c in keyset_id)
