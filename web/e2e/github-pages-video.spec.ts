import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// GitHub Pages E2E video spec for auditable-voting.
//
// Records a single continuous WebM (one context, three pages switched with
// bringToFront) showing:
//   1. Coordinator dashboard loading on GitHub Pages
//   2. Creating / publishing a questionnaire (election)
//   3. Uploading the residents CSV
//   4. Generating OTP codes (manual channel)
//   5. Mock email delivery — codes harvested from the DOM into a Node-side
//      mailbox, then rendered as a visual "email" overlay
//   6. Voter "checking email" and seeing their OTP code
//   7. Voter attempting to participate (ballot request)
//   8. Coordinator viewing results
//
// The OTP codes are coordinator-side bookkeeping (per the analysis), and the
// real Nostr blind-ballot flow depends on public relay round-trips, so the
// video emphasises the robust coordinator + mock-email story and *attempts*
// the voter ballot request without blocking on relay success.
// ---------------------------------------------------------------------------

const BASE = "https://felixfelix-bot.github.io/auditable-voting";

interface MockEmail {
  to: string;
  name: string;
  subject: string;
  body: string;
  otp: string;
  timestamp: number;
}

// Node-side shared mailbox = single source of truth across the pages.
const mailbox: MockEmail[] = [];

const RESIDENTS_CSV = [
  "masters_list_number,email,phone,name",
  "101,alice@example.com,5550101,Alice Archer",
  "102,bob@example.com,5550102,Bob Baker",
].join("\n");

// Slight variation in the CSV text so a repeat run differs (and store).
const tail = `-run-${Math.floor(Date.now() / 1000) % 1000}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pause = (p: Page, ms = 1200) => p.waitForTimeout(ms);

/**
 * Install a visual "email" overlay on a page. Used both for the coordinator
 * ("email sent" confirmation) and for voters ("checking email").
 */
async function showEmailOverlay(
  page: Page,
  mail: { to: string; subject: string; body: string; otp: string },
  kind: "sent" | "received",
): Promise<void> {
  const stamp = kind === "sent" ? "📤 Email sent to coordinator" : "📬 Checking email — inbox";
  await page.evaluate(
    ({ stamp, mail, kind }) => {
      const old = document.getElementById("video-email-overlay");
      if (old) old.remove();
      const box = document.createElement("div");
      box.id = "video-email-overlay";
      box.setAttribute("aria-label", "Mock email overlay");
      const border = kind === "sent" ? "#4A90E2" : "#52B788";
      const title = kind === "sent" ? "#4A90E2" : "#52B788";
      box.innerHTML = `
        <div style="font-family:monospace;font-size:13px;white-space:pre-wrap;">
          <div style="color:${title};font-weight:700;margin-bottom:6px;">${stamp}</div>
          <div>To:&nbsp;&nbsp;&nbsp;${mail.to}</div>
          <div>Subject: ${mail.subject}</div>
          <div>Body:&nbsp;${mail.body}</div>
          <div>OTP:&nbsp;&nbsp;<span style="color:#D9952B;font-weight:700;letter-spacing:2px;">${mail.otp}</span></div>
        </div>`;
      Object.assign(box.style, {
        position: "fixed",
        right: "24px",
        top: "24px",
        zIndex: "99999",
        background: "#FFFFFF",
        color: "#2D312E",
        border: `1px solid ${border}`,
        borderRadius: "10px",
        padding: "18px 22px",
        boxShadow: "0 6px 24px rgba(58, 52, 44, 0.12), 0 2px 8px rgba(58, 52, 44, 0.08)",
        maxWidth: "460px",
      });
      document.body.appendChild(box);
    },
    { stamp, mail: { ...mail }, kind },
  );
}

async function clearOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("video-email-overlay")?.remove();
  });
}

/**
 * Render a "codestrip" marker near the coordinator's Issued codes panel so
 * the video ties the generated codes to each named voter.
 */
async function annotateIssuedCodes(coord: Page): Promise<void> {
  await coord.evaluate(({ mails }) => {
    const old = document.getElementById("video-codestrip");
    if (old) old.remove();
    const strip = document.createElement("div");
    strip.id = "video-codestrip";
    strip.setAttribute("aria-label", "Mock email delivery log");
    strip.innerHTML =
      "<div style='font-weight:700;color:#D9952B;margin-bottom:6px;'>📨 Mock email delivery log</div>" +
      mails
        .map(
          (m: MockEmail) =>
            `<div style="font-family:monospace;font-size:12px;padding:3px 0;border-bottom:1px solid #EAE6DF;">` +
            `<span style="color:#52B788">✓</span> ${m.name} &lt;${m.to}&gt; → OTP <span style="color:#D9952B;letter-spacing:1px">${m.otp}</span></div>`,
        )
        .join("");
    Object.assign(strip.style, {
      position: "fixed",
      left: "24px",
      bottom: "24px",
      zIndex: "99999",
      background: "#FFFFFF",
      color: "#2D312E",
      border: "1px solid #52B788",
      borderRadius: "10px",
      padding: "12px 16px",
      boxShadow: "0 6px 24px rgba(58, 52, 44, 0.12), 0 2px 8px rgba(58, 52, 44, 0.08)",
      minWidth: "300px",
    });
    document.body.appendChild(strip);
  }, { mails: mailbox });
}

/**
 * Harvest the generated OTP codes from the Issued codes panel into the
 * Node-side mailbox.
 */
async function harvestCodes(coord: Page, electionId: string): Promise<void> {
  await coord.waitForSelector("[aria-label='Code for resident 101']", { timeout: 20_000 });
  const pairs = await coord.evaluate(() =>
    [...document.querySelectorAll('[aria-label^="Code for resident "]')].map((row) => {
      const label = row.getAttribute("aria-label") ?? "";
      const num = Number(label.replace(/^Code for resident /, ""));
      const code = (row.querySelector("code")?.textContent ?? "").trim();
      return { num, code };
    }),
  );
  for (const { num, code } of pairs) {
    if (!/^\d{6}$/.test(code)) continue;
    const row = coord.locator(`table[aria-label='Residents'] tbody tr`).filter({
      has: coord.locator(`td:nth-child(1)`, { hasText: new RegExp(`^${num}$`) }),
    });
    const name = (await row.locator("td:nth-child(4)").textContent())?.trim() || `Resident ${num}`;
    const email = (await row.locator("td:nth-child(3)").textContent())?.trim() || `${num}@example.com`;
    if (!mailbox.find((m) => m.to === email)) {
      mailbox.push({
        to: email,
        name,
        subject: `Your auditable-voting access code for ${electionId}`,
        body: `Dear ${name}, use this one-time code to participate in the vote: ${code}.`,
        otp: code,
        timestamp: Date.now(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main video test — one context, three pages → one continuous WebM
// ---------------------------------------------------------------------------
test("GitHub Pages end-to-end voting with mocked email delivery (video)", async ({ browser }) => {
  test.setTimeout(240_000);

  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: "light",
    // Explicitly record video for this hand-rolled context. The config's
    // `use.video` does NOT propagate to a hand-rolled browser.newContext(), so
    // we request the WebM capture here.
    recordVideo: { dir: "/home/c03rad0r/reports/videos" },
  });
  // Set light theme in localStorage + mock mailbox BEFORE any page JS runs.
  // The app's FOUC guard reads localStorage("av-theme") on page load; if
  // absent it falls back to prefers-color-scheme. We force "light" so the
  // very first frame is light-themed (no flash).
  await ctx.addInitScript(() => {
    try { window.localStorage.setItem("av-theme", "light"); } catch {}
    (window as any).__mockMailbox = { emails: [] };
  });

  const coord = await ctx.newPage();
  const v1 = await ctx.newPage();
  const v2 = await ctx.newPage();

  try {
    // ====================================================================
    // 1. Coordinator dashboard loads on GitHub Pages
    // ====================================================================
    await coord.bringToFront();
    await coord.goto(`${BASE}/dashboard.html?role=coordinator`, { waitUntil: "domcontentloaded" });
    await expect(coord.locator("nav[aria-label='Questionnaire navigation']")).toBeVisible({
      timeout: 30_000,
    });
    await pause(coord, 1500);

    // ====================================================================
    // 2. Create the election (Edit tab — default)
    // ====================================================================
    // Title
    const titleInput = coord.getByLabel("Title");
    await titleInput.waitFor({ timeout: 20_000 });
    await titleInput.click();
    await titleInput.fill(`Community Garden Funding Vote${tail}`);
    await pause(coord, 1200);

    // Description
    const desc = coord.getByLabel("Description");
    if (await desc.count()) {
      await desc.fill("Should the city fund the new community garden project this quarter?");
      await pause(coord, 1000);
    }

    // Add a question (yes/no default) so there are two on screen.
    const addQ = coord.locator("button.simple-questionnaire-add-question-button, button:has-text('Add Question')").first();
    await addQ.waitFor({ timeout: 15_000 });
    await addQ.scrollIntoViewIfNeeded();
    await addQ.click();
    await pause(coord, 1000);

    // The runtime auto-creates an initial empty question, and "Add Question"
    // adds another. Fill EVERY empty question prompt so the readiness gate
    // (every question draft valid) is satisfied — a single unfilled prompt
    // keeps "Go Live" disabled.
    const promptInputs = coord.locator(
      "input[aria-label^='Question '][aria-label$=' prompt']",
    );
    const promptCount = await promptInputs.count();
    for (let i = 0; i < promptCount; i++) {
      const field = promptInputs.nth(i);
      const current = ((await field.inputValue()) ?? "").trim();
      if (!current) {
        await field.scrollIntoViewIfNeeded();
        await field.fill(`Approve funding for the community garden?`);
        await pause(coord, 700);
      }
    }
    await pause(coord, 1000);

    // Add a voter group so the checklist (and the demo) shows a populated
    // voter roster. Optional for publishing but makes the video complete.
    const addGroupField = coord.getByLabel("Add voter group").first();
    if (await addGroupField.count()) {
      await addGroupField.scrollIntoViewIfNeeded();
      await addGroupField.fill("Residents");
      await coord.locator("button:has-text('Add group')").first().click();
      await pause(coord, 900);
    }

    // ====================================================================
    // 3. Publish the questionnaire (Go Live) — SKIPPED (OPTION B)
    // ====================================================================
    // The task notes EITHER publish the questionnaire OR skip it. After a Go
    // Live publish the coordinator Voters tab becomes flaky (nav race, then
    // duplicate/ambiguous "Resident admission" sections and CSV inputs that
    // collapse for the coordinator). The CSV + OTP + email mock flow is
    // CONFIRMED to work WITHOUT publishing, so we skip the publish step to
    // guarantee a reliable 60-90s video. The election is fully configured
    // (title + questions) from the Edit tab above; we go straight to Voters.
    let published = false;
    console.warn("[video] OPTION B: skipping Go Live publish; Voters flow works unpublised.");
    await pause(coord, 800);

    // ====================================================================
    // 4. Go to the Voters tab
    // ====================================================================
    // Without a publish there is no nav-race transition; the Voters button is
    // stable. Click it (with a fallback force-click in case of any residual
    // race) and verify the resident admission section.
    const nav = coord.locator("nav[aria-label='Questionnaire navigation']");
    const votersBtn = nav.getByRole("button", { name: "Voters", exact: true }).first();
    await votersBtn.scrollIntoViewIfNeeded();
    await pause(coord, 300);
    const voterSection = coord.locator(
      "section[aria-label='Resident admission']",
    ).first();

    async function ensureVotersTab(): Promise<boolean> {
      try {
        await voterSection.waitFor({ state: "visible", timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }

    // First attempt: normal click.
    await votersBtn.click({ timeout: 5000 }).catch(() => {});
    let onVoters = await ensureVotersTab();

    // Fallback: force-click via page.evaluate through the nav button list.
    if (!onVoters) {
      console.warn("[video] Normal Voters click missed; force-clicking via evaluate.");
      await coord.evaluate(() => {
        const btns = document.querySelectorAll(
          'nav[aria-label="Questionnaire navigation"] button',
        );
        for (const b of btns) {
          if (b.textContent?.includes("Voters")) {
            (b as HTMLElement).click();
            break;
          }
        }
      });
      onVoters = await ensureVotersTab();
    }

    if (!onVoters) {
      // Already on the Voters tab (single-tab wizard) or nav absent — check
      // whether the resident section is simply already visible.
      const already = await coord
        .locator("section[aria-label='Resident admission']")
        .count();
      if (already === 0) {
        // Last resort: just continue — the CSV field lookup below will
        // surface any problem.
        console.warn("[video] Voters tab did not activate; continuing anyway.");
      }
    }

    await voterSection.scrollIntoViewIfNeeded().catch(() => {});
    await pause(coord, 1000);

    // ====================================================================
    // 5. Upload the residents CSV
    // ====================================================================
    // Post-publish the coordinator renders TWO "Resident admission" sections
    // and TWO "Residents CSV file" inputs (a hidden duplicate template), which
    // makes an unscoped getByLabel ambiguous. Target the single component
    // wrapper that actually holds the active Voters admission UI.
    const csvInput = coord
      .locator("#coordinator-resident-admission-section input[aria-label='Residents CSV file']")
      .first();
    await csvInput.waitFor({ timeout: 15_000 });
    await csvInput.setInputFiles({
      name: "residents.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(RESIDENTS_CSV, "utf8"),
    });
    const residentTable = coord.locator("table[aria-label='Residents']");
    await expect(residentTable.first()).toBeVisible({ timeout: 15_000 });
    await expect(residentTable.first().locator("tbody tr")).toHaveCount(2);
    await pause(coord, 1400);

    // ====================================================================
    // 6. Select manual delivery channel (the only in-browser code channel)
    // ====================================================================
    const channelSel = coord.locator("select[aria-label='Delivery channel']");
    if (await channelSel.count()) {
      await channelSel.scrollIntoViewIfNeeded();
      await channelSel.selectOption("manual");
      await pause(coord, 800);
    }

    // ====================================================================
    // 7. Generate OTP codes for all residents
    // ====================================================================
    const genAll = coord.locator("button[aria-label='Generate codes for all residents']");
    if (await genAll.count()) {
      await genAll.first().scrollIntoViewIfNeeded();
      await genAll.first().click();
    } else {
      await coord.locator("button[aria-label='Generate code for resident 101']").click();
    }
    await expect(coord.locator("[aria-label='Issued codes']").first()).toBeVisible({ timeout: 15_000 });
    await pause(coord, 1400);

    // ====================================================================
    // 8. Harvest codes -> mock mailbox + visual "sent" emails
    // ====================================================================
    const electionId = (await coord.locator("header h1, .simple-questionnaire-editor-title h1").first().textContent().catch(() => "election")) ?? "election";
    await harvestCodes(coord, electionId);
    await annotateIssuedCodes(coord);

    for (const mail of mailbox) {
      await showEmailOverlay(coord, mail, "sent");
      await pause(coord, 900);
      await clearOverlay(coord);
      await pause(coord, 300);
    }
    await annotateIssuedCodes(coord); // re-show the log after clearing
    await pause(coord, 1200);

    // ====================================================================
    // 9. Voter 1 — "checks email", sees the OTP, tries to participate
    // ====================================================================
    await v1.bringToFront();
    const mail1 = mailbox[0];
    await v1.goto(`${BASE}/vote.html?role=voter&q=${encodeURIComponent(electionId)}&request_ballot=1`, {
      waitUntil: "domcontentloaded",
    });
    await pause(v1, 1500);

    // Voter 1 "checks email" — visual inbox overlay with their OTP.
    await showEmailOverlay(v1, mail1, "received");
    await pause(v1, 1800);
    await clearOverlay(v1);
    await pause(v1, 600);

    // Attempt to participate: open the linked questionnaire + request ballot.
    const startCard = v1.locator("section[aria-label='Questionnaire start']");
    const startBtn = v1.locator("section[aria-label='Questionnaire start'] button:has-text('Start')").first();
    if (await startBtn.count()) {
      await startBtn.click();
      await pause(v1, 1500);
    }
    const requestBallot = v1.locator(
      "section#questionnaire-ballot-status button:has-text('Request ballot'), button:has-text('Request ballot')",
    ).first();
    if (await requestBallot.count()) {
      await requestBallot.click();
      await pause(v1, 2000);
      await v1.locator("button:has-text('Refresh status')").first().click().catch(() => {});
      await pause(v1, 1500);
    }
    await pause(v1, 1200);

    // ====================================================================
    // 10. Voter 2 — same routine
    // ====================================================================
    await v2.bringToFront();
    const mail2 = mailbox[1] ?? mail1;
    await v2.goto(`${BASE}/vote.html?role=voter&q=${encodeURIComponent(electionId)}&request_ballot=1`, {
      waitUntil: "domcontentloaded",
    });
    await pause(v2, 1500);

    await showEmailOverlay(v2, mail2, "received");
    await pause(v2, 1800);
    await clearOverlay(v2);
    await pause(v2, 600);

    const startBtn2 = v2.locator("section[aria-label='Questionnaire start'] button:has-text('Start')").first();
    if (await startBtn2.count()) {
      await startBtn2.click();
      await pause(v2, 1500);
    }
    const requestBallot2 = v2.locator(
      "section#questionnaire-ballot-status button:has-text('Request ballot'), button:has-text('Request ballot')",
    ).first();
    if (await requestBallot2.count()) {
      await requestBallot2.click();
      await pause(v2, 2000);
      await v2.locator("button:has-text('Refresh status')").first().click().catch(() => {});
      await pause(v2, 1500);
    }
    await pause(v2, 1200);

    // ====================================================================
    // 11. Coordinator views results
    // ====================================================================
    await coord.bringToFront();
    await pause(coord, 800);
    await nav.getByRole("button", { name: "Results", exact: true }).click();
    await pause(coord, 2500); // allow relays to propagate while the dashboard renders

    const summary = coord.locator("div[aria-label='Questionnaire result summary'], div[aria-label='Questionnaire result summary']").first();
    if (await summary.count()) {
      await summary.scrollIntoViewIfNeeded().catch(() => {});
      await pause(coord, 2500);
    } else {
      // Show whatever results / participants content is available.
      const live = coord.locator("div[aria-label='Live status'], text=Results, text=Submitted Votes").first();
      await live.scrollIntoViewIfNeeded().catch(() => {});
      await pause(coord, 2500);
    }
    await clearOverlay(coord);
    await pause(coord, 1200);
  } finally {
    await ctx.close(); // flushes video.webm
  }
});
