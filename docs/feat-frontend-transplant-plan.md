# Transplant Plan: feat-frontend UI improvements into feature/integration

## Context

Branch `github/feat-frontend` (2 commits: `65db149`, `9254265`) adds UI polish and
a nostr event verification feature. Branch `feature/integration` (20 commits) has
the coordinator integration, per-election keysets, and deployment work. Both diverge
from merge-base `5153b10`.

A test merge shows conflicts in 6 files. This plan transplants the valuable
additions surgically without merge conflicts.

## What we transplant

| # | Feature | Files | Risk |
|---|---------|-------|------|
| 1 | `getNostrEventVerificationUrl()` | `nostrIdentity.ts` | None |
| 2 | `.notice-link` + `.hero-title` CSS | `styles.css` | None |
| 3 | DashboardApp hero-title class | `DashboardApp.tsx` | None |
| 4 | Claim verification URL in voter portal | `App.tsx` | Low |
| 5 | Ballot verification URL in voting page | `VotingApp.tsx` | Low |

## What we skip

- **Hero flow steps** (4-step indicator) — conflicts with current branch's
  restructured hero showing coordinator/mint/election metadata.
- **Copy changes** ("mock mint" -> "mint service" etc.) — current branch already
  has updated copy.
- **`.inline-code` CSS** — would require converting all body copy from backtick
  markdown to `<code>` tags; separate effort.
- **README Mermaid diagrams** — reference old mock-mint architecture; would need
  full rewrite for coordinator-based flow.

## Step-by-step

### Step 1 — `web/src/nostrIdentity.ts`

Add `getNostrEventVerificationUrl()` function before `formatDateTime()` (line 147).
Uses already-imported `nip19.neventEncode` to build `njump.me` links.

### Step 2 — `web/src/styles.css`

Add three CSS blocks:
- `.notice-link` after `.notice-success` (line 442)
- `.hero-title` + `.hero-title-dashboard` after existing `.hero-card h1` (line 113)
- Mobile override (reset `max-width: none`) in the 640px breakpoint (line 600)

### Step 3 — `web/src/DashboardApp.tsx`

Add `className="hero-title hero-title-dashboard"` to the `<h1>` at line 80.

### Step 4 — `web/src/App.tsx`

1. Import `getNostrEventVerificationUrl` from `./nostrIdentity` (line 12)
2. Add `claimVerificationUrl` useMemo after `activeMintUrl` (~line 65)
3. Add verification link inside the existing `notice-success` div (line 594)

### Step 5 — `web/src/VotingApp.tsx`

1. Import `BALLOT_EVENT_KIND` from `./ballot` and `getNostrEventVerificationUrl`
   from `./nostrIdentity`
2. Add `ballotVerificationUrl` computed value after existing state (~line 47)
3. Add verification link after relay stats (line 396)

## Tests

7 unit tests for `getNostrEventVerificationUrl` in `web/src/nostrIdentity.test.ts`:

- URL format validation (starts with `https://njump.me/nevent1`)
- Event-id-only encoding (no optional fields)
- Relay encoding
- Author encoding
- Kind encoding
- All fields together
- Empty relays array edge case

### Test learnings

1. **`nip19.neventEncode` normalizes `relays: undefined` to `[]`**: When no relays
   are passed, the decoded nevent data contains `relays: []` not `relays: undefined`.
   Tests must assert `toEqual([])` not `toBeUndefined()`.

2. **vitest does not have `toStartWith` matcher**: Use `toMatch(/^prefix/)` regex
   instead of jasmine-style `toStartWith()`.

3. **`nip19.neventData` type requires casts**: `nip19.decode()` returns a union
   type; cast `decoded.data as nip19.neventData` to access typed fields.

4. **vitest v4 added to devDependencies**: The project had no test framework.
   vitest was chosen since it integrates natively with Vite and requires no
   additional config for basic test files.

## Verification

`npm run build` — passes with no TypeScript or build errors.
`npm run test` — 7/7 tests passing.
