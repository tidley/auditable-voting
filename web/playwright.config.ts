import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E configuration for auditable-voting.
 *
 * Theme toggle tests (e2e/theme-toggle.spec.ts) exercise the actual
 * ThemeToggle.tsx component and inline preload scripts through the
 * Vite dev server on port 5173.
 *
 * Uses the system-installed google-chrome-stable via channel: 'chrome'.
 * Default colorScheme is 'dark' so tests that clear localStorage get
 * the expected dark default (matches app's fallback).
 *
 * Set PLAYWRIGHT_USE_BUNDLED_CHROMIUM=1 to use Playwright's bundled Chromium
 * instead of a system Chrome install. CI runners ship Chromium via
 * `npx playwright install` but have no google-chrome-stable, so the e2e job
 * sets this; local runs keep using the system browser.
 */
const useBundledChromium = process.env.PLAYWRIGHT_USE_BUNDLED_CHROMIUM === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    video: "on",
    screenshot: "only-on-failure",
    channel: useBundledChromium ? undefined : "chrome",
    colorScheme: "dark",
  },
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: true,
    // Generous because `npm run dev` triggers the `predev` wasm build on a
    // cold checkout. CI builds the artifacts in an earlier step so this is
    // normally fast, but a 60s budget proved too tight on a fresh runner.
    timeout: 180_000,
  },
});