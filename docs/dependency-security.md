# Dependency security follow-up — 12 November 2026

These changes describe local source and lockfiles, not an installed Guardian,
published release or deployed website. They are not a cryptographic audit.

## npm

`web/package-lock.json` resolves `source-map-js` to **1.2.2**, which fixes
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
No override or new direct dependency was needed. `npm audit --omit=dev` reports
zero vulnerabilities. The full development dependency graph still has findings
tracked in [issue #42](https://github.com/tidley/auditable-voting/issues/42).
The legacy JavaScript blind-signature implementation remains a dev-only oracle.

## Native Guardian

The Guardian uses `nostr-sdk` **0.45.6** and `nostr` **0.45.7**, with NIP-59
enabled explicitly on `nostr`. The SDK now contains the relay-pool implementation;
the unmaintained standalone `nostr-relay-pool` dependency is removed.

Targeted lockfile updates also select patched TLS, certificate, QUIC, cache,
runtime and error-handling dependencies. In particular: `rustls` 0.23.46,
`rustls-webpki` 0.103.17, `webpki-roots` 1.0.12, `quinn-proto` 0.11.19,
`lru` 0.18.5, `negentropy` 0.5.3, `tokio` 1.54.1 and `anyhow` 1.0.104.

SDK API changes keep signing and NIP-17 encryption on the Guardian's existing
local keys. NIP-42 relay authentication remains enabled. Reads and writes retain
explicit relay targets; successful sends still require relay acknowledgements.
Notifications use the SDK stream API. The receiver is opened before subscribing
so immediate historical events are not lost. Persisted election state, message
payloads and blind-credential formats are unchanged.

RustSec verification uses `cargo-audit` 0.23.0 and advisory database commit
`af7b3ec33460b8e2de8d422e16d628518891a519` (1,490 advisories). The Guardian
lockfile passes `cargo audit --no-fetch --deny warnings`, including yanked-crate
checks, with no advisory ignores or platform filters. This checks known dependency
advisories, not application reachability or unknown vulnerabilities.

## TODO: coordinator/MLS dependencies — deliberately deferred

The user deferred MLS remediation. `auditable-voting-core/Cargo.toml` and its
lockfile are unchanged. Its scan still reports **10 vulnerability entries and
8 warning entries**. Do not describe the whole repository as audit-clean.

- [ ] Update the OpenMLS/provider chain without changing the experimental packet
  format or claiming Marmot compatibility. Resolve the following advisories:
  - `crossbeam-epoch`: RUSTSEC-2026-0204.
  - `crypto-bigint`: RUSTSEC-2026-0387; the patched 0.7 line is not a drop-in
    replacement for the provider's 0.5 dependency.
  - `libcrux-aesgcm`: RUSTSEC-2026-0211 and RUSTSEC-2026-0209; migrate through
    supported upstream providers to the renamed `libcrux-aes` crate.
  - `libcrux-chacha20poly1305`: RUSTSEC-2026-0124.
  - `libcrux-kem`: RUSTSEC-2026-0330 and RUSTSEC-2026-0331.
  - `libcrux-secrets`: RUSTSEC-2026-0212.
  - `libcrux-sha3`: RUSTSEC-2026-0208 and RUSTSEC-2026-0207.
- [ ] Resolve unsoundness warnings for `anyhow` and the three locked `rand`
  versions, and maintenance warnings for `instant`, `libcrux-aesgcm`, `pin-utils`
  and `proc-macro-error2`. Check enabled features and actual use; do not silently
  suppress warnings to obtain a clean report.
- [ ] Rebuild coordinator Wasm, run native MLS/adversarial tests and browser
  checks, obtain two independent reviews, and repeat the complete RustSec scan.

## Reproduce

Local verification after these updates:

- Production npm audit: zero vulnerabilities; Guardian RustSec scan: zero
  vulnerabilities or warnings, with `--deny warnings` and yanked checks enabled.
- Guardian release-mode tests: 110 passed, 3 existing throughput probes ignored.
  Added checks use only loopback relays and fictional keys.
- Web tests: 768 passed across 88 files. TypeScript, the production web build
  and the production-only Guardian compile check passed.
- Two independent read-only reviews reported no demonstrated defects.
- The existing worker formatting check is not clean. The task-start source
  already had 50 rustfmt diff locations; unrelated formatting was not rewritten.
  Existing vendor deprecation and production dead-code compiler warnings remain.

No live relay messages or email were sent. No commit, release, installed Guardian
update or deployment was performed.

Use the configured build adapters with `/mnt/fastbuild` mounted. From `web/`:

```bash
npm audit --omit=dev
npm ls source-map-js
npx vitest run --maxWorkers=2
npx tsc --noEmit
npm run build
```

From `worker/`:

```bash
cargo audit --deny warnings
cargo test --release --locked --jobs 2
```

Run audits separately for the shared blind-credential, legacy browser,
coordinator/MLS and vendor test lockfiles. A clean Guardian result does not cover
these separate dependency graphs.
