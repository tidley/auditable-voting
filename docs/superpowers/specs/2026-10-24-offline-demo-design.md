# Offline voting sandbox

Approved scope: replace the real-publishing Start demo with a standalone,
deterministic offline teaching environment. Do not mount the live app inside it.

- Serve `demo.html` with local scripts/styles only, and a restrictive CSP that
  forbids all connections, workers and form submissions. No live transport,
  signer, runtime, storage or payment imports.
- Keep fictional state in memory only; reset and reload restore the same
  election. No persistence or service worker is required. It runs offline once
  the local assets have loaded; cold offline access requires a locally served
  copy, not a promise that a deployed URL works without a network.
- Presentation-only exception: read/write the existing `av-theme` preference
  so light/dark selection persists between the demo and live app. No other
  browser storage is read or modified. Put the toggle beside How it works.
- Reuse the app's local Plus Jakarta Sans font files and canonical palettes
  from shared `app-theme.css`. Keep operational screens concise and app-like;
  detailed role/privacy explanations are closed disclosures, not default prose.
  Verify computed typography and control styles against the actual app in both
  themes and keep the mobile chapter list collapsed by default.
- Provide Organiser, Voter, Worker and Observer views with explicit privacy
  boundaries and nine guided chapters. Demonstrate admission, conditional
  questions, lost receipts/idempotent retry, threshold/deadline publication,
  simulated restart, late/duplicate rejection and final reconciliation.
- Use a fixed simulated clock and reproducible example shuffle. IDs and
  credentials are deliberately fictional. Explain that neither signatures,
  encryption, relay delivery nor a real worker restart are tested.
- Remove the live demo preparation/publishing callbacks. Start demo links open
  the isolated page without mutating the parent app. Real operations remain
  available only through normal, explicitly live app controls.
  Show the launcher on the home screen and in the account menu only, not at
  the top of the organiser setup page.
- Unit-test model transitions first; browser-test the detailed walkthrough,
  reset, all roles, offline operation, no connection attempts, and unchanged
  local/session storage. Add CI coverage and align all tutorial artefacts.

Implementation order: tested pure model; standalone accessible UI; launcher
replacement; docs; browser isolation/regression tests; two read-only reviews.
