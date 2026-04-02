# Concerns

## Monolith Risk
- `coordinator/voting-coordinator-client.py` is doing a lot: CLI parsing, event storage, Merkle logic, relay recovery, HTTP routing, election join logic, and live processing.
- That concentration makes regressions likely when changing one part of issuance or tally behavior.

## Multi-Coordinator Gap
- The docs and frontend already describe multi-coordinator flow, but the implementation is still incomplete in places.
- The issuance loop, confirmation publishing, and dashboard audit views are still areas where behavior may lag the design.

## Environment Coupling
- The repo depends on specific VPS IPs, hostnames, relay URLs, mint URLs, and SSH access in tests and deployment.
- Several tests and fixtures assume live infrastructure is available and mutable.

## Privacy And Trust
- Vote privacy depends on relays, NIP-04 DMs, ephemeral vote keys, and correct confirmation-window timing.
- The frontend stores wallet state locally, so browser persistence and signer mode need careful handling.
- Public relay publication can leak operational metadata even when ballot content is protected.

## Config Drift
- There are multiple config sources: `.env`, Ansible inventory, README examples, test constants, and live deployment values.
- If these drift, the code can appear healthy locally while breaking in the deployed environment.

## Testing Fragility
- VPS and UI tests are stateful, slow, and sensitive to timing.
- Live relay queries and polling introduce nondeterminism that can hide intermittent failures.

