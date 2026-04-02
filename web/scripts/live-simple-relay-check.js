import { chromium } from "playwright";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getNpub(page) {
  return (await page.locator("code.simple-identity-code").nth(0).innerText()).trim();
}

async function clickByText(page, role, name) {
  await page.getByRole(role, { name }).click();
}

async function coordinatorDiagnostics(page) {
  const items = await page.locator(".simple-delivery-diagnostics").allInnerTexts().catch(() => []);
  return items.map((s) => s.replace(/\s+/g, " ").trim());
}

async function voterCardDiagnostics(page) {
  const cards = page.locator(".simple-coordinator-card");
  const count = await cards.count();
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push((await cards.nth(i).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function clickEnabledSendTickets(page, label) {
  const buttons = page.getByRole("button", { name: /Send ticket|Resend/i });
  const count = await buttons.count();
  let clicked = 0;
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isDisabled())) {
      await button.click();
      clicked += 1;
      await sleep(300);
    }
  }
  return { label, clicked, count };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const base = "http://127.0.0.1:4175/simple.html";
  const coordA = await context.newPage();
  const coordB = await context.newPage();
  const voter1 = await context.newPage();
  const voter2 = await context.newPage();

  for (const [page, role] of [
    [coordA, "coordinator"],
    [coordB, "coordinator"],
    [voter1, "voter"],
    [voter2, "voter"],
  ]) {
    await page.goto(`${base}?role=${role}`, { waitUntil: "networkidle" });
  }

  for (const page of [coordA, coordB, voter1, voter2]) {
    await clickByText(page, "button", /Refresh ID/i);
  }
  await sleep(1500);

  const coordANpub = await getNpub(coordA);
  const coordBNpub = await getNpub(coordB);
  const voter1Npub = await getNpub(voter1);
  const voter2Npub = await getNpub(voter2);

  await coordB.getByPlaceholder("Leave blank if this coordinator is the lead").fill(coordANpub);
  await clickByText(coordB, "button", /Submit to lead/i);

  for (const voter of [voter1, voter2]) {
    const draft = voter.getByPlaceholder("Enter npub...");
    await draft.fill(coordANpub);
    await clickByText(voter, "button", "Add coordinator");
    await draft.fill(coordBNpub);
    await clickByText(voter, "button", "Add coordinator");
    await clickByText(voter, "button", /Notify coordinators/i);
  }

  await sleep(35000);

  const preRound = {
    voterCards: {
      voter1: await voterCardDiagnostics(voter1),
      voter2: await voterCardDiagnostics(voter2),
    },
    coordinatorFollowers: {
      coordA: await coordinatorDiagnostics(coordA),
      coordB: await coordinatorDiagnostics(coordB),
    },
  };

  await coordA.getByRole("textbox", { name: "Question" }).fill("Live relay hardening test?");
  await clickByText(coordA, "button", /Broadcast live vote/i);
  const distributeButton = coordA.getByRole("button", { name: /Distribute share indexes/i });
  const distributeEnabled = !(await distributeButton.isDisabled());
  if (distributeEnabled) {
    await distributeButton.click();
  }

  await sleep(20000);

  const afterBroadcast = {
    voterCards: {
      voter1: await voterCardDiagnostics(voter1),
      voter2: await voterCardDiagnostics(voter2),
    },
    coordinatorFollowers: {
      coordA: await coordinatorDiagnostics(coordA),
      coordB: await coordinatorDiagnostics(coordB),
    },
  };

  const sendA = await clickEnabledSendTickets(coordA, "coordA");
  const sendB = await clickEnabledSendTickets(coordB, "coordB");

  await sleep(20000);

  const afterSend = {
    voterCards: {
      voter1: await voterCardDiagnostics(voter1),
      voter2: await voterCardDiagnostics(voter2),
    },
    coordinatorFollowers: {
      coordA: await coordinatorDiagnostics(coordA),
      coordB: await coordinatorDiagnostics(coordB),
    },
  };

  const body1 = (await voter1.locator("body").innerText()).replace(/\s+/g, " ");
  const body2 = (await voter2.locator("body").innerText()).replace(/\s+/g, " ");

  console.log(JSON.stringify({
    npubs: { coordANpub, coordBNpub, voter1Npub, voter2Npub },
    preRound,
    afterBroadcast,
    distributeEnabled,
    sendA,
    sendB,
    afterSend,
    voteStatus: {
      voter1Tickets: (/Tickets ready: ([0-9]+ of [0-9]+)/.exec(body1) || [null, null])[1],
      voter2Tickets: (/Tickets ready: ([0-9]+ of [0-9]+)/.exec(body2) || [null, null])[1],
      voter1HasQuestion: body1.includes("Live relay hardening test?"),
      voter2HasQuestion: body2.includes("Live relay hardening test?"),
    },
  }, null, 2));

  await browser.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
