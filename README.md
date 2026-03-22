# Auditable Voting

Nostr + Cashu voting with coordinator-mediated blind token issuance, eligibility checks, and private ballot submission.

## Live Deployment

**Voter Portal:** http://vote.mints.23.182.128.64.sslip.io/

**Operator Dashboard:** http://vote.mints.23.182.128.64.sslip.io/dashboard.html

**Voting Page:** http://vote.mints.23.182.128.64.sslip.io/vote.html

## Deploy

```bash
ansible-playbook ansible/playbooks/deploy-and-prepare.yml
```

This single command deploys Traefik, the voting coordinator, the frontend, and publishes the election with eligibility data.

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

## Testing

```bash
# Frontend unit tests (vitest)
cd web && npx vitest run

# Integration readiness tests (pytest)
python3 -m venv .venv && .venv/bin/pip install -r tests/requirements.txt
.venv/bin/pytest tests/ -v

# Playwright browser E2E tests (requires VPS running, Chromium installed)
.venv/bin/pip install pytest-playwright
.venv/bin/python -m playwright install chromium
.venv/bin/pytest tests/test_ui_dashboard.py tests/test_ui_issuance.py tests/test_ui_voting.py -v --timeout=600

# Headed mode (watch the browser — requires X server)
.venv/bin/pytest tests/test_ui_issuance.py -v --timeout=300 --headed --slowmo=500
```

- 8/8 Playwright browser E2E tests pass (~2m)
- 25/25 integration readiness tests pass
- 12/12 E2E voter flow steps pass (~87s)
- 13/13 signer tests pass
- 4/4 vitest unit tests pass (cashuBlind regression guards)

The ansible deploy playbook runs vitest automatically before building.

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
ansible/                    Ansible playbooks for deployment
tests/                      pytest integration + E2E tests
```

## Related Docs

- `docs/playwright-e2e-test-plan.md` -- Playwright browser E2E test plan and architecture
- `docs/proof-flow-fix-plan.md` -- all known bugs (A-K) with root cause, fix, and test cases
- `docs/integration-plan.md` -- full integration plan (all 6 phases, DONE)
- `docs/integration-test-plan.md` -- readiness + E2E test plan (all pass)
- `docs/deploy-and-prepare-plan.md` -- SEC-06 deployment playbook plan
- `docs/voting-client-deployment-plan.md` -- voting client deployment details
- `docs/branding-and-signer-plan.md` -- branding + NIP-07 signer integration
- `docs/reference-architecture.md` -- system architecture reference
- `docs/cashu-nostr-voting-design.md` -- voting protocol design
- `docs/self-service-issuance-3-mint-model.md` -- mint issuance model
- `docs/per-election-keysets.md` -- per-election keyset rotation and version compatibility
