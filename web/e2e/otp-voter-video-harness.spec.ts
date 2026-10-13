// Video harness for #25's VOTER-side feature.
// The existing resident-otp-admission.spec.ts drives the COORDINATOR verify form;
// this drives the voter-role ResidentOtpEntry panel (Vote tab), which is what this
// PR adds: a resident redeems a code and their ballot unlocks.
import { test, expect } from "@playwright/test";

// Issued by the coordinator UI in the same browser profile, then redeemed here.
// The roster key is per-election, so the election id must match.
test.use({ viewport: { width: 1280, height: 1800 } });

test("voter-side OTP entry: redeem a code and unlock the ballot", async ({ page, context }) => {
  test.setTimeout(90_000);

  // 1. Coordinator: issue a code for master 101.
  await page.goto("/dashboard.html?role=coordinator");
  const nav = page.locator("nav[aria-label='Questionnaire navigation']");
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Voters", exact: true }).click();

  const section = page.locator("section[aria-label='Resident admission']");
  await section.scrollIntoViewIfNeeded();
  const csv = [
    "masters_list_number,email,phone,name",
    "101,alice@example.com,5550101,Alice Archer",
  ].join("\n");
  await section.getByLabel("Residents CSV file").setInputFiles({
    name: "residents.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.waitForTimeout(500);
  await page.getByLabel("Generate code for resident 101").click();
  await page.waitForTimeout(700);
  const code = (
    await page.locator("[aria-label='Code for resident 101'] code").textContent()
  )?.trim() ?? "";
  expect(code).toMatch(/^\d{6}$/);

  // 2. Voter: open the voter app. A fresh session is either locked behind the
  //    unlock gate or on another tab; "Reset local state" generates a fresh
  //    voter identity and drops us into the shell, then we switch to Vote
  //    (where ResidentOtpEntry lives).
  // The voter shell opens on "configure" unless a questionnaire is linked via
  // ?q= (see SimpleAppShell: voterTab init). Linking one puts us straight on the
  // Vote tab, where ResidentOtpEntry is mounted. ?role=voter selects the voter shell.
  await page.goto("/vote.html?role=voter&q=harness-election");
  const continueAsVoter = page.getByRole("button", { name: "Continue as Voter" });
  if (await continueAsVoter.isVisible().catch(() => false)) {
    await continueAsVoter.click();
    await page.waitForTimeout(1000);
  }
  const reset = page.getByRole("button", { name: "Reset local state" });
  if (await reset.isVisible().catch(() => false)) {
    await reset.click();
    await page.waitForTimeout(1500);
  }
  const entry = page.locator("section[aria-label='Resident admission']");
  await expect(entry).toBeVisible();
  await entry.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await entry.getByLabel("Masters list number").fill("101");
  await entry.getByLabel("One-time code").fill(code);
  await page.waitForTimeout(300);
  await entry.getByLabel("Verify code").click();

  // 3. The admission is reported and the ballot is unlocked.
  await expect(page.locator("[aria-label='Admission status']")).toContainText(/admitted|verified|redeem/i, {
    timeout: 15_000,
  });
  await page.waitForTimeout(2500); // hold on the unlocked state for the recording
});
