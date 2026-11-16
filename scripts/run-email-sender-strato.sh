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

smtp_check() {
  python3 - "$SMTP_HOST" "$SMTP_PORT" "$SMTP_SECURE" "$SMTP_USER" "$SMTP_PASS" "${STRATO_TEST_TO:-}" "$SMTP_FROM" <<'PY'
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate

host, port, secure, user, password, test_to, sender = sys.argv[1:8]
port = int(port)
secure = secure.lower() in ("1", "true", "yes")
try:
    if secure:
        client = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
    else:
        client = smtplib.SMTP(host, port, timeout=20)
        client.starttls(context=ssl.create_default_context())
    client.login(user, password)
    print("SMTP AUTH OK")
    if test_to:
        message = EmailMessage()
        message["From"] = sender
        message["To"] = test_to
        message["Subject"] = "Auditable voting Strato delivery test"
        message["Date"] = formatdate(localtime=False)
        message.set_content(
            "Harmless delivery test for auditable voting email. No action required."
        )
        client.send_message(message)
        print(f"TEST MESSAGE SENT to {test_to}")
    client.quit()
except Exception as error:  # noqa: BLE001 - surface the provider's reason
    print(f"SMTP CHECK FAILED: {type(error).__name__}: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

if [[ -n "${STRATO_CHECK_ONLY:-}" || -n "${STRATO_TEST_TO:-}" ]]; then
  smtp_check
  exit $?
fi

exec node "$root/scripts/email-sender.mjs"
