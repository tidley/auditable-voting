# Voter Client Integration Guide

This guide describes what your voter client needs to do to obtain a Cashu proof from the TollGate voting coordinator. The coordinator runs as a daemon on the VPS that listens for kind 38010 Nostr events and auto-approves eligible voters' mint quotes via gRPC. Voters run their own client software on their own machines.

## Where Things Run

| Component | Machine | Network |
|---|---|---|
| Mint (CDK 0.15.1) | VPS (`23.182.128.64`) | Public HTTP API |
| Coordinator daemon | VPS (`23.182.128.64`) | Connects to relays internally |
| Nak relay | VPS (`23.182.128.64`) | WebSocket (public) |
| Damus relay | Public internet | WebSocket (public, always available) |
| Voter client | Voter's own machine | HTTP to mint, Nostr to relay |

**Important:** Your voter client only needs to reach two things over the internet:
1. The mint HTTP API at `http://23.182.128.64:3338`
2. A Nostr relay (damus.io is the default and always works)

## Discovering the Coordinator npub

The coordinator's npub is embedded in the mint's `/v1/info` response. Before publishing a kind 38010 event, fetch it:

```
GET http://23.182.128.64:3338/v1/info
```

```json
{
  "name": "Local Mint mint1",
  "pubkey": "02d86f4072929cd61a7d3f77878795686a47d6dece105ca848f555677bfc04e930",
  "description": "Local Cashu mint mint1 | coordinator: npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh",
  ...
}
```

Parse the `description` field to extract the coordinator npub (the value after `"coordinator: "`). Use this as the `p` tag in your kind 38010 event.

> **Note:** If the `description` field does not contain `"coordinator:"`, this deployment step has not been completed yet.

## Endpoints

| Service | URL | Protocol | From |
|---|---|---|---|
| Mint HTTP API | `http://23.182.128.64:3338` | HTTP REST | Anywhere |
| Mint info | `http://23.182.128.64:3338/v1/info` | HTTP GET | Anywhere |
| Nak relay | `ws://23.182.128.64:10547` | WebSocket | Anywhere (public, iptables allows) |
| Damus relay | `wss://relay.damus.io` | WebSocket | Anywhere |
| nos.lol relay | `wss://nos.lol` | WebSocket | Anywhere |
| Primal relay | `wss://relay.primal.net` | WebSocket | Anywhere |

**Recommendation:** Use `wss://relay.damus.io` for publishing kind 38010 events. The nak relay (`ws://23.182.128.64:10547`) is also publicly accessible and is the coordinator's primary relay for state storage.

## Issuance Flow

### Step 1: Create a Mint Quote

```
POST http://23.182.128.64:3338/v1/mint/quote/bolt11
Content-Type: application/json

{"amount": 1, "unit": "sat"}
```

Response (HTTP 200):

```json
{
  "quote": "<quote_id>",
  "request": "<bolt11_invoice>",
  "state": "UNPAID",
  "amount": 1,
  "unit": "sat",
  "expiry": 1800000
}
```

**Important:** The response field is `quote` (not `quote_id`). The response status is 200 (not 201). The state is uppercase `UNPAID`.

### Step 2: Discover the Coordinator npub

```
GET http://23.182.128.64:3338/v1/info
```

Parse the `description` field to extract the coordinator npub:
```
description: "Local Cashu mint mint1 | coordinator: npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh"
                                                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

### Step 3: Publish a Kind 38010 Nostr Event

Your client must publish a **kind 38010** event with these tags:

| Tag | Value | Required |
|---|---|---|
| `p` | The npub from Step 2 | **Yes** — enables relay-side filtering so only the coordinator sees your event |
| `quote` | The `quote` value from Step 1 | **Yes** |
| `amount` | `"1"` | **Yes** — must be exactly `"1"` (string) |
| `mint` | `http://23.182.128.64:3338` | **Yes** — must match the coordinator's configured mint URL exactly |
| `election` | Your election ID | **Yes** |

Event content can be empty or a human-readable description. Example:

```json
{
  "kind": 38010,
  "created_at": 1700000000,
  "tags": [
    ["p", "npub1mph5qu5jnntp5lflw7rc09tgdfradhkwzpw2sj8424nhhlqyaycq76v6uh"],
    ["quote", "abc123-def456"],
    ["amount", "1"],
    ["mint", "http://23.182.128.64:3338"],
    ["election", "election-2026-demo"]
  ],
  "content": "Requesting 1 sat proof for election-2026-demo"
}
```

### Step 4: Poll Quote Status

```
GET http://23.182.128.64:3338/v1/mint/quote/bolt11/<quote_id>
```

Poll with exponential backoff (e.g., 1s, 2s, 4s, 8s...) until the state changes to `PAID`. Timeout after 5 minutes.

```json
{
  "quote": "<quote_id>",
  "state": "PAID",
  "amount": 1,
  "unit": "sat"
}
```

### Step 5: Mint Tokens (Build Blinded Outputs → POST → Unblind)

**5a. Get the mint's public keys:**

```
GET http://23.182.128.64:3338/v1/keys
```

**5b. Get the active keyset ID:**

```
GET http://23.182.128.64:3338/v1/keysets
```

Use the `id` of the keyset where `unit == "sat"` and `active == true`. **Note:** CDK 0.15.1 keyset IDs are 66 characters (2-char prefix + 64-char hex), not 64.

**5c. Build blinded outputs** using the Cashu library — 1 output for 1 sat.

**5d. Post to the mint endpoint:**

```
POST http://23.182.128.64:3338/v1/mint/bolt11
Content-Type: application/json

{
  "quote": "<quote_id>",
  "outputs": ["<blinded_output_1>"]
}
```

**5e. Unblind the returned signatures** to get your proofs.

## Coordinator Validation Rules

The coordinator will **only** approve a quote if ALL of these conditions are met:

1. The event's pubkey is in the eligible voters list
2. The pubkey has NOT already received a proof (1 proof per voter)
3. The `amount` tag is exactly `"1"`
4. The `mint` tag matches the coordinator's configured mint URL (`http://23.182.128.64:3338`)
5. The `quote` tag contains a valid, existing quote ID
6. The quote is in `UNPAID` state on the mint

If any condition fails, the coordinator logs the reason and skips the event. There is no error response sent back to the voter — your client must detect this via the poll timeout in Step 4.

## Important Details

### State Strings are Uppercase

The CDK 0.15.1 mint returns uppercase state strings: `"UNPAID"`, `"PAID"`, `"ISSUED"`. Do not compare against lowercase.

### Quote Field Name

The mint response uses the field name `quote` (not `quote_id`). Use `quote` consistently.

### One Proof Per Voter

The coordinator tracks issued voters via kind 38011 events on Nostr. Each npub can only receive one proof. Subsequent requests from the same npub are silently skipped. On restart, the coordinator reconstructs the issued set from the relay.

### No Response Event

The coordinator does **not** publish a response event for issuance. The voter discovers approval by polling the mint quote status.

### Coordinator npub is Derived from Mint Mnemonic

The coordinator's Nostr identity (nsec/npub) is deterministically derived from the mint's BIP39 mnemonic via `scripts/derive-coordinator-keys.py`. This means the coordinator's identity is stable and reproducible — if the mnemonic doesn't change, the npub won't change.

## Coordinator HTTP API

The coordinator exposes an HTTP API for convenience queries. These endpoints serve discovery and preview data only. All authoritative trust anchors remain on Nostr as signed events.

| Endpoint | Description | Trust Level |
|---|---|---|
| `GET /info` | Coordinator metadata, relay list, mint URL | Informational |
| `GET /election` | Cached kind 38008 (questions, timing, mints) | Cache (verify on Nostr) |
| `GET /tally` | Live vote counts + spent commitment Merkle root | Unofficial |
| `GET /eligibility` | Cached kind 38009 (eligible npubs) | Cache (verify on Nostr) |

**Base URL:** `http://23.182.128.64:8081`

### GET /info

```
GET http://23.182.128.64:8081/info
```

Returns coordinator metadata including the coordinator npub, mint URL, and relay list.

### GET /election

```
GET http://23.182.128.64:8081/election
```

Returns the cached kind 38008 election announcement (questions, timing, mint URLs). Each response includes a `_trust` field with Nostr verification instructions.

### GET /tally

```
GET http://23.182.128.64:8081/tally
```

Returns live intermediate vote counts:
- `total_published_votes` — ALL kind 38000 events (unverified)
- `total_accepted_votes` — only votes with a kind 38002 receipt (proof burned)
- `spent_commitment_root` — current Merkle root of burned proof commitments
- `results` — per-question counts

**Important:** This is NOT the final tally. The final authoritative tally is published as kind 38003 by the coordinator after the election closes. The `_trust` field in each response explains how to verify on Nostr.

### GET /eligibility

```
GET http://23.182.128.64:8081/eligibility
```

Returns the cached kind 38009 eligibility set (list of eligible npubs).

## Proof Submission (NIP-04 Encrypted DM)

After publishing a vote (kind 38000) with an ephemeral npub, the voter sends the full Cashu proof to the coordinator via encrypted NIP-04 DM.

**Recipient:** coordinator's npub (from `GET /info` or election announcement)

**DM content (JSON string):**

```json
{
  "vote_event_id": "<kind 38000 event ID>",
  "proof": "<serialized Cashu proof>"
}
```

The coordinator:
1. Decrypts the DM (NIP-04)
2. Verifies the kind 38000 event exists on the relay
3. Submits the proof to the mint: `POST /v1/melt/bolt11`
4. On success: publishes kind 38002 (acceptance receipt), updates spent commitment Merkle tree
5. On failure: logs rejection, no Nostr event published

**No response DM is sent back.** The voter discovers acceptance by checking `/tally` or watching for kind 38002 events from the coordinator's npub.

## Nostr-Only Data (Not Available Over HTTP)

| Data | Event Kind | Actor | Why Nostr-Only |
|---|---|---|---|
| Final tally + Merkle root | 38003 | Coordinator | Signed trust anchor — must be independently verifiable |
| Inclusion proofs | -- | Coordinator | Computed from signed event data |
| Issuance commitment root | 38005 | Coordinator | Prevents coordinator from inflating eligibility |
| Spent commitment root (final) | 38006 | Coordinator | Prevents phantom votes |

## Troubleshooting

| Symptom | Likely Cause |
|---|---|
| Quote stays `UNPAID` forever | Voter not in eligible list, `p` tag wrong, `mint` tag mismatch, or `amount` not `"1"` |
| Quote stays `UNPAID` but voter is eligible | Coordinator daemon not running, or not connected to the relay you published to |
| Mint returns 404 for quote | Quote expired (default 30 min TTL) or wrong quote ID |
| Mint returns error on `/v1/mint/bolt11` | Quote not yet `PAID`, or blinded output format is wrong |
| `/v1/info` has no coordinator npub | Deployment step not yet completed |
| Nak relay connection times out | Port 10547 blocked by firewall or nak not running |

## Contact

For questions about the coordinator's behavior, check `docs/VOTING_EVENT_INTEROP_NOTES.md` in the repository or reach out to the TollGate team.
