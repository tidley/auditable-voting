#!/usr/bin/env node
/**
 * Development launcher for the app plus the optional local email companion.
 *
 * The original failure mode was ordering: Vite came up first, the browser
 * checked /__email/health before the companion was listening, and every send
 * after that raced a sender (or proxy socket) that was not ready. Starting the
 * sender first and waiting for health makes the ordering deterministic.
 *
 * Usage:
 *   npm --prefix web run email:dev
 *   npm --prefix web run email:dev -- --port 5174
 *
 * Extra arguments are forwarded to Vite. The sender reads the repository-root
 * .env exactly like `email:sender` does.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const webDir = resolve(repoRoot, "web");
const envFile = resolve(repoRoot, ".env");

const senderPort = Number(process.env.EMAIL_SENDER_PORT ?? "4319");
const senderBase = (process.env.EMAIL_SENDER_API || `http://127.0.0.1:${senderPort}`).replace(/\/$/, "");
const senderHealthUrl = `${senderBase}/__email/health`;
const viteArgs = process.argv.slice(2);
const hasHost = viteArgs.includes("--host");
const hasPort = viteArgs.includes("--port");
const resolvedViteArgs = [
  ...(hasHost ? [] : ["--host", "127.0.0.1"]),
  ...(hasPort ? [] : ["--port", "5174"]),
  ...viteArgs,
];

let shuttingDown = false;
let sender;
let vite;

function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the check and the signal.
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stop(vite);
  stop(sender);
  setTimeout(() => process.exit(code), 250).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      if (shuttingDown) return;
      if (sender.exitCode !== null) {
        reject(new Error(`The email sender exited before becoming ready (code ${sender.exitCode}).`));
        return;
      }
      try {
        const response = await fetch(senderHealthUrl, {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          const body = await response.json().catch(() => ({}));
          if (body?.service === "auditable-voting-email-sender") {
            resolvePromise(body);
            return;
          }
        }
      } catch {
        // Not listening yet; keep polling until the deadline.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`The email sender did not answer ${senderHealthUrl} within ${timeoutMs / 1000}s.`));
        return;
      }
      setTimeout(poll, 250);
    };
    void poll();
  });
}

if (!existsSync(resolve(webDir, "dist", "index.html"))) {
  console.log("email:dev — building the web app once so the sender has a static root…");
  const build = spawnSync("npm", ["run", "build"], { cwd: webDir, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

console.log(`email:dev — starting the sender (${senderHealthUrl})`);
sender = spawn(
  process.execPath,
  [`--env-file-if-exists=${envFile}`, resolve(repoRoot, "scripts", "email-sender.mjs")],
  { cwd: webDir, stdio: "inherit", env: process.env },
);
sender.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`email:dev — the sender exited (code ${code}); stopping Vite.`);
    shutdown(code ?? 1);
  }
});

try {
  const health = await waitForHealth();
  const transports = Array.isArray(health.transports) && health.transports.length
    ? health.transports.join(", ")
    : "none (set SMTP_* or NOMAIN_NSEC in .env)";
  console.log(`email:dev — sender ready; transports: ${transports}`);
} catch (error) {
  console.error(`email:dev — ${error instanceof Error ? error.message : error}`);
  shutdown(1);
  process.exit(1);
}

console.log("email:dev — starting Vite");
vite = spawn("npm", ["run", "dev", "--", ...resolvedViteArgs], {
  cwd: webDir,
  stdio: "inherit",
  // Keep the dev proxy pointed at the sender this launcher actually started,
  // including a non-default EMAIL_SENDER_PORT.
  env: { ...process.env, EMAIL_SENDER_API: senderBase },
});
vite.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 0);
});
