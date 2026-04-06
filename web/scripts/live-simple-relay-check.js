import { chromium } from "playwright";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getNpub(page) {
  const indexedDbNpub = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("auditable-voting-simple", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
    });

    const roles = ["coordinator", "voter"];
    for (const role of roles) {
      const value = await new Promise((resolve, reject) => {
        const transaction = database.transaction("actor-state", "readonly");
        const store = transaction.objectStore("actor-state");
        const request = store.get(role);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error("Unable to read actor state."));
      });

      if (value && typeof value === "object" && "keypair" in value) {
        const npub = value.keypair?.npub;
        if (typeof npub === "string" && npub.trim()) {
          database.close();
          return npub.trim();
        }
      }
    }

    database.close();
    return null;
  }).catch(() => null);

  if (indexedDbNpub) {
    return indexedDbNpub;
  }

  await ensureTab(page, "Settings");
  const codeLocator = page.locator("code.simple-identity-code").first();
  if (await codeLocator.count()) {
    await codeLocator.waitFor({ state: "attached", timeout: 30000 });
    const text = (await codeLocator.textContent())?.trim();
    if (text) {
      return text;
    }
  }

  const copyButton = page.getByRole("button", { name: /Copy npub/i }).first();
  if (await copyButton.count()) {
    await copyButton.waitFor({ state: "visible", timeout: 30000 });
    const identityField = page.locator(".simple-identity-field").first();
    const identityCode = identityField.locator("code.simple-identity-code").first();
    if (await identityCode.count()) {
      const text = (await identityCode.textContent())?.trim();
      if (text) {
        return text;
      }
    }
  }

  const body = await readBody(page);
  const match = body.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/i);
  if (match) {
    return match[0];
  }

  throw new Error("Could not find npub on page");
}

async function clickByText(page, role, name) {
  const locator = page.getByRole(role, { name }).first();
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click();
}

async function ensureVoterTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  if (await tab.count() > 0) {
    await tab.first().click();
    await sleep(100);
    return true;
  }
  const button = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await button.count() === 0) {
    return false;
  }
  await button.first().click();
  await sleep(100);
  return true;
}

async function ensureTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  if (await tab.count() > 0) {
    await tab.first().click();
    await sleep(100);
    return true;
  }
  const button = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await button.count() === 0) {
    return false;
  }
  await button.first().click();
  await sleep(100);
  return true;
}

async function coordinatorDiagnostics(page) {
  return page.locator(".simple-delivery-diagnostics").allInnerTexts().catch(() => []);
}

async function coordinatorFollowerRows(page) {
  const rows = page.locator(".simple-voter-list-item");
  const count = await rows.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await rows.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
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

async function getDisplayedActorId(page, prefix) {
  const body = await readBody(page);
  const match = body.match(new RegExp(`${prefix} ID ([0-9a-f]+)`, "i"));
  if (!match) {
    throw new Error(`Could not find ${prefix} ID on page`);
  }
  return match[1];
}

async function clickAllEnabled(page, matcher) {
  const buttons = page.getByRole("button", { name: matcher });
  const count = await buttons.count();
  let clicked = 0;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    try {
      if (!(await button.isVisible({ timeout: 1000 }))) {
        continue;
      }
      if (!(await button.isDisabled({ timeout: 1000 }))) {
        await button.click();
        clicked += 1;
        await sleep(100);
      }
    } catch {
      continue;
    }
  }
  return clicked;
}

async function setVerifyAll(page) {
  await ensureTab(page, "Configure");
  const checkbox = page.getByRole("checkbox", { name: /Verify all/i }).first();
  if (await checkbox.count() === 0) {
    return false;
  }
  await checkbox.waitFor({ state: "visible", timeout: 30000 });
  if (!(await checkbox.isChecked())) {
    await checkbox.click();
    await sleep(100);
  }
  return true;
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

function createRoundStageTracker({ round, prompt, voterIds, coordinatorCount }) {
  return {
    round,
    prompt,
    startedAtMs: Date.now(),
    lastObservedAtMs: 0,
    totalPairs: voterIds.length * coordinatorCount,
    voterIds,
    stages: {
      roundSeen: new Map(),
      blindKeySeen: new Map(),
      blindedRequestSent: new Map(),
      ticketSent: new Map(),
      receiptAcknowledged: new Map(),
    },
  };
}

function recordStage(stageTracker, stageName, pairKey, nowMs) {
  const stageMap = stageTracker.stages[stageName];
  if (!stageMap.has(pairKey)) {
    stageMap.set(pairKey, nowMs);
  }
}

function summariseStageMap(stageMap, startedAtMs, totalPairs) {
  const timings = [...stageMap.values()]
    .map((value) => value - startedAtMs)
    .sort((left, right) => left - right);
  const midpoint = timings.length
    ? timings[Math.floor((timings.length - 1) / 2)]
    : null;

  return {
    count: stageMap.size,
    totalPairs,
    firstMs: timings[0] ?? null,
    medianMs: midpoint,
    lastMs: timings[timings.length - 1] ?? null,
  };
}

function summariseRoundStages(stageTracker) {
  return Object.fromEntries(
    Object.entries(stageTracker.stages).map(([stageName, stageMap]) => [
      stageName,
      summariseStageMap(stageMap, stageTracker.startedAtMs, stageTracker.totalPairs),
    ]),
  );
}

async function observeRoundStages(stageTracker, coordinators, voters) {
  const nowMs = Date.now();

  for (const [voterIndex, page] of voters.entries()) {
    const voterId = stageTracker.voterIds[voterIndex] ?? `voter${voterIndex + 1}`;
    await ensureTab(page, "Configure");
    const cards = await voterCardDiagnostics(page);
    for (let coordinatorIndex = 0; coordinatorIndex < cards.length; coordinatorIndex += 1) {
      const text = cards[coordinatorIndex];
      const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
      if (/Live round seen\./i.test(text)) {
        recordStage(stageTracker, "roundSeen", pairKey, nowMs);
      }
      if (/Blind key seen\./i.test(text)) {
        recordStage(stageTracker, "blindKeySeen", pairKey, nowMs);
      }
      if (/Blinded ticket request acknowledged\./i.test(text)) {
        recordStage(stageTracker, "blindedRequestSent", pairKey, nowMs);
      }
    }
  }

  for (const [coordinatorIndex, page] of coordinators.entries()) {
    await ensureTab(page, "Configure");
    const rows = await coordinatorFollowerRows(page);
    for (const text of rows) {
      const match = text.match(/Voter ([0-9a-f]+)/i);
      if (!match) {
        continue;
      }
      const voterId = match[1];
      const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
      if (/Blinded ticket request received\./i.test(text)) {
        recordStage(stageTracker, "blindedRequestSent", pairKey, nowMs);
      }
      if (/Ticket sent\./i.test(text)) {
        recordStage(stageTracker, "ticketSent", pairKey, nowMs);
      }
      if (/Voter acknowledged ticket receipt\./i.test(text)) {
        recordStage(stageTracker, "receiptAcknowledged", pairKey, nowMs);
      }
    }
  }

  stageTracker.lastObservedAtMs = nowMs;
}

async function clickEnabledTicketsDuringWindow(coordinators, voters, durationMs, stageTracker) {
  const deadline = Date.now() + durationMs;
  const sendCounts = coordinators.map((_, index) => ({
    coordinator: index + 1,
    clicked: 0,
  }));

  while (Date.now() < deadline) {
    let clickedThisPass = 0;
    for (const [index, page] of coordinators.entries()) {
      const clicked = await clickAllEnabled(page, /^(Send ticket|Resend ticket)$/i);
      sendCounts[index].clicked += clicked;
      clickedThisPass += clicked;
    }

    if (await allVotersTicketReady(voters)) {
      break;
    }

    if (!stageTracker.lastObservedAtMs || Date.now() - stageTracker.lastObservedAtMs >= 4000) {
      await observeRoundStages(stageTracker, coordinators, voters);
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
  const voterBaseUrl = new URL(base);
  const coordinatorBaseUrl = new URL(base);
  coordinatorBaseUrl.pathname = coordinatorBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple-coordinator.html");
  voterBaseUrl.pathname = voterBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple.html");

  const coordinators = [];
  const voters = [];

  for (let index = 0; index < coordinatorCount; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = new URL(coordinatorBaseUrl.toString());
    if (nip65Mode !== "on") {
      url.searchParams.set("nip65", "off");
    }
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    coordinators.push(page);
  }

  for (let index = 0; index < voterCount; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = new URL(voterBaseUrl.toString());
    if (nip65Mode !== "on") {
      url.searchParams.set("nip65", "off");
    }
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    voters.push(page);
  }

  for (const page of coordinators) {
    await clickByText(page, 'button', /New ID/i);
    await ensureTab(page, "Settings");
  }
  for (const page of voters) {
    await clickByText(page, 'button', /^New$/i);
    await ensureTab(page, "Settings");
  }
  await sleep(1500);

  const coordinatorNpubs = [];
  for (const page of coordinators) {
    coordinatorNpubs.push(await getNpub(page));
  }

  const voterIds = [];
  for (const page of voters) {
    voterIds.push(await getDisplayedActorId(page, "Voter"));
  }

  for (let index = 1; index < coordinators.length; index += 1) {
    await ensureTab(coordinators[index], "Configure");
    await coordinators[index].getByPlaceholder("Leave blank if this coordinator is the lead").fill(coordinatorNpubs[0]);
    await clickByText(coordinators[index], "button", /Notify coordinator/i);
  }

  for (const page of voters) {
    await ensureTab(page, "Configure");
    await addCoordinatorsToVoter(page, coordinatorNpubs);
  }

  await sleep(startupWaitMs);

  for (const page of coordinators) {
    await setVerifyAll(page);
  }

  const rounds = [];
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const prompt = `Round ${roundIndex + 1}: Should the proposal pass?`;
    const stageTracker = createRoundStageTracker({
      round: roundIndex + 1,
      prompt,
      voterIds,
      coordinatorCount,
    });
    const lead = coordinators[0];
    await ensureTab(lead, "Voting");
    if (coordinatorCount > 1) {
      const increaseThreshold = lead.getByRole("button", { name: /Increase Threshold T/i }).first();
      if (await increaseThreshold.count()) {
        await increaseThreshold.click();
        await sleep(100);
      }
    }
    const questionBox = lead.locator("#simple-question-prompt").first();
    await questionBox.waitFor({ state: "visible", timeout: 30000 });
    await questionBox.fill(prompt);
    await clickByText(lead, "button", /Broadcast live vote|Vote broadcast/i);

    await observeRoundStages(stageTracker, coordinators, voters);

    const roundDiscoveryDeadline = Date.now() + roundWaitMs;
    while (Date.now() < roundDiscoveryDeadline) {
      await sleep(4000);
      await observeRoundStages(stageTracker, coordinators, voters);
    }

    const sendCounts = await clickEnabledTicketsDuringWindow(
      coordinators,
      voters,
      ticketWaitMs,
      stageTracker,
    );

    await sleep(4000);
    await observeRoundStages(stageTracker, coordinators, voters);

    for (const [index, page] of voters.entries()) {
      await ensureVoterTab(page, "Vote");
      const body = await readBody(page);
      const ticketReady = parseTicketReady(body);
      if (ticketReady && ticketReady.ready >= ticketReady.required) {
        const voteChoice = index % 2 === 0 ? "Yes" : "No";
        const button = page.getByRole("button", { name: new RegExp(`^${voteChoice}$`, "i") });
        await button.click({ force: true });
        const submit = page.getByRole("button", { name: /^Submit vote$/i });
        if (await submit.count()) {
          if (!(await submit.isDisabled())) {
            await submit.click({ force: true });
            await sleep(200);
          }
        }
      }
    }

    rounds.push({
      round: roundIndex + 1,
      prompt,
      sendCounts,
      stageMetrics: summariseRoundStages(stageTracker),
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
      stageMetrics: round.stageMetrics,
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
