#!/usr/bin/env bash
# =============================================================================
# remove-mint.sh - Remove a TollGate mint
# =============================================================================
#
# Usage:
#   ./scripts/remove-mint.sh <vps-ip> <subdomain>
#   ./scripts/remove-mint.sh -p <ssh-password> <vps-ip> <subdomain>
#
# SSH auth (pick one):
#   -p <password>          Pass SSH password directly
#   TG_SSH_PASS=<password> Set via environment variable
#   (neither)              Prompts interactively
#
# Example:
#   ./scripts/remove-mint.sh 203.0.113.10 a3b7c9d2e4f1
#
set -euo pipefail

if ! command -v ansible >/dev/null 2>&1; then
    echo "Error: 'ansible' is not installed."
    echo "Install with: pip install ansible"
    exit 1
fi

# --- Parse SSH password flag ---
SSH_PASS="${TG_SSH_PASS:-}"
if [ "${1:-}" = "-p" ]; then
    SSH_PASS="${2:?Error: -p requires a password argument}"
    shift 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ $# -lt 2 ]; then
    echo "Usage: $0 [-p <ssh-password>] <vps-ip> <subdomain>"
    echo ""
    echo "  Use list-mints.sh to see deployed mints and their subdomains."
    exit 1
fi

VPS_IP="$1"
SUBDOMAIN="$2"
CONTAINER="mint-${SUBDOMAIN}"
DATA_DIR="/opt/tollgate/mints/${SUBDOMAIN}"

echo "============================================"
echo " Removing TollGate Mint"
echo "============================================"
echo " VPS       : $VPS_IP"
echo " Subdomain : $SUBDOMAIN"
echo " Container : $CONTAINER"
echo " Data dir  : $DATA_DIR"
echo "============================================"
echo ""
printf "Are you sure? This will stop the mint and remove its data. [y/N] "
read -r confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

# SSH auth
EXTRA_VARS="-e vps_ip=${VPS_IP}"
SSH_ARGS=""
if [ -n "$SSH_PASS" ]; then
    if ! command -v sshpass >/dev/null 2>&1; then
        echo "Error: 'sshpass' is required for password-based SSH."
        echo "Install with: brew install hudochenkov/sshpass/sshpass (macOS)"
        echo "              apt install sshpass (Ubuntu/Debian)"
        exit 1
    fi
    EXTRA_VARS="$EXTRA_VARS -e ansible_ssh_pass=$SSH_PASS"
else
    SSH_ARGS="--ask-pass"
fi

cd "$PROJECT_DIR"

ansible tollgate-vps $EXTRA_VARS $SSH_ARGS -m shell -a "
    cd ${DATA_DIR} && docker compose down --volumes 2>/dev/null || true
    docker rm -f ${CONTAINER} 2>/dev/null || true

    # Clean up auth resources if auth services are deployed
    if docker ps -q -f name=keycloak 2>/dev/null | grep -q .; then
        echo '==> Cleaning up auth resources...'

        # Source admin credentials
        . /opt/tollgate/auth/admin.env 2>/dev/null || true

        # Read operator npub from metadata
        NPUB=\$(grep '^npub=' ${DATA_DIR}/operator.env 2>/dev/null | cut -d= -f2) || true

        # Delete Keycloak user
        if [ -n \"\${NPUB:-}\" ] && [ -n \"\${KEYCLOAK_ADMIN_PASSWORD:-}\" ]; then
            KC_TOKEN=\$(curl -sf -X POST http://127.0.0.1:8080/realms/master/protocol/openid-connect/token \
                -d \"grant_type=password&client_id=admin-cli&username=\${KEYCLOAK_ADMIN_USER}&password=\${KEYCLOAK_ADMIN_PASSWORD}\" \
                2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])' 2>/dev/null) || true

            if [ -n \"\${KC_TOKEN:-}\" ]; then
                USER_ID=\$(curl -sf -H \"Authorization: Bearer \${KC_TOKEN}\" \
                    \"http://127.0.0.1:8080/admin/realms/tollgate/users?username=\${NPUB}&exact=true\" \
                    2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0][\"id\"] if d else \"\")' 2>/dev/null) || true

                if [ -n \"\${USER_ID:-}\" ]; then
                    curl -sf -X DELETE -H \"Authorization: Bearer \${KC_TOKEN}\" \
                        \"http://127.0.0.1:8080/admin/realms/tollgate/users/\${USER_ID}\" 2>/dev/null || true
                    echo \"    Deleted Keycloak user: \${NPUB}\"
                fi
            fi
        fi

        # Drop per-mint auth database
        docker exec postgres psql -U \${AUTH_POSTGRES_USER:-tollgate} -d keycloak -c \"DROP DATABASE IF EXISTS auth_${SUBDOMAIN}\" 2>/dev/null || true
        echo \"    Dropped auth database: auth_${SUBDOMAIN}\"
    fi

    rm -rf ${DATA_DIR}
    sed -i '/${SUBDOMAIN}/d' /opt/tollgate/mints/registry.csv 2>/dev/null || true
    echo 'Mint ${SUBDOMAIN} removed.'
" --become

echo ""
echo "Done. Mint $SUBDOMAIN has been removed."
