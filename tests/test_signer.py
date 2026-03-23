import os
import subprocess
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = PROJECT_ROOT / "web"


def _run_tsx(script: str) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile(
        suffix=".ts", mode="w", delete=False, dir=str(WEB_DIR)
    ) as f:
        f.write(script)
        f.flush()
        tmp = f.name

    try:
        result = subprocess.run(
            ["npx", "tsx", tmp],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=str(WEB_DIR),
        )
        return result.returncode == 0, result.stdout + result.stderr
    finally:
        os.unlink(tmp)


def _run_tsx_with_window(script: str) -> tuple[bool, str]:
    header = """
globalThis.window = {
  nostr: {
    async getPublicKey() { return "deadbeef".repeat(4); },
    async signEvent(template) {
      const { finalizeEvent } = await import("nostr-tools");
      const fakeSk = new Uint8Array(32).fill(1);
      return finalizeEvent(template, fakeSk);
    }
  }
};
"""
    return _run_tsx(header + script)


@pytest.mark.fast
class TestRawSigner:
    def test_raw_signer_creates_valid_keypair(self):
        script = """
        import { generateSecretKey, getPublicKey } from "nostr-tools";
        const sk = generateSecretKey();
        const hexPub = getPublicKey(sk);
        if (typeof hexPub !== "string" || hexPub.length !== 64) {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_raw_signer_get_public_key(self):
        script = """
        import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
        import { createRawSigner } from "./src/signer.ts";

        const sk = generateSecretKey();
        const nsec = nip19.nsecEncode(sk);
        const signer = createRawSigner(nsec);
        const hexPub = await signer.getPublicKey();
        const expected = getPublicKey(sk);

        if (hexPub !== expected) {
          console.error("Mismatch: " + hexPub + " != " + expected);
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_raw_signer_get_npub(self):
        script = """
        import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
        import { createRawSigner } from "./src/signer.ts";

        const sk = generateSecretKey();
        const nsec = nip19.nsecEncode(sk);
        const signer = createRawSigner(nsec);
        const npub = await signer.getNpub();

        if (!npub.startsWith("npub1")) {
          process.exit(1);
        }

        const expectedNpub = nip19.npubEncode(getPublicKey(sk));
        if (npub !== expectedNpub) {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_raw_signer_sign_event(self):
        script = """
        import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
        import { createRawSigner } from "./src/signer.ts";

        const sk = generateSecretKey();
        const nsec = nip19.nsecEncode(sk);
        const signer = createRawSigner(nsec);
        const hexPub = await signer.getPublicKey();

        const event = await signer.signEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "hello from signer test"
        });

        if (event.pubkey !== hexPub) {
          process.exit(1);
        }
        if (event.content !== "hello from signer test") {
          process.exit(1);
        }
        if (!verifyEvent(event)) {
          process.exit(1);
        }
        console.log("OK: " + event.id.slice(0, 16));
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_raw_signer_rejects_invalid_nsec(self):
        script = """
        import { createRawSigner } from "./src/signer.ts";
        try {
          createRawSigner("not-a-valid-nsec");
          process.exit(1);
        } catch (e) {
          if (!e.message.includes("Invalid nsec")) {
            process.exit(1);
          }
          console.log("OK");
        }
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_raw_signer_mode_is_raw(self):
        script = """
        import { generateSecretKey, nip19 } from "nostr-tools";
        import { createRawSigner } from "./src/signer.ts";

        const sk = generateSecretKey();
        const nsec = nip19.nsecEncode(sk);
        const signer = createRawSigner(nsec);

        if (signer.mode !== "raw") {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"


@pytest.mark.fast
class TestNip07Signer:
    def test_nip07_signer_throws_without_extension(self):
        script = """
        globalThis.window = {};
        import { createNip07Signer } from "./src/signer.ts";

        try {
          createNip07Signer();
          process.exit(1);
        } catch (e) {
          if (!e.message.includes("No NIP-07")) {
            process.exit(1);
          }
          console.log("OK");
        }
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_nip07_signer_delegates_to_window_nostr(self):
        script = """
        import { createNip07Signer } from "./src/signer.ts";

        const signer = createNip07Signer();

        if (signer.mode !== "nip07") {
          process.exit(1);
        }

        const hexPub = await signer.getPublicKey();
        if (hexPub !== "deadbeef".repeat(4)) {
          process.exit(1);
        }

        console.log("OK");
        """
        ok, output = _run_tsx_with_window(script)
        assert ok, f"Failed:\n{output}"


@pytest.mark.fast
class TestDetectSigner:
    def test_detect_signer_returns_raw_without_extension(self):
        script = """
        globalThis.window = {};
        import { detectSigner } from "./src/signer.ts";

        const result = detectSigner();

        if (result.mode !== "raw") {
          process.exit(1);
        }
        if (result.signer !== null) {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_detect_signer_returns_nip07_with_extension(self):
        script = """
        import { detectSigner } from "./src/signer.ts";

        const result = detectSigner();

        if (result.mode !== "nip07") {
          process.exit(1);
        }
        if (result.signer === null) {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx_with_window(script)
        assert ok, f"Failed:\n{output}"

    def test_detect_signer_returns_raw_when_no_getpubkey(self):
        script = """
        globalThis.window = { nostr: { someOtherMethod() {} } };
        import { detectSigner } from "./src/signer.ts";

        const result = detectSigner();

        if (result.mode !== "raw") {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_detect_signer_returns_raw_when_no_signevent(self):
        script = """
        globalThis.window = { nostr: { async getPublicKey() { return "a".repeat(64); } } };
        import { detectSigner } from "./src/signer.ts";

        const result = detectSigner();

        if (result.mode !== "raw") {
          process.exit(1);
        }
        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"


@pytest.mark.fast
class TestSignCashuClaimEvent:
    def test_sign_claim_with_raw_signer(self):
        script = """
        import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
        import { createRawSigner } from "./src/signer.ts";
        import { signCashuClaimEvent } from "./src/nostrIdentity.ts";

        const sk = generateSecretKey();
        const nsec = nip19.nsecEncode(sk);
        const signer = createRawSigner(nsec);

        const coordSk = generateSecretKey();
        const coordNpub = nip19.npubEncode(getPublicKey(coordSk));

        const event = await signCashuClaimEvent(
          signer,
          coordNpub,
          "http://127.0.0.1:3338",
          "test-quote-id",
          "lnbc_test_invoice",
          "election-123"
        );

        if (event.kind !== 38010) {
          process.exit(1);
        }

        const pTag = event.tags.find(t => t[0] === "p");
        if (!pTag || pTag[1] !== getPublicKey(coordSk)) {
          process.exit(1);
        }

        const quoteTag = event.tags.find(t => t[0] === "quote");
        if (!quoteTag || quoteTag[1] !== "test-quote-id") {
          process.exit(1);
        }

        if (!verifyEvent(event)) {
          process.exit(1);
        }

        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"

    def test_sign_claim_with_mock_nip07_signer(self):
        script = """
        import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from "nostr-tools";
        import { signCashuClaimEvent } from "./src/nostrIdentity.ts";

        const sk = generateSecretKey();
        const hexPub = getPublicKey(sk);

        const mockSigner = {
          mode: "nip07",
          async getPublicKey() { return hexPub; },
          async getNpub() { return nip19.npubEncode(hexPub); },
          async signEvent(template) {
            return finalizeEvent(template, sk);
          }
        };

        const coordSk = generateSecretKey();
        const coordNpub = nip19.npubEncode(getPublicKey(coordSk));

        const event = await signCashuClaimEvent(
          mockSigner,
          coordNpub,
          "http://mint:3338",
          "quote-abc",
          "lnbc123",
          "election-xyz"
        );

        if (event.kind !== 38010) {
          process.exit(1);
        }
        if (event.pubkey !== hexPub) {
          process.exit(1);
        }

        console.log("OK");
        """
        ok, output = _run_tsx(script)
        assert ok, f"Failed:\n{output}"
