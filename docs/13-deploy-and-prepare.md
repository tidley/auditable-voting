# Deploy and Prepare Playbook Plan

**Status: IMPLEMENTED AND VERIFIED** (2026-03-20)

A single-command deployment that brings the VPS from **any state** to a fully
ready voter portal with a published SEC-06 feedback election.

```bash
ansible-playbook ansible/playbooks/deploy-and-prepare.yml
```

**Result:** All 4 plays succeed. Voter portal live at:
http://vote.mints.23.182.128.64.sslip.io/

---

## Pre-existing VPS Infrastructure

The playbook is idempotent and handles any starting state. The following
infrastructure must already exist on the VPS (it does):

| Component | Location | Port |
|-----------|----------|------|
| CDK mint | `/opt/tollgate/mints-local/mint1/` (Docker) | 3338 (HTTP), 8086 (gRPC) |
| Nak relay | systemd service | 10547 |
| Coordinator | `/opt/tollgate/coordinator/` (systemd) | 8081 |
| Traefik | `/opt/tollgate/traefik/` (Docker) | 80 |
| Coordinator nsec | `/opt/tollgate/coordinator/nsec.env` | -- |
| Eligible voters | `/opt/tollgate/coordinator/eligible-voters.json` | -- |
| Docker network | `tollgate-net` | -- |

---

## Playbook Task Breakdown

### Phase 1: Infrastructure Bootstrap

#### 1.1 Ensure Traefik is running

Check `docker ps` for the `traefik` container. If missing or stopped, deploy
from `/opt/tollgate/traefik/docker-compose.yml` via `docker_compose_v2`.
No configuration changes needed — Traefik is already configured with:

- Entrypoint `:80` (HTTP only, sslip.io DNS)
- Docker provider scanning `tollgate-net` for labels
- `exposedByDefault: false` (containers must opt in)

#### 1.2 Ensure `tollgate-net` Docker network exists

Create with `docker_network` if missing. Both the Traefik container and the
voting-client container must be on this network.

#### 1.3 Ensure coordinator dependencies are installed

Add `cashu>=0.19.0`, `coincurve`, `marshmallow<4` to the coordinator's
`requirements.txt`. These are needed for the swap-based proof burning
(`handle_proof_dm` uses `step1_alice` to generate throwaway blinded outputs
for `/v1/swap`).

### Phase 2: Deploy Services

#### 2.1 Import `update-coordinator-keep-existing-election.yml`

Delegates to `tg-mint-orchestrator/playbooks/update-coordinator-keep-existing-election.yml` which
handles:

- Mint health check (wait for `GET /v1/info`)
- Coordinator venv creation + `pip install` from requirements.txt
- Copy coordinator script + proto + eligible-voters.json
- Nak relay configuration (`--hostname 0.0.0.0`) + iptables rules
- Coordinator systemd service (`tollgate-coordinator.service`) install + restart
- `--public-mint-url` flag for public mint URL in `/info`

#### 2.2 Import `deploy-voting-client.yml`

Handles:

- Node.js install (NodeSource repo, Node 20)
- `rsync` repo to VPS (`/opt/auditable-voting/`)
- Build frontend: `VITE_USE_MOCK=false VITE_COORDINATOR_URL=/api VITE_MINT_URL=/mint npm run build`
- Deploy nginx config + docker-compose.yml templates
- Start `voting-client` container (nginx:alpine) in `tollgate-net`
- Traefik labels: `Host(vote.mints.23.182.128.64.sslip.io)` → container port 80
- Health check via `docker inspect`

### Phase 3: Election Publication

#### 3.1 Wait for coordinator

Poll `GET http://127.0.0.1:8081/info` until 200 (up to 30s).

#### 3.2 Generate unique election ID

`sec06-feedback-<unix_timestamp>` — unique per deployment to avoid collisions
with the coordinator's one-proof-per-voter-per-election restriction.

#### 3.3 Read coordinator nsec

Slurp `/opt/tollgate/coordinator/nsec.env` from VPS. The election events must
be signed by the coordinator's key so the coordinator accepts them.

#### 3.4 Publish kind 38008 (election announcement)

Run an inline Python script on the VPS via SSH using `nostr-sdk`. The script
connects to the local Nak relay (`ws://localhost:10547`), signs the event with
the coordinator's nsec, and publishes it.

**Election content:**

```json
{
  "title": "SEC-06 Feedback",
  "description": "Share your honest feedback on the SEC-06 cohort experience.",
  "questions": [
    {
      "id": "q1",
      "type": "choice",
      "prompt": "Would you say that you've enjoyed SEC-06 overall?",
      "description": "Be honest.",
      "options": ["Yes", "No"],
      "select": "single"
    },
    {
      "id": "q2",
      "type": "choice",
      "prompt": "Would you recommend SEC to a friend?",
      "description": "A good friend, one that you actually like.",
      "options": ["Yes", "No"],
      "select": "single"
    },
    {
      "id": "q3",
      "type": "scale",
      "prompt": "How would you rate SEC-06 overall?",
      "description": "0 = dogshit, 5 = excellent",
      "min": 0,
      "max": 5,
      "step": 1
    },
    {
      "id": "q4",
      "type": "text",
      "prompt": "What is the one thing that was really bad?",
      "description": "Like, the one thing that stuck out that annoyed you the most, that still annoys you weeks later."
    },
    {
      "id": "q5",
      "type": "text",
      "prompt": "What could've been better?",
      "description": "Leaving out the one worst thing from before, what could've been better in general? Feel free to be verbose."
    },
    {
      "id": "q6",
      "type": "text",
      "prompt": "What essentials did you miss, if any?",
      "description": "We don't consider foot massages to be essential"
    },
    {
      "id": "q7",
      "type": "text",
      "prompt": "What's one small change that we could implement that would improve the cohort experience by a lot?"
    },
    {
      "id": "q8",
      "type": "text",
      "prompt": "How many weeks would you prefer the cohort to be?",
      "description": "Was it too long? Too short? Tell us what the perfect duration would be, and why!"
    },
    {
      "id": "q9",
      "type": "text",
      "prompt": "Recommend at least one person for the next SEC.",
      "description": "Not from the alumni list, we know them already. Please add their contact if possible."
    },
    {
      "id": "q10",
      "type": "text",
      "prompt": "Any other comments and/or suggestions?",
      "description": "Again: we are not looking for praise here, if you have something good to say please tell a friend or shout it into the void that is nostr."
    }
  ],
  "start_time": <now>,
  "end_time": <now + 7 hours>,
  "mint_urls": ["http://23.182.128.64:3338"]
}
```

#### 3.5 Poll for election cache

Poll `GET http://127.0.0.1:8081/election` until 200 (up to 30s). The coordinator
subscribes to kind 38008 events and caches them. The poll ensures the election
is available before publishing eligibility.

#### 3.6 Publish kind 38009 (eligibility set)

Read `eligible-voters.json` from VPS, compute `sha256(sorted_npubs.join("\n"))`
as the Merkle root, and publish via SSH. The coordinator uses this to verify
voter eligibility.

### Phase 4: Summary

Print a formatted summary box with all URLs and instructions:

```
╔══════════════════════════════════════════════════════════╗
║  SEC-06 Feedback Election — Ready to Vote               ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Voter Portal:                                          ║
║    http://vote.mints.23.182.128.64.sslip.io/             ║
║                                                          ║
║  Coordinator API:                                        ║
║    http://23.182.128.64:8081/info                        ║
║                                                          ║
║  Mint:                                                  ║
║    http://23.182.128.64:3338/v1/info                     ║
║                                                          ║
║  Coordinator npub:                                       ║
║    npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh
║                                                          ║
║  Eligible voters: 23                                     ║
║  Election expires: <datetime in 7h>                      ║
║                                                          ║
║  To vote:                                                ║
║    1. Open the Voter Portal URL above                    ║
║    2. Enter your npub (must be in eligible list)         ║
║    3. Follow the steps: claim → mint → vote → submit     ║
╚══════════════════════════════════════════════════════════╝
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `ansible/playbooks/deploy-and-prepare.yml` | **New** | Main playbook: bootstrap + deploy + publish election + summary |
| `ansible/playbook.yml` | **Modify** | Add `prepare` tag, add import of `deploy-and-prepare.yml` |
| `tg-mint-orchestrator/scripts/requirements.txt` | **Modify** | Add `cashu>=0.19.0`, `coincurve`, `marshmallow<4` |

---

## Requirements.txt Changes

The coordinator's proof burning (`handle_proof_dm`) uses `step1_alice` from the
`cashu` library to generate throwaway blinded outputs for `/v1/swap`. These
dependencies must be in `requirements.txt` so the deploy playbook installs them:

```
cashu>=0.19.0
coincurve
marshmallow<4
```

`marshmallow<4` is required because `cashu>=0.19.0` uses
`marshmallow.__version_info__` which was removed in marshmallow 4.x.

---

## Text Responses and Tally

Text-type questions (q4-q10) are published in the vote event content as
`{question_id, value}` strings. The coordinator's `_compute_results()` only
counts choice/scale results. Text responses will be stored in the kind 38000
events on Nostr relays and can be read directly from there. They will not
appear in the `GET /tally` response's `results` object.

---

## Idempotency

The playbook is safe to run multiple times:

- **Traefik:** `docker_compose_v2` with `state: present` is idempotent
- **Docker network:** `docker_network` with `state: present` is idempotent
- **Coordinator:** systemd `state: restarted` re-applies config changes
- **Frontend:** `--force-recreate` on the nginx container picks up new builds
- **Election:** Each run generates a unique `election_id` (timestamp-based),
  so re-running creates a fresh election. The coordinator caches the latest
  kind 38008 event per the subscription filter.

---

## Bugs Found and Fixed During Implementation

### 1. rsync not installed on VPS

**Symptom:** `ansible.builtin.synchronize` failed with `sudo: rsync: command not found`.

**Fix:** Added `rsync` to the `apt` package list in `deploy-voting-client.yml`.

### 2. Container healthcheck IPv6 issue

**Symptom:** Docker healthcheck reported `unhealthy` even though nginx was serving
content on port 80. `wget http://localhost:80/` failed inside the `nginx:alpine`
container because `localhost` resolved to `::1` (IPv6) but nginx only listened on
`0.0.0.0:80` (IPv4).

**Fix:** Changed healthcheck URL from `http://localhost:80/` to
`http://127.0.0.1:80/` in `docker-compose.yml.j2`.

### 3. Eligibility root shell quoting

**Symptom:** Python script for computing SHA-256 eligibility root failed with
`NameError` because shell double-quotes ate the JSON string quotes.

**Fix:** Switched from `python3 -c "..."` to a heredoc (`<< 'PYEOF'`) which preserves
all quoting.

### 4. `to_datetime('%s')` removed in Python 3.13

**Symptom:** Ansible's `to_datetime('%s')` filter failed with `'s' is a bad directive
in format '%s'` on the VPS which runs Python 3.13 (the `%s` format code was removed).

**Fix:** Replaced with `date -u -d @<epoch> '+%Y-%m-%d %H:%M:%S UTC'` shell command.

### 5. `import_playbook` cannot use variables

**Symptom:** `ansible.builtin.import_playbook: update-coordinator-keep-existing-election.yml` failed because
`import_playbook` is evaluated at parse time, not runtime.

**Fix:** Rewrote `update-coordinator-keep-existing-election.yml` to use inline tasks instead of importing
the tg-mint-orchestrator playbook. Coordinator repo path resolved via
`delegate_to: localhost` with `realpath`.

### 6. Conflicting group_vars

**Symptom:** `ansible/inventory/group_vars/all.yml` and `ansible/group_vars/all.yml`
both existed. The inventory one took precedence, shadowing variables from the other.

**Fix:** Merged both into `ansible/inventory/group_vars/all.yml`.

---

## Execution Results (2026-03-20)

```
PLAY RECAP *********************************************************************
tollgate-vps               : ok=56   changed=2    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

All 4 plays completed successfully:
1. Traefik running (idempotent)
2. Coordinator deployed + healthy
3. Voting client deployed + healthy + verified via Traefik
4. SEC-06 election published (kind 38008 + 38009) with 24 eligible voters
