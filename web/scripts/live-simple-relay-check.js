import { chromium } from "playwright";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getNpub(page) {
  return (await page.locator("code.simple-identity-code").nth(0).innerText()).trim();
}

async function clickByText(page, role, name) {
  await page.getByRole(role, { name }).click();
}

async function ensureVoterTab(page, name) {
  const tab = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await tab.count() === 0) {
    return false;
  }
  await tab.first().click();
  await sleep(100);
  return true;
}

async function coordinatorDiagnostics(page) {
  return page.locator(".simple-delivery-diagnostics").allInnerTexts().catch(() => []);
}

async function voterCardDiagnostics(page) {
  const cards = page.locator(".simple-coordinator-card");
  const count = await cards.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await cards.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function readBody(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function clickAllEnabled(page, matcher) {
  const buttons = page.getByRole("button", { name: matcher });
  const count = await buttons.count();
  let clicked = 0;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isDisabled())) {
      await button.click();
      clicked += 1;
      await sleep(100);
    }
  }
  return clicked;
}

async function allVotersTicketReady(voters) {
  for (const page of voters) {
    await ensureVoterTab(page, "Vote");
    const body = await readBody(page);
    const ticketReady = parseTicketReady(body);
    if (!ticketReady || ticketReady.ready < ticketReady.required) {
      return false;
    }
  }
  return true;
}

async function clickEnabledTicketsDuringWindow(coordinators, voters, durationMs) {
  const deadline = Date.now() + durationMs;
  const sendCounts = coordinators.map((_, index) => ({
    coordinator: index + 1,
    clicked: 0,
  }));

  while (Date.now() < deadline) {
    let clickedThisPass = 0;
    for (const [index, page] of coordinators.entries()) {
      const clicked = await clickAllEnabled(page, /Send ticket|Resend/i);
      sendCounts[index].clicked += clicked;
      clickedThisPass += clicked;
    }

    if (await allVotersTicketReady(voters)) {
      break;
    }

    await sleep(clickedThisPass > 0 ? 750 : 1500);
  }

  return sendCounts;
}

async function addCoordinatorsToVoter(page, coordinatorNpubs) {
  const draft = page.getByPlaceholder('Enter coordinator npub...');
  for (const coordinatorNpub of coordinatorNpubs) {
    await draft.fill(coordinatorNpub);
    await clickByText(page, "button", "Add coordinator");
    await sleep(100);
  }
  await clickByText(page, "button", /Notify coordinators/i);
}

function parseTicketReady(text) {
  const match = /Tickets ready: ([0-9]+) of ([0-9]+)/i.exec(text);
  return match ? { ready: Number(match[1]), required: Number(match[2]) } : null;
}

async function captureRoundState(coordinators, voters) {
  const coordinatorStates = {};
  for (const [index, page] of coordinators.entries()) {
    coordinatorStates[`coord${index + 1}`] = {
      diagnostics: await coordinatorDiagnostics(page),
      body: await readBody(page),
    };
  }

  const voterStates = {};
  for (const [index, page] of voters.entries()) {
    await ensureVoterTab(page, "Vote");
    const body = await readBody(page);
    voterStates[`voter${index + 1}`] = {
      cards: await voterCardDiagnostics(page),
      body,
      ticketReady: parseTicketReady(body),
      seesQuestion: /Round [0-9]+/i.test(body) || /Should the proposal pass\?/i.test(body),
    };
  }

  return { coordinatorStates, voterStates };
}

async function main() {
  const coordinatorCount = envInt("LIVE_COORDINATORS", 5);
  const voterCount = envInt("LIVE_VOTERS", 10);
  const roundCount = envInt("LIVE_ROUNDS", 3);
  const base = process.env.LIVE_SIMPLE_BASE_URL ?? "http://127.0.0.1:4175/simple.html";
  const nip65Mode = (process.env.LIVE_NIP65 ?? "off").trim().toLowerCase();
  const startupWaitMs = envInt("LIVE_STARTUP_WAIT_MS", 45000);
  const roundWaitMs = envInt("LIVE_ROUND_WAIT_MS", 20000);
  const ticketWaitMs = envInt("LIVE_TICKET_WAIT_MS", 20000);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const coordinators = [];
  const voters = [];

  for (let index = 0; index < coordinatorCount; index += 1) {
    const page = await context.newPage();
    const url = new URL(base);
    url.searchParams.set("role", "coordinator");
    if (nip65Mode !== "on") {
      url.searchParams.set("nip65", "off");
    }
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    coordinators.push(page);
  }

  for (let index = 0; index < voterCount; index += 1) {
    const page = await context.newPage();
    const url = new URL(base);
    url.searchParams.set("role", "voter");
    if (nip65Mode !== "on") {
      url.searchParams.set("nip65", "off");
    }
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    voters.push(page);
  }

  for (const page of [...coordinators, ...voters]) {
    await clickByText(page, 'button', /New ID/i);
  }
  await sleep(1500);

  const coordinatorNpubs = [];
  for (const page of coordinators) {
    coordinatorNpubs.push(await getNpub(page));
  }

  for (let index = 1; index < coordinators.length; index += 1) {
    await coordinators[index].getByPlaceholder("Leave blank if this coordinator is the lead").fill(coordinatorNpubs[0]);
    await clickByText(coordinators[index], "button", /Submit to lead/i);
  }

  for (const page of voters) {
    await addCoordinatorsToVoter(page, coordinatorNpubs);
  }

  await sleep(startupWaitMs);

  const rounds = [];
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const prompt = `Round ${roundIndex + 1}: Should the proposal pass?`;
    const lead = coordinators[0];
    const questionBox = lead.getByRole("textbox", { name: "Question" });
    await questionBox.fill(prompt);
    await clickByText(lead, "button", /Broadcast live vote/i);

    const distributeButton = lead.getByRole("button", { name: /Distribute share indexes/i });
    if (!(await distributeButton.isDisabled())) {
      await distributeButton.click();
    }

    await sleep(roundWaitMs);

    const sendCounts = await clickEnabledTicketsDuringWindow(coordinators, voters, ticketWaitMs);

    await sleep(4000);

    for (const [index, page] of voters.entries()) {
      await ensureVoterTab(page, "Vote");
      const body = await readBody(page);
      const ticketReady = parseTicketReady(body);
      if (ticketReady && ticketReady.ready >= ticketReady.required) {
        const voteChoice = index % 2 === 0 ? "Yes" : "No";
        const button = page.getByRole("button", { name: new RegExp(`^${voteChoice}$`, "i") });
        const submit = page.getByRole("button", { name: /^Submit$/i });
        if (!(await submit.isDisabled())) {
          await button.click();
          await submit.click();
          await sleep(200);
        }
      }
    }

    rounds.push({
      round: roundIndex + 1,
      prompt,
      sendCounts,
      state: await captureRoundState(coordinators, voters),
    });
  }

  const summary = rounds.map((round) => {
    const voterTicketSummary = Object.entries(round.state.voterStates).map(([key, value]) => ({
      voter: key,
      ticketReady: value.ticketReady,
      hasTicket: Boolean(value.ticketReady && value.ticketReady.ready >= value.ticketReady.required),
    }));
    return {
      round: round.round,
      prompt: round.prompt,
      sendCounts: round.sendCounts,
      votersWithTickets: voterTicketSummary.filter((entry) => entry.hasTicket).length,
      totalVoters: voterTicketSummary.length,
      voterTicketSummary,
      coordinatorFailureHints: Object.entries(round.state.coordinatorStates).map(([key, value]) => ({
        coordinator: key,
        waitingForRequests: value.diagnostics.filter((line) => line.includes("Waiting for this voter's blinded ticket request")).length,
        waitingForReceipts: value.diagnostics.filter((line) => line.includes("Waiting for voter ticket receipt acknowledgement")).length,
      })),
    };
  });

  console.log(JSON.stringify({
    config: {
      base,
      nip65Mode,
      coordinatorCount,
      voterCount,
      roundCount,
      startupWaitMs,
      roundWaitMs,
      ticketWaitMs,
    },
    summary,
    rounds,
  }, null, 2));

  await browser.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
