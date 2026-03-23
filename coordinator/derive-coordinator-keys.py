#!/usr/bin/env python3
import sys
import json
import hmac
import hashlib

from mnemonic import Mnemonic
from bech32 import bech32_encode, convertbits
import coincurve


def mnemonic_to_master_key(mnemonic_phrase):
    mnemo = Mnemonic("english")
    seed = mnemo.to_seed(mnemonic_phrase, passphrase="")
    il, ir = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()[:32], \
             hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()[32:]
    return il, ir


def privkey_to_nostr_bech32(privkey_bytes):
    pk = coincurve.PrivateKey(privkey_bytes)
    x_only_bytes = pk.public_key.format(compressed=True)[1:]

    nsec_data = convertbits(privkey_bytes, 8, 5)
    npub_data = convertbits(x_only_bytes, 8, 5)

    nsec = bech32_encode("nsec", nsec_data)
    npub = bech32_encode("npub", npub_data)

    return nsec, npub, x_only_bytes.hex()


def main():
    if len(sys.argv) != 2:
        print("Usage: derive-coordinator-keys.py <mnemonic>", file=sys.stderr)
        sys.exit(1)

    mnemonic_phrase = sys.argv[1].strip()

    mnemo = Mnemonic("english")
    if not mnemo.check(mnemonic_phrase):
        print("Invalid mnemonic", file=sys.stderr)
        sys.exit(1)

    master_priv, _ = mnemonic_to_master_key(mnemonic_phrase)
    nsec, npub, pubkey_hex = privkey_to_nostr_bech32(master_priv)

    result = {
        "nsec": nsec,
        "npub": npub,
        "pubkey_hex": pubkey_hex,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
