# Branding and NIP-07 Signer Integration

Status: **Implemented** (Part A + Part B). See test results below.

## Part A: Nostr Robot Images

### Images to Download

All images saved to `web/public/images/nostr/` and `web/public/images/`.

| # | File | Source | Used in UI? |
|---|---|---|---|
| 1 | `images/logo.png` | github.com/soveng (avatar) | Yes -- favicon + hero brand |
| 2 | `images/og-image.jpg` | soveng/website | Yes -- OG meta tag only |
| 3 | `images/black-hat.webp` | soveng/website/swag | Yes -- Voter Portal hero accent |
| 4 | `images/bitcoin-logo.png` | soveng/website/showcase | Yes -- inline icon next to mint/proof labels |
| 5 | `nostr/gmnotes.png` | nostr.com/robots | Yes -- Signer panel (App.tsx) |
| 6 | `nostr/client.png` | nostr.com/robots | No -- reserved for future explainer page |
| 7 | `nostr/relayflasks.png` | nostr.com/robots | Yes -- VotingApp relays line |
| 8 | `nostr/underconstruction-dark.png` | nostr.com/robots | Yes -- empty states |
| 9 | `nostr/relays.png` | nostr.com/robots | No -- reserved for future relay config UI |
| 10 | `nostr/sendmenotes-dark.png` | nostr.com/robots | Yes -- proof submission panel (VotingApp.tsx) |
| 11 | `nostr/nostr-architecture.webp` | Medium (ishi_kawa article) | No -- reserved for documentation |

### Image Placement

| Image | Location | Purpose |
|---|---|---|
| `logo.png` | Favicon on all 3 HTML pages + 28px icon left of eyebrow text | Brand identity |
| `og-image.jpg` | `<meta property="og:image">` on `index.html` | Social sharing previews |
| `black-hat.webp` | App.tsx hero card, absolute right, 140px, hidden <768px | Decorative personality |
| `bitcoin-logo.png` | 18px inline icon next to "Mint" (App), "Stored proof" (VotingApp), "Mints:" (Dashboard) | Bitcoin association |
| `gmnotes.png` | App.tsx Signer panel (Step 2), right-aligned accent ~120px | Reinforces cryptographic signing concept |
| `relayflasks.png` | VotingApp.tsx hero, next to "Relays:" label, 18px inline icon | Relay distribution concept |
| `sendmenotes-dark.png` | VotingApp.tsx proof submission panel (Step 4), right-aligned accent | Reinforces publishing to relays |
| `underconstruction-dark.png` | Empty states: coordinator unreachable, no election, no proof | Friendly WIP indicator |

### CSS Classes Added

```css
.hero-brand              /* logo + eyebrow row, flex, gap 10px */
.hero-accent-image       /* absolute right in hero-card, 140px, opacity 0.85, hidden <768px */
.inline-icon             /* 18px vertical-align inline image */
.panel-accent-image      /* absolute right in panel, 120px, hidden <768px */
.empty-state-image       /* centered image for empty states, max-width 160px, opacity 0.6 */
.signer-mode-selector   /* flex row of mode toggle buttons */
.signer-mode-option      /* individual mode button, 14px radius, transitions */
.signer-mode-option.active /* active state: accent border + card-strong bg */
.signer-status           /* connected extension status: flex, green bg, pubkey code */
```

### HTML Changes

- `index.html`: favicon, apple-touch-icon, OG meta tags (type, title, description, image)
- `dashboard.html`: favicon, apple-touch-icon
- `vote.html`: favicon, apple-touch-icon

---

## Part B: NIP-07 Browser Extension Signer

Status: **Implemented.** NIP-46 deferred.

### Problem

Currently, the voter must paste their raw `nsec` into a textarea to sign the
kind 38010 Cashu claim event. The nsec is exposed to the page's JavaScript
context, creating a security risk: any XSS vulnerability or malicious script
could exfiltrate the key.

### Solution

A `NostrSigner` abstraction that supports two modes:

| Mode | Source | Security | UX |
|---|---|---|---|
| `raw` | User pastes nsec | Lowest -- nsec in page JS | Simplest, no extension |
| `nip07` | Browser extension (Alby, nos2x, NostrKey) | High -- key never leaves extension | One-click, approve in popup |

NIP-46 (nsec bunker) is deferred. The interface is designed to accommodate
it without breaking changes.

### Files Created

| File | Purpose |
|---|---|
| `web/src/signer.ts` | `NostrSigner` interface, `createRawSigner`, `createNip07Signer`, `detectSigner` |
| `web/src/nostr.d.ts` | `WindowNostr` interface + global `Window` augmentation |
| `tests/test_signer.py` | 13 tests across 4 test classes |

### Files Modified

| File | Change |
|---|---|
| `web/src/nostrIdentity.ts` | Added `signCashuClaimEvent(signer, ...)` alongside existing `createCashuClaimEvent(nsec, ...)` |
| `web/src/App.tsx` | Signer mode selector UI, auto-detect on mount, conditional nsec textarea, gmnotes image, underconstruction empty state |
| `web/src/VotingApp.tsx` | relayflasks + sendmenotes + underconstruction images (Part A only) |
| `web/src/styles.css` | `.signer-mode-selector`, `.signer-mode-option`, `.signer-status`, `.panel-accent-image`, `.empty-state-image` |

### Signing Touchpoint Analysis

Only **2 of 6 signing touchpoints** involve the user's real nsec:

| # | Touchpoint | File | User's nsec? | Needs signer? |
|---|---|---|---|---|
| 1 | `getPublicKey()` -- npub derivation | `nostrIdentity.ts` | Yes | Yes |
| 2 | `finalizeEvent()` -- kind 38010 | `nostrIdentity.ts` | Yes | Yes |
| 3 | `getPublicKey()` + `finalizeEvent()` -- kind 38000 | `ballot.ts` | No (ephemeral) | No |
| 4 | `nip17.wrapEvent()` -- proof gift wrap | `proofSubmission.ts` | No (ephemeral) | No |
| 5 | `send_event()` -- kind 1059 gift wrap | `proofSubmission.ts` | No (ephemeral) | No |

The ballot event (kind 38000) and proof gift wrap (kind 1059) are intentionally signed
with a throwaway keypair generated at ballot submission time. This provides
anonymity -- the ballot is unlinkable to the voter's real npub without the
coordinator's private records. These flows are **not affected** by the signer
change.

### NIP-46 (Deferred)

NIP-46 bunker support will be added later. The changes needed are minimal:

1. Add `SignerMode = "raw" | "nip07" | "nip46"`
2. Add `createNip46Signer(bunkerUri: string)` using `nostr-tools/nip46`
3. Add "nsec bunker" radio option in the signer panel
4. Add bunker URI input field with connect/disconnect flow

No existing code changes beyond the signer interface.

### Verification

- `npx tsc --noEmit` passes
- `npx vite build` passes (96 modules, 10 chunks)
- `pytest tests/test_signer.py` -- 13/13 pass
- `pytest tests/test_integration_readiness.py` -- 25/25 pass
- Total: **38/38 tests pass**

### Test Details (`tests/test_signer.py`)

Tests run via `npx tsx` with temp `.ts` files (unlike existing integration
tests which use `node --input-type=module`). A helper function writes the script
to a temp file, runs it with `tsx`, then cleans up.

| Class | Tests | What they verify |
|---|---|---|
| `TestRawSigner` | 6 | Keypair creation, `getPublicKey()`, `getNpub()`, `signEvent()` with signature verification, invalid nsec rejection, mode is `"raw"` |
| `TestNip07Signer` | 2 | Throws when `window.nostr` missing, delegates `getPublicKey()` to mocked extension |
| `TestDetectSigner` | 3 | Returns `raw` without extension, returns `nip07` with extension, returns `raw` when `getPublicKey` missing |
| `TestSignCashuClaimEvent` | 2 | Signs kind 38010 with raw signer (verified), signs with mock nip07 signer (verified) |

### Manual Testing

- Without extension: raw mode auto-selected, nsec textarea shown
- With nos2x/Alby: nip07 mode auto-detected, pubkey shown, signing works

### UI Panel Order (after refactor)

The npub is no longer manually typed. It is derived from the signer and the
eligibility check is triggered automatically when the signer changes.

| Panel | Title | What it does |
|---|---|---|
| Signer | Choose how to sign | Mode selector (Extension / Paste nsec), nsec textarea (raw mode), read-only npub display |
| Step 1 | Check your npub | Shows `activeNpub` read-only, "Check eligibility" button, eligibility result |
| Step 2 | Get your voter proof | 2.1: Request quote from Mint. 2.2: Sign and publish claim (button only, no nsec input) |
| Wallet | Your voting proof | Stored proof display, link to voting page |
| Status | Latest update | Status/error messages |

Key state change: `npubInput` (manual textarea) replaced by `activeNpub`
(computed from signer: `nip07Pubkey` or `deriveNpubFromNsec(nsecInput)`).
A `useEffect` on `activeNpub` resets eligibility when the signer changes.
