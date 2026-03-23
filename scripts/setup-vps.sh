#!/usr/bin/env bash
# =============================================================================
# setup-vps.sh - Provision a VPS with Docker, Traefik, and firewall
# =============================================================================
#
# Usage:
#   ./scripts/setup-vps.sh <vps-ip>
#   ./scripts/setup-vps.sh -p <ssh-password> <vps-ip>
#
# SSH auth (pick one):
#   -p <password>          Pass SSH password directly
#   TG_SSH_PASS=<password> Set via environment variable
#   (neither)              Uses SSH key or prompts interactively
#
# Examples:
#   ./scripts/setup-vps.sh 203.0.113.10
#   ./scripts/setup-vps.sh -p MyPass123 203.0.113.10
#   TG_SSH_PASS=MyPass123 ./scripts/setup-vps.sh 203.0.113.10
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

if [ $# -lt 1 ]; then
    echo "Usage: $0 [-p <ssh-password>] <vps-ip>"
    echo ""
    echo "  Installs Docker, Traefik, and configures the firewall on the VPS."
    echo "  Run this once before deploying any mints."
    exit 1
fi

VPS_IP="$1"

echo "============================================"
echo " TollGate VPS Setup"
echo "============================================"
echo " VPS: $VPS_IP"
echo "============================================"
echo ""

EXTRA_VARS="-e vps_ip=$VPS_IP"

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
ansible-playbook playbook.yml --tags setup $EXTRA_VARS $SSH_ARGS
