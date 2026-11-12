# Auditable Voting compatibility patch

Upstream: `jedisct1/rust-blind-rsa-signatures`, crates.io package **0.18.0** (MIT). Original copied-file SHA-256 hashes are in `UPSTREAM-SHA256.json`. This directory is a dependency copy, not a separate voting protocol.

Only three upstream files are changed:

1. `Cargo.toml`: require stable `rsa = 0.10.0`, the patched boundary published for [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html).
2. `src/lib.rs`: exclude `pub mod pbrsa`. That separate partially-blind-signature implementation uses prerelease-only RSA trait methods and does not compile with stable RSA. Auditable Voting does not use PBRSA. Its source remains unmodified for provenance but is not compiled or exported.
3. `tests/vectors.rs` (test-only): parse an empty RFC byte string as an empty byte vector rather than a zero bigint, whose current byte export contains a zero machine word. The original parser made the PSSZERO test RNG panic when asked to fill a zero-length salt. Expected vector values and production cryptographic code are unchanged.

No BRSA arithmetic, PSS encoding, blinding, finalisation, verification, RNG or private-operation implementation has been edited. All other copied upstream files must match the recorded hashes. RFC 9474 conformance tests remain included; run them before accepting the patch.

This patch is not an independent cryptographic audit. Replacing this copy with an upstream release requires the same native/Wasm interoperability tests and security review; do not silently re-enable PBRSA or downgrade RSA to satisfy compilation.
