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

## User Flow

### Target Protocol Direction

The current protocol direction is Nostr voting backed by blind threshold signatures. The intended user-visible flow is:

1. A voter proves eligibility out of band to coordinators and submits a blinded token commitment.
2. Multiple coordinators independently validate eligibility and return blind signature shares, without learning the final token or vote.
3. The voter combines enough shares to assemble a valid voting token, derives a `token_id = hash(token)`, and can render that as a deterministic visual fingerprint for human checking.
4. The voter generates an ephemeral Nostr keypair and publishes a signed vote event carrying the vote choice, the signed token, and the `token_id`.
5. Anyone can validate the threshold signature, reject duplicate token use, and compute the tally from the public Nostr event stream.
6. The live public ballot view shows `token_id`-derived patterns plus the associated vote, but does not reveal voter identity.
7. The voter independently verifies inclusion by checking that their local `token_id` or visual pattern appears publicly with the intended vote.

Protocol roles and trust boundaries:

- Coordinators validate voters and participate in threshold blind signing, but should not learn final tokens or ballots.
- Voters receive signature shares, assemble the final token locally, and vote anonymously through ephemeral Nostr keys.
- Observers and verifiers validate signatures, tally votes, and audit correctness from public artifacts.

Important properties:

- Blind threshold issuance provides anonymity and removes any single coordinator as a trust anchor.
- Nostr provides a public, append-only, multi-relay event stream for transparency and replayable verification.
- Token uniqueness prevents double voting.
- The visual token fingerprint is for human auditability only; cryptographic validity comes from the token and signature checks.

Ticket model:

- This project treats voting tickets as round-bound, not generic pre-issued vote credits.
- A ticket request is tied to a specific `voting_id`, and the resulting ticket is intended to be spent only on that round.
- The main reasons are replay prevention across rounds, simpler coordinator-side validation, and a clearer public audit trail because issued tickets and submitted votes refer to the same announced round.

### Current Implementation Snapshot

The repository currently implements coordinator-mediated blinded issuance with public Nostr ballot events and coordinator receipts.

Single-coordinator flow:

1. Open the voter portal URL.
2. Enter your npub and check eligibility.
3. Request a mint quote, publish a kind `38010` claim, and wait for approval.
4. Mint blinded tokens from the coordinator's Cashu mint.
5. Fill out the ballot and publish kind `38000`.
6. Submit the proof privately via NIP-17 gift wrap.
7. Check vote acceptance and tally state.

Multi-coordinator flow:

1. Open the voter portal and auto-discover coordinators via kinds `38008` and `38012`.
2. Enter your npub and verify it against the canonical eligible set.
3. Request issuance from each coordinator.
4. Publish a vote event with `proof-hash` tags for the relevant proofs.
5. Submit proofs privately to coordinators.
6. Publish voter confirmation via kind `38013` after the voting window closes.
7. Run the audit view to compare tallies, confirmations, and coordinator outputs.

See `docs/03-quorum-model.md` for the trust model and `docs/25-multi-coordinator-implementation-status.md` for implementation progress.

## Architecture

```
Browser --> Traefik (:80)
              |-- Host(vote.mints.23.182.128.64.sslip.io)
                  --> voting-client container (nginx:alpine)
                       |-- /        --> static HTML/JS
                       |-- /api/    --> coordinator:8081
                       |-- /mint/   --> mint:3338
```

## Local Demo (mock mode)

Run these commands from your local checkout root, not from a hardcoded path.

Install dependencies once:

```bash
npm install
npm --prefix web install
```

Start the mock coordinator + mock mint in one terminal:

```bash
npm run build
npm run server
```

Start the demo UI in a second terminal:

```bash
VITE_USE_MOCK=true VITE_DEMO_MODE=true npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Then open:

```text
http://127.0.0.1:5173/
```

Notes:

- `npm run server` serves the local mock API on `http://localhost:8789`
- the demo page uses the mock backend only when `VITE_USE_MOCK=true`
- if you cloned the repo somewhere else, stay in that directory instead of using `/home/tom/code/auditable-voting`

## GitHub Pages

The frontend can be deployed to GitHub Pages as a static site.

Important limitation:

- GitHub Pages only hosts the static frontend build
- it does not provide the local Vite `/api` proxy used in mock mode
- for a Pages deployment, point the app at a real coordinator and mint by setting repository variables:
  - `VITE_COORDINATOR_URL`
  - `VITE_MINT_URL`

This repo now includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml` that:

- builds the `web/` frontend
- uses a Pages-safe base path
- deploys `web/dist` to GitHub Pages

The workflow builds with:

```text
VITE_USE_MOCK=false
VITE_DEMO_MODE=false
```

If you want to test the same Pages-style path handling locally, run:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
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
web/src/proofSubmission.ts  NIP-17 gift-wrap sender
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

### Design & Protocol

- `docs/01-system-design.md` -- multi-coordinator voting system design (canonical)
- `docs/02-protocol-reference.md` -- all Nostr event kinds (38000-38013)
- `docs/03-quorum-model.md` -- 1-of-N coordinator quorum, trust model, adversarial analysis
- `docs/04-event-interop.md` -- client-facing event shapes
- `docs/05-voter-integration-guide.md` -- voter client integration steps
- `docs/06-per-election-keysets.md` -- per-election keyset rotation
- `docs/08-tally-implementation.md` -- Merkle trees, close election

### Implementation Status

- `docs/25-multi-coordinator-implementation-status.md` -- multi-coordinator implementation progress and remaining tasks

### Deployment

- `docs/07-coordinator-http-api.md` -- HTTP endpoints + stateless architecture
- `docs/13-deploy-and-prepare.md` -- single-command full stack deploy
- `docs/14-voting-client-deployment.md` -- voting client deployment details
- `docs/15-coordinator-deployment.md` -- coordinator systemd, 9 phases

### Testing

- `docs/16-coordinator-test-plan.md` -- 49 coordinator unit tests
- `docs/17-integration-test-plan.md` -- 3-layer test architecture
- `docs/18-frontend-test-plan.md` -- readiness tests + E2E voter flow
- `docs/19-playwright-test-plan.md` -- Playwright browser E2E test plan
