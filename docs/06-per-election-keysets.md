# Per-Election Mint Keysets

## Overview

Each election uses a unique mint mnemonic derived from the coordinator's nsec
and the election ID. This provides **cryptographic isolation** between elections:
old proofs become mathematically invalid after a keyset rotation because the
signing keys simply don't exist in the new mint database.

## Mnemonic Derivation

```
mnemonic = BIP-12(seed=SHA256(coordinator_nsec + ":" + election_id)[:16])
```

- Deterministic: same nsec + election_id always produces the same mnemonic
- Unique: different election_ids produce different mnemonics (SHA-256 collision resistance)
- Per-coordinator: different nsecs produce different mnemonics for the same election_id
- 12-word BIP-39 English mnemonic, compatible with CDK mint's `CDK_MINTD_MNEMONIC`

## Flow

```
New election
  1. Generate election_id
  2. Derive mnemonic from (coordinator_nsec, election_id)
  3. Backup current mint SQLite → backups/<old_election_id>/
  4. Stop mint, update CDK_MINTD_MNEMONIC, start mint
  5. Fetch new keyset_id from GET /v1/keysets
  6. Publish kind 38008 with election_id + keyset_id
  7. Publish kind 38009 with eligible voters
  8. Restart coordinator with --election-id <id>

Resume old election
  1. Recompute old mnemonic (deterministic)
  2. Restore old SQLite from backups/<old_election_id>/
  3. Update CDK_MINTD_MNEMONIC, restart mint
  4. Restart coordinator with --election-id <old_id>
```

## Coordinator Changes

- `derive_election_mnemonic(nsec, election_id)` — new function
- `--election-id` CLI argument — locks coordinator to a specific election
- Event filtering in `handle()` — skips events from other elections when `--election-id` is set
- State recovery filtering in `recover_state_from_relay()` — only loads events for the active election

## Keyset Version Compatibility

**Critical**: The CDK mint must use version 0 keysets (ID prefix `"00"`). The Cashu JS library v2.5+ silently ignores version 1 keysets (prefix `"01"`).

Set `CDK_MINTD_USE_KEYSET_V2: "false"` in the mint's docker-compose environment. This is enforced by:

1. All mint docker-compose templates in `tg-mint-orchestrator/roles/*/templates/`
2. `deploy-and-prepare.yml` during keyset rotation (adds the env var if missing)
3. Keyset ID assertion: `mint_keyset_id | regex_search('^00')`

Without this, the browser throws `Error: No active keyset found` when trying to mint proofs.

## Playbook Changes

- `deploy-and-prepare.yml` — new "Rotate Mint Keyset" play between client deploy and election publication
- `update-coordinator-keep-existing-election.yml` — systemd service template supports `--election-id`

## Testing

See `tests/test_election_keysets.py` for unit and integration tests.

### Unit tests (no VPS)
- `test_derive_mnemonic_deterministic` — same inputs → same output
- `test_derive_mnemonic_unique_per_election` — different elections → different outputs
- `test_derive_mnemonic_valid_bip39` — output is valid 12-word BIP-39
- `test_derive_mnemonic_different_coordinators` — different nsecs → different outputs

### Integration tests (VPS)
- `test_mint_rotation_produces_new_keyset` — rotate → new keyset_id
- `test_old_proof_invalid_after_rotation` — proof from old keyset rejected by swap
- `test_new_election_flow_with_rotated_keyset` — full voter flow after rotation
- `test_coordinator_election_id_filtering` — --election-id suppresses other elections
- `test_resume_old_election_from_backup` — restore backup → old tally preserved
- `test_reissuance_after_election_switch` — voter can participate in sequential elections
