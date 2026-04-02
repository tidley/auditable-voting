import json
import os
from pathlib import Path

import pytest
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = PROJECT_ROOT / "web"
ENV_FILE = PROJECT_ROOT / ".env"
ENV_EXAMPLE = PROJECT_ROOT / ".env.example"

COORDINATOR_URL = os.environ.get("COORDINATOR_URL", "http://23.182.128.64:8081")
MINT_URL = os.environ.get("MINT_URL", "http://23.182.128.64:3338")


# ---------------------------------------------------------------------------
# Group 1: Coordinator / Mint Connectivity and CORS
# ---------------------------------------------------------------------------

@pytest.mark.integration
class TestCoordinatorConnectivity:
    def test_coordinator_info_200(self):
        r = requests.get(f"{COORDINATOR_URL}/info", timeout=10)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "coordinatorNpub" in data, "Missing coordinatorNpub"
        assert data["coordinatorNpub"].startswith("npub1"), f"Bad npub format: {data['coordinatorNpub']}"
        assert "mintUrl" in data, "Missing mintUrl"
        assert "relays" in data, "Missing relays"

    def test_coordinator_cors_options(self):
        origin = "http://localhost:5173"
        r = requests.options(
            f"{COORDINATOR_URL}/info",
            timeout=10,
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )
        assert r.status_code in (200, 204), f"OPTIONS returned {r.status_code}"
        acao = r.headers.get("Access-Control-Allow-Origin", "")
        assert acao in ("*", origin), f"Expected Access-Control-Allow-Origin: {origin} or *, got '{acao}'"

    def test_coordinator_cors_get(self):
        origin = "http://localhost:5173"
        r = requests.get(
            f"{COORDINATOR_URL}/info",
            timeout=10,
            headers={"Origin": origin},
        )
        assert r.status_code == 200
        acao = r.headers.get("Access-Control-Allow-Origin", "")
        assert acao in ("*", origin), f"Expected Access-Control-Allow-Origin: {origin} or *, got '{acao}'"


@pytest.mark.integration
class TestMintConnectivity:
    def test_mint_info_200(self):
        r = requests.get(f"{MINT_URL}/v1/info", timeout=10)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "pubkey" in data, "Missing pubkey in mint /v1/info"

    def test_mint_cors_options(self):
        r = requests.options(
            f"{MINT_URL}/v1/info",
            timeout=10,
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert r.status_code in (200, 204), f"OPTIONS returned {r.status_code}"
        acao = r.headers.get("Access-Control-Allow-Origin", "")
        assert acao == "*", f"Expected Access-Control-Allow-Origin: *, got '{acao}'"

    def test_mint_cors_get(self):
        origin = "http://localhost:5173"
        r = requests.get(
            f"{MINT_URL}/v1/info",
            timeout=10,
            headers={"Origin": origin},
        )
        assert r.status_code == 200
        acao = r.headers.get("Access-Control-Allow-Origin", "")
        assert acao in ("*", origin), f"GET response missing CORS header, got '{acao}'"


# ---------------------------------------------------------------------------
# Group 2: Election and Eligibility State
# ---------------------------------------------------------------------------

@pytest.mark.integration
class TestElectionState:
    def test_election_announced(self):
        r = requests.get(f"{COORDINATOR_URL}/election", timeout=10)
        if r.status_code == 404:
            pytest.skip("No election announced yet (kind 38008 not published)")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "election_id" in data, "Missing election_id"
        assert "questions" in data, "Missing questions"
        assert "start_time" in data, "Missing start_time"
        assert "end_time" in data, "Missing end_time"

    def test_election_has_questions(self):
        r = requests.get(f"{COORDINATOR_URL}/election", timeout=10)
        if r.status_code == 404:
            pytest.skip("Election not announced (404)")
        data = r.json()
        questions = data.get("questions", [])
        assert isinstance(questions, list), "questions must be a list"
        assert len(questions) >= 1, "Election must have at least 1 question"
        for q in questions:
            assert "id" in q, f"Question missing 'id': {q}"
            assert "prompt" in q, f"Question missing 'prompt': {q}"
            assert "type" in q, f"Question missing 'type': {q}"


@pytest.mark.integration
class TestEligibilityState:
    def test_eligibility_published(self):
        r = requests.get(f"{COORDINATOR_URL}/eligibility", timeout=10)
        if r.status_code == 404:
            pytest.skip("No election announced yet (eligibility requires kind 38008)")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "eligible_npubs" in data, "Missing eligible_npubs"
        assert isinstance(data["eligible_npubs"], list), "eligible_npubs must be a list"
        assert data.get("eligible_count", 0) > 0, "eligible_count must be > 0"

    def test_tally_returns_data(self):
        r = requests.get(f"{COORDINATOR_URL}/tally", timeout=10)
        if r.status_code == 404:
            pytest.skip("No election announced yet (tally requires kind 38008)")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "election_id" in data, "Missing election_id in tally"


# ---------------------------------------------------------------------------
# Group 3: Mint NUT API Shape
# ---------------------------------------------------------------------------

@pytest.mark.integration
class TestMintApiShape:
    def test_mint_quote_creation(self):
        r = requests.post(
            f"{MINT_URL}/v1/mint/quote/bolt11",
            json={"amount": 1, "unit": "sat"},
            timeout=10,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "quote" in data, f"Missing 'quote' field (not 'quote_id'): {list(data.keys())}"
        assert data.get("state") == "UNPAID", f"Expected state UNPAID, got {data.get('state')}"
        assert data.get("amount") == 1, f"Expected amount 1, got {data.get('amount')}"

    def test_mint_keys(self):
        r = requests.get(f"{MINT_URL}/v1/keys", timeout=10)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert isinstance(data, dict), "Keys response must be a dict"

    def test_mint_keysets(self):
        r = requests.get(f"{MINT_URL}/v1/keysets", timeout=10)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        if isinstance(data, dict) and "keysets" in data:
            keysets = data["keysets"]
        elif isinstance(data, list):
            keysets = data
        else:
            pytest.fail(f"Unexpected keysets response shape: {type(data)}")
        assert isinstance(keysets, list), "Keysets must be a list"
        active_sat = [ks for ks in keysets if ks.get("unit") == "sat" and ks.get("active")]
        assert len(active_sat) >= 1, "No active sat keyset found"
        for ks in active_sat:
            assert len(ks["id"]) >= 1, f"Keyset ID is empty"

    def test_coordinator_info_mint_url_matches(self):
        coord_r = requests.get(f"{COORDINATOR_URL}/info", timeout=10)
        mint_r = requests.get(f"{MINT_URL}/v1/info", timeout=10)
        assert coord_r.status_code == 200
        assert mint_r.status_code == 200
        coord_data = coord_r.json()
        mint_data = mint_r.json()
        assert coord_data["mintPublicKey"] == mint_data["pubkey"], (
            f"Coordinator mint pubkey '{coord_data['mintPublicKey']}' != mint pubkey '{mint_data['pubkey']}'"
        )


# ---------------------------------------------------------------------------
# Group 4: Frontend Build and JS Package API Surface
# ---------------------------------------------------------------------------

@pytest.mark.fast
class TestFrontendBuild:
    def test_frontend_tsc_passes(self):
        from conftest import _run_in_web
        ok, output = _run_in_web(["npx", "tsc", "--noEmit"], timeout=30)
        assert ok, f"tsc --noEmit failed:\n{output[-2000:]}"

    def test_frontend_vite_build_passes(self):
        from conftest import _run_in_web
        ok, output = _run_in_web(["npx", "vite", "build"], timeout=60)
        assert ok, f"vite build failed:\n{output[-2000:]}"


@pytest.mark.fast
class TestCashuTsExports:
    def test_cashu_ts_exports_cashuwallet(self):
        from conftest import _check_js
        script = """
        import { CashuWallet } from "@cashu/cashu-ts";
        const methods = ["createMintQuote", "mintProofs", "createBlankOutputs", "createOutputData", "getActiveKeyset"];
        const proto = CashuWallet.prototype;
        const missing = methods.filter(m => typeof proto[m] !== "function");
        if (missing.length > 0) {
          console.error("MISSING methods: " + missing.join(", "));
          process.exit(1);
        }
        console.log("OK: all CashuWallet methods found");
        """
        ok, output = _check_js(script)
        assert ok, f"@cashu/cashu-ts API mismatch:\n{output}"

    def test_cashu_ts_exports_token_encode(self):
        from conftest import _check_js
        script = """
        import { getEncodedToken, getDecodedToken } from "@cashu/cashu-ts";
        if (typeof getEncodedToken !== "function") {
          console.error("getEncodedToken is not a function: " + typeof getEncodedToken);
          process.exit(1);
        }
        if (typeof getDecodedToken !== "function") {
          console.error("getDecodedToken is not a function: " + typeof getDecodedToken);
          process.exit(1);
        }
        console.log("OK: token encode/decode exports found");
        """
        ok, output = _check_js(script)
        assert ok, f"@cashu/cashu-ts token exports mismatch:\n{output}"


@pytest.mark.fast
class TestNostrToolsNip17:
    def test_nostr_tools_nip17_wrap_event(self):
        from conftest import _check_js
        script = """
        import { nip17 } from "nostr-tools";
        if (typeof nip17 !== "object" || typeof nip17.wrapEvent !== "function") {
          console.error("nip17.wrapEvent not found. nip17 type: " + typeof nip17);
          process.exit(1);
        }
        console.log("OK: nip17.wrapEvent found");
        """
        ok, output = _check_js(script)
        assert ok, f"nostr-tools nip17 mismatch:\n{output}"


# ---------------------------------------------------------------------------
# Group 5: Config and .env Validation
# ---------------------------------------------------------------------------

@pytest.mark.fast
class TestEnvConfig:
    def test_env_file_exists(self):
        assert ENV_FILE.exists(), f".env not found at {ENV_FILE}"

    def test_env_use_mock_false(self):
        content = ENV_FILE.read_text()
        for line in content.strip().splitlines():
            key = line.split("=", 1)[0].strip()
            if key == "VITE_USE_MOCK":
                value = line.split("=", 1)[1].strip().lower()
                assert value == "false", f"VITE_USE_MOCK={value}, expected false"
                return
        pytest.fail("VITE_USE_MOCK not found in .env")

    def test_env_coordinator_url_set(self):
        content = ENV_FILE.read_text()
        for line in content.strip().splitlines():
            key = line.split("=", 1)[0].strip()
            if key == "VITE_COORDINATOR_URL":
                value = line.split("=", 1)[1].strip()
                assert value.startswith("http"), f"VITE_COORDINATOR_URL looks wrong: {value}"
                return
        pytest.fail("VITE_COORDINATOR_URL not found in .env")

    def test_env_mint_url_set(self):
        content = ENV_FILE.read_text()
        for line in content.strip().splitlines():
            key = line.split("=", 1)[0].strip()
            if key == "VITE_MINT_URL":
                value = line.split("=", 1)[1].strip()
                assert value.startswith("http"), f"VITE_MINT_URL looks wrong: {value}"
                return
        pytest.fail("VITE_MINT_URL not found in .env")

    def test_env_example_committed(self):
        assert ENV_EXAMPLE.exists(), f".env.example not found at {ENV_EXAMPLE}"
        env_keys = set()
        example_keys = set()
        for line in ENV_FILE.read_text().strip().splitlines():
            if "=" in line and not line.startswith("#"):
                env_keys.add(line.split("=", 1)[0].strip())
        for line in ENV_EXAMPLE.read_text().strip().splitlines():
            if "=" in line and not line.startswith("#"):
                example_keys.add(line.split("=", 1)[0].strip())
        assert env_keys == example_keys, (
            f"Keys differ.\n.env: {sorted(env_keys)}\n.env.example: {sorted(example_keys)}"
        )


# ---------------------------------------------------------------------------
# Group 6: Type Declaration Correctness
# ---------------------------------------------------------------------------

@pytest.mark.fast
class TestCashuTypeDeclarations:
    def test_cashu_dts_declarations_match_real_api(self):
        from conftest import _check_js
        dts_path = WEB_DIR / "src" / "cashu.d.ts"
        assert dts_path.exists(), "cashu.d.ts not found"

        script = """
        import * as cashu from "@cashu/cashu-ts";
        const exports = Object.keys(cashu).filter(k => typeof cashu[k] === "function");
        console.log("EXPORTS:" + JSON.stringify(exports));

        // Also check CashuWallet prototype methods
        if (cashu.CashuWallet) {
          const proto = Object.getOwnPropertyNames(cashu.CashuWallet.prototype);
          console.log("WALLET_METHODS:" + JSON.stringify(proto));
        }
        """
        ok, output = _check_js(script)
        assert ok, f"Could not query @cashu/cashu-ts exports:\n{output}"

        dts_content = dts_path.read_text()

        # Extract function names declared in cashu.d.ts
        # Look for patterns like: export function fooBar(...)
        import re
        declared_functions = set(re.findall(r"export\s+function\s+(\w+)", dts_content))

        # Parse the exports from the JS output
        exports_line = [l for l in output.splitlines() if l.startswith("EXPORTS:")]
        wallet_line = [l for l in output.splitlines() if l.startswith("WALLET_METHODS:")]

        real_exports = set()
        if exports_line:
            real_exports.update(json.loads(exports_line[0].split(":", 1)[1]))
        if wallet_line:
            real_exports.update(json.loads(wallet_line[0].split(":", 1)[1]))

        missing = declared_functions - real_exports
        if missing:
            pytest.fail(
                f"cashu.d.ts declares functions not in @cashu/cashu-ts: {sorted(missing)}\n"
                f"Real exports: {sorted(real_exports)}\n"
                f"This means cashuBlind.ts needs to be rewritten to use the correct API."
            )
