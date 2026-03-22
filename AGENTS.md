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
├── src/                         # Server + CLI TypeScript code
│   ├── cli.ts                   # CLI entry point
│   ├── voterServer.ts           # Mock coordinator server
│   ├── nostrClient.ts           # Nostr relay client
│   ├── merkle.ts                # Merkle tree for vote commitment roots
│   └── voterConfig.ts           # Configuration loader
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
│   ├── conftest.py              # Shared fixtures (VPS, browser, SSH)
│   ├── conftest_e2e.py          # E2E fixtures (mint quotes, blinded outputs)
│   ├── test_signer.py           # Signer unit tests (nostr-tools via tsx)
│   ├── test_election_keysets.py # Keyset rotation + election isolation
│   ├── test_integration_readiness.py  # API connectivity + build checks
│   ├── test_e2e_voting.py       # Full voter flow (VPS required)
│   ├── test_ui_dashboard.py     # Playwright dashboard tests
│   ├── test_ui_issuance.py      # Playwright issuance flow tests
│   └── test_ui_voting.py        # Playwright voting flow tests
├── ansible/                     # Ansible playbooks for VPS deployment
│   ├── playbook.yml             # Main deploy playbook
│   ├── inventory/               # VPS inventory
│   └── playbooks/               # Task-specific playbooks
└── docs/                        # Design docs and planning notes
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
    --ignore=tests/test_e2e_voting.py

# E2E only
.venv/bin/python -m pytest tests/ -v -m e2e

# UI/Playwright only
.venv/bin/python -m pytest tests/ -v -m ui

# Frontend unit tests (vitest)
cd web && npx vitest run
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
| 38000 | Ballot | Voter -> Relay -> Coordinator |
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
- Python in `tests/` with pytest conventions
- All test classes must have a pytest marker (`fast`, `integration`, `e2e`, or `ui`)
- React components in `web/src/`, one file per major component
- Nostr operations go through `nostrClient.ts` (backend) or `nostrIdentity.ts` / `signer.ts` (frontend)
- Mint operations go through `mintApi.ts` and `cashuBlind.ts`

## Deployment

```bash
ansible-playbook ansible/playbooks/deploy-and-prepare.yml
```

Deploys Traefik, coordinator, frontend, and publishes election with eligibility data to the VPS.
