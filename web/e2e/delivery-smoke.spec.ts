import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Real delivery component and production styles, with invitation registration
// stubbed. No SMTP, public relay messages or real voter data are used here.
for (const theme of ['light', 'dark']) {
  test(`registered invitations are hidden, exported and recoverable in ${theme}`, async ({ page }) => {
    await page.goto('/e2e/resident-delivery-harness.html');
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByLabel('Residents CSV or saved invitation batch').setInputFiles({ name: 'residents.csv', mimeType: 'text/csv', buffer: Buffer.from('masters_list_number,email,phone,name\n401,alice@example.org,,Alice Archer\n402,bob@example.org,,Bob Baker') });
    await expect(page.getByRole('table', { name: 'Resident invitations' }).locator('tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: 'Generate missing invitations' }).click();
    await expect(page.getByText('Generated', { exact: true })).toHaveCount(2);
    await expect(page.locator('.simple-resident-invite-secret')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reveal invitation for resident 401' }).click();
    await expect(page.locator('.simple-resident-invite-secret')).toHaveCount(1);
    const secret = await page.locator('.simple-resident-invite-secret').innerText();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download private email batch' }).click();
    const downloaded = await downloadEvent;
    const path = test.info().outputPath('private-test-batch.json');
    await downloaded.saveAs(path);
    const batch = JSON.parse(await readFile(path, 'utf8'));
    const { validateBatch } = await import(new URL('../scripts/smtpDelivery.mjs', import.meta.url).href);
    expect(validateBatch(batch).invitations).toHaveLength(2);
    expect(batch.invitations[0].inviteUrl).toBe(secret);
    expect(batch.invitations[0].email).toBe('alice@example.org');
    await page.getByLabel('Delivery channel', { exact: true }).selectOption('email-smtp2go');
    await expect(page.locator('.simple-resident-invite-secret')).toHaveCount(0);
    await expect(page.getByText(/This tab never receives SMTP credentials/)).toBeVisible();
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.screenshot({ path: test.info().outputPath(`resident-delivery-${theme}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: test.info().outputPath(`resident-delivery-${theme}-desktop.png`), fullPage: true });
    await page.reload();
    await page.getByLabel('Residents CSV or saved invitation batch').setInputFiles(path);
    await expect(page.getByText('Generated', { exact: true })).toHaveCount(2);
    await expect(page.locator('.simple-resident-invite-secret')).toHaveCount(0);
  });
}
