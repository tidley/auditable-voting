#!/usr/bin/env bash
# Start the email companion with Strato SMTP for orangesync.tech.
#
# The mailbox password is never stored in this repository. Resolution order:
#   1. SMTP_PASS in the environment.
#   2. A trust-root SOPS secret (default:
#      ~/.hermes/trust-root/sops/strato-smtp.enc.yaml, field `password`).
#   3. A mode-0600 file (default: ~/.hermes/trust-root/strato-smtp.pass).
#
# The trust root can create the SOPS secret with:
#   cd ~/hermes-trust-root
#   make secret-put NAME=strato-smtp   # field: password
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SMTP_HOST="${SMTP_HOST:-smtp.strato.de}"
export SMTP_PORT="${SMTP_PORT:-465}"
export SMTP_SECURE="${SMTP_SECURE:-true}"
export SMTP_USER="${SMTP_USER:-vote@orangesync.tech}"
export SMTP_FROM="${SMTP_FROM:-$SMTP_USER}"
export EMAIL_SENDER_STATE_DIR="${EMAIL_SENDER_STATE_DIR:-/var/tmp/build/c08rad0r/email-sender-state}"

read_sops_password() {
  local sops_file="$1"
  if ! command -v sops >/dev/null 2>&1; then
    echo "sops is required to read $sops_file" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to parse $sops_file" >&2
    return 1
  fi
  SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.hermes/keys/fleet-age.key}" \
    sops -d "$sops_file" \
    | python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin) or {}; v=d.get("password") or (next(iter(d.values())) if d else ""); print(v)'
}

if [[ -z "${SMTP_PASS:-}" ]]; then
  sops_file="${STRATO_SMTP_SOPS_FILE:-$HOME/.hermes/trust-root/sops/strato-smtp.enc.yaml}"
  if [[ -r "$sops_file" ]]; then
    if ! SMTP_PASS="$(read_sops_password "$sops_file")"; then
      echo "Could not decrypt $sops_file." >&2
      exit 1
    fi
    export SMTP_PASS
  fi
fi

if [[ -z "${SMTP_PASS:-}" ]]; then
  pass_file="${STRATO_SMTP_PASS_FILE:-$HOME/.hermes/trust-root/strato-smtp.pass}"
  if [[ ! -r "$pass_file" ]]; then
    echo "Strato SMTP password is not set and $pass_file is not readable." >&2
    echo "Set SMTP_PASS, create the trust-root SOPS secret, or create the file with mode 0600." >&2
    exit 1
  fi
  mode="$(stat -c '%a' "$pass_file" 2>/dev/null || echo unknown)"
  if [[ "$mode" != "600" && "$mode" != "400" ]]; then
    echo "Refusing to read $pass_file with mode $mode; expected 600 or 400." >&2
    exit 1
  fi
  SMTP_PASS="$(<"$pass_file")"
  export SMTP_PASS
fi

if [[ -z "${SMTP_PASS}" ]]; then
  echo "Strato SMTP password is empty." >&2
  exit 1
fi

exec node "$root/scripts/email-sender.mjs"
