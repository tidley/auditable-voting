# Integrations

## Nostr
- The system uses Nostr relays for election announcements, claims, vote events, proofs, and receipts.
- Browser and Python code both use `nostr-tools` or `nostr-sdk` to publish and query events.
- The coordinator subscribes to event kinds such as 38000, 38002, 38003, 38007, 38008, 38009, 38010, 38011, and NIP-04 direct messages.
- The frontend discovers elections and coordinators from relay events rather than hardcoding a single election record.

## Cashu Mint
- Voters request a mint quote, wait for approval, and then mint blinded proofs from the Cashu mint.
- The frontend talks to the mint through `web/src/mintApi.ts` and `web/src/cashuBlind.ts`.
- The coordinator talks to the mint over HTTP and gRPC, including quote approval through the CDK mint RPC.
- The public mint URL exposed to voters can differ from the internal mint URL used by the coordinator.

## Coordinator HTTP API
- The frontend reads coordinator state from `/info`, `/election`, `/eligibility`, `/tally`, `/issuance-status`, `/result`, `/inclusion_proof`, `/vote_tree`, and `/close`.
- Dashboard and voter flows use the HTTP API to render election state, tally state, and proof status.
- The coordinator is also responsible for publishing election and tally commitment events back to Nostr.

## Frontend And Browser Integrations
- The browser supports raw `nsec` entry and NIP-07 signer detection.
- The portal writes wallet state to `localStorage` through `cashuWallet.ts`.
- Ballots, DMs, and proof submissions are all browser-side integrations with relays and the coordinator.
- Playwright-based UI tests exercise the live portal, voting page, and dashboard.

## Deployment And Infra
- Ansible provisions Traefik, the coordinator, mint containers, and the voting client container.
- The live deployment is routed through a public Traefik host and a single voting-client origin.
- VPS tests and fixtures SSH into the production host and can mutate coordinator eligibility state.

