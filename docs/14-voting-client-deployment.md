# Voting Client Deployment Plan

**Status: DEPLOYED AND VERIFIED** (2026-03-20)

The voting client is live at http://vote.mints.23.182.128.64.sslip.io/

## Architecture

The voting client is a static Vite/React frontend that communicates with a coordinator
HTTP API and a CDK Cashu mint API. It runs as an `nginx:alpine` Docker container
registered with the Traefik reverse proxy already deployed on the VPS. An internal
nginx config inside the container serves static files and proxies API requests under
the same origin, eliminating CORS issues entirely.

```
Browser --> Traefik (:80)
             |-- Host(`vote.mints.<vps_ip>.sslip.io`)
                 --> voting-client container (nginx:alpine, on tollgate-net)
                      |-- /        --> /usr/share/nginx/html  (web/dist/)
                      |-- /api/    --> host.docker.internal:8081  (coordinator)
                      |-- /mint/   --> host.docker.internal:3338  (CDK mint)
```

### Why Traefik (not standalone nginx)

- Traefik already owns port 80 on the VPS. The Traefik role actively kills
  non-Traefik containers on port 80 before starting.
- All existing services (mint, mint_voting, auth) register via Docker labels.
  The voting client follows the same pattern.
- TLS comes for free when `tls_enabled` is flipped to `true` later -- no
  additional certbot or nginx TLS config needed.

### Container Internals

The container uses `nginx:alpine` with volume mounts. No custom Dockerfile or image
build is needed.

- `/usr/share/nginx/html` <- mounted from `{{ app_deploy_dir }}/web/dist/`
- `/etc/nginx/conf.d/default.conf` <- mounted from rendered `nginx.conf.j2`
- `extra_hosts: ["host.docker.internal:host-gateway"]` <- reach host services

The coordinator (port 8081) is a systemd service on the host. The mint (port 3338)
is a Docker container with host port binding. Neither is on the `tollgate-net` Docker
network, so the voting client container reaches them via `host.docker.internal`.

### Deployment Topology

The playbook is fully standalone and location-independent. It does not depend on the
coordinator playbook from `tg-mint-orchestrator`.

| Scenario | `coordinator_url` | `mint_url` | Notes |
|---|---|---|---|
| Same VPS as coordinator | `http://host.docker.internal:8081` | `http://host.docker.internal:3338` | Default. Container reaches host services. |
| Separate VPS | `http://23.182.128.64:8081` | `http://23.182.128.64:3338` | Point at remote coordinator/mint. |

When deploying to a different VPS (no Traefik), `coordinator_url` and `mint_url`
point at the remote host IPs directly. Traefik labels still work on the local VPS.

### Build-Time Config

Vite injects `VITE_*` env vars at build time. In production these are **relative paths**
so the container-internal nginx handles routing:

```
VITE_USE_MOCK=false
VITE_COORDINATOR_URL=/api
VITE_MINT_URL=/mint
```

This matches section 5.9.2 of `docs/integration-plan.md`.

---

## Files

| # | File | Status | Description |
|---|---|---|---|
| 1 | `ansible/inventory.example` | Done | `[voting_servers]` group with host vars |
| 2 | `ansible/group_vars/all.yml` | Done | `coordinator_url`, `mint_url`, `app_deploy_dir`, `node_version`, `voting_subdomain`, `vps_ip`, `tls_enabled`, `docker_network_name` |
| 3 | `ansible/playbooks/deploy-voting-client.yml` | Done | Docker/Traefik playbook with `setup`/`deploy`/`verify` tags |
| 4 | `ansible/playbooks/templates/docker-compose.yml.j2` | Done | Docker Compose with Traefik labels, `nginx:alpine`, `host.docker.internal`, healthcheck |
| 5 | `ansible/playbooks/templates/nginx.conf.j2` | Done | Container-internal nginx: serve static, proxy `/api/` and `/mint/`, cache `/assets/` |

---

## Inventory (`ansible/inventory.example`)

```ini
[voting_servers]
your_server_ip ansible_user=root ansible_ssh_private_key_file=~/.ssh/id_rsa
```

Override per-host when deploying to a different machine than the coordinator.

---

## Group Variables (`ansible/group_vars/all.yml`)

```yaml
coordinator_url: "http://host.docker.internal:8081"
mint_url: "http://host.docker.internal:3338"
app_deploy_dir: "/opt/auditable-voting"
node_version: "20"
voting_subdomain: "vote"
vps_ip: "23.182.128.64"
tls_enabled: false
docker_network_name: "tollgate-net"
```

| Variable | Default | Description |
|---|---|---|
| `coordinator_url` | `http://host.docker.internal:8081` | Upstream coordinator HTTP API. Container-internal nginx proxies `/api/` here. |
| `mint_url` | `http://host.docker.internal:3338` | Upstream CDK mint HTTP API. Container-internal nginx proxies `/mint/` here. |
| `app_deploy_dir` | `/opt/auditable-voting` | Remote directory for source + built assets. |
| `node_version` | `20` | Node.js major version to install via NodeSource. |
| `voting_subdomain` | `vote` | Subdomain prefix under `effective_domain` (e.g. `vote.mints...`). |
| `vps_ip` | `23.182.128.64` | Used to compute `effective_domain` in test mode. |
| `tls_enabled` | `false` | When `false`: HTTP on port 80. When `true`: HTTPS on 443 via Let's Encrypt. |
| `docker_network_name` | `tollgate-net` | Docker network the voting client container joins (must match Traefik). |

### Computed Variables

The playbook computes `effective_domain` at runtime:

```yaml
effective_domain: "{{ 'mints.' + vps_ip + '.sslip.io' if not tls_enabled else mint_domain }}"
voting_fqdn: "{{ voting_subdomain }}.{{ effective_domain }}"
```

---

## Playbook Tasks (`ansible/playbooks/deploy-voting-client.yml`)

**Play:** Deploy Voting Client -> `voting_servers`, `become: true`

### Tags

| Tag | Purpose |
|---|---|
| `setup` | Node.js (for building on the target) |
| `deploy` | Sync repo, install deps, build, Docker/Traefik |
| `verify` | Smoke tests, print summary |

### Task Breakdown

| # | Task | Tag | Detail |
|---|---|---|---|
| 1 | Compute `effective_domain` | all | `mints.{{ vps_ip }}.sslip.io` or `{{ mint_domain }}` |
| 2 | Install system packages | `setup` | git, curl, rsync, build-essential |
| 3 | Install Node.js | `setup` | NodeSource GPG key + apt repo + `nodejs` package |
| 4 | Create deploy directory | `deploy` | `app_deploy_dir`, mode 0755 |
| 5 | Sync repo to remote | `deploy` | `ansible.builtin.synchronize` with excludes for node_modules, dist, .git, .env |
| 6 | Install root npm deps | `deploy` | `npm install` in `app_deploy_dir` |
| 7 | Build root TypeScript | `deploy` | `npm run build` in `app_deploy_dir` |
| 8 | Install web npm deps | `deploy` | `npm install` in `app_deploy_dir/web` |
| 9 | Build web frontend | `deploy` | `npm run build` in `app_deploy_dir/web` with `VITE_USE_MOCK=false`, `VITE_COORDINATOR_URL=/api`, `VITE_MINT_URL=/mint` |
| 10 | Deploy docker-compose.yml | `deploy` | Template with Traefik labels |
| 11 | Deploy container nginx.conf | `deploy` | Template for /api/ and /mint/ proxy inside container |
| 12 | Ensure `tollgate-net` exists | `deploy` | `docker network create tollgate-net` (idempotent) |
| 13 | Start voting-client container | `deploy` | `docker compose up -d` in deploy dir |
| 14 | Wait for container healthy | `deploy` | Retry loop on container health check |
| 15 | Verify frontend via Traefik | `verify` | `curl -H "Host: {{ voting_fqdn }}" http://127.0.0.1/` returns 200 |
| 16 | Verify API proxy works | `verify` | `curl -H "Host: {{ voting_fqdn }}" http://127.0.0.1/api/info` returns JSON |
| 17 | Print deployment summary | `verify` | URLs, subdomain, coordinator/mint targets |

---

## Docker Compose (`templates/docker-compose.yml.j2`)

```yaml
services:
  voting-client:
    image: nginx:alpine
    container_name: voting-client
    restart: always
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - {{ app_deploy_dir }}/web/dist:/usr/share/nginx/html:ro
      - {{ app_deploy_dir }}/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - {{ docker_network_name }}
    labels:
      traefik.enable: "true"
      traefik.http.routers.voting-client.rule: "Host(`{{ voting_fqdn }}`)"
      traefik.http.routers.voting-client.entrypoints: "{{ 'websecure' if tls_enabled else 'web' }}"
      {% if tls_enabled %}
      traefik.http.routers.voting-client.tls: "true"
      traefik.http.routers.voting-client.tls.certresolver: "letsencrypt"
      {% endif %}
      traefik.http.services.voting-client.loadbalancer.server.port: "80"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:80/"]
      interval: 10s
      timeout: 5s
      retries: 3

networks:
  {{ docker_network_name }}:
    external: true
```

### Traefik Labels

The standard label pattern matches all existing services in `tg-mint-orchestrator`:

| Label | Value | Purpose |
|---|---|---|
| `traefik.enable` | `"true"` | Opt in to Traefik routing |
| `traefik.http.routers.voting-client.rule` | `Host(...)` | Route by subdomain |
| `traefik.http.routers.voting-client.entrypoints` | `"web"` or `"websecure"` | HTTP or HTTPS |
| `traefik.http.services.voting-client.loadbalancer.server.port` | `"80"` | Internal nginx port |

When `tls_enabled` is flipped to `true` later, TLS labels are added automatically
and the Let's Encrypt wildcard cert resolver handles certificates.

---

## Container-Nginx Config (`templates/nginx.conf.j2`)

```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass {{ coordinator_url }}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /mint/ {
        proxy_pass {{ mint_url }}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

The `coordinator_url` and `mint_url` variables are injected at deploy time.
Defaults use `host.docker.internal` to reach host services from inside the container.

---

## Usage Examples

```bash
# Deploy to same VPS as coordinator (defaults to host.docker.internal)
ansible-playbook ansible/playbooks/deploy-voting-client.yml \
  -i ansible/inventory.example \
  -e "ansible_host=23.182.128.64"

# Deploy to a different machine, pointing at remote coordinator
ansible-playbook ansible/playbooks/deploy-voting-client.yml \
  -i ansible/inventory.example \
  -e "ansible_host=203.0.113.50" \
  -e "coordinator_url=http://23.182.128.64:8081" \
  -e "mint_url=http://23.182.128.64:3338"

# Redeploy after code changes (skip Node.js install)
ansible-playbook ansible/playbooks/deploy-voting-client.yml \
  -i ansible/inventory.example \
  --tags deploy,verify

# Deploy with custom subdomain
ansible-playbook ansible/playbooks/deploy-voting-client.yml \
  -i ansible/inventory.example \
  -e "voting_subdomain=ballot"
```

The voting client will be at `http://vote.mints.23.182.128.64.sslip.io/`.

---

## Relationship to Coordinator Playbook

| Concern | This repo (`auditable-voting`) | Coordinator repo (`tg-mint-orchestrator`) |
|---|---|---|
| Frontend static files | Built here, served by container nginx | N/A |
| Container-internal nginx | Routes `/api/` and `/mint/` to host | N/A |
| Traefik reverse proxy | Registered via Docker labels | Already running (port 80) |
| Coordinator HTTP API | Consumed via `/api/` proxy | Served on port 8081 by `tollgate-coordinator.service` |
| CDK mint API | Consumed via `/mint/` proxy | Served on port 3338 by Docker container |
| Docker network | Joins `tollgate-net` (external) | Created by Traefik role |

If deploying to a **different VPS** than the coordinator, ensure the coordinator's
iptables allows inbound TCP 8081 and 3338 from the voting client's IP. Currently the
coordinator playbook only opens these to `0.0.0.0` (all interfaces) so no change is
needed, but if the coordinator's firewall is tightened later, an explicit allow rule
for the voting client IP will be required.

### Interference with Tests

The deployment does **not** interfere with any `tg-mint-orchestrator` tests:

| Resource | Tests | Voting Client |
|---|---|---|
| Ports | 3338, 8081, 8086, 10547 | None (Traefik handles routing) |
| Directories | `/opt/tollgate/coordinator`, `/opt/tollgate/mints-local/` | `/opt/auditable-voting` |
| Services | `tollgate-coordinator`, `nak`, Docker `mint-mint1` | Docker `voting-client` |
| Docker network | `tollgate-net` (already exists) | Joins it (idempotent) |

The voting client container is a read-only consumer of the coordinator and mint APIs.
It never writes to or restarts any existing services.

---

## Deployment History

### 2026-03-20: Initial deployment + branding + NIP-07 signer + UI refactor

Deployed via `ansible-playbook ansible/playbook.yml --tags client`.

**Ansible result:** 24 tasks, 9 changed, 0 failed.

**Live verification (all passed):**

| Check | URL | Status |
|---|---|---|
| Frontend | `http://vote.mints.23.182.128.64.sslip.io/` | 200 |
| API proxy (coordinator) | `http://vote.mints.23.182.128.64.sslip.io/api/info` | 200, valid JSON |
| Soveng logo | `http://vote.mints.23.182.128.64.sslip.io/images/logo.png` | 200 |
| gmnotes robot | `http://vote.mints.23.182.128.64.sslip.io/images/nostr/gmnotes.png` | 200 |
| Bitcoin logo | `http://vote.mints.23.182.128.64.sslip.io/images/bitcoin-logo.png` | 200 |

**Container:** `voting-client` (nginx:alpine) on `tollgate-net`, healthy.

**Features deployed:**
- NIP-07 browser extension signer (auto-detect) + raw nsec mode
- Soveng branding: logo favicon, black-hat accent, bitcoin inline icons
- Nostr robot images: gmnotes, relayflasks, sendmenotes-dark, underconstruction-dark
- Refactored UI: Signer panel first, npub auto-derived, no duplicate nsec input

**Build details:**
- `VITE_USE_MOCK=false`, `VITE_COORDINATOR_URL=/api`, `VITE_MINT_URL=/mint`
- 96 modules, 10 chunks
- Node.js v20.20.1

---

## Future Extensions (not implemented yet)

- **TLS/HTTPS:** Flip `tls_enabled: true` and set `mint_domain`. The playbook already
  has conditional labels for the `websecure` entrypoint and Let's Encrypt cert resolver.
- **Multi-page routing:** The `try_files` fallback to `/index.html` works for SPA. The
  `dashboard.html` and `vote.html` entry points are separate files and served directly.
- **Cache headers:** Already included for `/assets/` (30-day expiry, immutable).
- **Basic auth:** Add `traefik.http.middlewares.voting-auth.basicauth.users=...` label
  and reference it in the router for restricting access during testing.
- **NIP-46 bunker signer:** Add `createNip46Signer(bunkerUri)` using
  `nostr-tools/nip46`, add "nsec bunker" radio option in the signer panel, bunker
  URI input field with connect/disconnect flow. The `NostrSigner` interface already
  accommodates this. See `docs/branding-and-signer-plan.md`.
- **Branding images:** Soveng logo, Nostr robots, Bitcoin logo, OG meta tags.
  All implemented. See `docs/branding-and-signer-plan.md`.
