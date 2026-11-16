import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const VALID_CSV = [
  "masters_list_number,email,phone,name",
  "401,alice@example.test,5550401,Alice Archer",
  "402,bob@example.test,5550402,Bob Baker",
  "403,carol@example.test,,Carol Cruz",
].join("\n");

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function importCsv(page: Page, csv = VALID_CSV, name = "residents.csv") {
  await page.getByLabel("Import resident CSV", { exact: true }).setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
}

// Production component + real code generation and CSV export; admission runtime
// is stubbed. This is deliberately NOT a relay redemption or delivery claim.
test("resident admission: one import, editable table, masked codes and exact bundle export", async ({ page }) => {
  await page.goto("/e2e/resident-email-harness.html");
  const section = page.getByRole("region", { name: "Resident email admission" });
  await expect(section.locator("input[type='file']")).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Import", exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Export", exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Set defaults", exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Send emails", exact: true })).toHaveCount(0);

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
  expect(lines[1]).not.toContain("request_ballot");
  expect(lines[1]).not.toContain("auto_request");
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
