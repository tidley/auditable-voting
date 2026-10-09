import { test, expect } from "@playwright/test";

/**
 * The role picker must keep every icon proportionate to its label.
 *
 * `.av-ui-icon` is a global, hard-coded 17px box (`styles.css`). The role
 * buttons render their icon through `av-ui-icon` — NOT through the
 * `.simple-account-menu-svg-icon` class that a nearby 31px rule sizes — so the
 * icon box is smaller than the label's own line box (17.37px at a 14.72px
 * font-size) and the label visually dominates the icon.
 *
 * The defect is invisible in Latin locales at a glance but is systematic: the
 * label line box is taller than 17px in EVERY locale, and in scripts with tall
 * glyphs (e.g. Tamil) it is stark. Sizing the icon in `em` makes it track the
 * local font-size, so the icon always encompasses the label line box.
 *
 * Invariant asserted: the icon box strictly contains the tallest label line box.
 *
 * Runs against the local dev server by default (playwright.config.ts). Point it
 * at an already-deployed build with E2E_AV_BASE_URL, no webServer needed.
 */

const BASE = process.env.E2E_AV_BASE_URL || "";

test("role picker icons encompass their label line box", async ({ page }) => {
  await page.goto(`${BASE}/`);

  const buttons = page.locator(
    ".simple-role-switch-login .simple-role-switch-button",
  );
  await expect(buttons.first()).toBeVisible();
  const count = await buttons.count();
  expect(count, "the role picker should offer at least one role").toBeGreaterThan(0);

  const measured = await buttons.evaluateAll((els) =>
    els.map((el) => {
      const svg = el.querySelector("svg");
      // The label is the deepest leaf element that carries text.
      const leaves = [...el.querySelectorAll("*")].filter(
        (e) => e.children.length === 0 && e.textContent && e.textContent.trim(),
      );
      const labelEl = leaves[leaves.length - 1] || null;
      const cs = labelEl ? getComputedStyle(labelEl) : null;
      const lineHeight = cs
        ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
        : 0;
      return {
        label: labelEl ? (labelEl.textContent || "").trim() : "",
        iconHeight: svg ? svg.getBoundingClientRect().height : 0,
        lineHeight,
      };
    }),
  );

  expect(measured.length).toBeGreaterThan(0);
  for (const m of measured) {
    expect(m.iconHeight, `"${m.label}" should not have a zero-size icon`).toBeGreaterThan(0);
    expect(
      m.iconHeight,
      `icon (${m.iconHeight.toFixed(2)}px) must encompass the "${m.label}" label line box (${m.lineHeight.toFixed(2)}px)`,
    ).toBeGreaterThan(m.lineHeight);
  }
});
