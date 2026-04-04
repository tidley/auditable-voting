# Auditable Voting

Client-only Nostr voting with browser-based voter, coordinator, and auditor flows.

## What is in this repo

- `web/` — the shipped React + Vite app
- `docs/project-explainer.md` — the main written explainer
- `presentation/project-overview.html` — the portable presentation deck
- `.github/workflows/static.yml` — GitHub Pages deployment

Everything else from the older coordinator/Cashu/deployment stack has been removed.

## Local development

Install dependencies:

```bash
npm --prefix web install
```

Run the app:

```bash
npm --prefix web run dev -- --host 127.0.0.1 --port 5173
```

Open:

- `http://127.0.0.1:5173/`
- `http://127.0.0.1:5173/vote.html`
- `http://127.0.0.1:5173/dashboard.html`
- `http://127.0.0.1:5173/simple.html`

## Verify the frontend

```bash
cd web
npx vitest run
npm run verify:simple-blind-shares
npm run build
```

## GitHub Pages

The app is deployed as a static site with GitHub Actions.

The workflow in `.github/workflows/static.yml`:

- installs `web/` dependencies
- builds the Vite app with a Pages-safe base path
- uploads `web/dist`
- deploys it to GitHub Pages

To test the same base path locally:

```bash
VITE_BASE_PATH=/auditable-voting/ npm --prefix web run build
```

## Main routes

- `/` — voter shell
- `/vote.html` — voter shell
- `/dashboard.html` — coordinator shell
- `/simple.html` — shared role-switching shell
- `/simple-coordinator.html` — coordinator-first shell

## Related material

- [Project explainer](./docs/project-explainer.md)
- [Portable presentation](./presentation/project-overview.html)
