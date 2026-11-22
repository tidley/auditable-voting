import { expect, test, type Page } from "@playwright/test";
// @ts-expect-error - the sender script is plain Node ESM without type declarations.
import { buildAdmissionEmail, formatAdmissionCode, parseAdmissionBundle } from "../../scripts/otp-send-email.mjs";
import { InMemoryNostrRelay, installNostrRelay } from "./nostr-relay-shim";

const MASTER = "901";
const RESIDENT_CSV = [
  "masters_list_number,email,phone,name",
  `${MASTER},alice@example.test,,Alice Archer`,
].join("\n");

type EmailSendBody = {
  transport?: string;
  bundleCsv?: string;
};

type AdmissionRow = {
  master: string;
  email: string;
  name: string;
  code: string;
  expiresAt: string;
  questionnaireTitle: string;
  voteUrl: string;
};

async function installEmailSender(page: Page) {
  const state: { body: EmailSendBody | null } = { body: null };
  await page.route("**/__email/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        service: "auditable-voting-email-sender",
        version: 1,
        transports: ["smtp"],
        maxRecipients: 1000,
      }),
    });
  });
  await page.route("**/__email/send", async (route) => {
    state.body = route.request().postDataJSON() as EmailSendBody;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sent: 1,
        skipped: 0,
        failed: 0,
        results: [{ master: MASTER, ok: true, detail: "sent", ref: "e2e-mail-901" }],
      }),
    });
  });
  return state;
}

async function publishQuestionnaire(page: Page) {
  await page.goto("/dashboard.html?role=coordinator");
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("E2E email admission");
  await page.getByLabel("Description", { exact: true }).fill("End-to-end email admission test.");
  await page.getByLabel("Question 1 prompt", { exact: true }).fill("Proceed?");
  const goLive = page.getByRole("button", { name: "Go Live", exact: true });
  await expect(goLive).toBeEnabled();
  await goLive.click();
  // Go Live publishes asynchronously and then navigates to Guardian. Wait for
  // that navigation so it cannot interrupt the email panel later.
  await expect(page.getByRole("tabpanel", { name: "Guardian", exact: true })).toBeVisible({ timeout: 90_000 });
}

async function openResidentEmailAdmission(page: Page) {
  await page.getByRole("button", { name: "Next: Voters", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Voters", exact: true })).toBeFocused({ timeout: 30_000 });
  await page.locator("summary").filter({ hasText: "Resident email admission" }).click();
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
}

async function generateAdmissionCode(page: Page) {
  await page.getByLabel("Import resident, delivery results, or exported delivery bundle CSV", { exact: true }).setInputFiles({
    name: "residents.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(RESIDENT_CSV, "utf8"),
  });
  await expect(page.getByText("1 resident imported.")).toBeVisible();
  await page.getByRole("button", { name: "Set defaults", exact: true }).click();
  await page.getByRole("button", { name: "Generate admission codes", exact: true }).click();
  await expect(page.getByLabel(`Code for resident ${MASTER}`, { exact: true })).toBeVisible();
  await page.getByLabel("This is a same-machine test").check();
  await expect(page.getByRole("status", { name: "Delivery readiness" })).toContainText("Browser only");
  await expect(page.getByRole("status", { name: "Delivery readiness" })).toContainText("Ready");
}

async function enterAdmissionCode(page: Page, code: string) {
  await expect(page.getByLabel("Admission code character 1 of 10", { exact: true })).toBeVisible();
  for (let index = 0; index < code.length; index += 1) {
    await page.getByLabel(`Admission code character ${index + 1} of 10`, { exact: true }).fill(code[index] ?? "");
  }
  await page.getByRole("button", { name: "Use admission code", exact: true }).click();
}

test("email admission happy path issues a credential and accepts a vote", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = new InMemoryNostrRelay();

  const coordinatorContext = await browser.newContext();
  const coordinator = await coordinatorContext.newPage();
  await installNostrRelay(coordinator, relay);
  const emailSender = await installEmailSender(coordinator);

  await publishQuestionnaire(coordinator);
  await openResidentEmailAdmission(coordinator);
  await generateAdmissionCode(coordinator);
  await coordinator.getByRole("button", { name: "Send emails", exact: true }).click();
  await expect(coordinator.getByText(/Email delivery: 1 sent/)).toBeVisible({ timeout: 30_000 });

  const bundleCsv = emailSender.body?.bundleCsv ?? "";
  expect(emailSender.body?.transport).toBe("smtp");
  expect(bundleCsv).toContain("alice@example.test");

  const parsed = parseAdmissionBundle(bundleCsv) as { rows: AdmissionRow[] };
  expect(parsed.rows).toHaveLength(1);
  const resident = parsed.rows[0]!;
  expect(resident.master).toBe(MASTER);
  expect(resident.code).toMatch(/^[0-9]{10}$/);

  // The browser sends the bundle; the companion renders this exact email. Run
  // the real builder so the test uses the code and link a resident would see.
  const message = buildAdmissionEmail(resident) as { subject: string; text: string; html: string };
  expect(message.text).not.toMatch(/Master-list number/i);
  expect(message.text).toContain(`Admission code: ${formatAdmissionCode(resident.code)}`);
  expect(message.text).toContain(`Select "Use admission code"`);
  expect(message.text).toContain(resident.voteUrl);
  expect(message.html).toContain(`href="${resident.voteUrl.replace(/&/g, "&amp;")}"`);

  const voterContext = await browser.newContext();
  const voter = await voterContext.newPage();
  await installNostrRelay(voter, relay);
  await voter.goto(resident.voteUrl);
  await voter.getByRole("button", { name: "Start", exact: true }).click({ timeout: 60_000 });
  await enterAdmissionCode(voter, resident.code);
  await expect(voter.getByText("Ballot credential received.")).toBeVisible({ timeout: 120_000 });

  await voter.getByRole("button", { name: "Yes", exact: true }).click();
  await voter.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(voter.getByRole("heading", { name: "Vote receipt" })).toBeVisible({ timeout: 120_000 });

  // The admission must have been attached to the request and redeemed by the
  // coordinator. A null/stale key here was the failure mode in manual testing.
  const redeemed = await coordinator.evaluate(() => {
    const key = Object.keys(window.localStorage).find((entry) => entry.endsWith(":paperBallotAdmissions"));
    if (!key) return [] as Array<{ state?: string }>;
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, { state?: string }>;
    return Object.values(parsed);
  });
  expect(redeemed.some((entry) => entry.state === "redeemed")).toBe(true);

  await coordinator.getByRole("navigation", { name: "Questionnaire navigation" }).getByRole("button", { name: "Results", exact: true }).click();
  await expect(coordinator.getByText(/1 of 1 responses|1 response/i).first()).toBeVisible({ timeout: 120_000 });

  await voterContext.close();
  await coordinatorContext.close();
});
