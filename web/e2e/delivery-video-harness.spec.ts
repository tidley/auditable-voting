// Video-harness wrapper: runs the delivery-smoke flow in a tall viewport so
// the generated-codes panel is actually visible in the recording.
// Mirrors e2e/delivery-smoke.spec.ts selectors exactly.
import { test, expect, type Page } from "@playwright/test";

const VALID_CSV = [
  "masters_list_number,email,phone,name",
  "401,alice@example.com,5550401,Alice Archer",
  "402,bob@example.com,5550402,Bob Baker",
  "403,carol@example.com,,Carol Cruz",
].join("\n");

test.use({ viewport: { width: 1280, height: 2400 } });

async function gotoDeliveryPanel(page: Page): Promise<void> {
  await page.goto("/dashboard.html?role=coordinator");
  const nav = page.locator("nav[aria-label='Questionnaire navigation']");
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Voters", exact: true }).click();
}

test("delivery smoke (tall viewport): CSV upload → generate → codes visible", async ({ page }) => {
  test.setTimeout(90_000);
  await gotoDeliveryPanel(page);

  const deliverySection = page.locator("section[aria-label='OTP delivery']");
  await expect(deliverySection).toBeVisible();
  await deliverySection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);

  const channelSelect = page.locator("select[aria-label='Delivery channel']");
  await channelSelect.selectOption("manual");
  await page.waitForTimeout(400);

  const deliveryFileInput = deliverySection.getByLabel("Residents CSV file");
  await deliveryFileInput.setInputFiles({
    name: "residents.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(VALID_CSV, "utf8"),
  });
  await page.waitForTimeout(600);

  const table = deliverySection.locator("table[aria-label='Residents']");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3);

  await page.locator("button[aria-label='Generate codes for all residents']").click();
  await page.waitForTimeout(800);

  const issuedPanel = page.locator("[aria-label='Issued codes']");
  await expect(issuedPanel).toBeVisible();
  await issuedPanel.scrollIntoViewIfNeeded();
  await expect(issuedPanel).toContainText("Shown once");
  for (const num of [401, 402, 403]) {
    const codeRow = page.locator(`[aria-label='Code for resident ${num}']`);
    await expect(codeRow).toBeVisible();
    await expect(codeRow.locator("code")).toHaveText(/^\d{6}$/);
  }
  // hold the final state so the video shows the codes clearly
  await page.waitForTimeout(2000);
});
