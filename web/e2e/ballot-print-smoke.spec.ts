import { expect, test, type Page } from "@playwright/test";
import { pathToFileURL } from 'node:url';

async function setExpiry(page: Page) {
  for (const [segment, value] of [['day', '01'], ['month', '01'], ['year', '2030'], ['hour', '12'], ['minute', '30']]) {
    await page.getByRole('spinbutton', { name: new RegExp(`^${segment},`) }).pressSequentially(value);
  }
}

// Component integration harness: real coordinator/print UI and production CSS,
// with admission persistence stubbed. This is not a relay admission E2E test.
test("paper ballots open as a separate printable and downloadable document", async ({ page }) => {
  await page.goto("/e2e/ballot-print-harness.html");
  await page.getByLabel("Master-list numbers", { exact: true }).fill("ML-001\nML-002");
  await setExpiry(page);
  await page.getByRole("button", { name: "Generate printable codes" }).click();
  await expect(page.locator('.ballot-print')).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Open printable ballots', exact: true }).click();
  const documentPage = await popupPromise;
  await documentPage.waitForLoadState('domcontentloaded');
  expect(await documentPage.evaluate(() => window.opener)).toBeNull();
  const ballots = documentPage.locator(".ballot-print");
  await expect(ballots).toHaveCount(2);
  await expect(ballots.first().locator("code")).toHaveText(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
  await expect(ballots.first()).toContainText("includes all of: Raised beds; Tool library. Other selections are allowed.");
  await expect(ballots.first()).toContainText("Otherwise leave blank.");
  await expect(documentPage.locator("body")).not.toContainText(/nsec|npub|Serial:/);
  await expect(documentPage.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'/);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download HTML', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^paper-ballots-.*\.html$/);
  const downloadedPath = test.info().outputPath('paper-ballots.html');
  await download.saveAs(downloadedPath);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Open printable ballots', exact: true })).toHaveCount(0);
  await page.context().setOffline(true);
  const downloadedDocument = await page.context().newPage();
  await downloadedDocument.goto(pathToFileURL(downloadedPath).href);
  await expect(downloadedDocument.locator('.ballot-print')).toHaveCount(2);
  await expect(downloadedDocument.locator('.ballot-print').first().locator('code')).toHaveText(await ballots.first().locator('code').innerText());

  await documentPage.emulateMedia({ media: "print" });
  // These checks fail if the real stylesheet hides any ancestor of the ballot.
  await expect(ballots.first()).toBeVisible();
  await expect(ballots.last()).toBeVisible();
  await expect(documentPage.getByRole("button", { name: "Generate printable codes" })).toHaveCount(0);
  await expect(documentPage.getByLabel("Master-list numbers", { exact: true })).toHaveCount(0);
  await expect(documentPage.locator(".harness-navigation")).toHaveCount(0);
  await expect(documentPage.locator('.paper-document-help')).toBeHidden();
  expect(await ballots.first().evaluate(el => getComputedStyle(el).breakAfter)).toBe("page");
  await documentPage.screenshot({ path: test.info().outputPath("paper-ballots-print.png"), fullPage: true });
  const pdf = await documentPage.pdf({ path: test.info().outputPath("paper-ballots.pdf"), format: "A4" });
  expect([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(2);
});

for (const theme of ['light', 'dark'] as const) {
  test(`paper expiry picker follows the ${theme} theme`, async ({ page }) => {
    await page.goto('/e2e/ballot-print-harness.html');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await setExpiry(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('button', { name: /^Choose date and time/ })).toBeVisible();
    await page.getByRole('button', { name: /^Choose date and time/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const colours = await page.locator('.av-ui-calendar-popover').evaluate(node => {
      const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--surface-inset)'; node.append(probe);
      const expected = getComputedStyle(probe).backgroundColor; probe.remove();
      return { actual: getComputedStyle(node).backgroundColor, expected };
    });
    expect(colours.actual).toBe(colours.expected);
    const popup = await page.locator('.av-ui-calendar-popover').boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(0);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(375);
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'February 2030', exact: true })).toBeVisible();
    await page.locator('.av-ui-calendar-cell:not([data-outside-month])').filter({ hasText: /^2$/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('spinbutton', { name: /^month,/ })).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('spinbutton', { name: /^day,/ })).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('spinbutton', { name: /^hour,/ })).toHaveAttribute('aria-valuenow', '12');
    await expect(page.getByRole('spinbutton', { name: /^minute,/ })).toHaveAttribute('aria-valuenow', '30');
  });
  test(`paper code boxes support typing, grouped paste and mobile layout in ${theme}`, async ({ page }) => {
    await page.goto('/e2e/ballot-print-harness.html');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const cells = page.locator('.simple-paper-code-character');
    await cells.first().focus();
    await page.keyboard.type('7k3m9t2x4r');
    await expect(cells.last()).toBeFocused();
    expect(await cells.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value).join(''))).toBe('7K3M9T2X4R');
    await cells.nth(4).evaluate(node => {
      const data = new DataTransfer(); data.setData('text', 'ABCD1-234EF');
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
    });
    expect(await cells.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value).join(''))).toBe('ABCD1234EF');
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(cells.first()).toBeVisible();
      await expect(cells.last()).toBeVisible();
    }
  });
}

test('an incomplete or invalid expiry cannot generate paper codes', async ({ page }) => {
  await page.goto('/e2e/ballot-print-harness.html');
  await page.getByLabel('Master-list numbers', { exact: true }).fill('1234');
  await setExpiry(page);
  await page.getByRole('spinbutton', { name: /^year,/ }).press('Backspace');
  await page.getByRole('button', { name: 'Generate printable codes', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open printable ballots', exact: true })).toHaveCount(0);
  await expect(page.getByText('Code expiry must be in the future.', { exact: true })).toBeVisible();
});
