import { expect, test } from "@playwright/test";

/**
 * Browser-level coverage for starting a new round from a published
 * questionnaire with no invited-voter roster. The harness mounts the real
 * coordinator panel; relay publishing is covered elsewhere.
 */
test("starts a routable new round without an invited-voter roster", async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.goto("/e2e/start-new-round-harness.html");

  const selector = page.getByLabel("Questionnaire", { exact: true });
  await expect(selector).toHaveValue("q_round_one_published");

  const startButton = page.getByRole("button", { name: "Start new round", exact: true });
  await expect(startButton).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add session", exact: true })).toHaveCount(0);
  await startButton.click();

  await expect(selector).toHaveValue("q_round_two_draft");
  await expect(page.getByRole("button", { name: "Publish new round", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Publish to invited voters", exact: true })).toHaveCount(0);
  await expect(page.getByText(/No invited-voter roster will be carried into this round/)).toBeVisible();

  // The setup is copied into the new round, but the questionnaire ID is new.
  await expect(page.getByLabel("Questionnaire ID", { exact: true })).toHaveValue("q_round_two_draft");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Round one");

  // Both rounds remain selectable and the published one is still intact.
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption("q_round_one_published");
  await expect(page.getByLabel("Questionnaire ID", { exact: true })).toHaveValue("q_round_one_published");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Round one");
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
});
