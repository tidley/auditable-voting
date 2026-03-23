#!/usr/bin/env bash
# =============================================================================
# deploy-mint.sh - Deploy a TollGate Cashu mint for an operator
# =============================================================================
#
# Usage:
#   ./scripts/deploy-mint.sh <vps-ip> <npub> [custom-subdomain]
#   ./scripts/deploy-mint.sh -p <ssh-password> <vps-ip> <npub> [custom-subdomain]
#
# SSH auth (pick one):
#   -p <password>          Pass SSH password directly
#   TG_SSH_PASS=<password> Set via environment variable
#   (neither)              Prompts interactively
#
# Examples:
#   ./scripts/deploy-mint.sh 203.0.113.10 npub1a3b7...
#   ./scripts/deploy-mint.sh -p MyPass123 203.0.113.10 npub1a3b7...
#   TG_SSH_PASS=MyPass123 ./scripts/deploy-mint.sh 203.0.113.10 npub1a3b7...
#
set -euo pipefail

# --- Verify dependencies ---
if ! command -v ansible-playbook >/dev/null 2>&1; then
    echo "Error: 'ansible-playbook' is not installed."
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
    echo "Usage: $0 [-p <ssh-password>] <vps-ip> <npub> [custom-subdomain]"
    echo ""
    echo "  vps-ip            IP address of the target VPS"
    echo "  npub              Nostr public key of the TollGate operator"
    echo "  custom-subdomain  Optional: custom subdomain prefix (default: derived from npub)"
    exit 1
fi

VPS_IP="$1"
NPUB="$2"

# Validate npub format (npub1 + 58 bech32 chars)
if ! echo "$NPUB" | grep -qE '^npub1[a-z0-9]{58}$'; then
    echo "Error: Invalid npub format."
    echo "Expected: npub1 followed by 58 lowercase alphanumeric characters"
    echo "Got:      $NPUB"
    exit 1
fi

# Derive subdomain preview
SUBDOMAIN="${3:-$(echo "$NPUB" | cut -c6-17)}"

echo "============================================"
echo " TollGate Mint Deployment"
echo "============================================"
echo " VPS      : $VPS_IP"
echo " Operator : $NPUB"
echo " Subdomain: $SUBDOMAIN"
echo "============================================"
echo ""

EXTRA_VARS="-e vps_ip=$VPS_IP -e npub=$NPUB"
if [ $# -ge 3 ]; then
    EXTRA_VARS="$EXTRA_VARS -e mint_subdomain=$3"
fi

# SSH auth
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
ansible-playbook playbook.yml --tags mint $EXTRA_VARS $SSH_ARGS
