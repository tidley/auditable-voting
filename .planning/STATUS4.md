# STATUS4

Repository: `/home/tom/code/auditable-voting`  
Date: `2026-04-16`  
Current visible app version: `0.134`

## Headline

The app now uses a landing login gateway on `/` (no forced voter redirect), with explicit role selection and improved signer compatibility for Android/Firefox-style NIP-07 bridges.

## Latest completed tranche

- Versioning switched to the `0.xxx` line; current app version is `0.134`.
- Landing/refresh behaviour changed so `/` stays on gateway until a role is explicitly selected.
- Signer service updated for better mobile/browser compatibility:
  - waits for delayed signer injection
  - listens for `nostr:ready`
  - preserves signer method binding (`this`) for provider bridges
- Option A flow docs updated to reflect signer-keyed resume and invite-driven request preparation.

## Verification run in this tranche

```bash
npm --prefix web run test -- src/services/signerService.test.ts
npm --prefix web run test -- src/questionnaireOptionA.runtime.test.ts
npm --prefix web run build
```

All passed locally.

## Planning status notes

- `.planning/STATUS3.md` and older `TODO*.md` files remain as historical context.
- This file (`STATUS4.md`) is now the canonical current-status handoff.
- Public documentation was refreshed in the same pass: `README.md`, `docs/project-explainer.md`, `web/public/project-explainer.html`, and `presentation/project-overview.html`.
- Next major planned tranche is documented in:
  - `.planning/2026-04-21-public-submission-migration-plan.md`
