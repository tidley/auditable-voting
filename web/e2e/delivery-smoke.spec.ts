import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const VALID_CSV = [
  "masters_list_number,email,phone,name",
  "401,alice@example.test,5550401,Alice Archer",
  "402,bob@example.test,5550402,Bob Baker",
  "403,carol@example.test,,Carol Cruz",
].join("\n");

async function setExpiry(page: Page) {
  for (const [segment, value] of [["day", "01"], ["month", "01"], ["year", "2099"], ["hour", "12"], ["minute", "30"]]) {
    await page.getByRole("spinbutton", { name: new RegExp(`^${segment},`) }).pressSequentially(value);
  }
}

async function importCsv(page: Page, csv = VALID_CSV, name = "residents.csv") {
  await page.getByLabel("Import resident or delivery results CSV", { exact: true }).setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
}

// Production component + real code generation and CSV export; admission runtime
// is stubbed. This is deliberately NOT a relay redemption or real-email claim.
test("resident email admission: one import, editable table, masked codes and exact bundle export", async ({ page }) => {
  await page.goto("/e2e/resident-email-harness.html");
  const section = page.getByRole("region", { name: "Resident email admission" });
  await expect(section.locator("input[type='file']")).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Import", exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Export", exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Set defaults", exact: true })).toHaveCount(1);

  await importCsv(page);
  await expect(section.getByText("3 residents imported.")).toBeVisible();
  const residents = section.getByRole("table", { name: "Residents" });
  await expect(residents.locator("tbody tr")).toHaveCount(3);
  await expect(section.getByRole("textbox", { name: "Name for row resident-row-1" })).toHaveValue("Alice Archer");

  await section.getByRole("button", { name: "Set defaults" }).click();
  await expect(section.getByText("Default expiry set to 24 hours from now.")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: /^year,/ })).toHaveAttribute("aria-valuenow", String(new Date().getFullYear()));
  await section.getByRole("button", { name: "Generate admission codes" }).click();
  await expect(section.getByRole("button", { name: "Choose date and time Code expiry" })).toBeDisabled();

  for (const master of [401, 402, 403]) {
    const row = section.getByLabel(`Code for resident ${master}`, { exact: true });
    await expect(row.locator("code")).toHaveText("•••••-•••••");
    await expect(row.getByRole("button", { name: "Copy code", exact: true })).toHaveCount(0);
  }
  await section.getByRole("button", { name: "Reveal code for resident 401" }).click();
  const firstCode = await section.getByLabel("Code for resident 401", { exact: true }).locator("code").innerText();
  expect(firstCode).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
  await section.getByRole("button", { name: "Copy code for resident 401" }).click();
  await expect(section.getByRole("button", { name: "Copied code for resident 401", exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Hide code for resident 401" }).click();
  await expect(section.getByLabel("Code for resident 401", { exact: true }).locator("code")).toHaveText("•••••-•••••");
  await expect(section.getByRole("button", { name: "Add row" })).toBeDisabled();

  const downloadEvent = page.waitForEvent("download");
  await section.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("resident-admission-emails-resident-email-harness.csv");
  const path = test.info().outputPath("admission-bundle.csv");
  await download.saveAs(path);
  const csv = await readFile(path, "utf8");
  const lines = csv.split("\n");
  expect(lines[0]).toBe("masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url");
  expect(lines).toHaveLength(4);
  expect(lines[1]).toContain(firstCode.replace("-", ""));
  expect(lines[1]).toContain("alice@example.test");
  const expiryMs = Date.parse(lines[1].split(",")[5] ?? "");
  expect(Math.abs(expiryMs - (Date.now() + 24 * 60 * 60 * 1000))).toBeLessThan(5 * 60 * 1000);
  expect(lines[1]).toContain("role=voter&q=resident-email-harness");
  expect(lines[1]).not.toContain("invite_code=");

  await page.reload();
  await expect(section.getByRole("table", { name: "Residents" })).toHaveCount(0);
  await expect(section.locator("[aria-label^='Code for resident']")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Export" })).toBeDisabled();
  await importCsv(page, [
    "masters_list_number,email,phone,name",
    "401,alice@example.test,,Alice",
    "401,duplicate@example.test,,Duplicate",
  ].join("\n"));
  await expect(section.getByRole("alert")).toContainText("duplicate masters_list_number");
});

test("resident email admission imports delivery results into the same table", async ({ page }) => {
  await page.goto("/e2e/resident-email-harness.html");
  const section = page.getByRole("region", { name: "Resident email admission" });
  await importCsv(page);
  await importCsv(page, "mastersListNumber,ok,detail,ref\n401,true,sent,mail-1\n402,false,send failed (HTTP 400),\n", "results.csv");
  const table = section.getByRole("table", { name: "Residents" });
  await expect(table).toContainText("Sent");
  await expect(table).toContainText("Failed: send failed (HTTP 400)");
  await expect(table).not.toContainText("alice@example.testFailed");
  expect(await table.innerText()).not.toContain("mail-1");
  await expect(section.getByText("2 delivery status rows imported.")).toBeVisible();
});

test("connecting the local sender enables Send emails and updates Delivery", async ({ page }) => {
  let submittedBody: { transport?: string; bundleCsv?: string } = {};
  await page.route("**/__email/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }),
    });
  });
  await page.route("**/__email/send", async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sent: 3,
        skipped: 0,
        failed: 0,
        results: [401, 402, 403].map((master) => ({ master: String(master), ok: true, detail: "sent", ref: `mail-${master}` })),
      }),
    });
  });
  await page.goto("/e2e/resident-email-harness.html");
  const section = page.getByRole("region", { name: "Resident email admission" });
  await importCsv(page);
  await section.getByRole("button", { name: "Set defaults" }).click();
  await section.getByRole("button", { name: "Generate admission codes" }).click();
  await expect(section.getByLabel("Code for resident 401", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Email sender", { exact: true })).toHaveValue("smtp");
  await section.getByRole("button", { name: "Send emails", exact: true }).click();
  await expect(section.getByText("Email delivery: 3 sent, 0 already sent, 0 failed.")).toBeVisible();
  await expect(section.getByRole("table", { name: "Residents" })).toContainText("Sent");
  expect(submittedBody.transport).toBe("smtp");
  expect(submittedBody.bundleCsv).toContain("questionnaire_title");
  expect(submittedBody.bundleCsv).toContain("alice@example.test");
  expect(submittedBody.bundleCsv).toMatch(/[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}/);
});
