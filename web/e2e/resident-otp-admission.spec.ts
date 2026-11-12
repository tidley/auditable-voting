import { test, expect, type Page } from '@playwright/test';

async function openResidents(page: Page) {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.goto('/dashboard.html?role=coordinator');
  await page.getByRole('navigation', { name: 'Questionnaire navigation' }).getByRole('button', { name: 'Voters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Resident invitation delivery' })).toBeVisible();
}
test('one resident upload replaces disconnected preview tools; unpublished generation is blocked', async ({ page }) => {
  await openResidents(page);
  await expect(page.getByLabel('Residents CSV or saved invitation batch')).toHaveCount(1);
  await expect(page.getByLabel('Residents CSV file', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verify code', exact: true })).toHaveCount(0);
  await page.getByLabel('Residents CSV or saved invitation batch').setInputFiles({ name: 'residents.csv', mimeType: 'text/csv', buffer: Buffer.from('masters_list_number,email,phone,name\n101,alice@example.org,,Alice') });
  await expect(page.getByRole('button', { name: 'Generate invitation for resident 101' })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Questionnaire navigation' }).getByRole('button', { name: 'Guardian', exact: true }).click();
  await page.getByRole('navigation', { name: 'Questionnaire navigation' }).getByRole('button', { name: 'Voters', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Resident invitations' })).toContainText('alice@example.org');
});
test('invalid CSV reports errors without creating invitations', async ({ page }) => {
  await openResidents(page);
  await page.getByLabel('Residents CSV or saved invitation batch').setInputFiles({ name: 'residents.csv', mimeType: 'text/csv', buffer: Buffer.from('masters_list_number,email,phone,name\n101,not-an-email,,Alice') });
  await expect(page.getByRole('region', { name: 'Resident invitation delivery' }).getByRole('alert')).toContainText('invalid email');
  await expect(page.getByRole('table', { name: 'Resident invitations' })).toHaveCount(0);
});
