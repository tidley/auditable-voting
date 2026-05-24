#!/usr/bin/env bash
set -euo pipefail

# Auditable Voting FIPS host launcher.
#
# This bootstraps a Linux/systemd host that:
# - builds the latest upstream FIPS Rust daemon from source;
# - runs FIPS with Nostr overlay discovery enabled;
# - advertises this node as a FIPS endpoint on Nostr;
# - builds and serves the Auditable Voting static app on fips0;
# - optionally installs a disabled audit-proxy systemd service.

FIPS_REPO="${FIPS_REPO:-https://github.com/jmcorgan/fips.git}"
FIPS_REF="${FIPS_REF:-master}"
APP_REPO="${APP_REPO:-https://github.com/tidley/auditable-voting.git}"
APP_REF="${APP_REF:-main}"
PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/}"

INSTALL_PREFIX="${INSTALL_PREFIX:-/opt/auditable-voting-fips}"
STATE_DIR="${STATE_DIR:-/var/lib/auditable-voting-fips}"
APP_SRC_DIR="${APP_SRC_DIR:-$INSTALL_PREFIX/auditable-voting}"
FIPS_SRC_DIR="${FIPS_SRC_DIR:-$INSTALL_PREFIX/fips}"
WEB_ROOT="${WEB_ROOT:-$STATE_DIR/site}"
WEB_PORT="${WEB_PORT:-8080}"
WEB_BASE_PATH="${WEB_BASE_PATH:-/}"
FIPS_IFACE="${FIPS_IFACE:-fips0}"
FIPS_UDP_PORT="${FIPS_UDP_PORT:-2121}"
FIPS_POLICY="${FIPS_POLICY:-open}"
FIPS_PUBLIC_UDP="${FIPS_PUBLIC_UDP:-0}"
FIPS_EXTERNAL_ADDR="${FIPS_EXTERNAL_ADDR:-}"
FIPS_NSEC="${FIPS_NSEC:-}"
FIPS_ADVERT_RELAYS="${FIPS_ADVERT_RELAYS:-wss://relay.damus.io,wss://nos.lol,wss://offchain.pub}"
FIPS_DM_RELAYS="${FIPS_DM_RELAYS:-wss://relay.damus.io,wss://nos.lol,wss://offchain.pub}"
FIPS_STUN_SERVERS="${FIPS_STUN_SERVERS:-stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478,stun:global.stun.twilio.com:3478}"
FIPS_BIN_PATH="${FIPS_BIN_PATH:-}"
FIPSCTL_BIN_PATH="${FIPSCTL_BIN_PATH:-}"
FIPSTOP_BIN_PATH="${FIPSTOP_BIN_PATH:-}"

WITH_PROXY=0
ENABLE_PROXY=0
START_SERVICES=1
SKIP_FIPS_BUILD=0
SKIP_APP_BUILD=0
USE_PUBLIC_BUILD=0
PRESERVE_FIPS_CONFIG=0
PRESERVE_FIPS_SERVICE=0
PRESERVE_FIPS_FIREWALL=0
ORIGINAL_ARGS=("$@")

usage() {
  cat <<'EOF'
Usage:
  sudo ./launch-auditable-voting-fips.sh [options]

Options:
  --with-proxy       Install the optional audit-proxy service and binary.
  --enable-proxy     Enable/start the audit-proxy service after installing it.
                     Requires WORKER_NSEC and COORDINATOR_NPUB to be set.
  --no-start         Install files but do not enable/start systemd services.
  --skip-fips-build  Reuse an installed fips binary from PATH or FIPS_BIN_PATH.
  --skip-app-build   Reuse WEB_ROOT instead of cloning/building the web app.
  --use-public-build Install the already-published static site instead of
                     cloning/building with npm.
  --preserve-fips-config
                     Do not replace /etc/fips/fips.yaml.
  --preserve-fips-service
                     Do not replace the existing fips.service unit.
  --preserve-fips-firewall
                     Do not install/enable a new fips-firewall.service.
  --reuse-running-fips
                     Shortcut for packaged installs: skip FIPS build and
                     preserve the existing FIPS config, service, and firewall.
  -h, --help         Show this help.

Common environment overrides:
  FIPS_REF=master
  APP_REF=main
  PUBLIC_SITE_URL=https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/
  WEB_PORT=8080
  WEB_BASE_PATH=/             # set to /auditable-voting/ when serving under that path
  FIPS_POLICY=open
  FIPS_PUBLIC_UDP=0          # 0 advertises udp:nat; 1 advertises direct UDP
  FIPS_EXTERNAL_ADDR=IP:2121 # optional direct advertise-as address
  FIPS_ADVERT_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://offchain.pub
  FIPS_DM_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://offchain.pub
  FIPS_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478
  FIPS_BIN_PATH=/usr/bin/fips
  FIPSCTL_BIN_PATH=/usr/bin/fipsctl

Optional proxy environment:
  WORKER_NSEC=nsec1...
  COORDINATOR_NPUB=npub1...
  WORKER_RELAYS=wss://relay.nostr.net,wss://nos.lol
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-proxy)
      WITH_PROXY=1
      ;;
    --enable-proxy)
      WITH_PROXY=1
      ENABLE_PROXY=1
      ;;
    --no-start)
      START_SERVICES=0
      ;;
    --skip-fips-build)
      SKIP_FIPS_BUILD=1
      ;;
    --skip-app-build)
      SKIP_APP_BUILD=1
      ;;
    --use-public-build)
      USE_PUBLIC_BUILD=1
      ;;
    --preserve-fips-config)
      PRESERVE_FIPS_CONFIG=1
      ;;
    --preserve-fips-service)
      PRESERVE_FIPS_SERVICE=1
      ;;
    --preserve-fips-firewall)
      PRESERVE_FIPS_FIREWALL=1
      ;;
    --reuse-running-fips)
      SKIP_FIPS_BUILD=1
      USE_PUBLIC_BUILD=1
      PRESERVE_FIPS_CONFIG=1
      PRESERVE_FIPS_SERVICE=1
      PRESERVE_FIPS_FIREWALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "${ORIGINAL_ARGS[@]}"
  fi
  die "run as root, or install sudo"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_command systemctl
require_command ip
require_command python3
require_command awk
require_command sed

if [ "$SKIP_FIPS_BUILD" -eq 0 ]; then
  require_command git
  require_command cargo
fi

if [ "$SKIP_APP_BUILD" -eq 0 ] && [ "$USE_PUBLIC_BUILD" -eq 0 ]; then
  if command -v npm >/dev/null 2>&1; then
    require_command git
  else
    USE_PUBLIC_BUILD=1
    log "npm not found; using published static site from $PUBLIC_SITE_URL"
  fi
fi

if [ "$START_SERVICES" -eq 1 ] && [ "$PRESERVE_FIPS_FIREWALL" -ne 1 ]; then
  require_command nft
fi

resolve_command_path() {
  local name="$1"
  local configured="$2"

  if [ -n "$configured" ]; then
    [ -x "$configured" ] || die "$name path is not executable: $configured"
    printf '%s\n' "$configured"
    return
  fi

  command -v "$name" 2>/dev/null || true
}

write_comma_list_yaml() {
  local csv="$1"
  local indent="$2"
  local item

  IFS=',' read -r -a items <<<"$csv"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -n "$item" ]; then
      printf '%s- "%s"\n' "$indent" "$item"
    fi
  done
}

backup_file() {
  local path="$1"
  if [ -e "$path" ]; then
    cp -a "$path" "$path.backup.$(date +%Y%m%d%H%M%S)"
  fi
}

clone_or_update_repo() {
  local repo="$1"
  local ref="$2"
  local dir="$3"

  mkdir -p "$(dirname "$dir")"
  if [ ! -d "$dir/.git" ]; then
    git clone "$repo" "$dir"
  fi

  git -C "$dir" fetch --all --tags --prune
  git -C "$dir" checkout "$ref"

  if git -C "$dir" rev-parse --verify --quiet "origin/$ref" >/dev/null; then
    git -C "$dir" reset --hard "origin/$ref"
  fi
}

install_fips_from_source() {
  if [ "$SKIP_FIPS_BUILD" -eq 1 ]; then
    log "Skipping FIPS build"
    FIPS_BIN_PATH="$(resolve_command_path fips "$FIPS_BIN_PATH")"
    FIPSCTL_BIN_PATH="$(resolve_command_path fipsctl "$FIPSCTL_BIN_PATH")"
    FIPSTOP_BIN_PATH="$(resolve_command_path fipstop "$FIPSTOP_BIN_PATH")"
    [ -n "$FIPS_BIN_PATH" ] || die "fips not found. Set FIPS_BIN_PATH=/path/to/fips"
    [ -x "$FIPS_BIN_PATH" ] || die "fips path is not executable: $FIPS_BIN_PATH"
    log "Using existing FIPS binary: $FIPS_BIN_PATH"
    if [ -n "$FIPSCTL_BIN_PATH" ]; then
      log "Using existing fipsctl binary: $FIPSCTL_BIN_PATH"
    else
      log "fipsctl not found; summary output will use /etc/fips/fips.pub if available"
    fi
    return
  fi

  log "Cloning/building FIPS from $FIPS_REPO ($FIPS_REF)"
  clone_or_update_repo "$FIPS_REPO" "$FIPS_REF" "$FIPS_SRC_DIR"
  cargo build --manifest-path "$FIPS_SRC_DIR/Cargo.toml" --release

  install -m 0755 "$FIPS_SRC_DIR/target/release/fips" /usr/local/bin/fips
  install -m 0755 "$FIPS_SRC_DIR/target/release/fipsctl" /usr/local/bin/fipsctl
  install -m 0755 "$FIPS_SRC_DIR/target/release/fipstop" /usr/local/bin/fipstop
  FIPS_BIN_PATH="/usr/local/bin/fips"
  FIPSCTL_BIN_PATH="/usr/local/bin/fipsctl"
  FIPSTOP_BIN_PATH="/usr/local/bin/fipstop"
  if [ -x "$FIPS_SRC_DIR/target/release/fips-gateway" ]; then
    install -m 0755 "$FIPS_SRC_DIR/target/release/fips-gateway" /usr/local/bin/fips-gateway
  fi
}

write_fips_firewall_drop_in() {
  mkdir -p /etc/fips/fips.d

  if [ -f "$FIPS_SRC_DIR/packaging/common/fips.nft" ] && [ ! -f /etc/fips/fips.nft ]; then
    install -m 0644 "$FIPS_SRC_DIR/packaging/common/fips.nft" /etc/fips/fips.nft
  elif [ ! -f /etc/fips/fips.nft ]; then
    cat >/etc/fips/fips.nft <<'EOF'
#!/usr/sbin/nft -f
add table inet fips
flush table inet fips
table inet fips {
  chain inbound {
    type filter hook input priority 0; policy accept;
    iifname != "fips0" return
    ct state established,related accept
    meta nfproto ipv6 icmpv6 type echo-request accept
    include "/etc/fips/fips.d/*.nft"
    counter drop
  }
}
EOF
    chmod 0644 /etc/fips/fips.nft
  fi

  printf 'tcp dport %s accept\n' "$WEB_PORT" >/etc/fips/fips.d/auditable-voting-web.nft
  chmod 0644 /etc/fips/fips.d/auditable-voting-web.nft
}

write_fips_config() {
  local public_value="false"
  local external_line=""
  local tmp

  if [ "$PRESERVE_FIPS_CONFIG" -eq 1 ]; then
    log "Preserving existing /etc/fips/fips.yaml"
    [ -f /etc/fips/fips.yaml ] || log "No /etc/fips/fips.yaml found; assuming the existing fips.service supplies its own config"
    write_fips_firewall_drop_in
    return
  fi

  if [ "$FIPS_PUBLIC_UDP" = "1" ] || [ "$FIPS_PUBLIC_UDP" = "true" ]; then
    public_value="true"
  fi

  if [ -n "$FIPS_EXTERNAL_ADDR" ]; then
    external_line="    external_addr: \"$FIPS_EXTERNAL_ADDR\""
  fi

  log "Writing /etc/fips/fips.yaml"
  mkdir -p /etc/fips/fips.d
  backup_file /etc/fips/fips.yaml
  tmp="$(mktemp)"
  {
    cat <<EOF
node:
  identity:
    persistent: true
EOF
    if [ -n "$FIPS_NSEC" ]; then
      printf '    nsec: "%s"\n' "$FIPS_NSEC"
    fi
    cat <<EOF
  discovery:
    nostr:
      enabled: true
      policy: "$FIPS_POLICY"
      advertise: true
      app: "fips-overlay-v1"
      advert_relays:
EOF
    write_comma_list_yaml "$FIPS_ADVERT_RELAYS" "        "
    cat <<EOF
      dm_relays:
EOF
    write_comma_list_yaml "$FIPS_DM_RELAYS" "        "
    cat <<EOF
      stun_servers:
EOF
    write_comma_list_yaml "$FIPS_STUN_SERVERS" "        "
    cat <<EOF

tun:
  enabled: true
  name: "$FIPS_IFACE"
  mtu: 1280

dns:
  enabled: true
  bind_addr: "::1"
  port: 5354

transports:
  udp:
    bind_addr: "0.0.0.0:$FIPS_UDP_PORT"
    advertise_on_nostr: true
    public: $public_value
    accept_connections: true
EOF
    if [ -n "$external_line" ]; then
      printf '%s\n' "$external_line"
    fi
    cat <<'EOF'

peers: []
EOF
  } >"$tmp"

  install -m 0600 "$tmp" /etc/fips/fips.yaml
  rm -f "$tmp"

  write_fips_firewall_drop_in
}

write_fips_units() {
  local nft_bin
  nft_bin="$(command -v nft || true)"
  nft_bin="${nft_bin:-/usr/sbin/nft}"

  if [ "$PRESERVE_FIPS_SERVICE" -eq 1 ]; then
    log "Preserving existing fips.service unit"
  else
    log "Writing FIPS systemd unit"
    cat >/etc/systemd/system/fips.service <<EOF
[Unit]
Description=FIPS Mesh Network Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$FIPS_BIN_PATH --config /etc/fips/fips.yaml
Restart=on-failure
RestartSec=5
RuntimeDirectory=fips
RuntimeDirectoryMode=0750
ProtectHome=yes
PrivateTmp=yes
ProtectKernelModules=yes
ProtectKernelTunables=no

[Install]
WantedBy=multi-user.target
EOF
  fi

  if [ "$PRESERVE_FIPS_FIREWALL" -eq 1 ]; then
    log "Preserving existing fips-firewall.service unit"
    return
  fi

  log "Writing FIPS firewall systemd unit"
  cat >/etc/systemd/system/fips-firewall.service <<EOF
[Unit]
Description=FIPS mesh-interface firewall
After=fips.service
Requires=fips.service

[Service]
Type=oneshot
ExecStart=$nft_bin -f /etc/fips/fips.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
}

build_web_app() {
  if [ "$SKIP_APP_BUILD" -eq 1 ]; then
    log "Skipping app build"
    [ -f "$WEB_ROOT/index.html" ] || die "$WEB_ROOT/index.html is missing"
    return
  fi

  if [ "$USE_PUBLIC_BUILD" -eq 1 ]; then
    install_public_web_app
    return
  fi

  log "Cloning/building Auditable Voting from $APP_REPO ($APP_REF)"
  clone_or_update_repo "$APP_REPO" "$APP_REF" "$APP_SRC_DIR"
  npm --prefix "$APP_SRC_DIR/web" ci
  VITE_BASE_PATH="$WEB_BASE_PATH" npm --prefix "$APP_SRC_DIR/web" run build

  sync_web_root_from_dir "$APP_SRC_DIR/web/dist" "$WEB_BASE_PATH"
}

sync_web_root_from_dir() {
  local source_dir="$1"
  local install_base="${2:-/}"
  local staging previous install_dir

  [ -f "$source_dir/index.html" ] || die "$source_dir/index.html is missing"

  log "Installing complete static web root from $source_dir"
  mkdir -p "$STATE_DIR"
  mkdir -p "$(dirname "$WEB_ROOT")"
  staging="$(mktemp -d "$STATE_DIR/site.new.XXXXXX")"

  install_base="/${install_base#/}"
  if [ "$install_base" != "/" ]; then
    install_base="${install_base%/}"
  fi

  if [ "$install_base" = "/" ]; then
    install_dir="$staging"
  else
    install_dir="$staging/${install_base#/}"
    mkdir -p "$install_dir"
  fi

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$source_dir"/ "$install_dir"/
  else
    cp -a "$source_dir/." "$install_dir/"
  fi

  [ -f "$install_dir/index.html" ] || {
    rm -rf "$staging"
    die "staged static site is missing index.html"
  }

  previous="$STATE_DIR/site.previous.$$"
  rm -rf "$previous"
  if [ -e "$WEB_ROOT" ] || [ -L "$WEB_ROOT" ]; then
    mv "$WEB_ROOT" "$previous"
  fi
  mv "$staging" "$WEB_ROOT"
  rm -rf "$previous"
}

install_public_web_app() {
  local tmp
  tmp="$(mktemp -d)"

  log "Installing published static site from $PUBLIC_SITE_URL"

  if command -v wget >/dev/null 2>&1; then
    wget \
      --quiet \
      --recursive \
      --level=1 \
      --page-requisites \
      --no-parent \
      --no-host-directories \
      --directory-prefix "$tmp" \
      "$PUBLIC_SITE_URL"
  elif command -v curl >/dev/null 2>&1; then
    install_public_web_app_with_curl "$tmp"
  else
    rm -rf "$tmp"
    die "need wget or curl to install the published static site"
  fi

  if [ ! -f "$tmp/index.html" ]; then
    local candidate
    candidate="$(find "$tmp" -name index.html -type f | head -1 || true)"
    [ -n "$candidate" ] || {
      rm -rf "$tmp"
      die "published static site download did not contain index.html"
    }
    cp -a "$(dirname "$candidate")/." "$tmp/"
  fi

  complete_public_web_app_assets "$tmp"
  mirror_public_base_entrypoints "$tmp"
  sync_web_root_from_dir "$tmp" /
  rm -rf "$tmp"
}

install_public_web_app_with_curl() {
  local tmp="$1"
  local base_url origin asset asset_path asset_url

  base_url="${PUBLIC_SITE_URL%/}/"
  origin="$(printf '%s\n' "$base_url" | sed -E 's#^(https?://[^/]+).*#\1#')"

  curl -L --fail "$base_url" -o "$tmp/index.html"

  grep -Eo '(src|href)="[^"]+"' "$tmp/index.html" \
    | sed -E 's/^[^"]+"//; s/"$//' \
    | grep -E '^(\/)?(assets|fips-host|worker-helper)\/|^[^:?#]+\.html($|[?#])' \
    | sort -u \
    | while read -r asset; do
        asset="${asset%%\#*}"
        asset="${asset%%\?*}"
        [ -n "$asset" ] || continue
        case "$asset" in
          /*)
            asset_path="${asset#/}"
            asset_url="$origin/$asset_path"
            ;;
          *)
            asset_path="$asset"
            asset_url="$base_url$asset"
            ;;
        esac
        mkdir -p "$tmp/$(dirname "$asset_path")"
        curl -L --fail "$asset_url" -o "$tmp/$asset_path" || true
      done
}

extract_public_asset_refs() {
  local file="$1"
  local ext

  ext='js|mjs|css|wasm|html|json|webmanifest|png|jpg|jpeg|gif|svg|webp|ico|txt|map|woff2?|ttf|otf'

  {
    grep -Eoh "[\"'\`][^\"'\`]+\.($ext)([?#][^\"'\`]*)?[\"'\`]" "$file" \
      | sed -E "s/^[\"'\`]//; s/[\"'\`]$//"
    grep -Eoh "url\([[:space:]]*['\"]?[^'\")]+\.($ext)([?#][^'\")]*)?['\"]?[[:space:]]*\)" "$file" \
      | sed -E "s/^url\([[:space:]]*['\"]?//; s/['\"]?[[:space:]]*\)$//"
  } 2>/dev/null || true
}

resolve_public_asset_ref() {
  local tmp="$1"
  local source_path="$2"
  local ref="$3"
  local source_dir asset_path

  ref="${ref%%\#*}"
  ref="${ref%%\?*}"
  [ -n "$ref" ] || return 1

  case "$ref" in
    *'${'*|*'{'*|*'}'*|*,*)
      return 1
      ;;
  esac

  case "$ref" in
    http://*|https://*|data:*|mailto:*|tel:*|javascript:*)
      return 1
      ;;
    /*)
      asset_path="${ref#/}"
      ;;
    ./*|../*)
      source_dir="$(dirname "$source_path")"
      [ "$source_dir" = "." ] && source_dir=""
      if [ -n "$source_dir" ]; then
        asset_path="$source_dir/$ref"
      else
        asset_path="$ref"
      fi
      ;;
    *)
      source_dir="$(dirname "$source_path")"
      [ "$source_dir" = "." ] && source_dir=""
      if [ -n "$source_dir" ]; then
        asset_path="$source_dir/$ref"
      else
        asset_path="$ref"
      fi
      ;;
  esac

  asset_path="$(realpath -m --relative-to="$tmp" "$tmp/$asset_path" 2>/dev/null || true)"
  [ -n "$asset_path" ] || return 1

  case "$asset_path" in
    ..|../*|/*)
      return 1
      ;;
  esac

  printf '%s\n' "$asset_path"
}

public_site_base_path() {
  local base_url base_path

  base_url="${PUBLIC_SITE_URL%/}/"
  base_path="$(printf '%s\n' "$base_url" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
  printf '%s\n' "$base_path"
}

mirror_public_base_entrypoints() {
  local tmp="$1"
  local base_path html name

  base_path="$(public_site_base_path)"
  [ -n "$base_path" ] || return 0

  mkdir -p "$tmp/$base_path"
  while IFS= read -r -d '' html; do
    name="$(basename "$html")"
    cp -a "$html" "$tmp/$base_path/$name"
  done < <(find "$tmp" -maxdepth 1 -type f -name '*.html' -print0)
}

download_public_asset_path() {
  local tmp="$1"
  local asset_path="$2"
  local base_url origin base_path asset_url missing_assets

  [ -f "$tmp/$asset_path" ] && return 1

  missing_assets="$tmp/.public-missing-assets"
  if [ -f "$missing_assets" ] && grep -Fxq "$asset_path" "$missing_assets"; then
    return 1
  fi

  base_url="${PUBLIC_SITE_URL%/}/"
  origin="$(printf '%s\n' "$base_url" | sed -E 's#^(https?://[^/]+).*#\1#')"
  base_path="$(public_site_base_path)"

  if [ -n "$base_path" ] && { [ "$asset_path" = "$base_path" ] || [ "${asset_path#"$base_path"/}" != "$asset_path" ]; }; then
    asset_url="$origin/$asset_path"
  else
    asset_url="$base_url$asset_path"
  fi

  mkdir -p "$tmp/$(dirname "$asset_path")"
  if command -v curl >/dev/null 2>&1; then
    if curl --globoff -L --fail --silent "$asset_url" -o "$tmp/$asset_path"; then
      return 0
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget --quiet -O "$tmp/$asset_path" "$asset_url"; then
      return 0
    fi
  else
    die "need wget or curl to complete the published static asset set"
  fi

  rm -f "$tmp/$asset_path"
  printf '%s\n' "$asset_path" >>"$missing_assets"
  log "Warning: missing published asset: $asset_url"
  return 1
}

complete_public_web_app_assets() {
  local tmp="$1"
  local pass source source_path ref asset_path downloaded

  log "Completing published static asset set"

  pass=1
  while [ "$pass" -le 8 ]; do
    downloaded=0
    while IFS= read -r -d '' source; do
      source_path="${source#$tmp/}"
      while IFS= read -r ref; do
        asset_path="$(resolve_public_asset_ref "$tmp" "$source_path" "$ref" || true)"
        [ -n "$asset_path" ] || continue
        if download_public_asset_path "$tmp" "$asset_path"; then
          downloaded=1
        fi
      done < <(extract_public_asset_refs "$source")
    done < <(find "$tmp" -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \) -print0)

    [ "$downloaded" -eq 1 ] || break
    pass=$((pass + 1))
  done

  rm -f "$tmp/.public-missing-assets"
}

write_web_runner_and_unit() {
  log "Writing Auditable Voting FIPS web service"
  mkdir -p /etc/auditable-voting "$STATE_DIR"

  cat >/etc/auditable-voting/fips-web.env <<EOF
FIPS_IFACE=$FIPS_IFACE
WEB_ROOT=$WEB_ROOT
WEB_PORT=$WEB_PORT
EOF
  chmod 0644 /etc/auditable-voting/fips-web.env

  cat >/usr/local/bin/auditable-voting-fips-web <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

FIPS_IFACE="${FIPS_IFACE:-fips0}"
WEB_ROOT="${WEB_ROOT:-/var/lib/auditable-voting-fips/site}"
WEB_PORT="${WEB_PORT:-8080}"

if [ ! -f "$WEB_ROOT/index.html" ]; then
  echo "Missing web root: $WEB_ROOT/index.html" >&2
  exit 1
fi

FIPS0_ADDR=""
for _ in $(seq 1 60); do
  FIPS0_ADDR="$(ip -6 -o addr show dev "$FIPS_IFACE" scope global 2>/dev/null | awk '$4 ~ /^fd/ { split($4, parts, "/"); print parts[1]; exit }')"
  if [ -n "$FIPS0_ADDR" ]; then
    break
  fi
  sleep 1
done

if [ -z "$FIPS0_ADDR" ]; then
  echo "No fd00::/8 address found on $FIPS_IFACE" >&2
  exit 1
fi

echo "Serving $WEB_ROOT on http://[$FIPS0_ADDR]:$WEB_PORT/"
exec python3 -m http.server "$WEB_PORT" --bind "$FIPS0_ADDR" --directory "$WEB_ROOT"
EOF
  chmod 0755 /usr/local/bin/auditable-voting-fips-web

  cat >/etc/systemd/system/auditable-voting-fips-web.service <<EOF
[Unit]
Description=Auditable Voting static site over FIPS
After=fips.service network-online.target
Requires=fips.service

[Service]
Type=simple
EnvironmentFile=/etc/auditable-voting/fips-web.env
ExecStart=/usr/local/bin/auditable-voting-fips-web
Restart=on-failure
RestartSec=5
User=root
WorkingDirectory=$STATE_DIR
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
}

worker_asset_for_host() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64)
      printf 'auditable-voting-worker-linux-x64.tar.gz auditable-voting-worker-linux-x64\n'
      ;;
    aarch64|arm64)
      printf 'auditable-voting-worker-linux-arm64.tar.gz auditable-voting-worker-linux-arm64\n'
      ;;
    armv7l|armv7*)
      printf 'auditable-voting-worker-linux-armv7.tar.gz auditable-voting-worker-linux-armv7\n'
      ;;
    *)
      die "unsupported Linux architecture for prebuilt audit proxy: $machine"
      ;;
  esac
}

download_file() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail "$url" -o "$dest"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "$url"
    return
  fi
  die "need curl or wget to download $url"
}

install_proxy_service() {
  local asset binary release_base proxy_dir archive
  read -r asset binary < <(worker_asset_for_host)
  release_base="${WORKER_RELEASE_BASE_URL:-https://github.com/tidley/auditable-voting/releases/latest/download}"
  proxy_dir="$INSTALL_PREFIX/worker"
  archive="$proxy_dir/$asset"

  log "Installing optional audit-proxy service"
  mkdir -p "$proxy_dir" /var/lib/auditable-voting-worker /etc/auditable-voting
  download_file "$release_base/$asset" "$archive"
  tar -xzf "$archive" -C "$proxy_dir"
  chmod +x "$proxy_dir/$binary"

  if [ ! -f /etc/auditable-voting/worker.env ]; then
    cat >/etc/auditable-voting/worker.env <<EOF
RUST_LOG=debug
WORKER_NSEC=${WORKER_NSEC:-nsec1...}
COORDINATOR_NPUB=${COORDINATOR_NPUB:-npub1...}
WORKER_RELAYS=${WORKER_RELAYS:-wss://relay.nostr.net,wss://nos.lol}
WORKER_STATE_DIR=/var/lib/auditable-voting-worker
WORKER_HEARTBEAT_SECONDS=${WORKER_HEARTBEAT_SECONDS:-30}
WORKER_POLL_SECONDS=${WORKER_POLL_SECONDS:-15}
EOF
    chmod 0600 /etc/auditable-voting/worker.env
  fi

  cat >/etc/systemd/system/auditable-voting-worker.service <<EOF
[Unit]
Description=Auditable Voting audit proxy
After=network-online.target fips.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/auditable-voting/worker.env
ExecStartPre=/bin/sh -c 'test "\$WORKER_NSEC" != "nsec1..." && test "\$COORDINATOR_NPUB" != "npub1..."'
ExecStart=$proxy_dir/$binary
Restart=on-failure
RestartSec=10
StateDirectory=auditable-voting-worker
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  if [ "$ENABLE_PROXY" -eq 1 ]; then
    systemctl daemon-reload
    systemctl enable --now auditable-voting-worker.service
  else
    log "Audit-proxy service installed but left disabled"
    printf 'Edit /etc/auditable-voting/worker.env, then run:\n'
    printf '  sudo systemctl enable --now auditable-voting-worker.service\n'
  fi
}

start_services() {
  if [ "$START_SERVICES" -ne 1 ]; then
    log "Service start skipped"
    return
  fi

  log "Starting services"
  systemctl daemon-reload
  if [ "$PRESERVE_FIPS_SERVICE" -eq 1 ]; then
    if ! systemctl is-active --quiet fips.service; then
      systemctl start fips.service
    fi
  else
    systemctl enable --now fips.service
  fi
  if [ "$PRESERVE_FIPS_FIREWALL" -eq 1 ]; then
    if systemctl is-active --quiet fips-firewall.service; then
      systemctl restart fips-firewall.service
    else
      log "fips-firewall.service is not active; leaving existing firewall state unchanged"
    fi
  else
    systemctl enable --now fips-firewall.service
  fi

  systemctl enable --now auditable-voting-fips-web.service
}

print_summary() {
  local npub fips_addr
  npub=""
  fips_addr=""

  if [ -f /etc/fips/fips.pub ]; then
    npub="$(tr -d '[:space:]' </etc/fips/fips.pub || true)"
  fi
  if [ -z "$npub" ] && [ -n "$FIPSCTL_BIN_PATH" ]; then
    npub="$("$FIPSCTL_BIN_PATH" show status 2>/dev/null | sed -n 's/.*"npub"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
  fi

  fips_addr="$(ip -6 -o addr show dev "$FIPS_IFACE" scope global 2>/dev/null | awk '$4 ~ /^fd/ { split($4, parts, "/"); print parts[1]; exit }' || true)"

  log "Done"
  if [ -n "$npub" ]; then
    printf 'FIPS npub: %s\n' "$npub"
    printf 'FIPS URL:  http://%s.fips:%s/\n' "$npub" "$WEB_PORT"
  else
    printf 'FIPS npub not visible yet. Check: sudo journalctl -u fips -e\n'
  fi
  if [ -n "$fips_addr" ]; then
    printf 'Direct mesh URL: http://[%s]:%s/\n' "$fips_addr" "$WEB_PORT"
  fi
  printf 'Public web equivalents remain:\n'
  printf '  https://tidley.github.io/auditable-voting/\n'
  printf '  https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/\n'
}

install_fips_from_source
write_fips_config
write_fips_units
build_web_app
write_web_runner_and_unit

if [ "$WITH_PROXY" -eq 1 ]; then
  install_proxy_service
fi

start_services
print_summary
