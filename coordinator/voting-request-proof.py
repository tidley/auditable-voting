#!/usr/bin/env python3
import argparse
import json
import logging
import secrets
import sys
import time
from pathlib import Path

import requests
from coincurve import PublicKey
from nostr_sdk import (
    Client,
    Event,
    EventBuilder,
    Filter,
    HandleNotification,
    Kind,
    NostrSigner,
    Tag,
    Timestamp,
    Keys,
)

log = logging.getLogger("voter")


def create_quote(mint_url: str) -> dict:
    resp = requests.post(
        f"{mint_url}/v1/mint/quote/bolt11",
        json={"amount": 1, "unit": "sat"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    quote_id = data.get("quote") or data.get("quote_id")
    if not quote_id:
        raise ValueError(f"No quote_id in response: {data}")
    data["quote_id"] = quote_id
    log.info("Created quote: %s", quote_id)
    return data


def get_keyset_id(mint_url: str) -> str:
    resp = requests.get(f"{mint_url}/v1/keysets", timeout=10)
    resp.raise_for_status()
    keysets = resp.json().get("keysets", [])
    sat_keysets = [ks for ks in keysets if ks.get("unit") == "sat" and ks.get("active")]
    if not sat_keysets:
        raise ValueError(f"No active sat keyset found: {keysets}")
    keyset_id = sat_keysets[0]["id"]
    log.info("Using keyset: %s", keyset_id)
    return keyset_id


def build_blinded_output(keyset_id: str, amount: int = 1) -> tuple[str, str]:
    from cashu.core.crypto.b_dhke import step1_alice
    from cashu.core.base import BlindedMessage

    secret_msg = secrets.token_hex(32)
    B_, r = step1_alice(secret_msg)
    B_hex = B_.format(compressed=True).hex()

    blinded_msg = BlindedMessage(amount=amount, id=keyset_id, B_=B_hex, C_=None)
    output_str = json.dumps(blinded_msg.model_dump(mode="json"))

    log.info("Built blinded output for %d sat (secret=%s...)", amount, secret_msg[:16])
    return output_str, secret_msg


def publish_issuance_request(
    nsec: str,
    quote_id: str,
    amount: str,
    mint_url: str,
    coordinator_npub: str,
    election: str,
    relays: list[str],
) -> None:
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)

    for relay in relays:
        client.add_relay(relay)
    client.connect()

    tags = [
        Tag.custom(["p", coordinator_npub]),
        Tag.custom(["quote", quote_id]),
        Tag.custom(["amount", amount]),
        Tag.custom(["mint", mint_url]),
        Tag.custom(["election", election]),
    ]

    builder = EventBuilder(kind=Kind(38010), content="Requesting 1 sat proof", tags=tags)
    event_id = client.send_event_builder(builder)
    log.info("Published kind 38010 event: %s", event_id.to_bech32() if hasattr(event_id, 'to_bech32') else event_id)


def poll_quote_until_paid(mint_url: str, quote_id: str, timeout: int = 300) -> bool:
    delay = 1.0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = requests.get(
                f"{mint_url}/v1/mint/quote/bolt11/{quote_id}", timeout=10
            )
            if resp.status_code == 200:
                state = resp.json().get("state", "").upper()
                if state == "PAID":
                    log.info("Quote %s is PAID", quote_id)
                    return True
                log.info("Quote state: %s (retrying in %.0fs)", state, delay)
        except requests.RequestException as exc:
            log.warning("Poll error: %s", exc)

        time.sleep(delay)
        delay = min(delay * 2, 30)

    log.error("Timeout waiting for quote %s to be paid (waited %ds)", quote_id, timeout)
    return False


def mint_tokens(
    mint_url: str, quote_id: str, blinded_outputs: list[str]
) -> list[dict]:
    resp = requests.post(
        f"{mint_url}/v1/mint/bolt11",
        json={"quote": quote_id, "outputs": blinded_outputs},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    signatures = data.get("signatures", [])
    log.info("Mint returned %d signatures", len(signatures))
    return signatures


def unblind_signature(
    signature_dict: dict, secret_msg: str, blinded_B_hex: str
) -> dict:
    from cashu.core.crypto.b_dhke import step3_alice

    C_hex = signature_dict["C_"]
    C_ = PublicKey(bytes.fromhex(C_hex))
    B_ = PublicKey(bytes.fromhex(blinded_B_hex))

    r_val = int.from_bytes(
        secrets.token_bytes(32), "big"
    )
    unblinded = step3_alice(C_, None, B_)
    return {
        "id": signature_dict["id"],
        "amount": signature_dict["amount"],
        "secret": secret_msg,
        "C": unblinded.format(compressed=True).hex(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Voter CLI: request a Cashu proof from the TollGate voting coordinator"
    )
    parser.add_argument("--nsec", required=True, help="Voter's Nostr private key (nsec1...)")
    parser.add_argument("--mint-url", required=True, help="Mint HTTP URL (e.g. http://23.182.128.64:3338)")
    parser.add_argument("--coordinator-npub", required=True, help="Coordinator's npub (for p tag)")
    parser.add_argument("--election", required=True, help="Election ID (for election tag)")
    parser.add_argument(
        "--relays",
        nargs="+",
        default=["ws://23.182.128.64:10547", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"],
        help="Nostr relay URLs (default: ws://23.182.128.64:10547 wss://relay.damus.io wss://nos.lol wss://relay.primal.net)",
    )
    parser.add_argument("--output", default="proof.json", help="Output file for proof (default: proof.json)")
    parser.add_argument("--timeout", type=int, default=300, help="Poll timeout in seconds (default: 300)")
    return parser.parse_args()


def check_dependencies() -> None:
    missing = []
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests (pip install requests)")
    try:
        import nostr_sdk  # noqa: F401
    except ImportError:
        missing.append("nostr-sdk (pip install nostr-sdk)")
    try:
        from cashu.core.crypto.b_dhke import step1_alice  # noqa: F401
    except ImportError:
        missing.append("cashu (pip install cashu)")
    if missing:
        for dep in missing:
            print(f"Missing dependency: {dep}", file=sys.stderr)
        raise SystemExit(1)


def main() -> int:
    check_dependencies()
    args = parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    log.info("Step 1: Creating 1-sat mint quote on %s", args.mint_url)
    quote_data = create_quote(args.mint_url)
    quote_id = quote_data["quote_id"]

    log.info("Step 2: Getting keyset from mint")
    keyset_id = get_keyset_id(args.mint_url)

    log.info("Step 3: Building blinded output")
    blinded_output, secret_msg = build_blinded_output(keyset_id, amount=1)
    blinded_B_hex = json.loads(blinded_output)["B_"]

    log.info("Step 4: Publishing kind 38010 event to relays")
    publish_issuance_request(
        nsec=args.nsec,
        quote_id=quote_id,
        amount="1",
        mint_url=args.mint_url,
        coordinator_npub=args.coordinator_npub,
        election=args.election,
        relays=args.relays,
    )

    log.info("Step 5: Polling for quote approval (timeout: %ds)", args.timeout)
    if not poll_quote_until_paid(args.mint_url, quote_id, timeout=args.timeout):
        log.error("Quote was not approved in time. The coordinator may not be running.")
        return 1

    log.info("Step 6: Minting tokens")
    signatures = mint_tokens(args.mint_url, quote_id, [blinded_output])

    log.info("Step 7: Saving proof to %s", args.output)
    proof_data = {
        "mint_url": args.mint_url,
        "quote_id": quote_id,
        "keyset_id": keyset_id,
        "proofs": signatures,
        "secret": secret_msg,
        "blinded_B": blinded_B_hex,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(proof_data, indent=2) + "\n")

    log.info("Done! Proof saved to %s (%d signature(s))", args.output, len(signatures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
