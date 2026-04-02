---
status: investigating
trigger: "Investigate issue: demo verifier never shows spent-tree root / step 6 stays amber in mock demo"
created: 2026-03-30T00:00:00Z
updated: 2026-03-30T00:00:00Z
---

## Current Focus

hypothesis: The mock/demo flow never sets or forwards `spent_commitment_root` into the state consumed by the verifier timeline.
test: Read the dark demo page shell, mock backend/demo state source, and verifier/timeline state wiring to identify where `spent_commitment_root` should be produced and consumed.
expecting: If the hypothesis is true, the demo path will either omit `spent_commitment_root` entirely or drop it during state mapping after receipt publication.
next_action: Inspect the relevant frontend demo and mock backend files for spent-tree root generation and propagation.

## Symptoms

expected: After proof delivery / 38002 receipt publication, the demo should show a concrete spent commitment root, step 6 should turn green, and the verifier panel should no longer show Unavailable.
actual: Step 6 remains waiting/current and the verifier panel shows Spent-tree Unavailable.
errors: No runtime crash reported in this symptom; the issue appears to be missing state rather than an exception.
reproduction: Open the root demo page in mock mode, mint proof, run the full demo, then inspect the verifier panel and live timeline.
started: This started after the demo page was reworked into the new ops-dashboard shell.

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
verification:
files_changed: []
