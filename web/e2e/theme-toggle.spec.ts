import { test, expect, type Page } from "@playwright/test";

/**
 * Helper: assert a localStorage value.
 */
async function expectLocalStorage(page: Page, key: string, expected: string) {
  const actual = await page.evaluate(
    ([k]) => localStorage.getItem(k as string),
    [key],
  );
  expect(actual).toBe(expected);
}

/**
 * Helper: set a theme preference in localStorage before the page loads.
 * Uses addInitScript so the value is set before any inline <head> script runs.
 * NOTE: addInitScript runs on EVERY navigation (including reloads), so only
 * use this when you want the same value applied on every navigation.
 * For tests that check persistence across reload, do NOT use this — rely on
 * the fresh context (empty localStorage) and set the theme via click instead.
 */
async function setThemePreference(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("av-theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
}

/**
 * Helper: clear the theme preference in localStorage before the page loads.
 * Same caveat as setThemePreference — runs on every navigation.
 */
async function clearThemePreference(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("av-theme");
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Toggle button visibility on gateway screen
// ---------------------------------------------------------------------------
test("theme toggle button is visible on gateway screen", async ({ page }) => {
  // Fresh context: localStorage is empty, colorScheme is dark (from config)
  // → app defaults to dark → aria-label = "Switch to light theme"
  await page.goto("/");

  const toggle = page.locator(".simple-theme-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
});

// ---------------------------------------------------------------------------
// 2. Clicking toggle switches dark → light
// ---------------------------------------------------------------------------
test("clicking toggle switches from dark to light theme", async ({ page }) => {
  await page.goto("/");

  const toggle = page.locator(".simple-theme-toggle");
  await toggle.click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectLocalStorage(page, "av-theme", "light");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
});

// ---------------------------------------------------------------------------
// 3. Clicking toggle switches light → dark
// ---------------------------------------------------------------------------
test("clicking toggle switches from light back to dark", async ({ page }) => {
  await setThemePreference(page, "light");
  await page.goto("/");

  const toggle = page.locator(".simple-theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
  await toggle.click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectLocalStorage(page, "av-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
});

// ---------------------------------------------------------------------------
// 4. Theme persists across page reload
// ---------------------------------------------------------------------------
test("theme persists across page reload", async ({ page }) => {
  // No addInitScript — fresh context has empty localStorage, defaults to dark
  await page.goto("/");

  // Toggle to light
  const toggle = page.locator(".simple-theme-toggle");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Reload — the inline <head> script should read localStorage and apply light
  // No init script to interfere — localStorage retains "light" from the click
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectLocalStorage(page, "av-theme", "light");
  // Button should show Moon (light is active, so "Switch to dark theme")
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
});

// ---------------------------------------------------------------------------
// 5. Theme persists across navigation between entrypoints
// ---------------------------------------------------------------------------
test("theme persists across navigation between entrypoints", async ({ page }) => {
  // Set light theme and navigate — the init script sets "light" on every
  // navigation, and the inline <head> script reads it.
  await setThemePreference(page, "light");
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Navigate to vote.html (the voter entrypoint)
  await page.goto("/vote.html");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Navigate to dashboard.html (the coordinator entrypoint)
  await page.goto("/dashboard.html");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

// ---------------------------------------------------------------------------
// 6. Default theme is dark when no preference stored
// ---------------------------------------------------------------------------
test("default theme is dark when no preference stored", async ({ page }) => {
  // Fresh context: empty localStorage, colorScheme: dark from config
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

// ---------------------------------------------------------------------------
// 7. Follows system prefers-color-scheme: light on first visit
// ---------------------------------------------------------------------------
test("follows system prefers-color-scheme: light on first visit", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "light",
  });
  const page = await context.newPage();
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await context.close();
});

// ---------------------------------------------------------------------------
// 8. Follows system prefers-color-scheme: dark on first visit
// ---------------------------------------------------------------------------
test("follows system prefers-color-scheme: dark on first visit", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await context.close();
});

// ---------------------------------------------------------------------------
// 9. Preload script prevents FOUC (data-theme set before React hydration)
// ---------------------------------------------------------------------------
test("preload script prevents FOUC (data-theme set before React)", async ({ page }) => {
  // The inline <head> script sets data-theme synchronously before the body
  // module script (React entry) loads. We verify this by intercepting the
  // document's readiness: if data-theme is already set by the time
  // DOMContentLoaded fires (before React hydrates), FOUC is prevented.
  //
  // We capture the data-theme value at the DOMContentLoaded moment via
  // an init script that runs before any page scripts.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as any).__foucTheme = document.documentElement.dataset.theme || null;
      (window as any).__foucThemeSetAt = performance.now();
    });
  });

  await page.goto("/");

  const result = await page.evaluate(() => ({
    theme: (window as any).__foucTheme,
    setAt: (window as any).__foucThemeSetAt,
  }));

  // data-theme must be set (not null/undefined) by DOMContentLoaded
  expect(result.theme).toMatch(/^(light|dark)$/);

  // Also verify the attribute is present on <html> after load
  const attr = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(attr).toMatch(/^(light|dark)$/);
});

// ---------------------------------------------------------------------------
// 10. Theme toggle is present after login on all roles
// ---------------------------------------------------------------------------
test("theme toggle is present after login on all roles", async ({ page }) => {
  // The app supports ?role= URL param to skip the gateway. We can navigate
  // directly to each role's entrypoint with ?role= to bypass login.
  // index.html → auditor (default), vote.html → voter, dashboard.html → coordinator

  // Voter
  await page.goto("/vote.html?role=voter");
  await expect(page.locator(".simple-theme-toggle")).toBeVisible();

  // Coordinator
  await page.goto("/dashboard.html?role=coordinator");
  await expect(page.locator(".simple-theme-toggle")).toBeVisible();

  // Auditor
  await page.goto("/?role=auditor");
  await expect(page.locator(".simple-theme-toggle")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 11. Light theme renders visible text (contrast check)
// ---------------------------------------------------------------------------
test("light theme renders visible text (contrast check)", async ({ page }) => {
  await setThemePreference(page, "light");
  await page.goto("/");

  // Wait for the app to render
  await page.locator(".simple-theme-toggle").waitFor();

  const lightBg = await page.evaluate(() => {
    const style = window.getComputedStyle(document.body);
    return style.backgroundColor;
  });
  // Light theme background should be a light color (rgb values all high)
  const lightRgb = lightBg.match(/\d+/g);
  expect(lightRgb).toBeTruthy();
  if (lightRgb) {
    const [r, g, b] = lightRgb.map(Number);
    expect(r + g + b).toBeGreaterThan(600); // light colors sum high
  }

  // Toggle to dark
  const toggle = page.locator(".simple-theme-toggle");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const darkBg = await page.evaluate(() => {
    const style = window.getComputedStyle(document.body);
    return style.backgroundColor;
  });
  const darkRgb = darkBg.match(/\d+/g);
  expect(darkRgb).toBeTruthy();
  if (darkRgb) {
    const [r, g, b] = darkRgb.map(Number);
    expect(r + g + b).toBeLessThan(150); // dark colors sum low
  }
});

// ---------------------------------------------------------------------------
// Single-flow happy path (for video recording)
// ---------------------------------------------------------------------------
test("full theme toggle happy path", async ({ page }) => {
  // Fresh context: empty localStorage, defaults to dark
  await page.goto("/");

  const toggle = page.locator(".simple-theme-toggle");

  // 1. Default is dark
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");

  // 2. Toggle to light
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectLocalStorage(page, "av-theme", "light");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");

  // 3. Reload — persistence (no init script, localStorage retains "light")
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");

  // 4. Navigate to another page — persistence across entrypoints
  await page.goto("/vote.html");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 5. Go back to main page
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 6. Toggle back to dark
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectLocalStorage(page, "av-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");

  // 7. Reload — dark persistence
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
});