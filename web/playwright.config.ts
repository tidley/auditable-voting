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
 */
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
    channel: "chrome",
    colorScheme: "dark",
  },
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});