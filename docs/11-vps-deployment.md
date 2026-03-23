# VPS Voting Playbook Design

> **Note:** The event kind specs in `../auditable-voting/docs/` are outdated. The canonical protocol definitions live in this repo: `docs/04-VOTING_EVENT_INTEROP_NOTES.md` and `docs/03-PROTOCOL_REFERENCE.md`.

Deploy 3 CDK Cashu mints on a VPS behind Traefik for the auditable voting demo.
Each mint is operated by a vote coordinator whose Nostr identity is deterministically derived from the mint's mnemonic.

## Architecture

- 3-mint 2-of-3 quorum model
- Each mint issues blind proofs to eligible voters during an issuance window
- Voters publish votes via Nostr (kind 38000), submit proofs privately to mints
- Coordinators build Merkle trees over accepted votes, publish results with inclusion proofs
- No blind auth — purely gRPC for management/approval workflow

## Coordinator Configuration

| Coordinator | Subdomain | Internal HTTP | gRPC |
|-------------|-----------|---------------|------|
| mint-a | `mint-a` | 8085 | 8086 |
| mint-b | `mint-b` | 8085 | 8087 |
| mint-c | `mint-c` | 8085 | 8088 |

All share internal container port 8085 (Traefik routes by Host header).
gRPC ports are unique per mint and exposed directly on the host.

## Key Derivation

- **Mint key**: CDK derives internally from `m/129372'/1967237907'/0'/...'` (SAT unit)
- **Coordinator Nostr key**: BIP32 master private key from same mnemonic/seed (no passphrase)
- Both deterministic from the same seed, different keys
- The coordinator nsec/npub is derived after mint deployment and persisted in `vote-coordinators.md`

### Derivation Chain

```
Mnemonic (BIP39, 12 words)
    |
    | to_seed_normalized("")  -- NO passphrase
    v
64-byte seed
    |
    | HMAC-SHA512(key="Bitcoin seed", data=seed)
    v
BIP32 master private key  -->  Coordinator Nostr key (nsec/npub)
    |
    | derive_priv m/129372'/{unit_hash}'/{keyset_index}'/{amount_index}'
    v
CDK per-amount signing keys  -->  Mint Cashu proofs
```

## Mint URLs (test mode, tls_enabled: false)

```
http://mint-a.mints.23.182.128.64.sslip.io
http://mint-b.mints.23.182.128.64.sslip.io
http://mint-c.mints.23.182.128.64.sslip.io
```

gRPC endpoints:
```
23.182.128.64:8086
23.182.128.64:8087
23.182.128.64:8088
```

## Files to Create

### 1. `scripts/derive-coordinator-keys.py`

Minimal Python script, runs on VPS.

**Input**: mnemonic (arg)

**Logic**:
1. `mnemonic` lib → seed (no passphrase)
2. `hmac`+`hashlib` (stdlib) → BIP32 master key (HMAC-SHA512, key="Bitcoin seed")
3. `coincurve` → master private key → x-only public key (Nostr-compatible)
4. `bech32` lib → encode as `nsec1...` / `npub1...`

**Output**: JSON `{"nsec": "...", "npub": "...", "pubkey_hex": "..."}`

**Dependencies**: `mnemonic`, `bech32`, `coincurve` (installed via pip on VPS)

### 2. `roles/mint_voting/tasks/main.yml`

Single coordinator mint deployment:

1. Create data dir (`/opt/tollgate/mints-voting/{{ name }}`)
2. Check if mnemonic exists, generate if not, persist to `mnemonic.txt`
3. Template docker-compose
4. Start container (`docker compose up`)
5. Wait for HTTP health (via Traefik Host header)
6. Run `derive-coordinator-keys.py` with the mnemonic
7. Register result (nsec, npub, mint URL, gRPC endpoint) in Ansible fact

### 3. `roles/mint_voting/templates/docker-compose.yml.j2`

Hybrid template — Traefik HTTP + direct gRPC + custom CDK image.

**Image**: `cdk-mint:manual-approval`

**Traefik labels**: `Host({{ fqdn }})` → container HTTP port 8085

**Ports**: `{{ grpc_port }}:{{ grpc_port }}` (direct gRPC exposure)

**Environment variables**:
- `CDK_MINTD_LN_BACKEND: "fakewallet"`
- `CDK_MINTD_DATABASE: "sqlite"`
- `CDK_MINTD_LISTEN_HOST: "0.0.0.0"`
- `CDK_MINTD_LISTEN_PORT: "8085"` (internal container port)
- `CDK_MINTD_URL: "{{ mint_scheme }}://{{ fqdn }}"` (public URL via Traefik)
- `CDK_MINTD_MNEMONIC: "{{ mint_mnemonic }}"`
- `CDK_MINTD_FAKE_WALLET_MANUAL_APPROVAL_INCOMING: "true"`
- `CDK_MINTD_FAKE_WALLET_MANUAL_APPROVAL_OUTGOING: "true"`
- `CDK_MINTD_FAKE_WALLET_ACCEPT_ARBITRARY_MELT: "true"`
- `CDK_MINTD_FAKE_WALLET_ARBITRARY_MELT_FEE: "0"`
- `CDK_MINTD_MINT_MANAGEMENT_ENABLED: "true"`
- `CDK_MINTD_MANAGEMENT_ADDRESS: "0.0.0.0"`
- `CDK_MINTD_MANAGEMENT_PORT: "{{ grpc_port }}"`

**Network**: `tollgate-net` (external, shared with Traefik)

**Volumes**: `{{ mint_data_dir }}:/root/.cdk-mintd`

### 4. `playbooks/voting-on-vps-playbook.yml` (rewrite)

```
pre_tasks:
  - Set effective domain (sslip.io / production)
  - Print config

roles (tag: setup):
  - base
  - traefik

tasks (tag: mint):
  - Install Python deps: mnemonic, bech32, coincurve
  - Build/load custom CDK image (cdk_image_source: "local_load" from host_vars)
  - Open gRPC firewall ports (8086, 8087, 8088)
  - Upload derive-coordinator-keys.py to VPS
  - Loop over 3 coordinators:
      include_role: mint_voting
      vars: { name, subdomain, http_port, grpc_port, ... }
      register: coordinator results

post_tasks:
  - Verify HTTP health on all 3 (via Traefik Host header)
  - Verify gRPC ports listening (ss -tlnp)
  - Build vote-coordinators.md content from registered facts
  - Write vote-coordinators.md to localhost (delegate_to, become: false)
  - Print summary
```

### 5. `vote-coordinators.md` (written to control machine)

```markdown
# Vote Coordinators

## mint-a
- Mint URL: http://mint-a.mints.23.182.128.64.sslip.io
- gRPC: 23.182.128.64:8086
- Nostr identity (nsec): nsec1...
- Nostr pubkey (npub): npub1...

## mint-b
- Mint URL: http://mint-b.mints.23.182.128.64.sslip.io
- gRPC: 23.182.128.64:8087
- Nostr identity (nsec): nsec1...
- Nostr pubkey (npub): npub1...

## mint-c
- Mint URL: http://mint-c.mints.23.182.128.64.sslip.io
- gRPC: 23.182.128.64:8088
- Nostr identity (nsec): nsec1...
- Nostr pubkey (npub): npub1...
```

## Files to Modify

- `inventory/host_vars/tollgate-vps.yml` — add `voting_data_dir` and `voting_mint_image` vars

## No Changes To

- Existing roles (`mint`, `mint_local`, `base`, `traefik`, `auth`)
- Existing playbooks (`playbook.yml`, `playbooks/local-mints.yml`)
- `group_vars/all.yml`

## Execution

```bash
# Setup (first time, or when infra changes)
ansible-playbook playbooks/voting-on-vps-playbook.yml \
  -i inventory/hosts.yml -e vps_ip=23.182.128.64 --tags setup

# Deploy/update mints
ansible-playbook playbooks/voting-on-vps-playbook.yml \
  -i inventory/hosts.yml -e vps_ip=23.182.128.64 --tags mint
```
