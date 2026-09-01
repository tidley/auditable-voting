import { test, expect, type Page } from "@playwright/test";

/**
 * Delivery smoke test — opens the coordinator dashboard, uploads a roster
 * CSV, generates OTP codes via the DeliveryPanel, selects the manual channel,
 * verifies codes are displayed, and exports the name+code CSV.
 *
 * Follows the same patterns as resident-otp-admission.spec.ts (same selectors,
 * same page setup via ?role=coordinator).
 */

const VALID_CSV = [
  "masters_list_number,email,phone,name",
  "401,alice@example.com,5550401,Alice Archer",
  "402,bob@example.com,5550402,Bob Baker",
  "403,carol@example.com,,Carol Cruz",
].join("\n");

/** Open the coordinator dashboard and navigate to the participants tab. */
async function gotoDeliveryPanel(page: Page): Promise<void> {
  await page.goto("/dashboard.html?role=coordinator");
  const nav = page.locator("nav[aria-label='Questionnaire navigation']");
  await expect(nav).toBeVisible();
  // Click the "Voters" tab button to reach the participants tab
  await nav.getByRole("button", { name: "Voters", exact: true }).click();
}

test("delivery smoke: CSV upload → manual channel → generate codes → export", async ({ page }) => {
  test.setTimeout(60_000);

  // 1. Open coordinator dashboard and go to Voters tab
  await gotoDeliveryPanel(page);

  // 2. The DeliveryPanel section should be present
  const deliverySection = page.locator("section[aria-label='OTP delivery']");
  await expect(deliverySection).toBeVisible();
  await deliverySection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);

  // 3. Select "manual" delivery channel (it's the default, but let's be explicit)
  const channelSelect = page.locator("select[aria-label='Delivery channel']");
  await expect(channelSelect).toBeVisible();
  await channelSelect.selectOption("manual");
  await page.waitForTimeout(400);

  // 4. Upload a valid CSV via the Residents CSV file input scoped to delivery section
  const deliveryFileInput = deliverySection.getByLabel("Residents CSV file");
  await deliveryFileInput.setInputFiles({
    name: "residents.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(VALID_CSV, "utf8"),
  });
  await page.waitForTimeout(600);

  // 5. Verify the residents table appears with 3 rows
  const table = deliverySection.locator("table[aria-label='Residents']");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.waitForTimeout(600);

  // 6. Generate codes for all residents
  const generateAllBtn = page.locator(
    "button[aria-label='Generate codes for all residents']",
  );
  await expect(generateAllBtn).toBeVisible();
  await generateAllBtn.click();
  await page.waitForTimeout(800);

  // 7. Verify manual codes are displayed in the "Issued codes" panel
  const issuedPanel = page.locator("[aria-label='Issued codes']");
  await expect(issuedPanel).toBeVisible();
  await expect(issuedPanel).toContainText("Shown once");
  // Each resident should have a code displayed
  for (const num of [401, 402, 403]) {
    const codeRow = page.locator(`[aria-label='Code for resident ${num}']`);
    await expect(codeRow).toBeVisible();
    const code = codeRow.locator("code");
    await expect(code).toHaveText(/^\d{6}$/);
  }
  await page.waitForTimeout(600);

  // 8. Export CSV (if button exists)
  const exportBtn = page.locator("button[aria-label='Export name+code CSV']");
  await expect(exportBtn).toBeVisible();
  await expect(exportBtn).toBeEnabled();
  await exportBtn.click();
  await page.waitForTimeout(900);
});