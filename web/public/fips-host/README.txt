Auditable Voting FIPS host launcher
===================================

This directory is copied into the static site so the launcher is available from
GitHub Pages, nsite, and any FIPS-hosted mirror of the app.

Launcher:

  ./launch-auditable-voting-fips.sh

What it does on a Linux/systemd host:

- builds the latest upstream FIPS Rust daemon from https://github.com/jmcorgan/fips;
- writes a persistent FIPS config with Nostr overlay discovery enabled;
- advertises the node as a FIPS endpoint using the current FIPS
  `fips-overlay-v1` Nostr advert path;
- builds Auditable Voting from https://github.com/tidley/auditable-voting;
- serves the static app on the node's `fips0` address;
- opens only the configured web port through the FIPS mesh firewall;
- optionally installs an audit-proxy systemd service.

Basic run:

  curl -L https://tidley.github.io/auditable-voting/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
  chmod +x launch-auditable-voting-fips.sh
  sudo ./launch-auditable-voting-fips.sh

From nsite:

  curl -L https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/fips-host/launch-auditable-voting-fips.sh -o launch-auditable-voting-fips.sh
  chmod +x launch-auditable-voting-fips.sh
  sudo ./launch-auditable-voting-fips.sh

Optional proxy service:

  sudo WORKER_NSEC="nsec1..." \
    COORDINATOR_NPUB="npub1..." \
    ./launch-auditable-voting-fips.sh --with-proxy --enable-proxy

Reuse an existing packaged FIPS install, such as a Raspberry Pi already running
`/usr/bin/fips` from `fips.service`:

  sudo ./launch-auditable-voting-fips.sh --reuse-running-fips

That mode does not rebuild FIPS, does not require npm, does not replace
`/etc/fips/fips.yaml`, and does not replace the existing `fips.service` or
install a new FIPS firewall service. It installs the already-published static
site from `PUBLIC_SITE_URL`, writes the web service, and adds the FIPS firewall
drop-in for the web port. If `fips-firewall.service` is already active, it is
restarted so the drop-in is loaded; otherwise the existing firewall state is
left alone.

When npm is available, the launcher builds Vite and installs the complete
`web/dist/` tree as one static web root. When reusing a published build, it
recursively downloads every referenced Vite asset, including dynamic JS chunks
and WASM files, before replacing the live web root. This avoids stale or partial
asset sets where browser module imports receive HTML fallback pages.

To serve under a path prefix instead of the FIPS site root, build from source
and set the Vite base path:

  sudo WEB_BASE_PATH=/auditable-voting/ ./launch-auditable-voting-fips.sh

By default the launcher advertises UDP as `udp:nat`, using FIPS' Nostr/STUN
handoff flow. For a host with a stable public UDP endpoint:

  sudo FIPS_PUBLIC_UDP=1 FIPS_EXTERNAL_ADDR="203.0.113.45:2121" \
    ./launch-auditable-voting-fips.sh

After install, other FIPS nodes can reach the site at:

  http://<fips-node-npub>.fips:8080/

The public web equivalents remain:

  https://tidley.github.io/auditable-voting/
  https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol/

Requirements:

- Linux with systemd;
- git, cargo/Rust, npm/node, python3, nftables, iproute2;
- root access for TUN, nftables, and systemd unit installation.

The script backs up an existing `/etc/fips/fips.yaml` before replacing it.
