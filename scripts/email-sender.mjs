#!/usr/bin/env node
/**
 * Local coordinator email companion.
 *
 * Serves the built static app and a same-origin API on the loopback interface.
 * SMTP/cashu credentials live only in this process environment. The browser
 * submits an already-generated admission bundle; this server validates it and
 * reuses otp-send-email.mjs for delivery, ledger and redaction behaviour.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdmissionBundle, runBatch, smtpConfigFromEnv } from "./otp-send-email.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4319;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENTS = 1_000;
const SERVICE_NAME = "auditable-voting-email-sender";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function loopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function validHostHeader(hostHeader) {
  if (!hostHeader) return false;
  try {
    return loopbackHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function validOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && loopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function configuredTransports(env) {
  const transports = [];
  try {
    smtpConfigFromEnv(env);
    transports.push("smtp");
  } catch {
    // Incomplete SMTP settings are intentionally not exposed in health output.
  }
  if ((env.NOMAIN_NSEC ?? "").trim()) transports.push("cashu");
  return transports;
}

function sendJson(res, status, value, origin = "") {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw Object.assign(new Error("Expected application/json."), { status: 415 });
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Malformed JSON request."), { status: 400 });
  }
}

function resolveStaticPath(distDir, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const candidate = resolve(distDir, relative || "index.html");
  const root = resolve(distDir);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function serveStatic(req, res, distDir, pathname) {
  if (!["GET", "HEAD"].includes(req.method ?? "")) {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  let filePath;
  try {
    filePath = resolveStaticPath(distDir, pathname);
  } catch {
    filePath = null;
  }
  if (!filePath) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, "index.html");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const size = statSync(filePath).size;
  res.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": extname(filePath) === ".html" ? "no-store" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(filePath).pipe(res);
}

export function createEmailSenderServer(options = {}) {
  const env = options.env ?? process.env;
  const distDir = resolve(options.distDir ?? resolve(__dirname, "../web/dist"));
  const stateDir = resolve(options.stateDir ?? env.EMAIL_SENDER_STATE_DIR ?? resolve(__dirname, "../.email-sender-state"));
  const execute = options.runDelivery ?? runBatch;
  let inFlight = false;

  const server = createServer(async (req, res) => {
    const hostHeader = String(req.headers.host ?? "");
    if (!validHostHeader(hostHeader)) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      res.end("Misdirected request");
      return;
    }
    const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (!validOrigin(rawOrigin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Origin not allowed");
      return;
    }
    const responseOrigin = rawOrigin;
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", `http://${hostHeader}`).pathname;
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (pathname === "/__email/health") {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      sendJson(res, 200, {
        service: SERVICE_NAME,
        version: 1,
        transports: configuredTransports(env),
        maxRecipients: MAX_RECIPIENTS,
      }, responseOrigin);
      return;
    }

    if (pathname === "/__email/send") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      if (inFlight) {
        sendJson(res, 409, { error: "Another email batch is already being sent from this companion." }, responseOrigin);
        return;
      }
      inFlight = true;
      try {
        const body = await readJsonBody(req);
        const transport = String(body?.transport ?? "");
        if (!configuredTransports(env).includes(transport)) {
          sendJson(res, 400, { error: "That email transport is not configured in the local sender." }, responseOrigin);
          return;
        }
        if (typeof body?.bundleCsv !== "string" || !body.bundleCsv.trim()) {
          sendJson(res, 400, { error: "The admission bundle is missing." }, responseOrigin);
          return;
        }
        const parsed = parseAdmissionBundle(body.bundleCsv);
        if (parsed.rows.length > MAX_RECIPIENTS) {
          sendJson(res, 413, { error: `A batch can contain at most ${MAX_RECIPIENTS} recipients.` }, responseOrigin);
          return;
        }
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const batchId = `${Date.now()}-${process.pid}`;
        const result = await execute({
          transport,
          csvText: body.bundleCsv,
          ledger: join(stateDir, "send-ledger.json"),
          results: join(stateDir, `results-${batchId}.csv`),
          api: env.CASHU_EMAIL_API || "https://cashu.email",
          nsec: env.NOMAIN_NSEC,
          cashuToken: env.CASHU_TOKEN,
          "cashu-tokens-file": env.CASHU_TOKENS_FILE,
          smtpEnv: env,
          smtpTransport: options.smtpTransport,
        });
        sendJson(res, 200, {
          sent: result.sentCount,
          skipped: result.skipCount,
          failed: result.failCount,
          notAttempted: result.notAttemptedCount,
          satsSpent: result.satsSpent,
          capUsedToday: result.capUsedToday,
          capRemaining: result.capRemaining,
          results: result.results,
        }, responseOrigin);
      } catch (error) {
        sendJson(res, Number.isInteger(error?.status) ? error.status : 502, {
          error: error instanceof Error ? error.message : "The email batch failed.",
          ...(Array.isArray(error?.results) ? { results: error.results } : {}),
        }, responseOrigin);
      } finally {
        inFlight = false;
      }
      return;
    }

    if (pathname.startsWith("/__email/")) {
      sendJson(res, 404, { error: "Unknown local sender endpoint." }, responseOrigin);
      return;
    }

    serveStatic(req, res, distDir, pathname);
  });

  return { server, distDir, stateDir };
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("EMAIL_SENDER_PORT must be a valid TCP port.");
  return port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const host = env.EMAIL_SENDER_HOST || DEFAULT_HOST;
  if (!loopbackHostname(host)) throw new Error("The email companion can only bind to a loopback address.");
  const port = parsePort(env.EMAIL_SENDER_PORT);
  const { server, distDir, stateDir } = createEmailSenderServer({ env });
  if (!existsSync(resolve(distDir, "index.html"))) {
    console.error("FATAL: the web build is missing. Run: npm --prefix web run build");
    process.exit(1);
  }
  server.listen(port, host, () => {
    const transports = configuredTransports(env);
    console.log(`Coordinator email companion: http://${host}:${port}/dashboard.html?role=coordinator`);
    console.log(`Transports configured: ${transports.length ? transports.join(", ") : "none"}`);
    console.log(`Send ledger/results: ${stateDir}`);
    console.log("Credentials stay in this process environment. Keep this terminal open while sending.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { configuredTransports, validHostHeader, validOrigin };
