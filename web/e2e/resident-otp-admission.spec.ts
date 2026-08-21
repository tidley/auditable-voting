import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * E2E coverage for the coordinator Resident admission (CSV + OTP) UI
 * (AV-UI-1, web/src/ResidentOtpAdmission.tsx) mounted in the participants
 * tab of the coordinator dashboard.
 *
 * The app supports the ?role= URL param to skip the gateway screen
 * (dashboard.html → coordinator entrypoint), same trick as the theme-toggle
 * spec. Dev server + chrome channel + video come from playwright.config.ts.
 *
 * OTP rules under test (web/src/otpService.ts):
 *   - 6-digit codes, shown once in the "Issued codes" panel
 *   - OTP_TTL_MS = 10 minutes (expiry test uses page.clock to advance time)
 *   - MAX_OTP_ATTEMPTS = 5 (lockout test enters 5 wrong codes, then the
 *     correct one — which must be rejected too)
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Valid roster: three residents, optional fields exercised. */
const VALID_CSV = [
  "masters_list_number,email,phone,name",
  "101,alice@example.com,5550101,Alice Archer",
  "102,bob@example.com,5550102,Bob Baker",
  "103,carol@example.com,,Carol Cruz",
].join("\n");

/** Invalid roster: malformed email (row 1) + duplicate number (row 3). */
const INVALID_CSV = [
  "masters_list_number,email,phone,name",
  "201,not-an-email,,Bad Email",
  "202,valid@example.com,,Dup One",
  "202,valid2@example.com,,Dup Two",
].join("\n");

/**
 * Roster whose name fields are spreadsheet formulas. parseResidentCsv must
 * neutralise every cell starting with a formula prefix (=, +, -, @) by
 * prepending an apostrophe, so the rendered table shows literal text and
 * no raw formula survives.
 */
const FORMULA_CSV = [
  "masters_list_number,email,phone,name",
  "301,dana@example.com,5550301,=SUM(A1:A2)",
  "302,erin@example.com,5550302,@SUM(A1:A2)",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the coordinator dashboard and navigate to the participants tab. */
async function gotoResidentAdmission(page: Page): Promise<void> {
  await page.goto("/dashboard.html?role=coordinator");
  const nav = page.locator("nav[aria-label='Questionnaire navigation']");
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Voters", exact: true }).click();
  const section = page.locator("section[aria-label='Resident admission']");
  await expect(section).toBeVisible();
}

/** Upload an in-memory CSV through the file input. */
async function uploadCsv(page: Page, csv: string): Promise<void> {
  await page.getByLabel("Residents CSV file").setInputFiles({
    name: "residents.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
}

/** The roster table (only rendered when residents parsed successfully). */
function residentsTable(page: Page): Locator {
  return page.locator("table[aria-label='Residents']");
}

/** The roster row for a masters list number, matched on the number cell. */
function residentRow(page: Page, num: number): Locator {
  return residentsTable(page)
    .locator("tbody tr")
    .filter({ has: page.locator("td:nth-child(1)", { hasText: new RegExp(`^${num}$`) }) });
}

/** The CSV error alert (role=alert, only rendered when errors exist). */
function csvErrors(page: Page): Locator {
  return page.locator("[aria-label='Residents CSV errors']");
}

/** Generate an OTP for a resident and return the displayed 6-digit code. */
async function generateCode(page: Page, num: number): Promise<string> {
  await page.locator(`button[aria-label="Generate code for resident ${num}"]`).click();
  const row = page.locator(`[aria-label="Code for resident ${num}"]`);
  await expect(row).toBeVisible();
  const code = row.locator("code");
  await expect(code).toHaveText(/^\d{6}$/);
  return (await code.textContent()) ?? "";
}

/** Fill the verify form and submit. */
async function verifyCode(page: Page, num: number, code: string): Promise<void> {
  await page.locator("select[aria-label='Resident to verify']").selectOption(String(num));
  await page.getByLabel("One-time code").fill(code);
  await page.locator("button[aria-label='Verify code']").click();
}

/** The verify form's role=status paragraph. */
function verifyStatus(page: Page): Locator {
  return page.locator(".simple-resident-verify [role='status']");
}

/** A wrong 6-digit code deterministically different from the given one. */
function wrongCodeFrom(code: string): string {
  return ((Number(code) + 1) % 1_000_000).toString().padStart(6, "0");
}

// ---------------------------------------------------------------------------
// 1. Valid CSV → all residents listed
// ---------------------------------------------------------------------------
test("valid CSV upload lists all residents", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, VALID_CSV);

  const table = residentsTable(page);
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(csvErrors(page)).toHaveCount(0);

  await expect(residentRow(page, 101)).toContainText("Alice Archer");
  await expect(residentRow(page, 101)).toContainText("alice@example.com");
  await expect(residentRow(page, 102)).toContainText("Bob Baker");
  await expect(residentRow(page, 103)).toContainText("Carol Cruz");
});

// ---------------------------------------------------------------------------
// 2. Invalid CSV → per-row errors shown, no roster
// ---------------------------------------------------------------------------
test("invalid CSV shows bad email and duplicate number errors", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, INVALID_CSV);

  const alert = csvErrors(page);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("The CSV could not be read:");
  await expect(alert).toContainText('Row 1: invalid email "not-an-email"');
  await expect(alert).toContainText('Row 3: duplicate masters_list_number "202"');
  // All-or-nothing parsing: no roster table when any row fails.
  await expect(residentsTable(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3. Formula cells neutralised (apostrophe prefix, no raw leading =)
// ---------------------------------------------------------------------------
test("formula cells are rendered neutralised with an apostrophe prefix", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, FORMULA_CSV);

  const table = residentsTable(page);
  await expect(table).toBeVisible();

  // Name column (td #2) shows the formula as literal text, apostrophe-prefixed.
  await expect(residentRow(page, 301).locator("td").nth(1)).toHaveText("'=SUM(A1:A2)");
  await expect(residentRow(page, 302).locator("td").nth(1)).toHaveText("'@SUM(A1:A2)");

  // Non-formula fields are untouched.
  await expect(residentRow(page, 301)).toContainText("dana@example.com");

  // Defence in depth: no rendered cell may start with a raw formula prefix.
  const hasRawFormulaPrefix = await table.locator("td").evaluateAll((cells) =>
    cells.some((cell) => {
      const text = (cell.textContent ?? "").trim();
      return text.startsWith("=") || text.startsWith("+") || text.startsWith("@");
    }),
  );
  expect(hasRawFormulaPrefix).toBe(false);
});

// ---------------------------------------------------------------------------
// 4. Generate OTP → 6-digit code displayed once + stored indicator
// ---------------------------------------------------------------------------
test("generating an OTP shows a 6-digit code once with an issued indicator", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, VALID_CSV);

  const code = await generateCode(page, 101);
  expect(code).toMatch(/^\d{6}$/);

  // The "Issued codes" panel flags the code as shown once.
  const panel = page.locator("[aria-label='Issued codes']");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Shown once — copy now and hand to the resident.");

  // Stored indicator: the row carries an issue timestamp next to the code.
  const row = page.locator("[aria-label='Code for resident 101']");
  await expect(row).toContainText(/issued \d{2}:\d{2}:\d{2}/);

  // The plaintext code appears exactly once on the page.
  await expect(page.locator("code", { hasText: code })).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 5. Correct OTP → success state
// ---------------------------------------------------------------------------
test("entering the correct OTP shows the success state", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, VALID_CSV);

  const code = await generateCode(page, 101);
  await verifyCode(page, 101, code);

  await expect(verifyStatus(page)).toHaveText("Code verified for resident 101.");
});

// ---------------------------------------------------------------------------
// 6. Wrong OTP 5× → locked; correct OTP afterwards also rejected
// ---------------------------------------------------------------------------
test("five wrong OTP attempts lock verification, correct code rejected too", async ({ page }) => {
  test.setTimeout(60_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, VALID_CSV);

  const code = await generateCode(page, 101);
  const wrong = wrongCodeFrom(code);

  // Attempts 1–4: plain "Incorrect code."
  for (let attempt = 1; attempt <= 4; attempt++) {
    await verifyCode(page, 101, wrong);
    await expect(verifyStatus(page)).toHaveText("Incorrect code.");
  }

  // Attempt 5: lockout message.
  await verifyCode(page, 101, wrong);
  await expect(verifyStatus(page)).toHaveText(
    "Too many failed attempts. Generate a new code to continue.",
  );

  // The correct code is now rejected as well (rate limit outlives the counter).
  await verifyCode(page, 101, code);
  await expect(verifyStatus(page)).toHaveText(
    "Too many failed attempts. Generate a new code to continue.",
  );
});

// ---------------------------------------------------------------------------
// 7. Expired OTP → expired message (clock mock past the 10-minute TTL)
// ---------------------------------------------------------------------------
test("expired OTP shows the expired message", async ({ page }) => {
  test.setTimeout(45_000);
  await gotoResidentAdmission(page);
  await uploadCsv(page, VALID_CSV);

  const code = await generateCode(page, 101);

  // Install the fake clock only once the app is fully booted (installing
  // before load would freeze boot timers), then advance past OTP_TTL_MS
  // (10 minutes) — margin included — so isOtpExpired() trips.
  await page.clock.install();
  await page.clock.fastForward(10 * 60 * 1000 + 30_000);

  await verifyCode(page, 101, code);
  await expect(verifyStatus(page)).toHaveText("This code has expired. Generate a new code.");
});

// ---------------------------------------------------------------------------
// 8. Happy path: upload → generate → verify → success (video evidence)
// ---------------------------------------------------------------------------
test("resident OTP admission happy path (video evidence)", async ({ page }) => {
  test.setTimeout(60_000);
  await gotoResidentAdmission(page);

  // Bring the section into frame for the recording.
  const section = page.locator("section[aria-label='Resident admission']");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);

  // 1. Upload the roster.
  await uploadCsv(page, VALID_CSV);
  const table = residentsTable(page);
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.waitForTimeout(600);

  // 2. Generate an OTP for the first resident.
  const code = await generateCode(page, 101);
  await expect(page.locator("[aria-label='Issued codes']")).toContainText(
    "Shown once — copy now and hand to the resident.",
  );
  await page.waitForTimeout(600);

  // 3. Verify it in the verify form.
  await verifyCode(page, 101, code);

  // 4. Success state.
  await expect(verifyStatus(page)).toHaveText("Code verified for resident 101.");
  await page.waitForTimeout(900);
});
