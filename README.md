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

### Single Coordinator

1. Open the voter portal URL
2. Enter your npub (checked against coordinator's eligibility list)
3. Request a mint quote, publish a claim (kind 38010), wait for approval
4. Mint blinded tokens from the CDK Cashu mint
5. Fill out the ballot and publish a vote event (kind 38000)
6. Submit the proof via NIP-17 gift wrap to the coordinator
7. Check vote acceptance via the tally endpoint

### Multi-Coordinator

When multiple coordinators participate in the same election:

1. Open the voter portal — coordinators are auto-discovered via kind 38012 events
2. Enter your npub (checked against canonical eligible set)
3. Click "Request from all N coordinators" — the portal iterates quote/claim/mint per coordinator
4. Fill out the ballot — proof-hash tags are added for each coordinator's proof
5. Submit proofs to all coordinators via encrypted DM (automated)
6. After the voting window closes, publish a voter confirmation (kind 38013)
7. On the dashboard, run the audit to compare tallies and detect inflation/censorship

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

- `npm run server` serves the local mock API on `http://localhost:8787`
- the demo page uses the mock backend only when `VITE_USE_MOCK=true`
- if you cloned the repo somewhere else, stay in that directory instead of using `/home/tom/code/auditable-voting`

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
