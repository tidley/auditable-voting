import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for recording the auditable-voting E2E video
 * against the live GitHub Pages deployment.
 *
 * - NO webServer — the site is hosted externally at
 *   https://felixfelix-bot.github.io/auditable-voting/
 * - video: "on" captures a WebM per browser context
 * - channel: "chrome" uses the system google-chrome-stable for realistic
 *   rendering and reliable WebCodecs/wasm.
 * - viewport 1400x900 for a wide, readable frame.
 */
export default defineConfig({
  testDir: ".",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "https://felixfelix-bot.github.io",
    viewport: { width: 1400, height: 900 },
    video: "on",
    screenshot: "on",
    channel: "chrome",
    colorScheme: "light",
    trace: "off",
    actionTimeout: 30_000,
  },
  // NO webServer — target is the hosted GitHub Pages site.
});
