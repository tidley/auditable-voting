#!/usr/bin/env bash
# =============================================================================
# list-mints.sh - List all deployed TollGate mints on the VPS
# =============================================================================
#
# Usage:
#   ./scripts/list-mints.sh <vps-ip>
#   ./scripts/list-mints.sh -p <ssh-password> <vps-ip>
#
# SSH auth (pick one):
#   -p <password>          Pass SSH password directly
#   TG_SSH_PASS=<password> Set via environment variable
#   (neither)              Prompts interactively
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

if [ $# -lt 1 ]; then
    echo "Usage: $0 [-p <ssh-password>] <vps-ip>"
    exit 1
fi

VPS_IP="$1"

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

echo "============================================"
echo " Deployed TollGate Mints"
echo "============================================"
echo ""

OUTPUT=$(ansible tollgate-vps $EXTRA_VARS $SSH_ARGS -m shell -a '
if [ -f /opt/tollgate/mints/registry.csv ] && [ -s /opt/tollgate/mints/registry.csv ]; then
    while IFS=, read -r npub subdomain fqdn created; do
        echo "${subdomain}|${fqdn}|${npub}|${created}"
    done < /opt/tollgate/mints/registry.csv
else
    echo "EMPTY"
fi
' --become 2>/dev/null | tail -n +2)

if [ "$OUTPUT" = "EMPTY" ] || [ -z "$OUTPUT" ]; then
    echo " No mints deployed yet."
    echo ""
    exit 0
fi

# Print table
printf " %-14s %-50s %s\n" "SUBDOMAIN" "FQDN" "DEPLOYED"
printf " %-14s %-50s %s\n" "---------" "----" "--------"
echo "$OUTPUT" | while IFS='|' read -r subdomain fqdn npub created; do
    printf " %-14s %-50s %s\n" "$subdomain" "$fqdn" "$created"
done

echo ""
echo "============================================"
echo " Test with curl:"
echo "============================================"
echo ""
echo "$OUTPUT" | while IFS='|' read -r subdomain fqdn npub created; do
    echo "  curl http://${fqdn}/v1/info"
    echo "  curl https://${fqdn}/v1/info"
done
echo ""
