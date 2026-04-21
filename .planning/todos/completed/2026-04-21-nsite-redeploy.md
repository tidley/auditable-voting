# NSite redeploy notes

Date: 2026-04-21

Goal: allow repeat `nsite` deploys with the same credentials.

## Local credential file

- path: `.secrets/nsite.env`
- mode: `600`
- directory mode: `.secrets` -> `700`
- contains:
  - `NSEC=<deploy private key>`
  - `NPUB=<deploy public key>`

Do not commit this file.

## Build + publish command

```bash
npm --prefix web run build
set -a && source .secrets/nsite.env && set +a
npx --yes nsite-cli upload web/dist \
  -k "$NSEC" \
  --servers "https://nostr.download,https://media-server.slidestr.net,https://blossom.primal.net" \
  --relays "wss://nos.lol,wss://relay.primal.net,wss://relay.damus.io,wss://offchain.pub,wss://nostr.mom" \
  --publish-server-list \
  --publish-relay-list \
  --publish-profile \
  -v
```

## Current deploy identity

- `NPUB=npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a`
- gateway URL:
  - `https://npub1hkze8k84da0qm4lu75x32z33qepyzdqc735jnj5a602x8q4cstksnkvl3a.nsite.lol`
