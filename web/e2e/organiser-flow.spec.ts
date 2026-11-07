import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`organiser follows a quiet sequential workspace in ${theme}`, async ({ page }) => {
    await page.routeWebSocket(/.*/, socket => socket.close());
    await page.addInitScript(theme => localStorage.setItem('av-theme', theme), theme);
    await page.goto('/dashboard.html?role=coordinator');
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Description', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Description', { exact: true })).toHaveAttribute('required', '');
    await expect.poll(async () => {
      const title = await page.locator('.simple-questionnaire-editor-title').boundingBox();
      const toolbar = await page.locator('.simple-questionnaire-build-toolbar').boundingBox();
      return Boolean(title && toolbar && title.y >= toolbar.y + toolbar.height);
    }).toBe(true);
    await expect(page.getByLabel('Question 1 prompt', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Questionnaire ID', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Enable close timer', { exact: true })).toBeHidden();
    await page.getByText('Questionnaire settings', { exact: true }).click();
    await expect(page.getByLabel('Questionnaire ID', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Enable close timer', { exact: true })).toBeVisible();
    await page.getByLabel('Enable close timer', { exact: true }).press('Space');
    await page.getByText('Questionnaire settings', { exact: true }).click();
    await page.getByText('Questionnaire settings', { exact: true }).click();
    await expect(page.getByLabel('Enable close timer', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Next: Guardian', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back: Prepare', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '1. Guardian account', exact: true })).toBeVisible();
    await expect(page.getByLabel('Guardian npub', { exact: true })).toBeVisible();
    await expect(page.getByText('Last heartbeat', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Next: Voters', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Voters', exact: true })).toBeFocused();
    await expect(page.getByLabel('Questionnaire', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Voter npub', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Paper ballot access', exact: true })).toBeHidden();
    await page.getByText('Paper ballots', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Paper ballot access', exact: true })).toBeVisible();
    await expect(page.getByText('Save or print codes before leaving. Do not generate another batch for the same roster.', { exact: true })).toBeVisible();
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(page.getByRole('navigation', { name: 'Questionnaire navigation' }).getByText('3', { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Next: Results', exact: true }).click();
    await expect(page.getByLabel('Voter npub', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back: Voters', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back: Voters', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Paper ballot access', exact: true })).toBeVisible();
  });
}
