# AGENTS.md

Instructions for coding sessions in this repository.

## Project overview

This repo now contains only the client-side Nostr voting app.

The active product lives in `web/`:

- voter flow
- coordinator flow
- auditor flow
- blind-signature share issuance
- Nostr round / DM / ballot handling
- local browser persistence and recovery

Older server, deployment, and Cashu-stack code has been removed.

## Repository layout

```text
auditable-voting/
├── AGENTS.md
├── README.md
├── .env.example
├── .github/workflows/static.yml
├── docs/project-explainer.md
├── presentation/project-overview.html
└── web/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    ├── vote.html
    ├── dashboard.html
    ├── simple.html
    ├── simple-coordinator.html
    ├── public/
    ├── scripts/
    └── src/
```

## Commands

Install:

```bash
npm --prefix web install
```

Run locally:

```bash
npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Build:

```bash
npm --prefix web run build
```

Tests:

```bash
cd web
npx vitest run
npm run verify:simple-blind-shares
```

## Working rules

- Focus changes in `web/` unless the task is clearly about docs or the Pages workflow.
- Prefer keeping the simple client path coherent rather than preserving backwards compatibility with removed legacy code.
- Use `rg` for searches.
- Use `apply_patch` for manual file edits.
- Do not reintroduce backend, Python, Ansible, or Cashu-specific repo structure unless the user explicitly asks for it.
- When protocol, relay, security, UX, or role behaviour changes, update the relevant documentation and presentation artefacts in the same pass.
  - At minimum, review `README.md`, `docs/project-explainer.md`, `web/public/project-explainer.html`, and `presentation/project-overview.html`.
  - Keep visible copy in those files aligned with the shipped app behaviour and current limitations.

## Frontend notes

- The shipped entrypoints are `web/src/main.tsx`, `web/src/vote.tsx`, and `web/src/dashboard.tsx`, all mounted through `SimpleAppShell`.
- The current protocol is Nostr-first and browser-local.
- Keep visible copy in UK English.
