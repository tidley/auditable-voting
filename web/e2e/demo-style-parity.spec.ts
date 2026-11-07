import { test, expect, type Page } from '@playwright/test';

const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'borderTopColor', 'borderTopWidth', 'minHeight', 'paddingTop', 'paddingRight'] as const;
async function appearance(page: Page, selector: string) {
  return page.locator(selector).evaluate((node, keys) => {
    const style = getComputedStyle(node);
    return Object.fromEntries(keys.map(key => [key, style[key as keyof CSSStyleDeclaration]]));
  }, [...properties]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`demo matches application ${theme} typography, surfaces and controls`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate(theme => {
      localStorage.setItem('av-theme', theme);
      document.documentElement.dataset.theme = theme;
      const samples = document.createElement('section');
      samples.id = 'style-parity-samples';
      samples.innerHTML = '<h1 class="simple-voter-title">Title</h1><h2 class="simple-voter-section-title">Section</h2><button id="reference-primary" class="av-ui-button av-ui-button-primary simple-voter-primary">Primary</button><button id="reference-secondary" class="av-ui-button av-ui-button-secondary simple-voter-secondary">Secondary</button><input id="reference-input" class="av-ui-input" aria-label="Reference field">';
      document.body.append(samples);
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    const reference = {
      body: await appearance(page, 'body'),
      title: await appearance(page, '#style-parity-samples h1'),
      section: await appearance(page, '#style-parity-samples h2'),
      primary: await appearance(page, '#reference-primary'),
      secondary: await appearance(page, '#reference-secondary'),
      field: await appearance(page, '#reference-input'),
    };
    await page.locator('#reference-primary').hover();
    await page.locator('#reference-primary').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    const primaryHover = await appearance(page, '#reference-primary');
    await page.locator('#reference-input').focus();
    await page.locator('#reference-input').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    const fieldFocus = await appearance(page, '#reference-input');
    await page.goto('/demo.html');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const body = await appearance(page, 'body');
    for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'color', 'backgroundColor']) expect(body[key], `body.${key}`).toBe(reference.body[key]);
    const title = await appearance(page, '#questionnaire-title');
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']) expect(title[key], `title.${key}`).toBe(reference.title[key]);
    const section = await appearance(page, '.chapter h2');
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']) expect(section[key], `section.${key}`).toBe(reference.section[key]);
    expect(await appearance(page, '[data-action="PREPARE"]')).toEqual(reference.primary);
    expect(await appearance(page, '#reset')).toEqual(reference.secondary);
    expect(await page.evaluate(() => document.fonts.check('16px "Plus Jakarta Sans"'))).toBe(true);
    await page.locator('[data-action="PREPARE"]').hover();
    await page.locator('[data-action="PREPARE"]').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    expect((await appearance(page, '[data-action="PREPARE"]')).backgroundColor).toBe(primaryHover.backgroundColor);
    expect((await appearance(page, '[data-action="PREPARE"]')).color).toBe(primaryHover.color);
    await page.getByRole('button', { name: 'Review questionnaire', exact: true }).click();
    await page.getByRole('button', { name: 'Go Live', exact: true }).click();
    expect(await appearance(page, '#paper-code')).toEqual(reference.field);
    await page.locator('#paper-code').focus();
    await expect.poll(async () => (await appearance(page, '#paper-code')).borderTopColor).toBe(fieldFocus.borderTopColor);
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
  });
}
