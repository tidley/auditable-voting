#!/usr/bin/env bash
# Start the email companion with Strato SMTP for orangesync.tech.
#
# The mailbox password is never stored in this repository. Provide it through
# SMTP_PASS, or through a mode-0600 file such as:
#
#   install -m 600 /dev/null "$HOME/.hermes/trust-root/strato-smtp.pass"
#   # write the mailbox password into that file
#
# The file can be rendered from the Hermes trust root (`make secret-put
# NAME=strato-smtp`) rather than kept in a plain `.env`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SMTP_HOST="${SMTP_HOST:-smtp.strato.de}"
export SMTP_PORT="${SMTP_PORT:-465}"
export SMTP_SECURE="${SMTP_SECURE:-true}"
export SMTP_USER="${SMTP_USER:-vote@orangesync.tech}"
export SMTP_FROM="${SMTP_FROM:-$SMTP_USER}"
export EMAIL_SENDER_STATE_DIR="${EMAIL_SENDER_STATE_DIR:-/var/tmp/build/c08rad0r/email-sender-state}"

if [[ -z "${SMTP_PASS:-}" ]]; then
  pass_file="${STRATO_SMTP_PASS_FILE:-$HOME/.hermes/trust-root/strato-smtp.pass}"
  if [[ ! -r "$pass_file" ]]; then
    echo "Strato SMTP password is not set and $pass_file is not readable." >&2
    echo "Set SMTP_PASS, or create the file with mode 0600 and retry." >&2
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
