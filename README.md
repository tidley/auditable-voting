# Auditable Voting

Nostr + Cashu voting with coordinator-mediated blind token issuance, eligibility checks, and private ballot submission.

## Live Deployment

**Voter Portal:** http://vote.mints.23.182.128.64.sslip.io/

**Operator Dashboard:** http://vote.mints.23.182.128.64.sslip.io/dashboard.html

**Voting Page:** http://vote.mints.23.182.128.64.sslip.io/vote.html

## Project Board

| Board | URL |
|-------|-----|
| **auditable-voting** (repo) | [link](https://www.kanbanstr.com/#/board/2c8db3b4bf7075f9f24db49d6443e144c780206c2b15671d0ddaebc1091108f9/auditable-voting) |
| **fix/ui-issues** (branch) | [link](https://www.kanbanstr.com/#/board/2c8db3b4bf7075f9f24db49d6443e144c780206c2b15671d0ddaebc1091108f9/fix-ui-issues) |

Managed via [kanbanstr-cli](https://gitworkshop.dev/npub19jxm8d9lwp6lnujdkjwkgslpgnrcqgrv9v2kw8gdmt4uzzg3pruse3s0f3/relay.ngit.dev/kanbanstr-cli) (NIP-100)

## Prerequisites

One-time local setup:

```bash
python3 -m venv .venv && .venv/bin/pip install -r tests/requirements.txt -r coordinator/requirements.txt
npm install && npm --prefix web install
```

## Deploy

### Configure VPS access

1. Set the VPS IP in `ansible/inventory/group_vars/all.yml`:

   ```yaml
   vps_ip: "1.2.3.4"
   ```

2. Ensure SSH key access as root to the VPS. Ansible uses `host_key_checking = False` in `ansible.cfg` and `ansible_user: root` in `ansible/inventory/hosts.yml`.

3. Override the IP at runtime if needed:

   ```bash
   ansible-playbook ansible/playbooks/deploy-and-prepare.yml -e vps_ip=1.2.3.4
   ```

### Deploy everything

```bash
ansible-playbook ansible/playbooks/deploy-and-prepare.yml
```

This single command deploys Traefik, the voting coordinator (Cashu mint + Nostr client), the frontend dashboard, and publishes the election with eligibility data.

## Testing

```bash
.venv/bin/python -m pytest tests/ -v
```

By default this runs fast unit tests and integration checks (no E2E, no UI).

| Variable | Effect |
|----------|--------|
| *(default)* | Fast + integration only |
| `RUN_ALL_TESTS=1` | All tests including E2E and UI (requires VPS) |
| `RUN_FAST_ONLY=1` | Fast unit tests only |
| `SKIP_TESTS=1` | Bypass tests entirely |

The pre-commit hook runs tests automatically on every `git commit` using the same tiers.

## Production Voter Flow

1. Open the voter portal URL
2. Enter your npub (checked against coordinator's eligibility list)
3. Request a mint quote, publish a claim (kind 38010), wait for approval
4. Mint blinded tokens from the CDK Cashu mint
5. Fill out the ballot and publish a vote event (kind 38000)
6. Submit the proof via NIP-04 encrypted DM to the coordinator
7. Check vote acceptance via the tally endpoint

## Architecture

```
Browser --> Traefik (:80)
              |-- Host(vote.mints.23.182.128.64.sslip.io)
                  --> voting-client container (nginx:alpine)
                       |-- /        --> static HTML/JS
                       |-- /api/    --> coordinator:8081
                       |-- /mint/   --> mint:3338
```

## Local Development (mock mode)

The frontend has a `VITE_USE_MOCK=true` mode that uses a local mock server
instead of the real coordinator and mint:

```bash
npm install && npm --prefix web install
npm run build && npm --prefix web run build
npm run server       # local mock server on :8787
npm --prefix web run dev   # Vite dev server on :5173
```

## Project Structure

```text
docs/                       design docs and planning notes
src/                        server and CLI TypeScript code
web/                        React + Vite frontend
web/src/App.tsx             voter portal (discovery + issuance)
web/src/VotingApp.tsx       voting page (ballot + proof DM + tally)
web/src/DashboardApp.tsx    operator dashboard (eligibility + tally)
web/src/coordinatorApi.ts   coordinator HTTP API client
web/src/mintApi.ts          CDK Cashu mint API client
web/src/cashuBlind.ts       blinded token operations (CashuWallet)
web/src/proofSubmission.ts  NIP-04 encrypted DM sender
web/src/ballot.ts           ballot event publishing
web/src/nostrIdentity.ts    Nostr key helpers, claim signing
web/src/signer.ts           NostrSigner abstraction (raw / NIP-07)
web/src/cashuWallet.ts      local wallet storage
coordinator/                voting coordinator daemon + proto stubs
ansible/                    Ansible playbooks for deployment
scripts/                    shell wrappers for ansible playbooks
tests/                      pytest integration + E2E tests
```

## Git Worktrees

The project uses [git worktrees](https://git-scm.com/docs/git-worktree) for parallel branch development. Each worktree is a separate directory with its own branch, sharing the same `.git` database.

### Active Worktrees

| Path | Branch |
|------|--------|
| `~/auditable-voting` | `feat/eligibility-move-and-merkle-tree-viz` |
| `~/auditable-voting-cf` | `feature/cloudflare-integration-for-voter-portal` |
| `~/auditable-voting-mc` | `feature/multi-coordinator-voting-deployment` |

### Common Commands

```bash
git worktree list                                    # list all worktrees
git worktree add -b <branch> ../<folder> main        # create new worktree
git worktree remove ../<folder>                      # remove worktree
git worktree prune                                   # clean up stale references
```

Each worktree has its own `.venv/` and `node_modules/`. To work in a worktree, `cd` into it and activate the venv (`source .venv/bin/activate`) before launching opencode.

## Future Improvements

- **Multi-coordinator voting deployment** — Distribute trust across multiple independent coordinators to mitigate censorship and timing attacks. See [feature/multi-coordinator-voting-deployment](https://github.com/c03rad0r/auditable-voting/tree/feature/multi-coordinator-voting-deployment).

## Related Docs

- `docs/01-system-design.md` -- voting system design (canonical)
- `docs/02-protocol-reference.md` -- all Nostr event kinds (38000-38011)
- `docs/07-coordinator-http-api.md` -- HTTP endpoints + stateless architecture
- `docs/13-deploy-and-prepare.md` -- single-command full stack deploy
- `docs/14-voting-client-deployment.md` -- voting client deployment details
- `docs/19-playwright-test-plan.md` -- Playwright browser E2E test plan
