# Shared native/Wasm blind-credential core

The browser and the Rust Guardian use `blind-credential-core/` for the same RSA blind-signature operations. This changes the implementation, not the voting protocol, eligibility, admission codes, message transport, response identity or public audit format.

## Compatibility contract

- Suite: `rsabssa-sha384-pss-deterministic-v1` (RFC 9474 SHA-384/PSS with 48-byte salt and deterministic message preparation). “Deterministic” does not remove the fresh PSS salt or blinding randomness.
- Browser key generation remains native WebCrypto RSA-PSS, SHA-384, 3072 bits, exponent 65537, extractable JWK. Questionnaire key IDs still hash `JSON.stringify({n,e})`; simple-share key IDs still hash `${n}:${e}`. Neither format is rewritten.
- Existing public JWK `n,e`, private JWK `n,e,d,p,q`, fixed-width hexadecimal blinded messages/signatures and saved inverse factors remain the inputs. Private CRT values are validated/recomputed by the RSA implementation rather than trusted from extra JWK metadata.
- Import bounds: existing 1024–4096-bit RSA keys, components up to 512 bytes, 1 MiB message bytes and 16 KiB binding JWK JSON. Legacy 1024-bit import compatibility is not a recommendation to create weak keys. Default generation is still 3072 bits. Unsupported/malformed material fails closed and never triggers automatic key replacement.
- Questionnaire callers supply the existing canonical signed-message bytes, including scope and credential-slot data. Simple shares retain the exact `auditable-voting/simple-blind/v2|` domain separator. No Rust JSON serialiser replaces the existing caller message encoding.
- The saved `blindingFactor` is the modular inverse, not the original random multiplier. Finalisation accepts an old saved inverse plus the original message and response; it does not need a new request or a regenerated secret. Finalisation verifies the resulting signature before returning it.

## Boundaries and API

Native `PublicKey::from_jwk`, `blind`, `finalize`, `verify`, and `sign` are implemented in `blind-credential-core/src/lib.rs`. Wasm exports are thin wrappers over the same code. `web/src/wasm/blindCredentials.ts` loads the generated module; questionnaire/simple-share wrappers retain their existing public interfaces and persisted structures. `worker/src/main.rs` uses the native API for issuance and proof verification.

No custom RSA arithmetic is introduced. Private operations use the library's randomly blinded, checked RSA operation rather than the Guardian's former raw call without a blinding RNG. Randomness comes from the Rust RNG backed by the platform CSPRNG; Wasm enables the JavaScript WebCrypto entropy backend. Failure does not fall back to weak randomness or legacy JavaScript crypto.

The browser still controls the Wasm host, code delivery, entropy source and storage. JWKs and inverse factors cross the JS/Wasm boundary and may have copies in both heaps. Wasm is not a secure enclave; this migration does not claim audited memory erasure, constant-time browser execution, protection from XSS, device compromise, coercion or network/timing correlation.

## Dependency security and local patch

`rsa` is pinned to stable **0.10.0**, the patched boundary documented by [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html). Do not downgrade to an earlier release candidate to satisfy another package.

The released `blind-rsa-signatures` 0.18.0 package does not compile unchanged with stable RSA because its separate partially-blind-signature module uses removed prerelease traits. The vendored copy pins stable RSA and omits that unused `pbrsa` module. A third, test-only change fixes empty byte-string parsing in the upstream RFC fixture reader: an empty salt must not become a zero machine word. Expected RFC vector values and all production BRSA, PSS, hashing, blinding and verification code remain unchanged. The MIT licence, original file hashes and conformance tests are retained; see `vendor/blind-rsa-signatures/LOCAL-PATCH.md`. This is a local maintenance obligation, not an audited upstream release.

After native/Wasm/legacy-JavaScript interoperability checks, application tests and two independent read-only reviews, `@cloudflare/blindrsa-ts` was removed from runtime dependency declarations. It is pinned as a **dev-only** independent oracle; its transitive SJCL dependency is not used by production application imports. Do not remove the oracle or claim its development dependency warnings are fixed. This document does not claim an independent cryptographic audit or that all dependency vulnerabilities in issue #42 are fixed. The 12 November scan with `cargo-audit` 0.23.0 reported no vulnerabilities or warnings in the shared-core and vendor test lockfiles. The separate coordinator/MLS graph still has deferred findings; see the [dependency security follow-up](dependency-security.md).

## Verification

Use the configured central build adapters with `/mnt/fastbuild` mounted. From the repository root:

```bash
cargo test --release --locked --manifest-path blind-credential-core/Cargo.toml --jobs 2
cargo test --release --locked --manifest-path worker/Cargo.toml --jobs 2
cargo test --release --manifest-path vendor/blind-rsa-signatures/Cargo.toml --test vectors --jobs 2
npm --prefix web run build:wasm:blind
npm --prefix web run verify:blind-compatibility
npm --prefix web run verify:simple-blind-shares
```

From `web/`, run `npx tsc --noEmit`, `npx vitest run --maxWorkers=2`, relevant local browser tests and `npm run build`. Generated Wasm output is ignored and must be rebuilt from matching source; `ensure-wasm-artifacts.mjs` checks each package independently, including the vendored inputs.

`verify:blind-compatibility` uses fictional keys only and builds a native test driver, using Cargo's reported executable path. It tests legacy-JS client/native issuer, Wasm client/legacy-JS issuer, native client/Wasm issuer, all three verifiers, legacy 1024-bit and normal 2048/3072/4096-bit formats, UTF-8/empty messages, tampering and the checked-in saved credential/request fixture. No relay events, email or real voter keys are used. The fixture is public test material and must never be used for an election.
