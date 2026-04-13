import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SimplePool } from "nostr-tools";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEBUG_DIR = path.resolve(process.cwd(), ".planning/debug/live-harness");
const relayProbePool = new SimplePool({
  enablePing: true,
  enableReconnect: true,
});

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveHarnessTimeoutMs({
  startupWaitMs,
  roundWaitMs,
  ticketWaitMs,
  roundCount,
}) {
  return startupWaitMs + (roundCount * (roundWaitMs + ticketWaitMs + 20000)) + 120000;
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Harness timeout after/i.test(message)) {
    return "protocol_timeout";
  }
  if (/Target page, context or browser has been closed/i.test(message)) {
    return "browser_resource_collapse";
  }
  if (/Timeout .*exceeded/i.test(message) || /waiting for/i.test(message)) {
    return "harness_failure";
  }
  return "unknown_failure";
}

function classifyProtocolFailure(rounds) {
  const latestRound = rounds.at(-1) ?? null;
  if (!latestRound?.stageMetrics) {
    return {
      protocolFailureClass: "startup",
      firstMissingStage: "roundSeen",
    };
  }

  const stageMetrics = latestRound.stageMetrics;
  const firstMissingStage = [
    "roundSeen",
    "blindKeySeen",
    "blindedRequestSent",
    "ticketSent",
    "ticketDeliveryConfirmed",
  ].find((stageName) => Number(stageMetrics[stageName]?.count ?? 0) === 0) ?? null;

  const roundSeen = Number(stageMetrics.roundSeen?.count ?? 0);
  const requestSeen = Number(stageMetrics.blindedRequestSent?.count ?? 0);
  const ticketSent = Number(stageMetrics.ticketSent?.count ?? 0);
  const completionSeen = Number(stageMetrics.ticketDeliveryConfirmed?.count ?? 0);

  let protocolFailureClass = "mixed";
  if (roundSeen === 0 && requestSeen === 0) {
    protocolFailureClass = "startup";
  } else if (roundSeen > 0 && (requestSeen > 0 || ticketSent > 0 || completionSeen > 0)) {
    protocolFailureClass = "dm_pipeline";
  }

  return {
    protocolFailureClass,
    firstMissingStage,
  };
}

function classifyStartupJoinFailure(snapshots) {
  const coordinatorSnapshots = snapshots.filter((snapshot) => snapshot.label.startsWith("coord"));
  return coordinatorSnapshots.map((snapshot) => {
    const startup = snapshot.coordinatorDebug?.startupDiagnostics ?? null;
    const readiness = snapshot.coordinatorDebug?.runtimeReadiness ?? null;
    const engineStatus = snapshot.coordinatorDebug?.engineStatus ?? null;
    const bucket = startup?.startupJoinFailureBucket ?? null;
    return {
      coordinator: snapshot.label,
      bucket,
      phase: readiness?.phase ?? null,
      joinedGroup: engineStatus?.joined_group ?? null,
      groupReady: engineStatus?.group_ready ?? null,
      startupDiagnostics: startup,
    };
  });
}

async function ensureDebugDir() {
  await mkdir(DEBUG_DIR, { recursive: true });
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runRelayProbe(input) {
  const relay = String(input?.relay ?? "").trim();
  const kind = Number(input?.kind ?? 0);
  const mailboxId = typeof input?.mailboxId === "string" ? input.mailboxId.trim() : "";
  const etype = typeof input?.etype === "string" ? input.etype.trim() : "";
  const eventId = typeof input?.eventId === "string" ? input.eventId.trim() : "";
  const ticketId = typeof input?.ticketId === "string" ? input.ticketId.trim() : "";
  const requestId = typeof input?.requestId === "string" ? input.requestId.trim() : "";

  if (!relay || !Number.isFinite(kind) || kind <= 0) {
    return null;
  }

  const filters = [
    {
      name: "kind_only",
      filter: { kinds: [kind], limit: 200 },
    },
    {
      name: "kind_mailbox",
      filter: { kinds: [kind], "#mailbox": mailboxId ? [mailboxId] : undefined, limit: 200 },
    },
    {
      name: "kind_mailbox_etype",
      filter: {
        kinds: [kind],
        "#mailbox": mailboxId ? [mailboxId] : undefined,
        "#etype": etype ? [etype] : undefined,
        limit: 200,
      },
    },
  ];

  const probes = [];
  const queryWithTimeout = async (relay, filter, timeoutMs = 8000) => {
    let timeoutId;
    try {
      return await Promise.race([
        relayProbePool.querySync([relay], filter),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Relay probe timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutId.unref?.();
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };
  for (const entry of filters) {
    const filter = Object.fromEntries(
      Object.entries(entry.filter).filter(([, value]) => value !== undefined),
    );
    try {
      const events = await queryWithTimeout(relay, filter, 8000);
      probes.push({
        name: entry.name,
        relay,
        filter,
        count: events.length,
        matchedEventId: Boolean(eventId) && events.some((event) => event.id === eventId),
        matchedTicketTag: Boolean(ticketId) && events.some((event) => (
          Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === "ticket" && tag[1] === ticketId)
        )),
        matchedRequestTag: Boolean(requestId) && events.some((event) => (
          Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === "request" && tag[1] === requestId)
        )),
      });
    } catch (error) {
      probes.push({
        name: entry.name,
        relay,
        filter,
        error: safeErrorMessage(error),
      });
    }
  }
  return probes;
}

function pageRuntimeState(page) {
  return {
    browserConnected: page.context().browser()?.isConnected?.() ?? false,
    contextClosed: page.context().pages().length === 0 && page.isClosed(),
    pageClosed: page.isClosed(),
  };
}

async function isPageAlive(page) {
  if (page.isClosed()) {
    return false;
  }
  const browser = page.context().browser();
  if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) {
    return false;
  }
  return true;
}

async function snapshotPage(actor, reason) {
  const label = actor.label.replace(/[^a-z0-9_-]/gi, "_");
  const prefix = `${Date.now()}-${label}-${reason.replace(/[^a-z0-9_-]/gi, "_")}`;
  const htmlPath = path.join(DEBUG_DIR, `${prefix}.html`);
  const pngPath = path.join(DEBUG_DIR, `${prefix}.png`);
  const metaPath = path.join(DEBUG_DIR, `${prefix}.json`);
  const meta = {
    label: actor.label,
    reason,
    url: null,
    body: null,
    coordinatorDebug: null,
    voterDebug: null,
    ticketLifecycleTraces: [],
    runtime: pageRuntimeState(actor.page),
    screenshotPath: pngPath,
    htmlPath,
    captureError: null,
  };

  try {
    meta.url = actor.page.url();
    if (await isPageAlive(actor.page)) {
      const html = await actor.page.content().catch(() => null);
      const body = await actor.page.locator("body").innerText().catch(() => null);
      const traces = await readTicketLifecycleTraces(actor.page).catch(() => []);
      const coordinatorDebug = await readCoordinatorDebug(actor.page).catch(() => null);
      const voterDebug = await readVoterDebug(actor.page).catch(() => null);
      meta.body = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : null;
      meta.coordinatorDebug = coordinatorDebug;
      meta.voterDebug = voterDebug;
      meta.ticketLifecycleTraces = Array.isArray(traces) ? traces : [];
      if (typeof html === "string") {
        await writeFile(htmlPath, html, "utf8");
      }
      await actor.page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);
    }
  } catch (error) {
    meta.captureError = safeErrorMessage(error);
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function snapshotAllActors(actors, reason) {
  await ensureDebugDir();
  return Promise.all(actors.map((actor) => snapshotPage(actor, reason)));
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

async function ensureVoterTab(page, name, actorLabel = "unknown-voter") {
  if (!(await isPageAlive(page))) {
    throw new Error(`Page is closed before ensureVoterTab(${name}) for ${actorLabel}`);
  }
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  try {
    if (await tab.count() > 0) {
      await tab.first().click();
      await sleep(100);
      return true;
    }
  } catch (error) {
    if (await isPageAlive(page)) {
      await sleep(150);
      if (await tab.count().catch(() => 0) > 0) {
        await tab.first().click();
        await sleep(100);
        return true;
      }
    }
    throw new Error(`ensureVoterTab(${name}) failed for ${actorLabel}: ${safeErrorMessage(error)}`);
  }
  const button = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await button.count().catch(() => 0) === 0) {
    return false;
  }
  await button.first().click();
  await sleep(100);
  return true;
}

async function ensureTab(page, name, actorLabel = "unknown-actor") {
  if (!(await isPageAlive(page))) {
    throw new Error(`Page is closed before ensureTab(${name}) for ${actorLabel}`);
  }
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  try {
    if (await tab.count() > 0) {
      await tab.first().click();
      await sleep(100);
      return true;
    }
  } catch (error) {
    if (await isPageAlive(page)) {
      await sleep(150);
      if (await tab.count().catch(() => 0) > 0) {
        await tab.first().click();
        await sleep(100);
        return true;
      }
    }
    throw new Error(`ensureTab(${name}) failed for ${actorLabel}: ${safeErrorMessage(error)}`);
  }
  const button = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await button.count().catch(() => 0) === 0) {
    return false;
  }
  await button.first().click();
  await sleep(100);
  return true;
}

async function coordinatorDiagnostics(page) {
  if (!(await isPageAlive(page))) {
    return ["PAGE_CLOSED"];
  }
  return page.locator(".simple-delivery-diagnostics").allInnerTexts().catch(() => []);
}

async function coordinatorFollowerRows(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  const rows = page.locator(".simple-voter-list-item");
  const count = await rows.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await rows.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function voterCardDiagnostics(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  const cards = page.locator(".simple-coordinator-card");
  const count = await cards.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await cards.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function readBody(page) {
  if (!(await isPageAlive(page))) {
    return "PAGE_CLOSED";
  }
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function readTicketLifecycleTraces(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  return page.evaluate(() => {
    const state = globalThis.__simpleTicketLifecycleTraceState;
    if (!state || typeof state !== "object" || !state.traces || typeof state.traces !== "object") {
      return [];
    }
    return Object.values(state.traces);
  }).catch(() => []);
}

async function readCoordinatorDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__simpleCoordinatorDebug ?? null).catch(() => null);
}

async function readVoterDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__simpleVoterDebug ?? null).catch(() => null);
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

async function getThresholdT(page) {
  const output = page.locator("#simple-threshold-t-value").first();
  if (await output.count() === 0) {
    return null;
  }
  await output.waitFor({ state: "visible", timeout: 30000 });
  const text = (await output.textContent())?.trim() ?? "";
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureThresholdT(page, desiredT) {
  const increaseThreshold = page.getByRole("button", { name: /Increase Threshold T/i }).first();
  if (await increaseThreshold.count() === 0) {
    return { reached: false, value: null, reason: "threshold_stepper_missing" };
  }

  let currentT = await getThresholdT(page);
  if (currentT === null) {
    return { reached: false, value: null, reason: "threshold_value_missing" };
  }

  if (currentT >= desiredT) {
    return { reached: true, value: currentT, reason: currentT === desiredT ? "already_target" : "already_above_target" };
  }

  for (let attempts = 0; attempts < 10 && currentT < desiredT; attempts += 1) {
    if (await increaseThreshold.isDisabled()) {
      return { reached: false, value: currentT, reason: "threshold_stepper_disabled" };
    }
    await increaseThreshold.click();
    await sleep(150);
    const nextT = await getThresholdT(page);
    if (nextT === null) {
      return { reached: false, value: currentT, reason: "threshold_value_missing_after_click" };
    }
    currentT = nextT;
  }

  return {
    reached: currentT >= desiredT,
    value: currentT,
    reason: currentT >= desiredT ? "target_reached" : "target_not_reached",
  };
}

async function waitForLeadRoundBroadcastReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureTab(page, "Voting", "lead");
    const body = await readBody(page);
    const questionBox = page.locator("#simple-question-prompt").first();
    const broadcastButton = page.getByRole("button", { name: /Broadcast live vote|Vote broadcast/i }).first();
    const waitingForSupervisor =
      /Preparing coordinator MLS group/i.test(body)
      || /Waiting for MLS welcome acknowledgements/i.test(body)
      || /Coordinator control engine is not ready/i.test(body);

    const questionVisible =
      (await questionBox.count().catch(() => 0)) > 0
      && (await questionBox.isVisible().catch(() => false));
    const buttonVisible =
      (await broadcastButton.count().catch(() => 0)) > 0
      && (await broadcastButton.isVisible().catch(() => false));
    const buttonEnabled = buttonVisible && !(await broadcastButton.isDisabled().catch(() => true));

    if (questionVisible && buttonEnabled && !waitingForSupervisor) {
      return true;
    }

    await sleep(500);
  }

  return false;
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
  for (const actor of voters) {
    await ensureVoterTab(actor.page, "Vote", actor.label);
    const body = await readBody(actor.page);
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
      ticketObserved: new Map(),
      ballotSubmitted: new Map(),
      ballotAccepted: new Map(),
      ticketDeliveryConfirmedByAck: new Map(),
      ticketDeliveryConfirmedByBallot: new Map(),
      ticketDeliveryConfirmed: new Map(),
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

function recordStageForAllCoordinators(stageTracker, stageName, voterId, coordinatorCount, nowMs) {
  for (let coordinatorIndex = 0; coordinatorIndex < coordinatorCount; coordinatorIndex += 1) {
    const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
    recordStage(stageTracker, stageName, pairKey, nowMs);
  }
}

async function observeRoundStages(stageTracker, coordinators, voters) {
  const nowMs = Date.now();

  for (const [voterIndex, actor] of voters.entries()) {
    const page = actor.page;
    const voterId = stageTracker.voterIds[voterIndex] ?? `voter${voterIndex + 1}`;
    await ensureTab(page, "Configure", actor.label);
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
    const voterDebug = await readVoterDebug(page);
    if (voterDebug && typeof voterDebug === "object") {
      const coordinatorCount = coordinators.length;
      if (voterDebug.ticketObserved === true) {
        recordStageForAllCoordinators(stageTracker, "ticketObserved", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ticketAckSent === true) {
        recordStageForAllCoordinators(stageTracker, "ticketDeliveryConfirmedByAck", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ballotSubmitted === true) {
        recordStageForAllCoordinators(stageTracker, "ballotSubmitted", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ticketAckSent === true) {
        recordStageForAllCoordinators(stageTracker, "ticketDeliveryConfirmed", voterId, coordinatorCount, nowMs);
      }
    }
  }

  for (const [coordinatorIndex, actor] of coordinators.entries()) {
    const page = actor.page;
    await ensureTab(page, "Configure", actor.label);
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
        recordStage(stageTracker, "ticketDeliveryConfirmedByAck", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmed", pairKey, nowMs);
      }
      if (/Valid ballot accepted\./i.test(text)) {
        recordStage(stageTracker, "ballotAccepted", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmedByBallot", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmed", pairKey, nowMs);
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
    for (const [index, actor] of coordinators.entries()) {
      const clicked = await clickAllEnabled(actor.page, /^Send ticket$/i);
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
  for (const [index, actor] of coordinators.entries()) {
    const page = actor.page;
    coordinatorStates[`coord${index + 1}`] = {
      diagnostics: await coordinatorDiagnostics(page),
      body: await readBody(page),
      coordinatorDebug: await readCoordinatorDebug(page),
      ticketLifecycleTraces: await readTicketLifecycleTraces(page),
      url: await isPageAlive(page) ? page.url() : null,
      runtime: pageRuntimeState(page),
    };
  }

  const voterStates = {};
  for (const [index, actor] of voters.entries()) {
    const page = actor.page;
    await ensureVoterTab(page, "Vote", actor.label);
    const body = await readBody(page);
    voterStates[`voter${index + 1}`] = {
      cards: await voterCardDiagnostics(page),
      body,
      voterDebug: await readVoterDebug(page),
      ticketLifecycleTraces: await readTicketLifecycleTraces(page),
      ticketReady: parseTicketReady(body),
      seesQuestion: /Round [0-9]+/i.test(body) || /Should the proposal pass\?/i.test(body),
      url: await isPageAlive(page) ? page.url() : null,
      runtime: pageRuntimeState(page),
    };
  }

  return { coordinatorStates, voterStates };
}

async function main() {
  const coordinatorCount = envInt("LIVE_COORDINATORS", 5);
  const voterCount = envInt("LIVE_VOTERS", 10);
  const roundCount = envInt("LIVE_ROUNDS", 3);
  const deploymentMode = (process.env.LIVE_DEPLOYMENT_MODE ?? "course_feedback").trim().toLowerCase();
  const base = process.env.LIVE_SIMPLE_BASE_URL ?? "http://127.0.0.1:4175/simple.html";
  const nip65Mode = (process.env.LIVE_NIP65 ?? "off").trim().toLowerCase();
  const startupWaitMs = envInt("LIVE_STARTUP_WAIT_MS", 45000);
  const roundWaitMs = envInt("LIVE_ROUND_WAIT_MS", 20000);
  const ticketWaitMs = envInt("LIVE_TICKET_WAIT_MS", 20000);
  const harnessTimeoutMs = envInt(
    "LIVE_HARNESS_TIMEOUT_MS",
    deriveHarnessTimeoutMs({ startupWaitMs, roundWaitMs, ticketWaitMs, roundCount }),
  );

  const browser = await chromium.launch({ headless: true });
  const voterBaseUrl = new URL(base);
  const coordinatorBaseUrl = new URL(base);
  coordinatorBaseUrl.pathname = coordinatorBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple-coordinator.html");
  voterBaseUrl.pathname = voterBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple.html");

  const coordinators = [];
  const voters = [];
  const rounds = [];
  let timeoutId = null;

  try {
    const runPromise = (async () => {
      for (let index = 0; index < coordinatorCount; index += 1) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const url = new URL(coordinatorBaseUrl.toString());
        if (nip65Mode !== "on") {
          url.searchParams.set("nip65", "off");
        }
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        coordinators.push({ label: `coord${index + 1}`, page, context });
      }

      for (let index = 0; index < voterCount; index += 1) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const url = new URL(voterBaseUrl.toString());
        if (nip65Mode !== "on") {
          url.searchParams.set("nip65", "off");
        }
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        voters.push({ label: `voter${index + 1}`, page, context });
      }

      for (const actor of coordinators) {
        await clickByText(actor.page, 'button', /New ID/i);
        await ensureTab(actor.page, "Settings", actor.label);
      }
      for (const actor of voters) {
        await clickByText(actor.page, 'button', /^New$/i);
        await ensureTab(actor.page, "Settings", actor.label);
      }
      await sleep(1500);

      const coordinatorNpubs = [];
      for (const actor of coordinators) {
        coordinatorNpubs.push(await getNpub(actor.page));
      }

      const voterIds = [];
      for (const actor of voters) {
        voterIds.push(await getDisplayedActorId(actor.page, "Voter"));
      }

      for (let index = 1; index < coordinators.length; index += 1) {
        await ensureTab(coordinators[index].page, "Configure", coordinators[index].label);
        await coordinators[index].page.getByPlaceholder("Leave blank if this coordinator is the lead").fill(coordinatorNpubs[0]);
        await clickByText(coordinators[index].page, "button", /Notify coordinator/i);
      }

      for (const actor of voters) {
        await ensureTab(actor.page, "Configure", actor.label);
        await addCoordinatorsToVoter(actor.page, coordinatorNpubs);
      }

      await sleep(startupWaitMs);

      for (const actor of coordinators) {
        await setVerifyAll(actor.page);
      }

      for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
        const prompt = `Round ${roundIndex + 1}: Should the proposal pass?`;
        const stageTracker = createRoundStageTracker({
          round: roundIndex + 1,
          prompt,
          voterIds,
          coordinatorCount,
        });
        const lead = coordinators[0].page;
        await ensureTab(lead, "Voting", coordinators[0].label);
        if (coordinatorCount > 1) {
          const thresholdResult = await ensureThresholdT(lead, Math.min(coordinatorCount, 2));
          if (!thresholdResult.reached) {
            throw new Error(
              `Could not reach desired Threshold T before round ${roundIndex + 1}: ${thresholdResult.reason} (current=${thresholdResult.value ?? "unknown"})`,
            );
          }
        }
        const readyForBroadcast = await waitForLeadRoundBroadcastReady(lead, startupWaitMs);
        if (!readyForBroadcast) {
          throw new Error(`Lead coordinator was not ready to broadcast round ${roundIndex + 1} within ${startupWaitMs}ms`);
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

        for (const [index, actor] of voters.entries()) {
          const page = actor.page;
          await ensureVoterTab(page, "Vote", actor.label);
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
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        reject(new Error(`Harness timeout after ${harnessTimeoutMs}ms`));
      }, harnessTimeoutMs);
    });

    await Promise.race([runPromise, timeoutPromise]);
  } catch (error) {
    const participants = [...coordinators, ...voters];
    const snapshots = await snapshotAllActors(participants, classifyHarnessFailure(error));
    const diagnostic = {
      failureClass: classifyHarnessFailure(error),
      error: safeErrorMessage(error),
      config: {
        base,
        deploymentMode,
        nip65Mode,
        coordinatorCount,
        voterCount,
        roundCount,
        startupWaitMs,
        roundWaitMs,
        ticketWaitMs,
        harnessTimeoutMs,
      },
      completedRounds: rounds,
      snapshots,
    };
    const protocolFailure = classifyProtocolFailure(rounds);
    diagnostic.protocolFailureClass = protocolFailure.protocolFailureClass;
    diagnostic.firstMissingStage = protocolFailure.firstMissingStage;
    diagnostic.coordinatorReadinessSummary = snapshots
      .filter((snapshot) => snapshot.label.startsWith("coord"))
      .map((snapshot) => ({
        coordinator: snapshot.label,
        readiness: snapshot.coordinatorDebug?.runtimeReadiness ?? null,
        engineStatus: snapshot.coordinatorDebug?.engineStatus ?? null,
        startupDiagnostics: snapshot.coordinatorDebug?.startupDiagnostics ?? null,
        controlStateLabel: snapshot.coordinatorDebug?.controlStateLabel ?? null,
      }));
    diagnostic.startupJoinSummary = classifyStartupJoinFailure(snapshots);
    diagnostic.voterRoundVisibilitySummary = snapshots
      .filter((snapshot) => snapshot.label.startsWith("voter"))
      .map((snapshot) => ({
        voter: snapshot.label,
        visibility: snapshot.voterDebug ?? null,
      }));
    console.error(JSON.stringify(diagnostic, null, 2));
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
    await browser.close().catch(() => undefined);
    process.exit(1);
  }

  const summary = rounds.map((round) => {
    const voterTicketSummary = Object.entries(round.state.voterStates).map(([key, value]) => ({
      voter: key,
      ticketReady: value.ticketReady,
      hasTicket: Boolean(value.ticketReady && value.ticketReady.ready >= value.ticketReady.required),
      ballotSubmitted: Boolean(value.voterDebug?.ballotSubmitted),
      ballotAccepted: Boolean(value.voterDebug?.ballotAccepted),
    }));
    const coordinatorStates = Object.values(round.state.coordinatorStates ?? {});
    const coordinatorAcceptedBallots = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.acceptedBallotCount ?? 0)),
    );
    const coordinatorRejectedBallots = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.rejectedBallotCount ?? 0)),
    );
    const coordinatorAcceptedByLineage = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.voters?.filter((entry) => entry.ballotAccepted).length ?? 0)),
    );
    const primaryCoordinatorDebug = coordinatorStates[0]?.coordinatorDebug ?? null;
    const rowsWithoutAcceptedBallot = Array.isArray(primaryCoordinatorDebug?.rowsWithoutAcceptedBallot)
      ? primaryCoordinatorDebug.rowsWithoutAcceptedBallot
      : [];
    const acceptedBallotsByRequestId = Array.isArray(primaryCoordinatorDebug?.acceptedBallotsByRequestId)
      ? primaryCoordinatorDebug.acceptedBallotsByRequestId
      : [];
    const acceptedBallotsByTicketId = Array.isArray(primaryCoordinatorDebug?.acceptedBallotsByTicketId)
      ? primaryCoordinatorDebug.acceptedBallotsByTicketId
      : [];
    const acceptedRequestIds = new Set(
      acceptedBallotsByRequestId
        .map((entry) => (Array.isArray(entry) ? String(entry[0] ?? "").trim() : ""))
        .filter(Boolean),
    );
    const acceptedTicketIds = new Set(
      acceptedBallotsByTicketId
        .map((entry) => (Array.isArray(entry) ? String(entry[0] ?? "").trim() : ""))
        .filter(Boolean),
    );
    const voterStateByNpub = new Map(
      Object.values(round.state.voterStates)
        .map((value) => [
          typeof value?.voterDebug?.voterNpub === "string" ? value.voterDebug.voterNpub.trim() : "",
          value,
        ])
        .filter(([npub]) => Boolean(npub)),
    );
    const coordinatorVoterByNpub = new Map(
      Array.isArray(primaryCoordinatorDebug?.voters)
        ? primaryCoordinatorDebug.voters
          .map((entry) => [String(entry?.voterPubkey ?? ""), entry])
          .filter(([npub]) => Boolean(npub))
        : [],
    );
    const unmatchedRowDiagnostics = rowsWithoutAcceptedBallot.map((row) => {
      const voterPubkey = String(row?.voterPubkey ?? "");
      const requestId = typeof row?.requestId === "string" ? row.requestId.trim() : "";
      const requestMailboxId = typeof row?.requestMailboxId === "string" ? row.requestMailboxId.trim() : "";
      const ticketId = typeof row?.ticketId === "string" ? row.ticketId.trim() : "";
      const voterState = voterStateByNpub.get(voterPubkey);
      const coordinatorVoter = coordinatorVoterByNpub.get(voterPubkey);
      const ticketObserved = Boolean(voterState?.ticketReady && voterState.ticketReady.ready >= voterState.ticketReady.required);
      const ticketObservedLiveCount = Number(voterState?.voterDebug?.ticketObservedLiveCount ?? 0);
      const ticketObservedBackfillCount = Number(voterState?.voterDebug?.ticketObservedBackfillCount ?? 0);
      const ticketBackfillByRequestId = voterState?.voterDebug?.ticketBackfillByRequestId ?? {};
      const backfillDebugByRequestId = requestId ? ticketBackfillByRequestId[requestId] : null;
      const ticketBackfillAttemptCount = Number(
        backfillDebugByRequestId?.attemptCount
        ?? voterState?.voterDebug?.ticketBackfillAttemptCount
        ?? 0,
      );
      const ticketBackfillLastResultCount = Number(
        backfillDebugByRequestId?.lastResultCount
        ?? voterState?.voterDebug?.ticketBackfillLastResultCount
        ?? 0,
      );
      const ticketBackfillLastMatchedCount = Number(
        backfillDebugByRequestId?.lastMatchedCount
        ?? voterState?.voterDebug?.ticketBackfillLastMatchedCount
        ?? 0,
      );
      const ticketBackfillLastAttemptAt = backfillDebugByRequestId?.lastAttemptAt
        ?? voterState?.voterDebug?.ticketBackfillLastAttemptAt
        ?? null;
      const ticketBackfillLastSourceRelays = Array.isArray(backfillDebugByRequestId?.lastSourceRelays)
        ? backfillDebugByRequestId.lastSourceRelays
        : Array.isArray(voterState?.voterDebug?.ticketBackfillLastSourceRelays)
          ? voterState.voterDebug.ticketBackfillLastSourceRelays
          : [];
      const ticketBackfillFailureClass = ticketBackfillAttemptCount <= 0
        ? "backfill_not_triggered"
        : ticketBackfillLastResultCount <= 0
          ? "backfill_no_events_returned"
          : ticketBackfillLastMatchedCount <= 0
            ? "backfill_events_returned_no_match"
            : ticketObserved
              ? "backfill_match_found_observed"
              : "backfill_match_found_not_reconciled";
      const ticketLiveQuery = voterState?.voterDebug?.ticketLiveQuery ?? null;
      const ticketBackfillQuery = voterState?.voterDebug?.ticketBackfillQuery ?? null;
      const ticketPendingMailboxIds = Array.isArray(voterState?.voterDebug?.ticketPendingMailboxIds)
        ? voterState.voterDebug.ticketPendingMailboxIds
        : [];
      const ticketBackfillByRequestIdState = voterState?.voterDebug?.ticketBackfillByRequestId ?? {};
      const liveMailboxIds = Array.isArray(ticketLiveQuery?.mailboxIds) ? ticketLiveQuery.mailboxIds : [];
      const backfillMailboxIds = Array.isArray(ticketBackfillQuery?.mailboxIds) ? ticketBackfillQuery.mailboxIds : [];
      const ticketReadMailboxId = requestId
        ? ticketBackfillByRequestIdState?.[requestId]?.ticketReadMailboxId ?? null
        : null;
      const ticketBackfillMailboxId = requestId
        ? ticketBackfillByRequestIdState?.[requestId]?.ticketBackfillMailboxId ?? null
        : null;
      const ticketPublishMailboxId = typeof coordinatorVoter?.ticketPublishMailboxId === "string"
        ? coordinatorVoter.ticketPublishMailboxId.trim()
        : "";
      const liveMailboxFilterMatchesRequest = requestMailboxId
        ? liveMailboxIds.includes(requestMailboxId)
        : null;
      const backfillMailboxFilterMatchesRequest = requestMailboxId
        ? ticketPendingMailboxIds.includes(requestMailboxId) || backfillMailboxIds.includes(requestMailboxId)
        : null;
      const mailboxIdConsistent = Boolean(
        requestMailboxId
        && ticketPublishMailboxId
        && requestMailboxId === ticketPublishMailboxId
        && (ticketBackfillMailboxId ? ticketBackfillMailboxId === requestMailboxId : true)
        && (ticketReadMailboxId ? ticketReadMailboxId === requestMailboxId : true),
      );
      const mailboxIdConsistentReadRequest = requestMailboxId
        ? ticketReadMailboxId === requestMailboxId
        : null;
      const mailboxIdConsistentBackfillRequest = requestMailboxId
        ? ticketBackfillMailboxId === requestMailboxId
        : null;
      const ballotSubmitted = Boolean(voterState?.voterDebug?.ballotSubmitted);
      const ballotAccepted = Boolean(voterState?.voterDebug?.ballotAccepted);
      const ticketSent = Boolean(coordinatorVoter?.ticketSent || ticketObserved);
      const inAcceptedByRequestId = Boolean(requestId && acceptedRequestIds.has(requestId));
      const inAcceptedByTicketId = Boolean(ticketId && acceptedTicketIds.has(ticketId));
      const ticketPublishStartedAt = coordinatorVoter?.ticketPublishStartedAt ?? null;
      const ticketPublishSucceededAt = coordinatorVoter?.ticketPublishSucceededAt ?? null;
      const ticketResentCount = Number(coordinatorVoter?.ticketResentCount ?? 0);
      const recoveredByBackfill = !ticketObservedLiveCount && ticketObservedBackfillCount > 0;
      const recoveredByResend = ticketResentCount > 0 && (ticketObserved || inAcceptedByRequestId || inAcceptedByTicketId);
      const firstMissingStage = recoveredByResend
        ? "ticket_recovered_by_resend"
        : recoveredByBackfill
          ? "ticket_recovered_by_backfill"
          : !ticketSent
        ? "ticket_not_sent"
        : Boolean(ticketPublishStartedAt) && !Boolean(ticketPublishSucceededAt) && !ticketObserved
          ? "ticket_publish_unconfirmed"
          : Boolean(ticketPublishSucceededAt) && !ticketObserved
            ? (!mailboxIdConsistent ? "mailbox_id_mismatch" : ticketBackfillFailureClass)
        : !ticketObserved
          ? "ticket_not_observed"
          : ticketObserved && !inAcceptedByRequestId && !inAcceptedByTicketId
            ? "ticket_observed_unmapped"
          : !ballotSubmitted
            ? "ballot_not_submitted"
            : !inAcceptedByRequestId && !inAcceptedByTicketId
              ? "ballot_not_accepted_by_lineage"
              : "accepted_not_mapped";
      return {
        voterPubkey,
        requestId: requestId || null,
        requestMailboxId: requestMailboxId || null,
        ticketPublishMailboxId: ticketPublishMailboxId || null,
        ticketReadMailboxId,
        ticketBackfillMailboxId,
        mailboxIdConsistent,
        mailboxIdConsistentReadRequest,
        mailboxIdConsistentBackfillRequest,
        ticketId: ticketId || null,
        ticketSent,
        ticketObserved,
        ticketObservedLiveCount,
        ticketObservedBackfillCount,
        ticketObservedLiveAt: voterState?.voterDebug?.ticketObservedLiveAt ?? null,
        ticketObservedBackfillAt: voterState?.voterDebug?.ticketObservedBackfillAt ?? null,
        ballotSubmitted,
        ballotAccepted,
        ticketPublishStartedAt,
        ticketPublishSucceededAt,
        ticketPublishEventId: coordinatorVoter?.ticketPublishEventId ?? null,
        ticketPublishEventKind: coordinatorVoter?.ticketPublishEventKind ?? null,
        ticketPublishEventCreatedAt: coordinatorVoter?.ticketPublishEventCreatedAt ?? null,
        ticketPublishEventTags: Array.isArray(coordinatorVoter?.ticketPublishEventTags) ? coordinatorVoter.ticketPublishEventTags : [],
        ticketPublishEventContent: typeof coordinatorVoter?.ticketPublishEventContent === "string"
          ? coordinatorVoter.ticketPublishEventContent
          : null,
        ticketResentCount,
        ticketRelayTargets: Array.isArray(coordinatorVoter?.ticketRelayTargets) ? coordinatorVoter.ticketRelayTargets : [],
        ticketRelayResults: Array.isArray(coordinatorVoter?.ticketRelayResults) ? coordinatorVoter.ticketRelayResults : [],
        ticketRelaySuccessCount: Number(coordinatorVoter?.ticketRelaySuccessCount ?? 0),
        ticketBackfillAttemptCount,
        ticketBackfillLastAttemptAt,
        ticketBackfillLastResultCount,
        ticketBackfillLastMatchedCount,
        ticketBackfillLastSourceRelays,
        ticketBackfillFailureClass,
        ticketPendingMailboxIds,
        liveMailboxFilterMatchesRequest,
        backfillMailboxFilterMatchesRequest,
        ticketLiveQuery,
        ticketBackfillQuery,
        resendEligible: Boolean(coordinatorVoter?.resendEligible),
        resendBlockedReason: coordinatorVoter?.resendBlockedReason ?? null,
        inAcceptedByRequestId,
        inAcceptedByTicketId,
        firstMissingStage,
      };
    });
    const ticketObservedLiveCount = Object.values(round.state.voterStates).filter(
      (value) => Number(value?.voterDebug?.ticketObservedLiveCount ?? 0) > 0,
    ).length;
    const ticketObservedBackfillCount = Object.values(round.state.voterStates).filter(
      (value) => Number(value?.voterDebug?.ticketObservedBackfillCount ?? 0) > 0,
    ).length;
    const ticketRecoveredByResendCount = Array.isArray(primaryCoordinatorDebug?.voters)
      ? primaryCoordinatorDebug.voters.filter((entry) => (
        Number(entry?.ticketResentCount ?? 0) > 0
        && (Boolean(entry?.ballotAccepted) || Boolean(entry?.ticketAckSeen))
      )).length
      : 0;
    const ticketStillMissingCount = Number(primaryCoordinatorDebug?.ticketStillMissingCount ?? 0);
    const rowsWithPublishSuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      Boolean(entry.ticketPublishSucceededAt)
      && !entry.ticketObserved
    )).length;
    const rowsWithFullRelaySuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && Array.isArray(entry.ticketRelayTargets)
      && entry.ticketRelayTargets.length > 0
      && entry.ticketRelaySuccessCount >= entry.ticketRelayTargets.length
    )).length;
    const rowsWithPartialRelaySuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && entry.ticketRelaySuccessCount > 0
      && Array.isArray(entry.ticketRelayTargets)
      && entry.ticketRelaySuccessCount < entry.ticketRelayTargets.length
    )).length;
    const rowsWithPublishUnconfirmedEventuallyObserved = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketPublishSucceededAt
      && entry.ticketObserved
    )).length;
    const rowsObservedOnlyAfterBackfill = unmatchedRowDiagnostics.filter((entry) => (
      Number(entry.ticketObservedBackfillCount ?? 0) > 0
      && Number(entry.ticketObservedLiveCount ?? 0) === 0
    )).length;
    const ticketPublishSucceededCount = Number(primaryCoordinatorDebug?.ticketPublishSucceededCount ?? 0);
    const backfillFailureClassCounts = unmatchedRowDiagnostics.reduce((acc, row) => {
      const key = String(row.ticketBackfillFailureClass ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const rowsWithRelayOverlapNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      const writeRelays = Array.isArray(entry.ticketRelayTargets) ? entry.ticketRelayTargets : [];
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      if (entry.ticketObserved || writeRelays.length === 0 || readRelays.length === 0) {
        return false;
      }
      const overlap = writeRelays.filter((relay) => readRelays.includes(relay)).length;
      return overlap > 0;
    }).length;
    const rowsWithNoRelayOverlapNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      const writeRelays = Array.isArray(entry.ticketRelayTargets) ? entry.ticketRelayTargets : [];
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      if (entry.ticketObserved || writeRelays.length === 0 || readRelays.length === 0) {
        return false;
      }
      const overlap = writeRelays.filter((relay) => readRelays.includes(relay)).length;
      return overlap === 0;
    }).length;
    const rowsWithReadRelaySetUnknown = unmatchedRowDiagnostics.filter((entry) => {
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      return !entry.ticketObserved && readRelays.length === 0;
    }).length;
    const rowsWithMailboxFilterMismatchNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      if (entry.ticketObserved || !entry.requestMailboxId) {
        return false;
      }
      return entry.liveMailboxFilterMatchesRequest === false || entry.backfillMailboxFilterMatchesRequest === false;
    }).length;
    const rowsWithMailboxIdMismatchNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && entry.requestMailboxId
      && entry.mailboxIdConsistent === false
    )).length;
    const publishSuccessObservationGapRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((rowsWithPublishSuccessNoObservation / Math.max(1, ticketPublishSucceededCount)).toFixed(3))
      : 0;
    const fullRelaySuccessObservationGapRatio = rowsWithFullRelaySuccessNoObservation > 0
      ? Number((rowsWithFullRelaySuccessNoObservation / Math.max(1, rowsWithPublishSuccessNoObservation)).toFixed(3))
      : 0;
    const backfillObservationRecoveryRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((rowsObservedOnlyAfterBackfill / rowsWithPublishSuccessNoObservation).toFixed(3))
      : 0;
    const backfillTriggeredRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((
        (rowsWithPublishSuccessNoObservation - Number(backfillFailureClassCounts.backfill_not_triggered ?? 0))
        / rowsWithPublishSuccessNoObservation
      ).toFixed(3))
      : 0;
    const sendQueueEligibleCount = Number(primaryCoordinatorDebug?.sendQueueEligibleCount ?? 0);
    const sendQueueStartedCount = Number(primaryCoordinatorDebug?.sendQueueStartedCount ?? 0);
    const sendQueueBlockedCount = Number(primaryCoordinatorDebug?.sendQueueBlockedCount ?? 0);
    const sendQueueBlockedReasons = primaryCoordinatorDebug?.sendQueueBlockedReasons ?? {};
    const sendQueueInFlightCount = Number(primaryCoordinatorDebug?.sendQueueInFlightCount ?? 0);
    const sendQueueUnsentCount = Number(primaryCoordinatorDebug?.sendQueueUnsentCount ?? 0);
    const roundOpenAt = primaryCoordinatorDebug?.roundOpenAt ?? null;
    const lastTicketSendStartedAt = primaryCoordinatorDebug?.lastTicketSendStartedAt ?? null;
    const unsentRowsAtRoundTimeout = unmatchedRowDiagnostics.filter((entry) => (
      entry.firstMissingStage === "ticket_not_sent"
      || entry.firstMissingStage === "ticket_publish_unconfirmed"
    )).length;
    const stageMetrics = round.stageMetrics ?? {};
    const ticketSentCount = Number(stageMetrics.ticketSent?.count ?? 0);
    const ticketObservedCount = Number(stageMetrics.ticketObserved?.count ?? 0);
    const ballotSubmittedCount = Number(stageMetrics.ballotSubmitted?.count ?? 0);
    const ballotAcceptedCount = Number(stageMetrics.ballotAccepted?.count ?? 0);
    const ticketDeliveryConfirmedByAckCount = Number(stageMetrics.ticketDeliveryConfirmedByAck?.count ?? 0);
    const ticketDeliveryConfirmedByBallotCount = Number(stageMetrics.ticketDeliveryConfirmedByBallot?.count ?? 0);
    const ticketDeliveryConfirmedCount = Number(stageMetrics.ticketDeliveryConfirmed?.count ?? 0);
    const expectedPairs = Number(stageMetrics.ticketSent?.totalPairs ?? 0);
    const expectedAcceptedThreshold = round.state.voterStates ? Object.keys(round.state.voterStates).length : 0;
    const roundSuccess = deploymentMode === "course_feedback"
      ? expectedAcceptedThreshold > 0 && coordinatorAcceptedBallots >= expectedAcceptedThreshold
      : voterTicketSummary.length > 0 && voterTicketSummary.every((entry) => entry.hasTicket);
    const voterPublishedBallots = voterTicketSummary.filter((entry) => entry.ballotSubmitted).length;
    const voterObservedTickets = voterTicketSummary.filter((entry) => entry.hasTicket).length;
    return {
      round: round.round,
      prompt: round.prompt,
      deploymentMode,
      roundSuccess,
      sendCounts: round.sendCounts,
      votersWithTickets: voterTicketSummary.filter((entry) => entry.hasTicket).length,
      votersWithSubmittedBallots: voterTicketSummary.filter((entry) => entry.ballotSubmitted).length,
      votersWithAcceptedBallots: voterTicketSummary.filter((entry) => entry.ballotAccepted).length,
      voterPublishedBallots,
      voterObservedTickets,
      coordinatorAcceptedBallots,
      coordinatorRejectedBallots,
      coordinatorAcceptedByLineage,
      coordinatorTicketPublishStartedCount: Number(primaryCoordinatorDebug?.ticketPublishStartedCount ?? 0),
      coordinatorTicketPublishSucceededCount: Number(primaryCoordinatorDebug?.ticketPublishSucceededCount ?? 0),
      coordinatorTicketStillMissingCount: Number(primaryCoordinatorDebug?.ticketStillMissingCount ?? 0),
      coordinatorTicketResentCount: Number(primaryCoordinatorDebug?.ticketResentCount ?? 0),
      ticketObservedLiveCount,
      ticketObservedBackfillCount,
      ticketRecoveredByResendCount,
      ticketStillMissingCount,
      sendQueueEligibleCount,
      sendQueueStartedCount,
      sendQueueBlockedCount,
      sendQueueBlockedReasons,
      sendQueueInFlightCount,
      sendQueueUnsentCount,
      roundOpenAt,
      lastTicketSendStartedAt,
      unsentRowsAtRoundTimeout,
      rowsWithPublishSuccessNoObservation,
      rowsWithFullRelaySuccessNoObservation,
      rowsWithPartialRelaySuccessNoObservation,
      rowsWithPublishUnconfirmedEventuallyObserved,
      rowsObservedOnlyAfterBackfill,
      rowsWithRelayOverlapNoObservation,
      rowsWithNoRelayOverlapNoObservation,
      rowsWithReadRelaySetUnknown,
      rowsWithMailboxFilterMismatchNoObservation,
      rowsWithMailboxIdMismatchNoObservation,
      backfillFailureClassCounts,
      publishSuccessObservationGapRatio,
      fullRelaySuccessObservationGapRatio,
      backfillObservationRecoveryRatio,
      backfillTriggeredRatio,
      rowsWithoutAcceptedBallotCount: rowsWithoutAcceptedBallot.length,
      unmatchedRowDiagnostics,
      totalVoters: voterTicketSummary.length,
      voterTicketSummary,
      stageMetrics,
      ticketSentCount,
      ticketObservedCount,
      ballotSubmittedCount,
      ballotAcceptedCount,
      ticketDeliveryConfirmedByAckCount,
      ticketDeliveryConfirmedByBallotCount,
      ticketDeliveryConfirmedCount,
      coordinatorFailureHints: Object.entries(round.state.coordinatorStates).map(([key, value]) => ({
        coordinator: key,
        waitingForRequests: value.diagnostics.filter((line) => line.includes("Waiting for this voter's blinded ticket request")).length,
        waitingForAcknowledgements: value.diagnostics.filter((line) => line.includes("acknowledgement")).length,
        waitingForCompletionConfirmation: value.diagnostics.filter((line) => line.includes("valid ballot submission")).length,
      })),
      startupJoinFailureBucket: primaryCoordinatorDebug?.startupDiagnostics?.startupJoinFailureBucket ?? null,
      startupDiagnostics: primaryCoordinatorDebug?.startupDiagnostics ?? null,
    };
  });

  for (const roundSummary of summary) {
    const diagnostics = Array.isArray(roundSummary.unmatchedRowDiagnostics)
      ? roundSummary.unmatchedRowDiagnostics
      : [];
    const candidate = diagnostics.find((entry) => (
      Boolean(entry.ticketPublishSucceededAt)
      && !entry.ticketObserved
      && Number(entry.ticketPublishEventKind ?? 0) > 0
      && Array.isArray(entry.ticketRelayResults)
      && entry.ticketRelayResults.some((result) => result?.success)
    ));
    if (!candidate) {
      roundSummary.phase10ObservationProbe = null;
      continue;
    }

    const successfulRelay = candidate.ticketRelayResults.find((result) => result?.success)?.relay
      ?? candidate.ticketRelayTargets[0]
      ?? null;
    const ticketTags = Array.isArray(candidate.ticketPublishEventTags) ? candidate.ticketPublishEventTags : [];
    const publishedMailboxTag = ticketTags.find((tag) => tag?.[0] === "mailbox")?.[1] ?? null;
    const publishedEtypeTag = ticketTags.find((tag) => tag?.[0] === "etype")?.[1] ?? null;
    const publishedTicketTag = ticketTags.find((tag) => tag?.[0] === "ticket")?.[1] ?? null;
    const publishedRequestTag = ticketTags.find((tag) => tag?.[0] === "request")?.[1] ?? null;
    const liveQuery = candidate.ticketLiveQuery ?? null;
    const backfillQuery = candidate.ticketBackfillQuery ?? null;
    const relayProbe = successfulRelay
      ? await runRelayProbe({
        relay: successfulRelay,
        kind: candidate.ticketPublishEventKind,
        mailboxId: candidate.requestMailboxId ?? publishedMailboxTag,
        etype: publishedEtypeTag ?? "mailbox_ticket_envelope",
        eventId: candidate.ticketPublishEventId,
        ticketId: candidate.ticketId ?? publishedTicketTag,
        requestId: candidate.requestId ?? publishedRequestTag,
      })
      : null;

    roundSummary.phase10ObservationProbe = {
      voterPubkey: candidate.voterPubkey,
      requestId: candidate.requestId,
      requestMailboxId: candidate.requestMailboxId,
      ticketId: candidate.ticketId,
      published: {
        eventId: candidate.ticketPublishEventId,
        kind: candidate.ticketPublishEventKind,
        createdAt: candidate.ticketPublishEventCreatedAt,
        tags: ticketTags,
        mailboxTag: publishedMailboxTag,
        etypeTag: publishedEtypeTag,
        requestTag: publishedRequestTag,
        ticketTag: publishedTicketTag,
        relayTargets: candidate.ticketRelayTargets,
        relayResults: candidate.ticketRelayResults,
      },
      readerFilters: {
        live: liveQuery,
        backfill: backfillQuery,
      },
      filterComparison: {
        kindMatchesLive: Number(liveQuery?.kinds?.[0] ?? 0) === Number(candidate.ticketPublishEventKind ?? 0),
        kindMatchesBackfill: Number(backfillQuery?.kinds?.[0] ?? 0) === Number(candidate.ticketPublishEventKind ?? 0),
        publishedMailboxMatchesRequest: Boolean(candidate.requestMailboxId && publishedMailboxTag)
          ? candidate.requestMailboxId === publishedMailboxTag
          : null,
        mailboxMatchesLive: Boolean(candidate.requestMailboxId)
          ? Array.isArray(liveQuery?.mailboxIds) && liveQuery.mailboxIds.includes(candidate.requestMailboxId)
          : null,
        mailboxMatchesBackfill: Boolean(candidate.requestMailboxId)
          ? (
            (Array.isArray(backfillQuery?.mailboxIds) && backfillQuery.mailboxIds.includes(candidate.requestMailboxId))
            || (Array.isArray(candidate.ticketPendingMailboxIds) && candidate.ticketPendingMailboxIds.includes(candidate.requestMailboxId))
          )
          : null,
        etypeMatchesLive: Boolean(publishedEtypeTag)
          ? Array.isArray(liveQuery?.eventTypes) && liveQuery.eventTypes.includes(publishedEtypeTag)
          : null,
        etypeMatchesBackfill: Boolean(publishedEtypeTag)
          ? Array.isArray(backfillQuery?.eventTypes) && backfillQuery.eventTypes.includes(publishedEtypeTag)
          : null,
        relayOverlap: Array.isArray(candidate.ticketRelayTargets)
          ? candidate.ticketRelayTargets.filter((relay) => (
            Array.isArray(liveQuery?.relays) && liveQuery.relays.includes(relay)
          ) || (
            Array.isArray(backfillQuery?.relays) && backfillQuery.relays.includes(relay)
          ))
          : [],
      },
      relayProbe,
    };
  }

  console.log(JSON.stringify({
    config: {
      base,
      deploymentMode,
      nip65Mode,
      coordinatorCount,
      voterCount,
      roundCount,
      startupWaitMs,
      roundWaitMs,
      ticketWaitMs,
      harnessTimeoutMs,
    },
    summary,
    rounds,
  }, null, 2));

  if (timeoutId !== null) {
    globalThis.clearTimeout(timeoutId);
  }
  relayProbePool.destroy?.();
  await browser.close();
}
void main();
