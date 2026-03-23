# AGENTS.md

Instructions for LLM coding sessions working in this repository.

## Project Overview

**auditable-voting** is a Nostr + Cashu voting system with coordinator-mediated blind token issuance, eligibility checks, and private ballot submission. Voters receive blinded Cashu tokens as proof of eligibility, fill out a ballot, and submit proofs to a coordinator via NIP-04 encrypted DMs. The coordinator tallies votes and publishes a verifiable commitment root.

**Live deployment:** http://vote.mints.23.182.128.64.sslip.io/

## Repository Layout

```text
auditable-voting/
├── AGENTS.md                    # THIS FILE - LLM session instructions
├── README.md                    # User-facing documentation
├── pyproject.toml               # Project metadata + pytest config + markers
├── package.json                 # Root Node.js deps (nostr-tools, typescript)
├── .env                         # Environment variables (VITE_USE_MOCK, URLs)
├── .env.example                 # Template for .env
├── .venv/                       # Python virtual environment (DO NOT delete)
├── eligible-voters.json         # List of eligible voter npubs
├── src/                         # Server + CLI TypeScript code
│   ├── cli.ts                   # CLI entry point
│   ├── voterServer.ts           # Mock coordinator server
│   ├── nostrClient.ts           # Nostr relay client
│   ├── merkle.ts                # Merkle tree for vote commitment roots
│   └── voterConfig.ts           # Configuration loader
├── coordinator/                 # Voting coordinator daemon (Python)
│   ├── voting-coordinator-client.py  # Coordinator Nostr client + HTTP API
│   ├── derive-coordinator-keys.py    # BIP32 mnemonic -> nsec/npub derivation
│   ├── voting-request-proof.py       # Voter CLI: quote + blinded output + mint
│   ├── requirements.txt               # Coordinator runtime deps
│   ├── voter-requirements.txt         # Voter CLI deps
│   └── proto/                         # CDK gRPC proto + generated stubs
│       ├── cdk-mint-rpc.proto
│       └── _gen/
├── web/                         # React + Vite voter frontend
│   ├── package.json             # Frontend deps (react, vite, cashu-ts, nostr-tools)
│   ├── tsconfig.json            # TypeScript config
│   ├── vite.config.ts           # Vite build config
│   ├── index.html               # Issuance page (voter portal)
│   ├── vote.html                # Voting page (ballot submission)
│   ├── dashboard.html           # Operator dashboard (eligibility + tally)
│   └── src/
│       ├── App.tsx              # Voter portal (discovery + issuance)
│       ├── VotingApp.tsx        # Voting page (ballot + proof DM + tally)
│       ├── DashboardApp.tsx     # Operator dashboard
│       ├── coordinatorApi.ts    # Coordinator HTTP API client
│       ├── mintApi.ts           # CDK Cashu mint API client
│       ├── cashuBlind.ts        # Blinded token operations
│       ├── cashuWallet.ts       # Local wallet storage (localStorage)
│       ├── proofSubmission.ts   # NIP-04 encrypted DM sender
│       ├── ballot.ts            # Ballot event publishing (kind 38000)
│       ├── nostrIdentity.ts     # Nostr key helpers, claim signing
│       ├── signer.ts            # NostrSigner abstraction (raw / NIP-07)
│       └── cashu.d.ts           # Type declarations for @cashu/cashu-ts
├── tests/                       # Python pytest test suite
│   ├── requirements.txt         # Python test dependencies
│   ├── conftest.py              # Shared fixtures (VPS, browser, SSH, coordinator module)
│   ├── conftest_e2e.py          # E2E fixtures (mint quotes, blinded outputs)
│   ├── conftest_vps.py          # VPS constants (IP, ports, paths)
│   ├── conftest_voter.py        # Voter constants (mint URL)
│   ├── test_signer.py           # Signer unit tests (nostr-tools via tsx)
│   ├── test_election_keysets.py # Keyset rotation + election isolation
│   ├── test_integration_readiness.py  # API connectivity + build checks
│   ├── test_e2e_voting.py       # Full voter flow (VPS required)
│   ├── test_coordinator_deploy.py      # VPS: systemd, venv, nak relay
│   ├── test_coordinator_e2e.py         # VPS E2E: HTTP API, issuance, proof burn
│   ├── test_coordinator_eligibility.py # Unit: eligibility checks
│   ├── test_coordinator_info.py        # Unit: /info endpoint
│   ├── test_coordinator_integration.py # Unit: full flow with mocked HTTP
│   ├── test_coordinator_integration_vps.py # VPS: real gRPC via SSH tunnel
│   ├── test_coordinator_issuance.py    # Unit: quote states, gRPC errors
│   ├── test_coordinator_persistence.py # Unit: EventStore, load_json_set
│   ├── test_merkle_trees.py            # Unit: MerkleTree variants
│   ├── test_publish_tally_events.py    # Unit: tally event publishing
│   ├── test_voter_flow.py              # Voter: blinded output, quote polling
│   ├── test_domain_deploy.py           # HTTPS/TLS/domain verification (after deploy-domain)
│   ├── test_ui_dashboard.py     # Playwright dashboard tests
│   ├── test_ui_issuance.py      # Playwright issuance flow tests
│   └── test_ui_voting.py        # Playwright voting flow tests
├── scripts/                     # Shell wrappers and utilities
│   ├── setup-vps.sh             # VPS provisioning via ansible
│   ├── deploy-mint.sh           # Per-operator mint deployment
│   ├── teardown.sh              # Remove all TollGate infra from VPS
│   ├── list-mints.sh            # List deployed mints
│   ├── remove-mint.sh           # Remove a specific mint
│   ├── install-nutshell.sh      # Install Cashu CLI wallet
│   ├── run-tests.py             # Test runner with JSON result persistence
│   └── watch-tests.sh           # Watch mode for running tests
├── ansible/                     # Ansible playbooks for VPS deployment
│   ├── playbook.yml             # Main entry point (all tags)
│   ├── inventory/               # VPS inventory + group/host vars
│   │   ├── hosts.yml            # Production VPS inventory
│   │   ├── hosts.local.yml      # Localhost inventory
│   │   ├── group_vars/all.yml   # Global variables (VPS, Traefik, CDK, auth)
│   │   ├── group_vars/mint_hosts.yml  # Multi-mint config
│   │   └── host_vars/           # Per-host overrides
│   ├── playbooks/               # Task-specific playbooks
│   │   ├── deploy-and-prepare.yml     # Full stack + election publication
│   │   ├── deploy-coordinator.yml      # Coordinator initial deploy
│   │   ├── deploy-voting-client.yml    # Frontend build + nginx container
│   │   ├── verify.yml                 # Post-deploy health checks
│   │   ├── local-mints.yml            # Local 3-mint development setup
│   │   ├── voting-on-vps-playbook.yml # 3-mint quorum behind Traefik
│   │   ├── run-integration-tests.yml  # Prepare VPS for integration tests
│   │   ├── setup-pytest.yml           # Create venv, install deps, run tests
│   │   ├── nutshell-wallet.yml        # Install Cashu CLI wallet
│   │   └── templates/                 # Jinja2 templates (nginx, docker-compose)
│   └── roles/                     # Ansible roles
│       ├── base/                 # Docker, network, firewall
│       ├── traefik/              # Reverse proxy with TLS
│       ├── auth/                 # Keycloak + PostgreSQL (blind auth)
│       ├── mint/                 # Per-operator mint (Traefik-routed)
│       ├── mint_local/           # Local multi-mint (Docker, gRPC)
│       └── mint_voting/          # Voting mint (Traefik + coordinator keys)
├── docs/                        # Design docs and planning notes
│   ├── 01-system-design.md            # Voting system design (canonical)
│   ├── 02-protocol-reference.md       # All Nostr event kinds (38000-38011)
│   ├── 03-quorum-model.md             # 3-mint 2-of-3 quorum model
│   ├── 04-event-interop.md            # Client-facing event shapes
│   ├── 05-voter-integration-guide.md   # Voter client integration steps
│   ├── 06-per-election-keysets.md      # Per-election keyset rotation
│   ├── 07-coordinator-http-api.md     # HTTP endpoints + stateless architecture
│   ├── 08-tally-implementation.md     # Merkle trees, close election
│   ├── 09-issuance-client-design.md   # Coordinator daemon + voter CLI design
│   ├── 10-demo-implementation.md      # Demo roadmap + status
│   ├── 11-vps-deployment.md           # 3 CDK mints behind Traefik
│   ├── 12-local-mint-deployment.md    # Local Docker multi-mint + gRPC CLI
│   ├── 13-deploy-and-prepare.md       # Single-command full stack deploy
│   ├── 14-voting-client-deployment.md # Nginx container + Traefik
│   ├── 15-coordinator-deployment.md   # Coordinator systemd, 9 phases
│   ├── 16-coordinator-test-plan.md    # 49 coordinator unit tests
│   ├── 17-integration-test-plan.md    # 3-layer test architecture
│   ├── 18-frontend-test-plan.md       # Readiness tests + E2E voter flow
│   ├── 19-playwright-test-plan.md     # 8 Playwright browser tests
│   ├── 20-integration-log.md          # 6-phase frontend integration (all DONE)
│   ├── 21-proof-flow-fixes.md         # 11 bugs (A-K) with root causes
│   ├── 22-branding-and-signer.md      # NIP-07 signer + branding
│   ├── 23-transplant-log.md           # Branch merge surgery
│   └── 24-friday-demo-bug.md          # Quote approval debug report
└── presentation/                # Demo slides
    └── slides.html
```

## Environment Setup

### Python Virtual Environment

A Python virtual environment lives at `.venv/` in the project root. It **persists on disk** across terminal sessions and restarts. You do NOT need to reinstall dependencies each time.

**Activate it** at the start of each new terminal session:

```bash
source .venv/bin/activate
```

After activation, `python` and `pip` resolve to the venv. All test dependencies (pytest, playwright, nostr-sdk, cashu) are already installed.

**If the venv is missing**, recreate it:

```bash
python3 -m venv .venv
.venv/bin/pip install -r tests/requirements.txt
.venv/bin/pip install -r coordinator/requirements.txt
.venv/bin/python -m playwright install chromium
```

### Node.js Dependencies

Node modules are in `node_modules/` (root) and `web/node_modules/` (frontend). Install once:

```bash
npm install
cd web && npm install
```

### Environment Variables

`.env` contains runtime configuration. Key variables:

| Variable | Purpose |
|----------|---------|
| `VITE_USE_MOCK` | Set to `false` for production, `true` for local mock mode |
| `VITE_COORDINATOR_URL` | Coordinator HTTP URL |
| `VITE_MINT_URL` | CDK Cashu mint URL |

`.env.example` is the committed template. The keys in `.env` and `.env.example` must match exactly.

### Deployment Secrets (deploy.env)

`deploy.env` (gitignored) holds all operator-specific secrets. Copy from the template:

```bash
cp deploy.env.example deploy.env
```

Two sections separated by purpose:

| Section | Variables | Used by |
|---------|-----------|---------|
| `make deploy` (HTTP/sslip.io) | `VPS_IP`, `SSH_KEY_PATH`, `ANSIBLE_USER` | `make deploy` |
| `make deploy-domain` (HTTPS/custom domain) | `VOTING_DOMAIN`, `CF_API_EMAIL`, `CF_DNS_API_TOKEN`, `ACME_EMAIL` | `make deploy-domain` |

The Makefile reads `deploy.env` via `-include deploy.env` and passes values as Ansible extra-vars. Swap this file when changing operators or deploying to a different VPS.

## Key Dependencies

### Python (in `.venv/`)

| Package | Purpose |
|---------|---------|
| `pytest` | Test runner |
| `pytest-playwright` | Browser automation for UI tests |
| `nostr-sdk` | Nostr relay client for E2E tests |
| `cashu` | Cashu blinded token operations for E2E tests |
| `requests` | HTTP client for integration tests |
| `pytest-timeout` | Per-test timeout enforcement |
| `pytest-order` | Test execution ordering |

### Node.js

| Package | Location | Purpose |
|---------|----------|---------|
| `nostr-tools` | root + web | Nostr protocol (events, signing, NIP-04) |
| `@cashu/cashu-ts` | web | Cashu wallet, blinded tokens, mint API |
| `react` / `react-dom` | web | UI framework |
| `vite` | web | Build tool + dev server |
| `vitest` | web | Frontend unit tests |
| `typescript` | root + web | Type checking |

## Pre-commit Hooks

A pre-commit hook at `.git/hooks/pre-commit` runs tests before every commit. **Commits are blocked if tests fail.**

### How It Works

The hook always uses `.venv/bin/python3 -m pytest` regardless of whether the venv is activated in the shell. This ensures consistent behavior.

### Test Tiers

Tests are categorized by pytest markers defined in `pyproject.toml`:

| Tier | Marker | Tests | Runtime | Dependencies |
|------|--------|-------|---------|-------------|
| **fast** | `@pytest.mark.fast` | `test_signer`, `TestDeriveElectionMnemonic`, `TestFrontendBuild`, `TestCashuTsExports`, `TestNostrToolsNip04`, `TestEnvConfig`, `TestCashuTypeDeclarations` | ~20s | Local only (node, tsc, vite) |
| **integration** | `@pytest.mark.integration` | `TestCoordinatorConnectivity`, `TestMintConnectivity`, `TestElectionState`, `TestEligibilityState`, `TestMintApiShape` | ~5s | VPS network (read-only) |
| **e2e** | `@pytest.mark.e2e` | `test_full_voter_flow`, `TestMintKeysetRotation`, `TestElectionIsolation` | 2-5 min | VPS SSH, mint, coordinator |
| **ui** | `@pytest.mark.ui` | `TestUIDashboard`, `TestUIIssuance`, `TestUIVotingStatic`, `TestUIVotingWithProof` | 3-5 min | VPS + Playwright browser |
| **vps** | `@pytest.mark.vps` | `test_coordinator_deploy`, `test_coordinator_integration_vps`, `test_coordinator_e2e` | 3-5 min | VPS SSH, mint, coordinator |
| **voter** | `@pytest.mark.voter` | `test_voter_flow` | ~30s | VPS mint reachable over public internet |

### Environment Variable Overrides

| Variable | Effect |
|----------|--------|
| *(default)* | Runs **fast + integration** (no e2e, no UI) |
| `RUN_ALL_TESTS=1` | Runs **all** tests including e2e and UI (requires VPS) |
| `RUN_FAST_ONLY=1` | Runs **fast** unit tests only |
| `SKIP_TESTS=1` | Bypasses tests entirely (for emergency commits) |

### Usage Examples

```bash
# Default: fast + integration
git commit -m "feat: something"

# All tests including e2e and UI (requires VPS)
RUN_ALL_TESTS=1 git commit -m "feat: something"

# Fast unit tests only
RUN_FAST_ONLY=1 git commit -m "fix: typo"

# Emergency bypass (not recommended)
SKIP_TESTS=1 git commit -m "hotfix"
```

## Running Tests Manually

Always use the venv Python:

```bash
# All tests
.venv/bin/python -m pytest tests/ -v

# Fast tier only
.venv/bin/python -m pytest tests/ -v -m fast

# Fast + integration (no e2e, no UI)
.venv/bin/python -m pytest tests/ -v -m "fast or integration" \
    --ignore=tests/test_ui_dashboard.py \
    --ignore=tests/test_ui_issuance.py \
    --ignore=tests/test_ui_voting.py \
    --ignore=tests/test_e2e_voting.py \
    --ignore=tests/test_coordinator_deploy.py \
    --ignore=tests/test_coordinator_e2e.py \
    --ignore=tests/test_coordinator_integration_vps.py

# E2E only
.venv/bin/python -m pytest tests/ -v -m e2e

# UI/Playwright only
.venv/bin/python -m pytest tests/ -v -m ui

# VPS coordinator tests
.venv/bin/python -m pytest tests/ -v -m vps

# Frontend unit tests (vitest)
cd web && npx vitest run

# Domain/TLS tests (after make deploy-domain)
BASE_URL=https://vote.orangesync.tech .venv/bin/python -m pytest tests/test_domain_deploy.py -v
```

## Architecture

```
Browser --> Traefik (:80)
              |-- Host(vote.mints.23.182.128.64.sslip.io)
                  --> voting-client container (nginx:alpine)
                       |-- /        --> static HTML/JS
                       |-- /api/    --> coordinator:8081
                       |-- /mint/   --> mint:3338
```

### Nostr Event Kinds

| Kind | Purpose | Direction |
|------|---------|-----------|
| 38008 | Election announcement | Coordinator -> Relay |
| 38009 | Eligibility list | Coordinator -> Relay |
| 38010 | Token issuance claim | Voter -> Relay -> Coordinator |
| 38011 | Issuance approval receipt | Coordinator -> Relay |
| 38000 | Ballot | Voter -> Relay -> Coordinator |
| 38002 | Vote acceptance | Coordinator -> Relay |
| 38003 | Final result | Coordinator -> Relay |
| 38005 | Issuance commitment root | Coordinator -> Relay |
| 38006 | Spent commitment root | Coordinator -> Relay |
| 4 | Encrypted DM (proof) | Voter -> Coordinator (NIP-04) |

### Voter Flow

1. Discover coordinator via `/info` endpoint
2. Check eligibility against coordinator's eligible npub list
3. Request mint quote, publish claim event (kind 38010), wait for approval
4. Mint blinded tokens from CDK Cashu mint
5. Fill out ballot, publish vote event (kind 38000)
6. Submit proof via NIP-04 encrypted DM to coordinator
7. Verify vote acceptance via `/tally` endpoint

## Code Style

- Do not add comments unless explicitly asked
- TypeScript in `web/src/` with strict mode
- Python in `tests/` and `coordinator/` with pytest conventions
- All test classes must have a pytest marker (`fast`, `integration`, `e2e`, `ui`, `vps`, or `voter`)
- React components in `web/src/`, one file per major component
- Nostr operations go through `nostrClient.ts` (backend) or `nostrIdentity.ts` / `signer.ts` (frontend)
- Mint operations go through `mintApi.ts` and `cashuBlind.ts`
- Coordinator source lives in `coordinator/` and is imported as a Python module for testing

## Deployment

### Make targets

```bash
# HTTP only (sslip.io, no domain needed)
make deploy

# HTTPS with custom domain + Cloudflare TLS
make deploy-domain

# Frontend only
make deploy-client

# Coordinator only
make deploy-coordinator
```

### How it works

- `make deploy` — Deploys the full stack (Traefik, coordinator, frontend) over HTTP using sslip.io for free wildcard DNS. Reads `VPS_IP`, `SSH_KEY_PATH`, `ANSIBLE_USER` from `deploy.env`.
- `make deploy-domain` — Same as `make deploy` but enables TLS via Let's Encrypt DNS-01 challenge (Cloudflare). Passes `tls_enabled=true`, `voting_domain`, `acme_email`, and Cloudflare API credentials as extra-vars. Requires: (1) a wildcard DNS A record `*.orangesync.tech` pointing at the VPS, (2) a Cloudflare DNS API token with zone-level permissions.

### Prerequisites for make deploy-domain

1. **DNS**: Create an A record at Cloudflare: `vote.orangesync.tech -> <VPS_IP>` (or a wildcard `*.orangesync.tech -> <VPS_IP>`)
2. **CF API token**: Create a DNS-only API token at Cloudflare, add `CF_API_EMAIL` and `CF_DNS_API_TOKEN` to `deploy.env`

### Known Issues

- **Mint keyset rotation timeout**: Both `make deploy` and `make deploy-domain` may time out during the "Rotate Mint Keyset" phase (mint regeneration can exceed 10 minutes). The core deploy (Traefik, coordinator, voting-client) completes successfully before the timeout. The mint will finish starting on its own — check with `ssh root@<VPS_IP> "docker ps | grep mint-mint1"`.

1. **DNS**: Create an A record at Cloudflare: `vote.orangesync.tech -> <VPS_IP>` (or a wildcard `*.orangesync.tech -> <VPS_IP>`)
2. **CF API token**: Create a DNS-only API token at Cloudflare, add `CF_API_EMAIL` and `CF_DNS_API_TOKEN` to `deploy.env`

### Other deployment commands

```bash
# Full initial coordinator deploy (from coordinator/ source)
ansible-playbook ansible/playbook.yml --tags coordinator

# Update voting client only
ansible-playbook ansible/playbook.yml --tags client

# Verify all services
ansible-playbook ansible/playbook.yml --tags verify

# Local multi-mint development
ansible-playbook ansible/playbook.yml --tags local-mints

# 3-mint quorum behind Traefik on VPS
ansible-playbook ansible/playbook.yml --tags voting-on-vps

# Local dev build only (no VPS)
ansible-playbook ansible/playbook.yml --tags local-dev
```

## Git Worktrees (Parallel Branch Development)

Git worktrees allow multiple branches to be checked out simultaneously in separate directories, all sharing the same `.git` database. This is essential for running multiple opencode sessions on different branches without them interfering with each other.

### Active Worktrees

| Path | Branch | Purpose |
|------|--------|---------|
| `/home/c03rad0r/auditable-voting` | `feat/eligibility-move-and-merkle-tree-viz` | Primary worktree (main repo folder) |
| `/home/c03rad0r/auditable-voting-cf` | `feature/cloudflare-integration-for-voter-portal` | Cloudflare integration for voter portal |
| `/home/c03rad0r/auditable-voting-mc` | `feature/multi-coordinator-voting-deployment` | Multi-coordinator voting deployment |

List all worktrees at any time:

```bash
git worktree list
```

### Resuming a Worktree

Each worktree has its own `.venv/` and `node_modules/`. To resume work in a worktree:

```bash
cd /home/c03rad0r/auditable-voting-cf
source .venv/bin/activate
```

Then launch opencode from that directory.

### Creating a New Worktree

```bash
git worktree add -b <new-branch-name> ../<folder-name> main
cd ../<folder-name>
npm install && cd web && npm install && cd ..
python3 -m venv .venv
.venv/bin/pip install -r tests/requirements.txt -r coordinator/requirements.txt
.venv/bin/python -m playwright install chromium
```

### Removing a Worktree

After merging or finishing work:

```bash
git worktree remove ../<folder-name>
git worktree prune
git branch -d <branch-name>
```

### Important Notes

- Git prevents the same branch from being checked out in two worktrees simultaneously.
- `git fetch` in any worktree updates history for all worktrees.
- The pre-commit hook at `.git/hooks/pre-commit` is shared across all worktrees.
- Each worktree needs its own `.venv/` and `node_modules/` — they are not shared.
- Worktree creation does not affect other worktrees (no branch switching, no disturbance of uncommitted changes).

## Kanban Boards (kanbanstr — NIP-100)

Project tracking is done via [kanbanstr](https://www.kanbanstr.com/), a Nostr-native kanban board (NIP-100).

**Boards must be maintained on every commit.** After completing any work, update the relevant boards to reflect current status.

### Board structure

| Board | URL | Purpose |
|-------|-----|---------|
| **auditable-voting** (repo-level) | [link](https://www.kanbanstr.com/#/board/2c8db3b4bf7075f9f24db49d6443e144c780206c2b15671d0ddaebc1091108f9/auditable-voting) | Cross-branch roadmap, backlog, and long-lived items |
| **fix/ui-issues** (branch-level) | [link](https://www.kanbanstr.com/#/board/2c8db3b4bf7075f9f24db49d6443e144c780206c2b15671d0ddaebc1091108f9/fix-ui-issues) | Tasks specific to the fix/ui-issues branch |

### Rules

1. **One board per branch** — create a new kanbanstr board when branching, archive when merging.
2. **One board per repo** — the repo-level board tracks cross-cutting concerns and the master backlog.
3. **Update on every commit** — after committing, move completed items to "Done" and add any new items discovered during the session.
4. **Board IDs follow the pattern** — the board slug matches the branch name or `auditable-voting` for the repo-level board.
5. Managed via [kanbanstr-cli](https://gitworkshop.dev/npub19jxm8d9lwp6lnujdkjwkgslpgnrcqgrv9v2kw8gdmt4uzzg3pruse3s0f3/relay.ngit.dev/kanbanstr-cli) if automated updates are needed.
