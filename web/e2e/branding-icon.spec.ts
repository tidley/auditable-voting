import { test, expect } from "@playwright/test";

/**
 * Instance branding. The app must advertise the Auroville symbol as its icon on
 * every entrypoint, and the shared-link card (og:image) must be the branded
 * 1200x630 PNG instead of the upstream logo.
 *
 * Source: the public-domain Auroville symbol
 * (https://commons.wikimedia.org/wiki/File:Auroville_symbol.svg), vendored as
 * web/public/images/auroville-symbol.svg plus a rasterised .png for clients
 * that reject SVG favicons or SVG og:image.
 */

const ENTRYPOINTS = [
  "/",
  "/vote.html",
  "/dashboard.html",
  "/simple.html",
  "/simple-coordinator.html",
];

for (const path of ENTRYPOINTS) {
  test(`${path} advertises the Auroville symbol as its icon`, async ({ page }) => {
    // Only <head> metadata is asserted here, so wait for DOMContentLoaded
    // rather than "load": the heavier entrypoints (index.html boots the auditor
    // app) can exceed the default timeout on a cold Vite dev server, which is a
    // test-infrastructure flake unrelated to the branding under test.
    test.setTimeout(60_000);
    await page.goto(path, { waitUntil: "domcontentloaded" });

    const svgIcon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(svgIcon).toHaveAttribute("href", /images\/auroville-symbol\.svg$/);

    const pngIcon = page.locator('link[rel="alternate icon"]');
    await expect(pngIcon).toHaveAttribute("href", /images\/auroville-symbol\.png$/);

    const appleIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(appleIcon).toHaveAttribute("href", /images\/auroville-symbol\.png$/);

    // The referenced files must actually be served, not just linked.
    for (const locator of [svgIcon, pngIcon]) {
      const href = await locator.getAttribute("href");
      const response = await page.request.get(href as string);
      expect(response.status(), `${href} should be reachable`).toBe(200);
    }
  });
}

test("link-preview card uses the branded og-image", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /images\/og-image\.png$/,
  );
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute("content", "630");
});

test("no entrypoint still references the upstream logo branding", async ({ page }) => {
  test.setTimeout(60_000);
  for (const path of ENTRYPOINTS) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    expect(html, `${path} must not reference the upstream logo`).not.toContain("images/logo.png");
    expect(html, `${path} must not reference the upstream og card`).not.toContain("og-image.jpg");
  }
});
