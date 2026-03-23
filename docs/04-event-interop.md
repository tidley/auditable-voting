# Voting Protocol Event Specs

> **Source of truth:** This repo (`tg-mint-orchestrator/docs/`) is the canonical location for all protocol specifications. The copy in `../auditable-voting/docs/` is outdated and should not be referenced.

Notes for the voter-facing client collaborator on event shapes for kinds 38008, 38010, and 38000.

---

# Kind 38010 Event Interop Notes

## Current Event Shape (from your mock)

```
kind: 38010
content: "{\"action\":\"cashu_invoice_claim\",\"quote_id\":\"...\",\"invoice\":\"...\",\"npub\":\"...\"}"
tags:
  - ["t", "cashu-issuance"]
  - ["quote", "<quote_id>"]
  - ["invoice", "<bolt11_invoice>"]
  - ["mint", "<mint_url>"]
  - ["amount", "1"]
```

## Requested Additions (2 tags)

### 1. Add a `p` tag with the coordinator's npub

```
  - ["p", "<coordinator_npub>"]
```

**Why:** The coordinator subscribes to the relay with a filter like `Kind(38010)` + `Tag(["p", "<my_npub>"])`. This tells the relay to only send events where the coordinator is the intended recipient. Without this tag, the relay would have to send every kind 38010 event from every user to the coordinator, and the coordinator would have to inspect each one client-side to decide if it's relevant. With the `p` tag, the relay does this filtering server-side -- much more efficient, and it's the standard Nostr pattern for directed events (same mechanism NIP-04 encrypted DMs and NIP-57 zaps use to address recipients).

### 2. Add an `election` tag with the election ID

```
  - ["election", "<election_id>"]
```

**Why:** The coordinator may manage multiple elections over time. The `quote_id` alone doesn't tell the coordinator which election a request belongs to. With an `election` tag, the coordinator can verify the request targets the current active election and reject stale or mismatched requests. This also helps with auditability -- election-scoped events are easier to reason about.

## Resulting Event Shape

```
kind: 38010
content: "{\"action\":\"cashu_invoice_claim\",\"quote_id\":\"...\",\"invoice\":\"...\",\"npub\":\"...\"}"
tags:
  - ["p", "<coordinator_npub>"]      <-- new
  - ["t", "cashu-issuance"]
  - ["quote", "<quote_id>"]
  - ["invoice", "<bolt11_invoice>"]
  - ["mint", "<mint_url>"]
  - ["amount", "1"]
  - ["election", "<election_id>"]    <-- new
```

Everything else in your current event shape we're adopting as-is on our side. These are the only two additions we need.

---

# Kind 38008 — Election Announcement

The coordinator publishes this event to announce an election: its questions, candidates, timing, and which mints to use. The event's own ID (`<hex_event_id>`) **is** the election ID — voters compute it after receiving the event and use it as `["election", "<id>"]` in their 38010 issuance requests and 38000 vote events.

## Event Shape

```
kind: 38008
pubkey: <coordinator_npub>
content: {
  "title": "Community Governance Poll 2026",
  "description": "Annual governance election",
  "questions": [
    {
      "id": "q1",
      "type": "choice",
      "prompt": "Who should fill the open board seat?",
      "options": ["Alice", "Bob", "Carol"],
      "select": "single"
    },
    {
      "id": "q2",
      "type": "choice",
      "prompt": "Which initiatives should we fund?",
      "options": ["Lightning dev", "Privacy research", "Events"],
      "select": "multiple"
    },
    {
      "id": "q3",
      "type": "scale",
      "prompt": "Rate the current board performance",
      "min": 1,
      "max": 10,
      "step": 1
    },
    {
      "id": "q4",
      "type": "text",
      "prompt": "Any additional comments?",
      "max_length": 500
    }
  ],
  "start_time": 1710000000,
  "end_time": 1710003600
}
tags:
  - ["t", "election-announcement"]
  - ["mint", "<mint_url_1>"]
  - ["mint", "<mint_url_2>"]
  - ["mint", "<mint_url_3>"]
```

## Question Types

| Type | Required Fields | Optional Fields | Description |
|------|----------------|-----------------|-------------|
| `choice` | `options[]`, `select` | — | Multiple choice. `select`: `"single"` or `"multiple"`. |
| `scale` | `min`, `max` | `step` (default 1) | Numeric rating. `step=0.1` for decimals. |
| `text` | — | `max_length` | Free-form string response. |

Every question has `id` (unique within the election) and `prompt` (display text).

## Vote Response Format (Kind 38000)

Voters reference question IDs in their vote event:

```
kind: 38000
content: {
  "election_id": "<38008_event_id>",
  "responses": [
    {"question_id": "q1", "value": "Alice"},
    {"question_id": "q2", "values": ["Lightning dev", "Privacy research"]},
    {"question_id": "q3", "value": 7},
    {"question_id": "q4", "value": "Great work overall!"}
  ],
  "timestamp": 1710000000
}
tags:
  - ["election", "<election_id>"]
```

| Question Type | Response Field | Value |
|--------------|---------------|-------|
| `choice` (single) | `"value"` | Selected option string |
| `choice` (multiple) | `"values"` | Array of selected option strings |
| `scale` | `"value"` | Number (integer or float per `step`) |
| `text` | `"value"` | String (within `max_length` if specified) |

## Discovery

Voters filter `Kind(38008)` from the coordinator's pubkey. The `["t", "election-announcement"]` tag enables NIP-12 topic-based discovery as well. The `mint` tags tell voters which mints to request proofs from for this election.
