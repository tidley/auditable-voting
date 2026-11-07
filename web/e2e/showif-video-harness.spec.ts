import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`organiser adds a linked follow-up in the ${theme} theme without publishing`, async ({ page }) => {
    // Use a fresh browser context and block relay traffic, not the user's draft.
    await page.routeWebSocket(/.*/, socket => socket.close());
    await page.addInitScript(theme => localStorage.setItem('av-theme', theme), theme);
    await page.goto('/dashboard.html?role=coordinator');
    await page.getByLabel('Title', { exact: true }).fill('Follow-up setup check');
    await page.getByLabel('Question 1 prompt', { exact: true }).fill('Do you agree?');
    await expect(page.getByLabel('Question 1 visibility')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add follow-up to question 1', exact: true }).click();
    await expect(page.getByLabel('Question 1-A prompt', { exact: true })).toBeFocused();
    await page.getByLabel('Question 1-A prompt', { exact: true }).fill('Who should take part?');
    await expect(page.getByText('Follow-up to question 1', { exact: true })).toBeVisible();
    const child = page.getByRole('group', { name: 'Question 1-A', exact: true });
    const parent = page.getByRole('group', { name: 'Question 1', exact: true });
    await expect(parent.getByRole('group', { name: 'Question 1-A', exact: true })).toBeVisible();
    await expect(page.getByLabel('Question 2 depends on')).toHaveCount(0);
    await page.getByLabel('Question 1-A required answer No', { exact: true }).check();
    await page.getByLabel('Question 1-A type', { exact: true }).selectOption('multiple_choice');
    await expect(page.getByLabel('Question 1-A required answer No', { exact: true })).toBeChecked();
    await page.reload();
    await expect(page.getByLabel('Question 1-A required answer No', { exact: true })).toBeChecked();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel('Question 1-A prompt', { exact: true })).toHaveValue('Who should take part?');
      await expect.poll(() => page.locator('.simple-questionnaire-option-stack').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(width === 375 ? 1 : 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const action = await page.getByRole('button', { name: 'Add follow-up to question 1-A', exact: true }).boundingBox();
      const option = await page.getByLabel('Option 1', { exact: true }).boundingBox();
      expect(action).not.toBeNull();
      expect(option).not.toBeNull();
      expect(action!.y + action!.height <= option!.y || option!.y + option!.height <= action!.y).toBe(true);
      const childBox = await child.boundingBox();
      const parentBox = await parent.boundingBox();
      expect(childBox!.x).toBeGreaterThan(parentBox!.x);
      expect(childBox!.x + childBox!.width).toBeLessThan(parentBox!.x + parentBox!.width);
      const toggleBox = await child.locator('.av-ui-switch').filter({ hasText: 'Allow multiple selections' }).boundingBox();
      expect(toggleBox!.x + toggleBox!.width).toBeLessThan(childBox!.x + childBox!.width);
      const conditionBeforeHeading = await child.evaluate(node => {
        const condition = node.querySelector(':scope > .simple-questionnaire-conditional-config')!;
        const heading = node.querySelector(':scope > .simple-questionnaire-question-head')!;
        return condition.getBoundingClientRect().bottom <= heading.getBoundingClientRect().top;
      });
      expect(conditionBeforeHeading).toBe(true);
      expect(await child.evaluate(node => node.firstElementChild?.classList.contains('simple-questionnaire-conditional-config'))).toBe(true);
      const selectedAnswer = page.getByLabel('Question 1-A required answer No', { exact: true });
      await expect(selectedAnswer).toHaveCSS('appearance', 'none');
      await expect(selectedAnswer).toHaveCSS('width', '18px');
      const selectedColour = await selectedAnswer.evaluate(node => getComputedStyle(node).borderTopColor);
      const themeColour = await child.locator(':scope > .simple-questionnaire-question-head .simple-questionnaire-question-title').evaluate(node => getComputedStyle(node).color);
      expect(selectedColour).toBe(themeColour);
    }
    await page.getByLabel('Question 1-A required answer No', { exact: true }).press('ArrowLeft');
    const yes = page.getByLabel('Question 1-A required answer Yes', { exact: true });
    await expect(yes).toBeChecked();
    await expect(yes).toBeFocused();
    await expect(yes).toHaveCSS('outline-style', 'solid');
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(yes).toHaveCSS('appearance', 'auto');
    await page.emulateMedia({ forcedColors: 'none' });
    await page.getByRole('button', { name: 'Make question 1-A standalone', exact: true }).click();
    await expect(page.getByLabel('Question 1-A required answer No', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Question 2', exact: true })).toBeVisible();
  });
}
