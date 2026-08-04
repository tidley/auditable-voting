import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SIMPLE_PUBLIC_RELAYS } from "../src/simpleVotingSession";
import { normalizeRelaysRust } from "../src/wasm/auditableVotingCore";

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>;

type WorkerState = {
  elections?: Record<string, {
    seen_blind_request_ids?: string[];
  }>;
};

const baseUrl = (process.env.OPTIONA_LIVE_UI_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const timeoutMs = positiveEnvInt("OPTIONA_LIVE_UI_TIMEOUT_MS", 180_000);
const pollMs = positiveEnvInt("OPTIONA_LIVE_UI_POLL_MS", 1_000);

function positiveEnvInt(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function relaysFromEnv(name: string, fallback: string[]) {
  const raw = process.env[name]?.trim();
  return normalizeRelaysRust(raw ? raw.split(",").map((relay) => relay.trim()).filter(Boolean) : fallback);
}

function workerBinary() {
  const override = process.env.OPTIONA_LIVE_UI_WORKER_BINARY?.trim();
  return override
    ? path.resolve(override)
    : path.resolve(process.cwd(), "..", "worker", "target", "debug", "auditable-voting-worker");
}

async function waitFor<T>(label: string, task: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (ready(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function readWorkerState(stateDir: string) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as WorkerState;
  } catch {
    return null;
  }
}

async function stopWorker(worker: WorkerProcess | null) {
  if (!worker || worker.exitCode !== null || worker.killed) {
    return;
  }
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => worker.once("exit", () => resolve())),
    sleep(5_000),
  ]);
  if (worker.exitCode === null) {
    worker.kill("SIGKILL");
  }
}

async function prepareContext(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => {
    const clipboard = { text: "" };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => { clipboard.text = text; },
        readText: async () => clipboard.text,
      },
    });
  });
  return context;
}

async function continueRole(page: Page, role: "Organiser" | "Voter") {
  await page.goto(`${baseUrl}/${role === "Organiser" ? "dashboard.html" : "vote.html"}`, { waitUntil: "networkidle" });
  const continueButton = page.getByRole("button", { name: new RegExp(`^Continue as ${role}$`, "i") });
  if (await continueButton.count()) {
    await continueButton.click();
  }
  if (role === "Organiser") {
    await page.getByRole("button", { name: /^Go Live$/i }).waitFor();
  }
}

async function coordinatorNpub(page: Page) {
  return await waitFor("coordinator npub", async () => {
    const text = [
      await page.locator("body").innerText(),
      ...(await page.getByRole("button").allTextContents()),
    ].join(" ");
    return text.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/i)?.[0] ?? "";
  }, Boolean);
}

async function fill(page: Page, label: string | RegExp, value: string) {
  await page.getByLabel(label).fill(value);
}

async function openCoordinatorBuild(page: Page) {
  await waitFor("questionnaire editor", () => page.getByLabel("Title").count(), (count) => count > 0);
}

async function startWorker(input: { nsec: string; coordinatorNpub: string; relays: string[]; stateDir: string }) {
  const binary = workerBinary();
  await fs.access(binary);
  const child = spawn(binary, [], {
    cwd: path.dirname(binary),
    env: {
      ...process.env,
      RUST_LOG: process.env.RUST_LOG ?? "info",
      WORKER_NSEC: input.nsec,
      COORDINATOR_NPUB: input.coordinatorNpub,
      WORKER_RELAYS: input.relays.join(","),
      WORKER_STATE_DIR: input.stateDir,
      WORKER_POLL_SECONDS: process.env.OPTIONA_LIVE_UI_WORKER_POLL_SECONDS ?? "2",
      WORKER_HEARTBEAT_SECONDS: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); process.stdout.write(`[ui-rust-worker] ${chunk}`); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); process.stderr.write(`[ui-rust-worker] ${chunk}`); });
  await waitFor("Rust audit worker startup", async () => {
    if (child.exitCode !== null) {
      throw new Error(`worker exited with code ${child.exitCode}: ${output}`);
    }
    return output.includes("worker started as");
  }, Boolean);
  return child;
}

async function main() {
  const relays = relaysFromEnv("OPTIONA_LIVE_UI_RELAYS", SIMPLE_PUBLIC_RELAYS.slice(0, 4));
  const browser = await chromium.launch({ headless: process.env.OPTIONA_LIVE_UI_HEADLESS !== "0" });
  let worker: WorkerProcess | null = null;
  const workerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "auditable-voting-ui-worker-"));
  try {
    const coordinatorContext = await prepareContext(browser);
    const coordinatorPage = await coordinatorContext.newPage();
    await continueRole(coordinatorPage, "Organiser");
    const organiserNpub = await coordinatorNpub(coordinatorPage);
    await openCoordinatorBuild(coordinatorPage);

    await fill(coordinatorPage, "Title", "UI Rust worker group smoke");
    await fill(coordinatorPage, /Question 1 prompt/i, "Can this group submit through the Rust audit worker?");
    await fill(coordinatorPage, "Add voter group", "Smoke group");
    await coordinatorPage.getByRole("button", { name: /^Add group$/i }).click();
    const questionGroupSelect = coordinatorPage.getByLabel(/Question 1 voter group/i);
    await waitFor("new voter group option", () => questionGroupSelect.locator("option").count(), (count) => count > 1);
    await questionGroupSelect.selectOption({ index: 1 });

    await coordinatorPage.getByRole("button", { name: /^Go Live$/i }).click();
    await waitFor("published open questionnaire", async () => coordinatorPage.locator("body").innerText(), (text) => /Close & Publish|\[Open\]|Vote published|Audit proxy configured/i.test(text));

    // Proxy setup is intentionally available only for a published questionnaire.
    await waitFor("proxy setup", async () => {
      if (await coordinatorPage.getByRole("button", { name: /^New account$/i }).count()) {
        return true;
      }
      const setupButton = coordinatorPage.getByRole("button", { name: /Proxy Setup/i });
      if (await setupButton.count() && !(await setupButton.isDisabled())) {
        await setupButton.click();
      }
      return await coordinatorPage.getByRole("button", { name: /^New account$/i }).count() > 0;
    }, Boolean);
    await coordinatorPage.getByRole("button", { name: /^New account$/i }).click();
    const workerNsec = await coordinatorPage.locator("#generated-worker-nsec").inputValue();
    assert.match(workerNsec, /^nsec1/, "expected UI-generated worker private key");
    worker = await startWorker({ nsec: workerNsec, coordinatorNpub: organiserNpub, relays, stateDir: workerStateDir });
    await coordinatorPage.getByRole("button", { name: /^Confirm configuration$/i }).click();
    await waitFor("audit proxy configuration", async () => coordinatorPage.locator("body").innerText(), (text) => /Audit proxy configured|Delegation state\s*Active/i.test(text));

    await coordinatorPage.getByRole("button", { name: /^Voters$/i }).click();
    const privateInviteGroupSelect = coordinatorPage.getByLabel("Voter group for new private invite");
    await waitFor("published voter group option", () => privateInviteGroupSelect.locator("option").count(), (count) => count > 1);
    await privateInviteGroupSelect.selectOption({ index: 1 });
    await coordinatorPage.getByRole("button", { name: /^Create private invite link$/i }).click();
    const inviteUrl = await waitFor("private invite clipboard value", () => coordinatorPage.evaluate(() => navigator.clipboard.readText()), (value) => value.includes("invite_code="));
    assert.match(inviteUrl, /ballot_group=/, "expected private invite to preserve its voter group");

    const voterContext = await prepareContext(browser);
    const voterPage = await voterContext.newPage();
    voterPage.on("console", (message) => {
      if (message.text().includes("[OptionA]")) {
        process.stdout.write(`[ui-voter] ${message.text()}\n`);
      }
    });
    const debugInviteUrl = new URL(inviteUrl);
    debugInviteUrl.searchParams.set("debug_option_a", "1");
    await voterPage.goto(debugInviteUrl.toString(), { waitUntil: "networkidle" });
    const voterContinueButton = voterPage.getByRole("button", { name: /^Continue as Voter$/i });
    if (await voterContinueButton.count()) {
      await voterContinueButton.click();
    }
    const startButton = voterPage.getByRole("button", { name: /^Start$/i });
    if (await startButton.count() && await startButton.isVisible()) {
      await startButton.click();
    }
    await waitFor("blind credential issuance", async () => voterPage.locator("body").innerText(), (text) => /credential|ballot/i.test(text) && !/Waiting for.*ballot|Requesting.*ballot/i.test(text));
    await voterPage.getByRole("button", { name: /^Yes$/i }).click();
    await voterPage.getByRole("button", { name: /Submit|Vote now/i }).click();
    await waitFor("successful submission", async () => voterPage.locator("body").innerText(), (text) => /Response submitted|Submission accepted:\s*Yes|Accepted/i.test(text));

    const questionnaireId = await coordinatorPage.getByLabel("Questionnaire ID").inputValue();
    const state = await waitFor("exactly one worker blind request", () => readWorkerState(workerStateDir), (value) => (value?.elections?.[questionnaireId]?.seen_blind_request_ids?.length ?? 0) === 1);
    assert.equal(state?.elections?.[questionnaireId]?.seen_blind_request_ids?.length, 1, "expected exactly one blind request for the voter/group scope");
    process.stdout.write(`UI Rust worker smoke passed: questionnaire=${questionnaireId}, blindRequests=1\n`);
  } finally {
    await stopWorker(worker);
    await browser.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
