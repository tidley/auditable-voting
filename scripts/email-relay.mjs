#!/usr/bin/env node
/**
 * Authenticated email relay for resident admission bundles.
 *
 * This is a separate service from the voting worker. It accepts a bundle from a
 * coordinator, verifies a NIP-98 signed request, enforces allowlists and rate
 * limits, and delivers through SMTP using the shared sender implementation.
 *
 * Credentials live in this process environment (or an optional secret backend),
 * never in the browser. Logs and result files contain no recipient addresses or
 * plaintext admission codes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdmissionBundle, runBatch, smtpConfigFromEnv } from "./otp-send-email.mjs";
import { createOpenBaoSmtpEnvProvider, openBaoConfigured } from "./openbao-smtp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, "../web/package.json"));
const { verifyEvent } = require("nostr-tools/pure");
const { decode: decodeNip19 } = require("nostr-tools/nip19");

const SERVICE_NAME = "auditable-voting-email-relay";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4320;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECIPIENTS = 1_000;
const DEFAULT_MAX_RECIPIENTS_PER_DAY = 500;
const DEFAULT_MAX_BATCHES_PER_HOUR = 20;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_REPLAY_TTL_SECONDS = 600;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:4319",
  "http://localhost:4319",
  "https://tidley.github.io",
  "https://vote.orangesync.tech",
];
const ELECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { httpStatus: status, code });
}

function loopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function envList(value, fallback = []) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function normaliseCoordinator(value) {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = decodeNip19(trimmed);
      if (decoded.type === "npub") return String(decoded.data).toLowerCase();
    } catch {
      // Fall through to the shared error below.
    }
  }
  throw new Error(`Invalid coordinator npub or hex key: ${trimmed}`);
}

function parseCoordinatorList(value, fallback = new Set()) {
  const entries = envList(value);
  if (entries.length === 0) return fallback;
  return new Set(entries.map(normaliseCoordinator));
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("RELAY_PORT must be a valid TCP port.");
  return port;
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function hashPayload(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") return fallback;
  return value;
}

function writeJsonFile(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readRawBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(httpError(413, "Request body is too large.", "body_too_large"));
      return;
    }
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError(413, "Request body is too large.", "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(httpError(400, error.message, "body_read_failed")));
  });
}

function sendJson(res, status, value, origin = "") {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(origin ? {
      "access-control-allow-origin": origin,
      "vary": "Origin",
      "access-control-expose-headers": "content-type",
    } : {}),
  });
  res.end(body);
}

function configuredRelayTransports(env) {
  try {
    smtpConfigFromEnv(env);
    return ["smtp"];
  } catch {
    if (openBaoConfigured(env)) {
      const tokenFile = String(env.OPENBAO_TOKEN_FILE ?? "").trim();
      if (String(env.OPENBAO_TOKEN ?? "").trim() || (tokenFile && existsSync(tokenFile))) {
        return ["smtp"];
      }
    }
    return [];
  }
}

function publicUrlForRequest(req, configuredPublicUrl) {
  if (configuredPublicUrl) return configuredPublicUrl.replace(/\/+$/, "");
  const hostHeader = String(req.headers.host ?? "");
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    throw httpError(400, "Invalid Host header.", "invalid_host");
  }
  if (!loopbackHostname(hostname)) {
    throw httpError(400, "RELAY_PUBLIC_URL must be configured for non-loopback requests.", "public_url_required");
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
  const protocol = forwardedProto === "https" ? "https" : "http";
  return `${protocol}://${hostHeader}`.replace(/\/+$/, "");
}

function verifyNip98(req, rawBody, options) {
  const header = String(req.headers.authorization ?? "");
  if (!/^Nostr\s+/i.test(header)) {
    throw httpError(401, "Missing NIP-98 authorization.", "unauthorized");
  }
  let event;
  try {
    event = JSON.parse(Buffer.from(header.replace(/^Nostr\s+/i, "").trim(), "base64").toString("utf8"));
  } catch {
    throw httpError(401, "Malformed NIP-98 authorization.", "unauthorized");
  }
  if (!event || event.kind !== 27235 || !verifyEvent(event)) {
    throw httpError(401, "Invalid NIP-98 signature.", "unauthorized");
  }
  const nowSeconds = Math.floor(options.now() / 1000);
  if (!Number.isInteger(event.created_at) || Math.abs(nowSeconds - event.created_at) > options.clockSkewSeconds) {
    throw httpError(401, "NIP-98 request is outside the allowed clock window.", "request_expired");
  }
  const tag = (name) => event.tags?.find((entry) => Array.isArray(entry) && entry[0] === name)?.[1];
  const requestPath = new URL(req.url ?? "/", "http://relay.local").pathname.replace(/^\/+/, "");
  const expectedUrl = new URL(requestPath, `${options.publicUrlFor(req)}/`).toString();
  const signedUrl = tag("u");
  if (!signedUrl || signedUrl !== expectedUrl) {
    throw httpError(401, "NIP-98 URL does not match this endpoint.", "unauthorized");
  }
  if (String(tag("method") ?? "").toUpperCase() !== String(req.method ?? "").toUpperCase()) {
    throw httpError(401, "NIP-98 method does not match this request.", "unauthorized");
  }
  if (tag("payload") !== hashPayload(rawBody)) {
    throw httpError(401, "NIP-98 payload hash does not match the request body.", "unauthorized");
  }
  const eventId = String(event.id ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(eventId)) {
    throw httpError(401, "NIP-98 event ID is invalid.", "unauthorized");
  }
  return { event, coordinator: String(event.pubkey).toLowerCase(), eventId };
}

function createRateLimiter(stateDir, options) {
  const path = join(stateDir, "rate-limit.json");
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  function readState() {
    return readJsonFile(path, {});
  }

  function prune(entry, now) {
    const batches = Array.isArray(entry?.batches)
      ? entry.batches.filter((value) => typeof value === "number" && now - value < hourMs)
      : [];
    const recipients = Array.isArray(entry?.recipients)
      ? entry.recipients.filter((item) => item && typeof item.at === "number" && now - item.at < dayMs)
      : [];
    return { batches, recipients };
  }

  function check(coordinator, recipientCount) {
    const now = options.now();
    const state = readState();
    const entry = prune(state[coordinator], now);
    if (entry.batches.length >= options.maxBatchesPerHour) {
      throw httpError(429, `This coordinator has reached the hourly batch limit (${options.maxBatchesPerHour}).`, "rate_limited");
    }
    const recipientsToday = entry.recipients.reduce((total, item) => total + (Number(item.count) || 0), 0);
    if (recipientsToday + recipientCount > options.maxRecipientsPerDay) {
      throw httpError(429, `This coordinator has reached the daily recipient limit (${options.maxRecipientsPerDay}).`, "rate_limited");
    }
    return { state, entry, now };
  }

  function record(coordinator, recipientCount, checked) {
    const { state, entry, now } = checked;
    entry.batches.push(now);
    entry.recipients.push({ at: now, count: recipientCount });
    state[coordinator] = entry;
    writeJsonFile(path, state);
  }

  return { check, record };
}

export function createEmailRelayServer(options = {}) {
  const env = options.env ?? process.env;
  const stateDir = resolve(options.stateDir ?? env.RELAY_STATE_DIR ?? resolve(__dirname, "../.email-relay-state"));
  const allowedCoordinators = options.allowedCoordinators
    ?? parseCoordinatorList(env.RELAY_ALLOWED_COORDINATORS);
  const allowedElections = options.allowedElections
    ?? new Set(envList(env.RELAY_ALLOWED_ELECTIONS));
  const allowedOrigins = new Set(options.allowedOrigins
    ?? envList(env.RELAY_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS));
  const publicUrl = options.publicUrl ?? env.RELAY_PUBLIC_URL ?? "";
  const maxRecipients = options.maxRecipients
    ?? parsePositiveInt(env.RELAY_MAX_RECIPIENTS, DEFAULT_MAX_RECIPIENTS, "RELAY_MAX_RECIPIENTS");
  const maxRecipientsPerDay = options.maxRecipientsPerDay
    ?? parsePositiveInt(env.RELAY_MAX_RECIPIENTS_PER_DAY, DEFAULT_MAX_RECIPIENTS_PER_DAY, "RELAY_MAX_RECIPIENTS_PER_DAY");
  const maxBatchesPerHour = options.maxBatchesPerHour
    ?? parsePositiveInt(env.RELAY_MAX_BATCHES_PER_HOUR, DEFAULT_MAX_BATCHES_PER_HOUR, "RELAY_MAX_BATCHES_PER_HOUR");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const replayTtlSeconds = options.replayTtlSeconds ?? DEFAULT_REPLAY_TTL_SECONDS;
  const now = options.now ?? (() => Date.now());
  const execute = options.runDelivery ?? runBatch;
  const smtpEnvProvider = options.smtpEnvProvider ?? createOpenBaoSmtpEnvProvider({ env });
  const replayCache = new Map();
  const inFlight = new Set();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const rateLimiter = createRateLimiter(stateDir, { now, maxBatchesPerHour, maxRecipientsPerDay });

  if (allowedCoordinators.size === 0) {
    // Fail closed. The CLI also checks this eagerly.
    allowedCoordinators.add("0".repeat(64));
  }

  function pruneReplay() {
    const current = now();
    for (const [eventId, expiresAt] of replayCache) {
      if (expiresAt <= current) replayCache.delete(eventId);
    }
  }

  function rememberReplay(eventId) {
    pruneReplay();
    if (replayCache.has(eventId)) {
      throw httpError(409, "This signed request has already been used.", "replayed_request");
    }
    replayCache.set(eventId, now() + replayTtlSeconds * 1000);
  }

  function ensureElection(electionId) {
    if (!ELECTION_ID_PATTERN.test(electionId)) {
      throw httpError(400, "Invalid election ID.", "invalid_election");
    }
    if (allowedElections.size > 0 && !allowedElections.has(electionId)) {
      throw httpError(403, "This election is not enabled on the relay.", "election_not_allowed");
    }
  }

  const server = createServer(async (req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && !allowedOrigins.has(origin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Origin not allowed");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
    try {
      if (pathname === "/health") {
        if (req.method !== "GET") throw httpError(405, "Use GET.", "method_not_allowed");
        sendJson(res, 200, {
          service: SERVICE_NAME,
          version: 1,
          transports: configuredRelayTransports(env),
          maxRecipients,
          auth: "nip98",
        }, origin);
        return;
      }
      if (pathname !== "/send") {
        throw httpError(404, "Unknown relay endpoint.", "not_found");
      }
      if (req.method !== "POST") throw httpError(405, "Use POST.", "method_not_allowed");

      const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw httpError(415, "Expected application/json.", "unsupported_media_type");
      }
      const rawBody = await readRawBody(req, maxBodyBytes);
      const auth = verifyNip98(req, rawBody, {
        now,
        clockSkewSeconds,
        publicUrlFor: (request) => publicUrlForRequest(request, publicUrl),
      });
      if (!allowedCoordinators.has(auth.coordinator)) {
        throw httpError(403, "This coordinator is not allowed to use the relay.", "coordinator_not_allowed");
      }
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw httpError(400, "Malformed JSON request.", "invalid_json");
      }
      const electionId = String(body?.electionId ?? "").trim();
      ensureElection(electionId);
      if (typeof body?.bundleCsv !== "string" || !body.bundleCsv.trim()) {
        throw httpError(400, "The admission bundle is missing.", "invalid_bundle");
      }
      let parsed;
      try {
        parsed = parseAdmissionBundle(body.bundleCsv);
      } catch (error) {
        throw httpError(400, error instanceof Error ? error.message : "Invalid admission bundle.", "invalid_bundle");
      }
      if (parsed.rows.length > maxRecipients) {
        throw httpError(413, `A batch can contain at most ${maxRecipients} recipients.`, "bundle_too_large");
      }
      let voteElectionId;
      try {
        voteElectionId = new URL(parsed.rows[0].voteUrl).searchParams.get("q") ?? "";
      } catch {
        throw httpError(400, "The bundle vote_url is invalid.", "invalid_bundle");
      }
      if (voteElectionId !== electionId) {
        throw httpError(400, "The bundle vote_url does not match the election ID.", "election_mismatch");
      }
      if (inFlight.has(electionId)) {
        throw httpError(409, "Another batch for this election is already in flight.", "batch_in_flight");
      }
      rememberReplay(auth.eventId);
      const checked = rateLimiter.check(auth.coordinator, parsed.rows.length);
      rateLimiter.record(auth.coordinator, parsed.rows.length, checked);
      inFlight.add(electionId);
      const startedAt = Date.now();
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const electionDir = join(stateDir, "elections", electionId);
        mkdirSync(electionDir, { recursive: true, mode: 0o700 });
        const batchId = `${Date.now()}-${process.pid}`;
        const smtpEnv = await smtpEnvProvider();
        const result = await execute({
          transport: "smtp",
          csvText: body.bundleCsv,
          ledger: join(electionDir, "send-ledger.json"),
          results: join(electionDir, `results-${batchId}.csv`),
          smtpEnv,
          smtpTransport: options.smtpTransport,
        });
        console.log(JSON.stringify({
          service: SERVICE_NAME,
          event: "send",
          electionId,
          coordinator: auth.coordinator.slice(0, 12),
          recipients: parsed.rows.length,
          sent: result.sentCount,
          skipped: result.skipCount,
          failed: result.failCount,
          notAttempted: result.notAttemptedCount,
          status: 200,
          ms: Date.now() - startedAt,
        }));
        sendJson(res, 200, {
          sent: result.sentCount,
          skipped: result.skipCount,
          failed: result.failCount,
          notAttempted: result.notAttemptedCount,
          results: result.results,
        }, origin);
      } finally {
        inFlight.delete(electionId);
      }
    } catch (error) {
      const status = Number.isInteger(error?.httpStatus)
        ? error.httpStatus
        : Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
          ? error.status
          : 502;
      const code = typeof error?.code === "string" ? error.code : "relay_error";
      console.error(JSON.stringify({
        service: SERVICE_NAME,
        event: "send_error",
        code,
        status,
      }));
      sendJson(res, status, {
        error: error instanceof Error ? error.message : "The relay rejected the batch.",
        code,
        ...(Array.isArray(error?.results) ? { results: error.results } : {}),
      }, origin);
    }
  });

  return { server, stateDir };
}

function usage() {
  return `Usage: node scripts/email-relay.mjs

Environment:
  RELAY_HOST                       Bind address (default 127.0.0.1)
  RELAY_PORT                       Port (default 4320)
  RELAY_PUBLIC_URL                 Public origin, e.g. https://mail.example.org
  RELAY_ALLOWED_COORDINATORS       Comma-separated npub or hex keys (required)
  RELAY_ALLOWED_ELECTIONS          Optional comma-separated election IDs
  RELAY_ALLOWED_ORIGINS            Comma-separated browser origins
  RELAY_STATE_DIR                  Ledger/rate-limit directory
  RELAY_MAX_RECIPIENTS             Max recipients per batch (default 1000)
  RELAY_MAX_RECIPIENTS_PER_DAY     Per-coordinator daily limit (default 500)
  RELAY_MAX_BATCHES_PER_HOUR       Per-coordinator hourly limit (default 20)
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM

The relay requires a NIP-98 Authorization header. Do not expose it without TLS
and an allowlist.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const env = process.env;
  const host = env.RELAY_HOST || DEFAULT_HOST;
  const port = parsePort(env.RELAY_PORT);
  const allowedCoordinators = parseCoordinatorList(env.RELAY_ALLOWED_COORDINATORS);
  if (allowedCoordinators.size === 0) {
    console.error("RELAY_ALLOWED_COORDINATORS must list at least one coordinator npub or hex key.");
    process.exit(1);
  }
  if (!loopbackHostname(host) && !env.RELAY_PUBLIC_URL) {
    console.error("RELAY_PUBLIC_URL is required when binding to a non-loopback address.");
    process.exit(1);
  }
  const { server, stateDir } = createEmailRelayServer({ env });
  server.listen(port, host, () => {
    console.log(`${SERVICE_NAME} listening on http://${host}:${port}`);
    console.log(`State directory: ${stateDir}`);
    console.log(`Coordinators: ${allowedCoordinators.size}; transports: ${configuredRelayTransports(env).join(",") || "none"}`);
    console.log("Requires NIP-98 authorization; credentials stay in this process environment.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { usage, normaliseCoordinator, parseCoordinatorList, publicUrlForRequest };
