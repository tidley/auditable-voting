# Coordinator Integration Plan

Integrate the auditable-voting frontend with the tg-mint-orchestrator vote
coordinator. The local mock server (`voterServer.ts`) is retained behind a
`VITE_USE_MOCK` flag for offline development.

Reference docs (tg-mint-orchestrator):

- `docs/VOTER_CLIENT_INTEGRATION_GUIDE.md`
- `docs/04-VOTING_EVENT_INTEROP_NOTES.md`
- `docs/12-COORDINATOR_HTTP_API_PLAN.md`

---

## 1. Architecture Overview

### Current (mock)

```
Browser  --GET /mock-mint/invoice-->  local voterServer (8787)
Browser  --GET /mock-mint/proof/-->  local voterServer (8787)
Browser  --GET /api/eligibility/-->  local voterServer (8787)
Browser  --publish kind 38010-->     Nostr relays (no listener)
```

### Target (production)

All voter traffic goes through the nginx reverse proxy on the voting FQDN.
The voter only needs to know one public URL. The coordinator and mint are never
exposed directly to voters.

```
Voter (anywhere on internet)
  |
  |  https://vote.mints.23.182.128.64.sslip.io/
  v
nginx (voting-client container, port 80)
  |
  |  /api/*   -->  coordinator:8081  (internal)
  |  /mint/*  -->  mint:3338         (internal)
  |  /*       -->  static HTML/JS
  v
Coordinator returns public mintUrl (http://23.182.128.64:3338) in /info
for use by non-web clients. The web frontend uses /mint/* proxy path.

Flow:
  Browser  --GET  /api/info----------->  discover coordinatorNpub, relays, mintUrl
  Browser  --GET  /api/election------->  election questions + metadata
  Browser  --GET  /api/eligibility---->  eligible npub list
  Browser  --POST /mint/v1/mint/quote/-->  create mint quote
  Browser  --GET  /mint/v1/mint/quote/-->  poll quote status
  Browser  --GET  /mint/v1/keys-------->  mint public keys
  Browser  --GET  /mint/v1/keysets----->  active keyset ID
  Browser  --POST /mint/v1/mint/bolt11-->  mint blinded tokens
  Browser  --publish kind 38010-------->  Nostr relays --> coordinator auto-approves
  Browser  --publish kind 38000-------->  Nostr relays (public vote)
  Browser  --NIP-04 DM (kind 4)------->  Nostr relays --> coordinator burns proof
  Browser  --GET  /api/tally---------->  check vote acceptance
```

### Dev mode (`VITE_USE_MOCK=true`)

All routes continue to proxy through `localhost:8787` to the existing
`voterServer.ts`. No coordinator or mint calls are made.

---

## 2. Configuration

### 2.1 New file: `.env.example`

```env
VITE_USE_MOCK=false
VITE_COORDINATOR_URL=http://23.182.128.64:8081
VITE_MINT_URL=http://23.182.128.64:3338
```

When `VITE_USE_MOCK=true`, every API module falls back to its current
mock paths and types. When `false`, the modules call the real endpoints.

### 2.2 New file: `web/src/config.ts`

```typescript
export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const COORDINATOR_URL = USE_MOCK
  ? "http://localhost:8787"
  : (import.meta.env.VITE_COORDINATOR_URL as string) || "http://23.182.128.64:8081";
export const MINT_URL = USE_MOCK
  ? "http://localhost:8787/mock-mint"
  : (import.meta.env.VITE_MINT_URL as string) || "http://23.182.128.64:3338";
```

When deployed behind nginx (see 5.9.2), `COORDINATOR_URL` and `MINT_URL`
become relative paths (`"/api"` and `"/mint"`), since nginx handles routing
to the correct backend services.

All modules import from `config.ts` rather than hardcoding URLs.

### 2.3 `web/vite.config.ts`

Add `envPrefix: "VITE_"` (Vite default, but explicit). No other change
needed -- Vite automatically injects `VITE_*` variables at build time.

---

## 3. New Dependency

### `web/package.json`

Add `@cashu/cashu-ts` for blinded token construction and proof handling:

```json
"@cashu/cashu-ts": "^3.6.0"
```

This library provides:

- `CashuWallet` class with `createMintQuote()`, `mintProofs()`, `createBlankOutputs()` methods
- `getEncodedToken()` -- serialize proofs for DM submission
- `getDecodedToken()` -- parse serialized proofs

---

## 4. New Files

### 4.1 `web/src/coordinatorApi.ts`

Client for the coordinator HTTP API (port 8081). All functions gated on
`USE_MOCK`.

| Function | Real endpoint | Mock fallback |
|---|---|---|
| `fetchCoordinatorInfo()` | `GET /info` | Returns mock `coordinatorNpub`, `mintUrl`, relays |
| `fetchElection()` | `GET /election` | Returns mock election from `voterServer` |
| `fetchEligibility()` | `GET /eligibility` | Returns `GET /api/eligibility` from local server |
| `fetchTally()` | `GET /tally` | Returns empty mock tally |

Types to define:

```typescript
type CoordinatorInfo = {
  coordinatorNpub: string;
  mintUrl: string;
  mintPublicKey: string;
  relays: string[];
  electionId: string | null;
};

type ElectionInfo = {
  election_id: string;
  event_id: string;
  title: string;
  description: string;
  questions: ElectionQuestion[];
  start_time: number;
  end_time: number;
  mint_urls: string[];
};

type ElectionQuestion = {
  id: string;
  type: "choice" | "scale" | "text";
  prompt: string;
  options?: string[];
  select?: "single" | "multiple";
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
};

type EligibilityInfo = {
  election_id: string;
  eligible_count: number;
  eligible_npubs: string[];
};

type TallyInfo = {
  election_id: string;
  status: "in_progress" | "closed";
  total_published_votes: number;
  total_accepted_votes: number | null;
  spent_commitment_root: string | null;
  results: Record<string, Record<string, number>>;
};
```

### 4.2 `web/src/mintApi.ts`

Client for the real CDK Cashu mint API (port 3338). All functions gated on
`USE_MOCK`.

| Function | Real endpoint | Mock fallback |
|---|---|---|
| `createMintQuote()` | `POST /v1/mint/quote/bolt11` body `{"amount":1,"unit":"sat"}` | `GET /mock-mint/invoice` |
| `checkQuoteStatus(quote)` | `GET /v1/mint/quote/bolt11/{quote}` | `GET /mock-mint/proof/{quoteId}` |
| `getMintKeys()` | `GET /v1/keys` | Returns mock keys |
| `getMintKeysets()` | `GET /v1/keysets` | Returns mock keyset |
| `mintTokens(quote, outputs)` | `POST /v1/mint/bolt11` body `{"quote":"...","outputs":[...]}` | Returns mock proof |

Types to define:

```typescript
type MintQuoteResponse = {
  quote: string;
  request: string;       // bolt11 invoice
  state: "UNPAID" | "PAID" | "ISSUED";
  amount: number;
  unit: string;
  expiry: number;        // ms
};

type MintQuoteStatusResponse = {
  quote: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  amount: number;
  unit: string;
};

type MintKeysetResponse = {
  id: string;            // 66 chars in CDK 0.15.1
  unit: string;
  active: boolean;
  // ...
};

type MintTokensResponse = {
  signatures: string[];  // blinded signatures
};
```

### 4.3 `web/src/cashuBlind.ts`

Wraps `@cashu/cashu-ts` for the quote creation and blinded token minting.
Keeps Cashu library usage isolated to one file. The `CashuWallet.mintProofs()`
method returns proper `Proof` objects with unblinded `C` signatures and DLEQ
proofs (including the blinding factor `r`).

```typescript
import { CashuWallet, getEncodedToken } from "@cashu/cashu-ts";

type CashuProof = {
  id: string;     // keyset ID
  amount: number;
  secret: string;  // blinding secret
  C: string;       // UNBLINDED signature (not C_)
  dleq?: { e: string; s: string; r?: string };
};

type MintResult = {
  proofs: CashuProof[];
  quote: string;
  serializedToken?: string;
};

async function requestQuoteAndMint(mintUrl: string): Promise<MintResult>;
```

**Important:** The `Proof` objects returned by `mintProofs()` already contain the
unblinded `C` field and a `dleq` with `{e, s, r}`. These should be passed directly
to `submitProofViaDm()` as nested JSON objects -- not double-encoded as strings.

### 4.4 `web/src/proofSubmission.ts`

NIP-04 encrypted DM sender. After publishing the vote event (kind 38000),
sends the Cashu proof (as a nested JSON object, not a double-encoded string)
to the coordinator.

```typescript
import { nip04 } from "nostr-tools";
import type { CashuProof } from "./cashuBlind";

async function submitProofViaDm(input: {
  voterSecretKey: Uint8Array;        // ephemeral key from ballot.ts
  coordinatorNpub: string;
  voteEventId: string;
  proof: CashuProof;                  // unblinded proof with C, dleq
  relays: string[];
}): Promise<DmPublishResult>;
```

Uses `nip04.encrypt()` to encrypt the DM content, then publishes a kind 4
event with tag `["p", coordinatorHexPubkey]`.

---

## 5. Changes to Existing Files

### 5.1 `web/src/cashuMintApi.ts`

**Scope:** Major rewrite. This file becomes a thin compatibility layer.

**Remove:**

- `MintInvoiceResponse` type (replaced by coordinator's election metadata)
- `CashuProof` type (replaced by real Cashu proof shape from `@cashu/cashu`)
- `ProofStatusResponse` type (replaced by `MintQuoteStatusResponse`)
- `requestMintInvoice()` (replaced by `mintApi.createMintQuote()`)
- `fetchMintProof()` (replaced by `mintApi.checkQuoteStatus()`)
- Debug log functions `logClaimDebug()` / `logBallotDebug()` (keep as optional
  no-ops or gate behind `USE_MOCK`)

**Add:**

- Re-export types from `coordinatorApi.ts` and `mintApi.ts` for backward
  compatibility with components that import from this module.
- Keep `BallotQuestion` type but widen it to match `ElectionQuestion`
  (add `type`, `select`, `min`, `max`, `step`, `max_length`).

**Keep:**

- `RelayPublishResult` type (still used by `nostrIdentity.ts` and `ballot.ts`)
- `ClaimDebugPayload` / `BallotDebugPayload` types (optional debug logging)

### 5.2 `web/src/nostrIdentity.ts`

**Scope:** Small changes + signer abstraction (see section 12).

**Change `createCashuClaimEvent()` (line 44-78):**

The function currently takes `(nsec, npub, invoice, mintApiUrl)`. The
`invoice` parameter is the mock `MintInvoiceResponse`. In production,
the invoice is the bolt11 string from the mint quote response, and the
quote ID is separate.

New signature:

```typescript
createCashuClaimEvent(
  nsec: string,
  coordinatorNpub: string,
  mintUrl: string,
  quoteId: string,
  bolt11Invoice: string,
  electionId: string,
  relays: string[]
)
```

This removes the dependency on the mock `MintInvoiceResponse` type.

The event shape already includes `["p", coordinatorNpub]` and `["election", electionId]`
tags -- these are correct per the coordinator spec. No tag changes needed.

**No changes needed to:**

- `isValidNpub()` (line 6-13)
- `decodeNsec()` (line 15-22)
- `deriveNpubFromNsec()` (line 24-32)
- `publishCashuClaim()` (line 80-104)
- `formatDateTime()` (line 106-108)

### 5.3 `web/src/ballot.ts`

**Scope:** Significant rewrite of vote event content and tags.

**Current (line 38-55):**

```typescript
tags: [
  ["t", "auditable-vote"],
  ["election", input.electionId],
  ["proof_hash", proofHash],
  ["mint", input.proof.mintUrl]
],
content: JSON.stringify({
  election_id: input.electionId,
  proof_hash: proofHash,
  ballot: input.answers
})
```

**Target (per `04-VOTING_EVENT_INTEROP_NOTES.md:128-141`):**

```typescript
tags: [
  ["election", input.electionId]
],
content: JSON.stringify({
  election_id: input.electionId,
  responses: [
    { question_id: "q1", value: "community-grants" },
    { question_id: "q2", values: ["Lightning dev", "Privacy research"] }
  ],
  timestamp: Math.floor(Date.now() / 1000)
})
```

**Changes:**

1. Remove `["t", "auditable-vote"]` tag -- not in protocol spec.
2. Remove `["proof_hash", ...]` tag -- proof is submitted via separate DM.
3. Remove `["mint", ...]` tag -- not in protocol spec.
4. Rewrite `content` to use `responses` array with `{question_id, value}` or
   `{question_id, values}` format instead of flat `ballot` object.
5. Add `timestamp` field to content.
6. Remove `hashProof()` function (no longer needed -- proof hash not included
   in vote event). The proof commitment is computed by the coordinator when
   burning.
7. Update `publishBallotEvent()` input parameter:
   - Remove `proof` field (proof not needed for vote event)
   - Change `answers: Record<string, string>` to `responses: Array<{question_id: string, value?: string, values?: string[]}>`
   - Add optional `questions: ElectionQuestion[]` parameter so the function can
     adapt answer format based on question type (single choice -> `value`,
     multiple choice -> `values`)

**Update `hashProof()` (line 12-25):** Remove or gate behind `USE_MOCK`. In
production, proof hashing is done server-side by the coordinator
(`SHA256(proof_secret)`), not by the voter client.

### 5.4 `web/src/voterManagementApi.ts`

**Scope:** Rewrite to call coordinator API in production, keep mock in dev.

**In production mode:**

- `fetchEligibility()` -> calls `coordinatorApi.fetchEligibility()`
- `checkEligibility(npub)` -> calls `coordinatorApi.fetchEligibility()`, then
  checks locally whether `npub` is in the returned `eligible_npubs` array
- `resetEligibility()` -> remove or no-op (no equivalent in coordinator)
- Update `EligibilityCheckResponse` type:

```typescript
type EligibilityCheckResponse = {
  npub: string;
  allowed: boolean;
  canProceed: boolean;
  message: string;
  // hasVoted removed -- coordinator does not expose this per-npub over HTTP
};
```

**In mock mode:** No change -- continues to call `GET /api/eligibility/check`.

### 5.5 `web/src/cashuWallet.ts`

**Scope:** Update stored proof type.

**Current `StoredWalletBundle` (line 5-8):**

```typescript
type StoredWalletBundle = {
  proof: CashuProof | null;
  invoice: MintInvoiceResponse;
};
```

**Target:**

```typescript
type StoredWalletBundle = {
  proof: CashuProof | null;
  election: {
    electionId: string;
    title: string;
    questions: ElectionQuestion[];
    start_time: number;
    end_time: number;
    mint_urls: string[];
  };
  quote: {
    quoteId: string;
    bolt11: string;
  };
  coordinatorNpub: string;
  mintUrl: string;
  relays: string[];
};
```

The mock `MintInvoiceResponse` bundled election metadata with the invoice.
In production, election metadata comes from `GET /election` and the quote
comes from `POST /v1/mint/quote/bolt11`. These are separate concerns.

**Storage key:** Keep `"auditable-voting.cashu-proof"` to avoid breaking
existing stored data (or add a version check and migration).

### 5.6 `web/src/App.tsx` (Voter Portal)

**Scope:** Major rewrite of the issuance flow.

**Current flow:**

1. Enter npub -> `checkEligibility()` against local server
2. Request invoice -> `GET /mock-mint/invoice` (returns quote + election + coordinator)
3. Sign claim -> publish kind 38010 with mock data
4. Poll for proof -> `GET /mock-mint/proof/{quoteId}`
5. Store proof -> localStorage

**Target flow:**

1. On mount: `fetchCoordinatorInfo()` -> discover `coordinatorNpub`, `mintUrl`, `relays`
2. On mount: `fetchElection()` -> get questions, election ID, timing
3. Enter npub -> `checkEligibility()` against coordinator `/eligibility`
4. Request quote -> `POST /v1/mint/quote/bolt11` on real mint
5. Sign claim -> publish kind 38010 with real quote ID + bolt11 invoice
6. Poll quote -> `GET /v1/mint/quote/bolt11/{quoteId}` until `PAID`
7. Build blinded output -> `cashuBlind.buildBlindedOutput()`
8. Mint tokens -> `POST /v1/mint/bolt11` with blinded output
9. Unblind signatures -> `cashuBlind.unblindProof()` -> real Cashu proof
10. Store proof + election + quote metadata -> localStorage

**New state variables:**

- `coordinatorInfo: CoordinatorInfo | null`
- `electionInfo: ElectionInfo | null`
- `mintQuote: MintQuoteResponse | null` (replaces `invoiceQuote`)
- `blindedOutput: BlindedOutput | null`
- `quoteState: "UNPAID" | "PAID" | "ISSUED" | null`

**New UI elements:**

- Election title and description (from `/election`)
- Election timing (start/end time)
- Mint URL display (from `/info`)
- Coordinator npub display (from `/info`)
- Quote state indicator (`UNPAID` -> waiting for coordinator approval -> `PAID`)

**Step 2.1 UI update:** "Request invoice from Mint" -> "Request quote from Mint"

- Show quote ID (not quoteId -- field name is `quote`)
- Show bolt11 invoice string
- Show expiry countdown
- Remove coordinator npub from invoice display (shown at top of page)

**Step 2.2 UI update:** "Sign and publish claim" -> same, but uses real quote data

- The `createCashuClaimEvent()` call changes (see 5.2)

**Proof polling UI update:**

- Show "Waiting for coordinator to approve quote..." while state is `UNPAID`
- Show "Quote approved! Minting blinded tokens..." when state becomes `PAID`
- Show "Proof received!" when tokens are minted and unblinded

**Mock mode:** All new steps are skipped. The existing mock flow runs
unchanged.

### 5.7 `web/src/VotingApp.tsx` (Voting Page)

**Scope:** Add question type rendering, proof DM step, acceptance polling.

**Question rendering changes:**

Current (line 168-187): All questions rendered as radio buttons (single choice).

Target: Render based on `question.type`:

- `"choice"` + `select: "single"` -> radio buttons (current behavior)
- `"choice"` + `select: "multiple"` -> checkboxes
- `"scale"` -> range slider or number input (min/max/step)
- `"text"` -> textarea (with optional character counter for `max_length`)

**Answer state type change:**

```typescript
// Current
const [answers, setAnswers] = useState<Record<string, string>>({});

// Target
const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({});
```

**New Step 3: Submit proof via encrypted DM:**

After the ballot is published (kind 38000), add a new section:

- Button: "Submit proof to coordinator"
- Calls `proofSubmission.submitProofViaDm()` with:
  - The ephemeral secret key (from `publishBallotEvent()` -- currently not
    returned; must be returned)
  - The coordinator npub (from stored wallet bundle)
  - The vote event ID (from ballot publish result)
  - The serialized Cashu proof (from stored wallet bundle)
  - The relay list (from stored wallet bundle)
- Display DM publish result (successes/failures per relay)

**New Step 4: Check vote acceptance:**

After proof DM submission, add a polling section:

- Poll `GET /tally` every 10 seconds
- Display `total_accepted_votes` count
- Show "Your vote was accepted!" when `total_accepted_votes` increases
  (or subscribe to kind 38002 events from coordinator npub for real-time
  detection -- more complex, can be a follow-up)

**`publishBallotEvent()` return value change:**

Current return type (`VotePublishResult`, line 7-28) does not include the
ephemeral secret key. The secret key must be returned for NIP-04 DM
encryption. Update to include `ballotNsec` or the raw `Uint8Array` secret.

### 5.8 `web/src/DashboardApp.tsx` (Operator Dashboard)

**Scope:** Replace data sources with coordinator HTTP API.

**Current data sources:**

- `fetchEligibility()` -> `GET /api/eligibility` (local mock)
- `resetEligibility()` -> `POST /api/eligibility/reset` (local mock)

**Target data sources (production):**

- `coordinatorApi.fetchEligibility()` -> `GET /eligibility` (coordinator)
- `coordinatorApi.fetchTally()` -> `GET /tally` (coordinator)
- `coordinatorApi.fetchElection()` -> `GET /election` (coordinator)

**UI additions:**

- Election title and timing section
- Vote tally section:
  - `total_published_votes` (all kind 38000 events)
  - `total_accepted_votes` (votes with burned proofs)
  - `spent_commitment_root` (Merkle root hex)
  - Per-question result counts
- Coordinator npub and mint URL display

**UI removals:**

- "Reset all npubs" button (no equivalent in coordinator)
- "Verified" count column (coordinator doesn't expose per-npub issued status
  over HTTP -- only the full eligible set)

**Mock mode:** Continue using local mock endpoints.

### 5.9 CORS Handling

The browser blocks cross-origin `fetch()` calls unless the target server
responds with `Access-Control-Allow-Origin` headers. Two complementary
measures address this.

#### 5.9.1 CORS headers on the coordinator (`tg-mint-orchestrator`)

CORS middleware was added to the coordinator's `aiohttp` server in
`voting-coordinator-client.py` using the `aiohttp-cors` package. The coordinator
responds to preflight `OPTIONS` requests and includes permissive headers on
all responses:

```python
import aiohttp_cors

cors = aiohttp_cors.setup(
    app,
    defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
        )
    },
)
```

`allow_credentials=True` causes the middleware to echo the requesting origin
(rather than `*`), which is required when credentials are involved.

This unblocks direct browser-to-coordinator calls during development
(e.g., Vite dev server at `localhost:5173` calling `http://23.182.128.64:8081`).

The CDK mint (port 3338) may already include CORS headers. If not, the
same approach applies to its HTTP handler.

#### 5.9.2 Nginx reverse proxy (production)

In production, an nginx reverse proxy serves the frontend static files and
proxies API requests to the coordinator and mint under the same origin.
The browser never makes a cross-origin request, so CORS is irrelevant.

```
Browser --https://vote.example.com/----------->  nginx (static files)
    Browser --https://vote.example.com/api/------->  nginx --->  coordinator:8081
Browser --https://vote.example.com/mint/------>  nginx --->  mint:3338
```

Minimal nginx config:

```nginx
server {
    listen 443 ssl;
    server_name vote.example.com;

    # Frontend static files
    root /var/www/auditable-voting/web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Coordinator API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Mint API proxy
    location /mint/ {
        proxy_pass http://127.0.0.1:3338/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

With this setup, the frontend's `config.ts` uses relative paths in
production:

```typescript
export const COORDINATOR_URL = USE_MOCK
  ? "http://localhost:8787"
  : "/api";
export const MINT_URL = USE_MOCK
  ? "http://localhost:8787/mock-mint"
  : "/mint";
```

No absolute VPS URL is needed -- nginx routes `/api/*` and `/mint/*`
to the correct backend services.

#### 5.9.3 Vite dev proxy (development)

During development, the Vite dev server can proxy the same paths to the
VPS. This avoids CORS entirely without needing nginx:

```typescript
// vite.config.ts
server: {
  proxy: {
    "/api": { target: "http://23.182.128.64:8081", changeOrigin: true },
    "/mint": { target: "http://23.182.128.64:3338", changeOrigin: true },
  },
},
```

**Summary:** CORS headers on the coordinator are the quick fix for dev.
Nginx is the production deployment pattern. The Vite dev proxy is an
alternative for local development if the CORS headers haven't been added
yet. All three can coexist.

---

## 6. Kind 38010 Event Verification

The current kind 38010 event shape (`nostrIdentity.ts:56-77`) is already
compatible with the coordinator's expectations. Verified fields:

| Tag | Current (line) | Coordinator expects | Match? |
|---|---|---|---|
| `["p", coordinatorNpub]` | line 62 | Yes | Yes |
| `["t", "cashu-issuance"]` | line 61 | Yes | Yes |
| `["quote", quoteId]` | line 63 | Yes | Yes |
| `["invoice", bolt11]` | line 64 | Yes | Yes |
| `["mint", mintUrl]` | line 65 | Yes | Yes |
| `["amount", "1"]` | line 66 | Yes | Yes |
| `["election", electionId]` | line 65 | Yes | Yes |

Content JSON shape also matches. **No changes needed to the event
structure itself** -- only the parameters passed to `createCashuClaimEvent()`
change (see 5.2).

---

## 7. Implementation Phases

### Phase 1: Configuration + Discovery -- DONE

1. ~~Create `.env.example` with `VITE_USE_MOCK`, `VITE_COORDINATOR_URL`, `VITE_MINT_URL`~~
2. ~~Create `web/src/config.ts`~~
3. ~~Create `web/src/coordinatorApi.ts` with `fetchCoordinatorInfo()` and `fetchElection()`~~
4. ~~Update `App.tsx` to discover coordinator/mint on mount~~
5. ~~Add election title, description, timing display to `App.tsx`~~
6. ~~Test: Page loads and shows election metadata from coordinator~~

### Phase 2: Eligibility -- DONE

1. ~~Update `web/src/coordinatorApi.ts` with `fetchEligibility()`~~
2. ~~Update `web/src/voterManagementApi.ts` to use coordinator in production~~
3. ~~Update `App.tsx` eligibility check to use new API~~
4. ~~Update `DashboardApp.tsx` to use coordinator for eligible list~~
5. ~~Test: Eligibility check works against coordinator~~

### Phase 3: Real Mint Integration -- DONE

1. ~~Add `@cashu/cashu-ts` dependency~~
2. ~~Create `web/src/mintApi.ts` with all mint endpoints~~
3. ~~Create `web/src/cashuBlind.ts` for blinded token operations~~
4. ~~Update `App.tsx` issuance flow~~
5. ~~Update `cashuWallet.ts` storage type~~
6. ~~Test: End-to-end proof issuance against real mint~~

### Phase 4: Vote Event + Proof Submission -- DONE

1. ~~Update `ballot.ts` vote event content/tags to match protocol~~
2. ~~Add new question type rendering to `VotingApp.tsx`~~
3. ~~Return ephemeral secret key from `publishBallotEvent()`~~
4. ~~Create `web/src/proofSubmission.ts` for NIP-04 DM~~
5. ~~Add proof DM submission UI to `VotingApp.tsx`~~
6. ~~Add tally polling / acceptance display to `VotingApp.tsx`~~
7. ~~Test: Publish vote + submit proof + verify acceptance on tally~~

### Phase 5: Dashboard + Cleanup -- DONE

1. ~~Update `DashboardApp.tsx` with tally section~~
2. ~~Add election info to dashboard~~
3. ~~Remove `cashuMintApi.ts` mock-only functions or gate behind `USE_MOCK`~~
4. ~~Update `vite.config.ts` proxy for coordinator/mint CORS~~
5. ~~Update `.gitignore` to include `.env`~~
6. ~~Final integration test: full flow from eligibility check to accepted vote~~

### Phase 6: Deployment + Election Publication -- DONE

1. ~~Create `deploy-and-prepare.yml` playbook (Traefik + coordinator + client + election)~~
2. ~~Fix rsync, healthcheck IPv6, shell quoting, Python 3.13 date formatting bugs~~
3. ~~Playbook passes end-to-end: all 4 plays succeed~~
4. ~~SEC-06 feedback election published (kind 38008 + 38009) with 24 eligible voters~~
5. ~~Write `~/voting-information.md` with live URLs~~
6. ~~Update `README.md` with deploy command and live voter portal link~~
7. ~~Commit and push all changes~~

**Voter portal live:** http://vote.mints.23.182.128.64.sslip.io/

---

## 8. Key Gotchas

1. **CDK 0.15.1 field names:** Response uses `quote` not `quote_id`. State
   strings are uppercase (`"UNPAID"`, `"PAID"`). Keyset IDs are 66 chars.

2. **Coordinator validates `mint` tag exactly:** The `["mint", ...]` tag in
   kind 38010 must match the coordinator's configured mint URL exactly,
   including trailing-slash handling. The coordinator strips trailing slashes
   for comparison (`voting-coordinator-client.py:293`). The `--public-mint-url`
   argument was added so remote voters can send the public URL.

3. **One proof per npub:** The coordinator silently skips duplicate issuance
   requests. No error is returned -- the voter discovers this via poll timeout.

4. **No response DM:** The coordinator does not send a reply DM after burning
   a proof. Acceptance is discovered via `GET /tally` or kind 38002 events.

5. **Election ID is a hex event ID:** The election ID is the hex ID of the
   kind 38008 event, not a human-readable string like `"spring-2026-council"`.

6. **NIP-04 vs NIP-44:** The coordinator uses NIP-04 for encrypted DMs.
   `nostr-tools` v2 supports both; ensure `nip04.encrypt()` is used (not
   NIP-44).

7. **CORS:** The browser blocks cross-origin requests to the coordinator
   and mint unless they include `Access-Control-Allow-Origin` headers.
   See section 5.9 for the three-pronged approach (coordinator CORS
   middleware, Vite dev proxy, nginx production proxy).

8. **`@cashu/cashu-ts` v3.x uses OOP, not standalone functions:** The library
   does not export standalone `generateSecret()` or `amountToBlindedMessage()`.
   Use the `CashuWallet` class with `createMintQuote()`, `mintProofs()`,
   and `createBlankOutputs()` methods.

9. **BlindSignature vs Proof:** The mint's `/v1/mint/bolt11` returns
   `BlindSignature` objects (`{id, amount, C_, dleq:{e,s}}`). The melt/swap
   endpoints require `Proof` objects (`{id, amount, secret, C, dleq:{e,s,r}}`).
   The wallet must call `step3_alice()` to unblind `C_` to `C` and include
   the blinding factor `r` in the DLEQ proof. The `CashuWallet.mintProofs()`
   method handles this internally.

10. **CDK mint melt requires a valid quote:** `/v1/melt/bolt11` needs a valid
    melt quote ID from `/v1/melt/quote/bolt11`. If the Lightning receive
    backend is broken, the coordinator falls back to `/v1/swap` which burns
    input proofs without requiring a Lightning payment.

11. **`nostr-sdk` SendEventOutput:** `str(result)` on a `SendEventOutput`
    returns the full debug representation. Use `result.id.to_hex()` for the
    64-character hex event ID.

12. **Blinded output requires mint keys:** Before calling
    `POST /v1/mint/bolt11`, the client must fetch `GET /v1/keys` and
    `GET /v1/keysets` to build correctly formatted blinded outputs. The
    `@cashu/cashu-ts` library handles this internally when given the keys.

---

## 9. Summary of Changes by File

| File | Scope | Phase |
|---|---|---|
| `.env.example` | New | 1 |
| `web/src/config.ts` | New | 1 |
| `web/src/coordinatorApi.ts` | New | 1-2 |
| `web/src/mintApi.ts` | New | 3 |
| `web/src/cashuBlind.ts` | New | 3 |
| `web/src/proofSubmission.ts` | New | 4 |
| `web/src/cashuMintApi.ts` | Major rewrite | 1-5 |
| `web/src/nostrIdentity.ts` | Small change | 3 |
| `web/src/ballot.ts` | Significant rewrite | 4 |
| `web/src/voterManagementApi.ts` | Rewrite | 2 |
| `web/src/cashuWallet.ts` | Update type | 3 |
| `web/src/App.tsx` | Major rewrite | 1-3 |
| `web/src/VotingApp.tsx` | Add features | 4 |
| `web/src/DashboardApp.tsx` | Replace data sources | 2, 5 |
| `web/vite.config.ts` | Add proxy rules | 1, 5 |
| `web/package.json` | Add dependency | 3 |
| `.gitignore` | Add `.env` | 1 |
| `tests/conftest_e2e.py` | New | E2E |
| `tests/test_e2e_voting.py` | New | E2E |
| `ansible/playbooks/deploy-and-prepare.yml` | New | 6 |
| `ansible/playbooks/templates/voter-instructions.j2` | New | 6 |
| `~/voting-information.md` | New | 6 |

---

## 10. E2E Voter Flow Test Plan

A comprehensive end-to-end test (`tests/test_e2e_voting.py`) validates the
entire voter lifecycle against the live infrastructure. See
[integration-test-plan.md](integration-test-plan.md) Phase 3 for full details.

**Status: PASSED (2026-03-20).** All 12 steps complete in ~87 seconds.

### Test Phases

1. **Setup:** Publish ephemeral kind 38008 (election) and 38009 (eligibility)
   events via SSH to VPS local relay. Poll until coordinator caches them.
2. **Discovery:** Verify `/info`, `/election`, `/eligibility` endpoints.
3. **Issuance:** Create mint quote, publish kind 38010 claim, poll for PAID,
   mint blinded tokens.
4. **Voting:** Publish kind 38000 ballot with ephemeral keypair.
5. **Proof:** Unblind mint signature into proper Proof object, send NIP-04 DM
   (kind 4) to coordinator. Coordinator burns proof via `/v1/swap`.
6. **Verification:** Poll `/tally` until `total_accepted_votes >= 1`.

### Key Discoveries During E2E Development

1. **Proof unblinding is mandatory.** The mint returns `BlindSignature` with
   `C_` and `DLEQ{e,s}`. The swap endpoint requires `Proof` with `C` and
   `DLEQWallet{e,s,r}`. The wallet must preserve the blinding factor `r` from
   the blinding step and call `step3_alice()` to unblind.

2. **`/v1/swap` instead of `/v1/melt/bolt11`.** The CDK mint's Lightning
   receive backend is not functional on the VPS. The coordinator was modified
   to use `/v1/swap` (burns inputs, returns new blinded outputs) which does
   not require a melt quote or Lightning payment.

3. **`event_id.id.to_hex()` vs `str(event_id)`.** In Python's `nostr-sdk`,
   `str(SendEventOutput(...))` returns the full debug representation, not the
   hex event ID. All publish scripts were fixed to use `.id.to_hex()`.

4. **Local event store insertion for immediate tally updates.** The coordinator
   now inserts kind 38002 events into its local `event_store` immediately after
   publishing, rather than waiting for relay echo propagation.

5. **Fresh voter keypair per run.** The coordinator's `issued_set` is not keyed
   by election, so once a pubkey is issued it can never be issued again. The
   E2E test generates a fresh keypair and adds it to `eligible-voters.json`.

### Resolved: Mint URL Tag Validation

The coordinator's `process_issuance_request()` validates the `["mint", ...]`
tag in kind 38010 against `--mint-url` (internal: `http://127.0.0.1:3338`).
A remote voter would naturally send `http://23.182.128.64:3338` (the public
URL returned by `/info`).

**Fix:** Added `--public-mint-url` CLI argument. The coordinator now returns the
public URL in `/info` and accepts both internal and public URLs in the
`["mint", ...]` tag validation.

---

## 11. Ansible Deployment

The Ansible playbooks in `ansible/playbooks/` provide a single-command
deployment for the entire stack:

```bash
# Deploy everything (coordinator + voting client + verification)
ansible-playbook ansible/playbook.yml

# Deploy coordinator only
ansible-playbook ansible/playbook.yml --tags coordinator

# Deploy voting client only
ansible-playbook ansible/playbook.yml --tags client

# Verify infrastructure (no changes)
ansible-playbook ansible/playbook.yml --tags verify

# Local dev build only
ansible-playbook ansible/playbook.yml --tags local-dev
```

### Playbook Structure

| Playbook | Purpose |
|----------|---------|
| `ansible/playbook.yml` | Main entry point, delegates to sub-playbooks |
| `ansible/playbooks/deploy-all.yml` | Runs coordinator + client + verify in sequence |
| `ansible/playbooks/deploy-coordinator.yml` | Inline tasks (no import_playbook), resolves coordinator repo path via delegate_to localhost |
| `ansible/playbooks/deploy-voting-client.yml` | Installs rsync, Node.js, syncs repo, builds frontend, deploys nginx container via Docker/Traefik |
| `ansible/playbooks/deploy-and-prepare.yml` | **Full-stack playbook:** Traefik + coordinator + client + SEC-06 election publication + voter instructions |
| `ansible/playbooks/verify.yml` | 12 health checks: service status, CORS, pubkey match, public URL, proxy routing |
| `ansible/playbooks/templates/voter-instructions.j2` | Formatted box with live URLs printed after successful deploy |

### Inventory

```
ansible/inventory/
  hosts.yml              # defines tollgate-vps, voting_servers, mint_hosts groups
  group_vars/all.yml     # merged: vps_ip, node_version, coordinator_url, mint_url, app_deploy_dir, etc.
```

**Note:** Two conflicting `group_vars/all.yml` files existed (one under `ansible/inventory/`,
one under `ansible/group_vars/`). These were merged into `ansible/inventory/group_vars/all.yml`.
The `ansible/group_vars/all.yml` file can be deleted.

### Single-Command Deploy (DONE)

```bash
ansible-playbook ansible/playbooks/deploy-and-prepare.yml
```

This playbook brings the VPS from any state to a fully ready voter portal with a
published SEC-06 feedback election. It is idempotent and can be re-run safely.

**Result:** All 4 plays succeed. Voter portal live at:
http://vote.mints.23.182.128.64.sslip.io/

### Deployment Bugs Fixed

1. **rsync not installed on VPS.** The `ansible.builtin.synchronize` module requires
   `rsync` on both the control host and the remote. Added `rsync` to the apt package
   list in `deploy-voting-client.yml`.

2. **Container healthcheck IPv6 issue.** `wget http://localhost:80/` failed inside the
   `nginx:alpine` container because `localhost` resolved to `::1` (IPv6) but nginx only
   listened on `0.0.0.0:80` (IPv4). Changed healthcheck URL to `http://127.0.0.1:80/`.

3. **Eligibility root shell quoting.** The Python inline script for computing the SHA-256
   eligibility root used double quotes inside a Jinja2 template, causing the JSON string
   quotes to be eaten by the shell. Switched to a heredoc (`<< 'PYEOF'`) to preserve
   quoting.

4. **`to_datetime('%s')` removed in Python 3.13.** The `%s` format code was deprecated
   in Python 3.12 and removed in 3.13. Replaced with `date -u -d @<epoch>` shell command.

---

## 12. Branding and NIP-07 Signer Integration

Both parts implemented and deployed. See `docs/branding-and-signer-plan.md`.

- **Part A (done, deployed):** 11 images saved to `web/public/images/` and
  `web/public/images/nostr/`. Soveng logo as favicon on all 3 pages, OG meta tags on
  `index.html`, black-hat accent in Voter Portal hero, bitcoin-logo inline icons,
  gmnotes in signer panel, relayflasks on VotingApp relays line, sendmenotes in proof
  submission panel, underconstruction-dark in empty states.

- **Part B (done, deployed):** `NostrSigner` abstraction in `web/src/signer.ts` with
  `createRawSigner()`, `createNip07Signer()`, and `detectSigner()` (auto-detects
  browser extension on mount). `signCashuClaimEvent()` in `nostrIdentity.ts` accepts
  any `NostrSigner` for kind 38010 signing. 38/38 tests pass (13 signer + 25 integration).

- **UI refactor (done, deployed):** Panel order changed to Signer -> Check
  eligibility -> Get proof. The npub is auto-derived from the signer (NIP-07 extension
  or raw nsec input). The nsec textarea is only in the Signer panel; Step 2.2 no
  longer duplicates it. `activeNpub` computed value drives both eligibility checks
  and claim signing. Eligibility auto-resets when signer changes.

- **Deployed to:** `http://vote.mints.23.182.128.64.sslip.io/`
- **Container:** `voting-client` (nginx:alpine) on `tollgate-net`, healthy
- **Build:** 96 modules, 10 chunks, Node.js v20.20.1, VITE_USE_MOCK=false
