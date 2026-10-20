import { test, expect } from "@playwright/test";

test("active voter switches locales, retains answers and safely resolves conditional text", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/i18n-voter-harness.html");
  // Real browser WASM matches the worker vectors, without the Vitest stub.
  await expect(page.getByLabel("Legacy definition hash", { exact: true })).toHaveText("45f68db54b8cceac5ba13b025aa74da46d10f2590d27cf5fba339e828081b9c8");
  await expect(page.getByLabel("Translated definition hash", { exact: true })).toHaveText("07cc770c450a680b12718841154a0276b7e6e969dd076b665a9dbdc9ab983fb7");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("fr");
  await expect(page.getByRole("heading", { name: "Question française", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Oui", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Suivant/ }).click();
  await expect(page.getByRole("heading", { name: "English follow-up", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "One", exact: true }).check();
  await expect(page.getByRole("button", { name: /En attente du justificatif de vote/ })).toBeVisible();
  await page.getByRole("button", { name: /Précédent/ }).click();
  await page.getByRole("combobox", { name: "Langue", exact: true }).selectOption("ta");
  await expect(page.getByRole("heading", { name: "தமிழ் கேள்வி", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ஆம்", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "இல்லை", exact: true }).click();
  await expect(page.getByRole("button", { name: /அடுத்து/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Paper code", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
