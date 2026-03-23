#!/usr/bin/env bash
# =============================================================================
# teardown.sh - Reset VPS by removing all mints, Traefik, and TollGate infra
# =============================================================================
# Compatible with: Ubuntu 20.04+, Debian 11+
#
# Usage:
#   ./scripts/teardown.sh <vps-ip>
#   ./scripts/teardown.sh -p <ssh-password> <vps-ip>
#
# SSH auth (pick one):
#   -p <password>          Pass SSH password directly
#   TG_SSH_PASS=<password> Set via environment variable
#   (neither)              Prompts interactively
#
# Example:
#   ./scripts/teardown.sh 203.0.113.10
#   ./scripts/teardown.sh -p MyPass123 203.0.113.10
#
# This will:
#   1. Stop and remove all mint containers
#   2. Stop and remove Traefik
#   3. Remove the tollgate-net Docker network
#   4. Remove all TollGate data (/opt/tollgate)
#
set -euo pipefail

for cmd in ansible; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: '$cmd' is not installed."
        exit 1
    fi
done

# --- Parse SSH password flag ---
SSH_PASS="${TG_SSH_PASS:-}"
if [ "${1:-}" = "-p" ]; then
    SSH_PASS="${2:?Error: -p requires a password argument}"
    shift 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ $# -lt 1 ]; then
    echo "Usage: $0 [-p <ssh-password>] <vps-ip>"
    echo ""
    echo "  Example: $0 203.0.113.10"
    exit 1
fi

VPS_IP="$1"

# SSH auth
EXTRA_VARS="-e vps_ip=${VPS_IP}"
SSH_ARGS=""
if [ -n "$SSH_PASS" ]; then
    EXTRA_VARS="$EXTRA_VARS -e ansible_ssh_pass=$SSH_PASS"
else
    SSH_ARGS="--ask-pass"
fi

echo "============================================"
echo " TollGate VPS Teardown"
echo "============================================"
echo " This will remove:"
echo "   - All mint containers and data"
echo "   - Auth services (Keycloak + PostgreSQL) if deployed"
echo "   - Traefik reverse proxy"
echo "   - Docker network (tollgate-net)"
echo "   - All data under /opt/tollgate"
echo "============================================"
echo ""
printf "Are you sure? This is irreversible. [y/N] "
read -r confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

cd "$PROJECT_DIR"

echo ""
echo "Tearing down TollGate infrastructure..."

ansible tollgate-vps $EXTRA_VARS $SSH_ARGS -m shell -a '
set -e

echo "==> Stopping all mint containers..."
for dir in /opt/tollgate/mints/*/; do
    if [ -f "${dir}docker-compose.yml" ]; then
        cd "$dir"
        docker compose down --volumes 2>/dev/null || true
        echo "    Stopped: $(basename $dir)"
    fi
done

echo "==> Stopping auth services (Keycloak + PostgreSQL)..."
if [ -f /opt/tollgate/auth/docker-compose.yml ]; then
    cd /opt/tollgate/auth
    docker compose down --volumes 2>/dev/null || true
fi
docker rm -f keycloak postgres 2>/dev/null || true

echo "==> Stopping Traefik..."
if [ -f /opt/tollgate/traefik/docker-compose.yml ]; then
    cd /opt/tollgate/traefik
    docker compose down --volumes 2>/dev/null || true
fi
docker rm -f traefik 2>/dev/null || true

echo "==> Removing Docker network..."
docker network rm tollgate-net 2>/dev/null || true

echo "==> Removing TollGate data..."
rm -rf /opt/tollgate

echo "==> Done. VPS has been reset."
' --become

echo ""
echo "============================================"
echo " Teardown complete."
echo " The VPS has been reset to pre-setup state."
echo " Docker itself is still installed."
echo "============================================"
