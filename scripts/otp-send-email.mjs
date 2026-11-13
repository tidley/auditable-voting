#!/usr/bin/env node
/**
 * Deliver browser-generated resident admission emails from the coordinator's
 * computer through SMTP or cashu.email.
 *
 * The browser creates and registers each admission code. This process only
 * delivers those exact codes. It never generates an OTP, sends from the
 * browser, publishes contact details to Nostr, or writes codes/email addresses
 * to its ledger, results or console output.
 *
 * Run --dry-run without credentials first. Live sending requires SMTP_* settings
 * or a cashu.email sender key and one payment token per pending recipient.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, "../web/package.json"));
const { finalizeEvent, getPublicKey } = require("nostr-tools/pure");
const API_DEFAULT = "https://cashu.email";
const CODE_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const TRANSPORTS = new Set(["cashu", "smtp"]);

function parseNsec(raw) {
  const value = raw.trim();
  if (value.startsWith("nsec1")) {
    try {
      const { data } = require("nostr-tools").nip19.decode(value);
      if (data instanceof Uint8Array) return data;
      throw new Error("unexpected nsec decode shape");
    } catch (error) {
      throw new Error(`invalid nsec key: ${error instanceof Error ? error.message : "decode failed"}`);
    }
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return new Uint8Array(value.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
  }
  throw new Error("nsec must be nsec1... bech32 or 64-char hex");
}

function parseArgs(argv) {
  const opts = {};
  const values = new Set(["nsec", "csv", "subject", "api", "ledger", "results", "cashu-token", "cashu-tokens-file", "transport"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (values.has(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      opts[key] = value;
      index += 1;
    } else if (["dry-run", "help", "retry-unknown"].includes(key)) {
      if (key === "dry-run") opts.dryRun = true;
      else opts[key] = true;
    } else {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  return opts;
}

export function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += character;
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      cells.push(current);
      current = "";
    } else current += character;
  }
  if (quoted) throw new Error("Malformed quoted CSV field.");
  cells.push(current);
  return cells;
}

export function parseCsv(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map(parseCsvLine);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normaliseCode(code) {
  return code.trim().replace(/[\s-]/g, "").toUpperCase();
}

export function formatAdmissionCode(code) {
  const normalised = normaliseCode(code);
  return `${normalised.slice(0, 5)}-${normalised.slice(5)}`;
}

export function parseAdmissionBundle(csvText, now = Date.now()) {
  const lines = parseCsv(csvText);
  const header = (lines.shift() || []).map((cell) => cell.trim().toLowerCase());
  const required = ["masters_list_number", "email", "name", "code", "expires_at", "questionnaire_title", "vote_url"];
  const indexes = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]));
  for (const [name, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`The admission bundle is missing the required ${name} column.`);
  }
  if (!lines.length) throw new Error("The admission bundle contains no residents.");

  const seenMasters = new Set();
  const scopes = new Set();
  const rows = lines.map((cells, offset) => {
    const location = `Bundle row ${offset + 2}`;
    const get = (name) => (cells[indexes[name]] || "").trim();
    const master = get("masters_list_number");
    const email = get("email");
    const name = get("name");
    const code = normaliseCode(get("code"));
    const expiresAt = get("expires_at");
    const questionnaireTitle = get("questionnaire_title");
    const voteUrl = get("vote_url");
    if ([master, email, name, code, expiresAt, questionnaireTitle, voteUrl].some((value) => /[\0\r\n]/.test(value))) {
      throw new Error(`${location}: fields cannot contain newlines or NUL characters.`);
    }
    if (!/^[1-9][0-9]*$/.test(master)) throw new Error(`${location}: invalid master-list number.`);
    if (seenMasters.has(master)) throw new Error(`${location}: duplicate master-list number ${master}.`);
    seenMasters.add(master);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${location}: invalid email address for master-list number ${master}.`);
    if (!questionnaireTitle) throw new Error(`${location}: questionnaire_title is required.`);
    if (!CODE_PATTERN.test(code)) throw new Error(`${location}: invalid admission code for master-list number ${master}.`);
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= now || new Date(expiryMs).toISOString() !== expiresAt) {
      throw new Error(`${location}: expires_at must be an unexpired ISO UTC timestamp for master-list number ${master}.`);
    }
    let url;
    try {
      url = new URL(voteUrl);
    } catch {
      throw new Error(`${location}: invalid vote_url for master-list number ${master}.`);
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.searchParams.get("q") || url.searchParams.has("invite_code") || url.searchParams.has("code") || /(?:invite_code|code)=/i.test(url.hash)) {
      throw new Error(`${location}: vote_url must be a public questionnaire link without an admission code.`);
    }
    if (voteUrl.toUpperCase().includes(code)) throw new Error(`${location}: vote_url cannot contain the admission code.`);
    scopes.add(voteUrl);
    return {
      master,
      email,
      name,
      code,
      expiresAt,
      questionnaireTitle,
      voteUrl,
      fingerprint: sha256(JSON.stringify([master, email, name, code, expiresAt, questionnaireTitle, voteUrl])),
    };
  });
  if (scopes.size !== 1) throw new Error("All bundle rows must use the same questionnaire vote_url.");
  return { rows, bundleScope: sha256(rows[0].voteUrl) };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readableExpiry(expiresAt) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(expiresAt));
}

export function buildAdmissionEmail(row, subjectOverride = "") {
  if (/[\r\n]/.test(subjectOverride)) throw new Error("The email subject cannot contain line breaks.");
  const name = row.name || "Resident";
  const formattedCode = formatAdmissionCode(row.code);
  const expiry = readableExpiry(row.expiresAt);
  const subject = subjectOverride || `Voting access code for ${row.questionnaireTitle}`;
  const text = [
    `Hello ${name},`,
    "",
    `You are invited to take part in "${row.questionnaireTitle}".`,
    "",
    "1. Open this link on your device:",
    row.voteUrl,
    "",
    "2. Select \"Use admission code\".",
    "3. Enter:",
    `   Master-list number: ${row.master}`,
    `   Admission code: ${formattedCode}`,
    "4. Request your ballot and wait until it is received before answering.",
    "",
    `This code expires at ${expiry} UTC.`,
    "It is single-use and only grants access. It is not included in your anonymous ballot.",
    "Do not forward this email.",
    "",
    "If the code has expired or does not work, contact the organiser using the contact details you were given separately.",
  ].join("\n");
  const html = [
    "<!doctype html><html><body style=\"margin:0;padding:24px;background:#f6f2e9;color:#1f2b2f;font-family:Arial,sans-serif\">",
    "<div style=\"max-width:620px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #d8d2c5;border-radius:12px;line-height:1.55\">",
    `<p>Hello ${escapeHtml(name)},</p>`,
    `<p>You are invited to take part in <strong>${escapeHtml(row.questionnaireTitle)}</strong>.</p>`,
    `<ol><li><p>Open this link on your device:</p><p><a href="${escapeHtml(row.voteUrl)}">Open the voter page</a></p><p style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(row.voteUrl)}</p></li>`,
    "<li><p>Select <strong>Use admission code</strong>.</p></li>",
    `<li><p>Enter these details:</p><p><strong>Master-list number:</strong> ${escapeHtml(row.master)}<br><strong>Admission code:</strong> <code style="font-size:18px;letter-spacing:0.12em">${escapeHtml(formattedCode)}</code></p></li>`,
    "<li><p>Request your ballot and wait until it is received before answering.</p></li></ol>",
    `<p>This code expires at <strong>${escapeHtml(expiry)} UTC</strong>.</p>`,
    "<p>It is single-use and only grants access. It is not included in your anonymous ballot.</p>",
    "<p><strong>Do not forward this email.</strong></p>",
    "<p>If the code has expired or does not work, contact the organiser using the contact details you were given separately.</p>",
    "</div></body></html>",
  ].join("");
  return { to: row.email, subject, text, html };
}

function serviceError(operation, status) {
  return Object.assign(new Error(`${operation} failed with HTTP ${status}.`), {
    status,
    fatal: [401, 402, 403, 407, 408, 409, 410, 412, 413, 429].includes(status),
  });
}

async function responseError(res, operation) {
  return serviceError(operation, res.status);
}

async function postJson(api, path, body) {
  let res;
  try {
    res = await fetch(api + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(new Error(`${path} could not be reached.`), { fatal: true, cause: error });
  }
  const text = res.ok ? await res.text() : "";
  if (!res.ok) throw await responseError(res, path);
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(`${path} returned malformed JSON.`), { fatal: true });
  }
  return { data, setCookie: res.headers.getSetCookie?.()?.[0] || res.headers.get("set-cookie") || "" };
}

async function nomailSession(api, nsecRaw) {
  const skBytes = parseNsec(nsecRaw);
  if (process.env.TEST_API_STUB === "1") return { pubkey: getPublicKey(skBytes), sessionCookie: "" };
  const challenge = await postJson(api, "/api/auth/challenge", {});
  const nonce = challenge.data.nonce;
  const signed = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["challenge", nonce]],
    content: nonce,
  }, skBytes);
  const verify = await postJson(api, "/api/auth/verify", { event: signed });
  const sessionCookie = verify.setCookie.split(";")[0];
  if (!sessionCookie) throw Object.assign(new Error("The email service returned no session cookie."), { fatal: true });
  return { pubkey: getPublicKey(skBytes), sessionCookie };
}

async function sendCashuEmail(api, sessionCookie, message, cashuToken) {
  if (process.env.TEST_API_STUB === "1") return { id: "offline-stub" };
  let res;
  try {
    res = await fetch(api + "/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", ...(sessionCookie ? { cookie: sessionCookie } : {}) },
      body: JSON.stringify({ ...message, cashuToken }),
    });
  } catch (error) {
    throw Object.assign(new Error("The mail request did not receive a response; delivery is unknown."), { deliveryUnknown: true, fatal: true, cause: error });
  }
  const text = res.ok ? await res.text() : "";
  if (!res.ok) throw await responseError(res, "send");
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("The mail service accepted a response that could not be parsed; delivery is unknown."), { deliveryUnknown: true, fatal: true });
  }
  if (data?.ok === false) throw new Error("The email service reported that the message was not sent.");
  return data;
}

export function smtpConfigFromEnv(env = process.env) {
  const host = (env.SMTP_HOST ?? "").trim();
  const from = (env.SMTP_FROM ?? "").trim();
  const port = Number(env.SMTP_PORT ?? "587");
  if (!host || !from) throw new Error("SMTP_HOST and SMTP_FROM are required for SMTP delivery.");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("SMTP_PORT must be a valid TCP port.");
  if (/[\r\n]/.test(from)) throw new Error("SMTP_FROM cannot contain line breaks.");
  const user = (env.SMTP_USER ?? "").trim();
  const pass = env.SMTP_PASS ?? "";
  if (Boolean(user) !== Boolean(pass)) throw new Error("SMTP_USER and SMTP_PASS must be provided together.");
  const secure = env.SMTP_SECURE === undefined ? port === 465 : /^(1|true|yes)$/i.test(env.SMTP_SECURE);
  return { host, port, secure, from, ...(user ? { auth: { user, pass } } : {}) };
}

export async function createSmtpTransport(config) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth ? { auth: config.auth } : {}),
  });
  await transporter.verify();
  return transporter;
}

function smtpDeliveryError(error) {
  const responseCode = Number(error?.responseCode);
  const authFailure = [530, 534, 535, 538].includes(responseCode);
  const recipientFailure = [550, 551, 552, 553, 554].includes(responseCode);
  const safeMessage = authFailure
    ? "SMTP authentication failed."
    : recipientFailure
      ? "SMTP rejected the message or recipient."
      : responseCode >= 400
        ? "SMTP delivery failed."
        : "SMTP connection failed; delivery is unknown.";
  return Object.assign(new Error(safeMessage), {
    status: Number.isInteger(responseCode) ? responseCode : undefined,
    fatal: !recipientFailure,
    deliveryUnknown: !authFailure && !recipientFailure && !Number.isInteger(responseCode),
  });
}

async function sendSmtpEmail(transporter, message, from) {
  try {
    const info = await transporter.sendMail({ from, ...message });
    if (!info?.accepted?.length && info?.rejected?.length) {
      throw Object.assign(new Error("SMTP rejected the message or recipient."), { responseCode: 550 });
    }
    return { id: info?.messageId ?? "" };
  } catch (error) {
    throw smtpDeliveryError(error);
  }
}

function readPaymentTokens(opts, requiredCount, usedTokenFingerprints = new Set()) {
  if (opts["cashu-tokens-file"] && opts.cashuToken) {
    throw new Error("Use either --cashu-token/CASHU_TOKEN or --cashu-tokens-file/CASHU_TOKENS_FILE, not both.");
  }
  const path = opts["cashu-tokens-file"] || process.env.CASHU_TOKENS_FILE;
  const tokens = (path
    ? readFileSync(path, "utf8").split(/\r?\n/).map((token) => token.trim()).filter(Boolean)
    : opts.cashuToken ? [opts.cashuToken] : [])
    .filter((token) => !usedTokenFingerprints.has(sha256(token)));
  if (requiredCount > 0 && process.env.TEST_API_STUB !== "1" && tokens.length < requiredCount) {
    throw new Error(`Live cashu.email sending needs one unused 100-sat payment token per pending recipient (${requiredCount} required, ${tokens.length} supplied). Provide --cashu-tokens-file with one token per line. No emails were sent.`);
  }
  return tokens;
}

export function readLedger(path) {
  if (!path || !existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("The send ledger must be a JSON object.");
  return value;
}

export function writeLedger(path, ledger) {
  if (!path) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function publicFailure(error) {
  if (error?.deliveryUnknown) return "delivery-unknown; do not retry until delivery is checked";
  if (error?.message && /^SMTP /.test(error.message)) return error.message;
  if (Number.isInteger(error?.status)) return `send failed (HTTP ${error.status})`;
  return "send failed before a delivery response";
}

function writeResults(path, results) {
  if (!path) return;
  const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const csv = ["mastersListNumber,ok,detail,ref"]
    .concat(results.map((result) => `${escape(result.master)},${result.ok ? "true" : "false"},${escape(result.detail)},${escape(result.ref ?? "")}`))
    .join("\n");
  writeFileSync(path, `${csv}\n`, "utf8");
}

export async function runBatch(opts) {
  const transport = opts.transport || "cashu";
  if (!TRANSPORTS.has(transport)) throw new Error(`Unsupported email transport: ${transport}.`);
  const csvText = opts.csvText ?? readFileSync(opts.csv, "utf8");
  const { rows, bundleScope } = parseAdmissionBundle(csvText);
  const ledger = readLedger(opts.ledger);
  const results = [];
  let sentCount = 0;
  let dryRunCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const row of rows) {
    const key = `${bundleScope}:${row.master}`;
    const existing = ledger[key];
    if (existing && existing.fingerprint && existing.fingerprint !== row.fingerprint) {
      throw new Error(`The ledger belongs to different admission details for master-list number ${row.master}. Use a new ledger for a new bundle; do not overwrite an existing admission batch.`);
    }
    if (existing?.deliveryUnknown && !opts["retry-unknown"]) {
      throw new Error(`A previous send has unknown delivery for master-list number ${row.master}. Check delivery before retrying. If resending is intentional, add --retry-unknown.`);
    }
  }

  const pendingRows = opts.dryRun ? rows : rows.filter((row) => !ledger[`${bundleScope}:${row.master}`]?.ok);
  const usedTokenFingerprints = new Set(Object.values(ledger).map((entry) => entry?.paymentFingerprint).filter((value) => typeof value === "string"));
  const paymentTokens = transport === "cashu" ? readPaymentTokens(opts, pendingRows.length, usedTokenFingerprints) : [];
  let paymentIndex = 0;
  let sender = null;
  let smtp = null;
  if (!opts.dryRun && pendingRows.length) {
    if (transport === "cashu") {
      sender = await nomailSession(opts.api, opts.nsec);
    } else {
      const config = smtpConfigFromEnv(opts.smtpEnv ?? process.env);
      smtp = { config, transporter: opts.smtpTransport ?? await createSmtpTransport(config) };
    }
  }

  for (const row of rows) {
    const key = `${bundleScope}:${row.master}`;
    let paymentToken = "";
    if (!opts.dryRun && ledger[key]?.ok) {
      results.push({ master: row.master, ok: true, detail: "already-sent (skipped)" });
      skipCount += 1;
      continue;
    }
    try {
      const message = buildAdmissionEmail(row, opts.subject || "");
      if (opts.dryRun) {
        results.push({ master: row.master, ok: true, detail: "dry-run (not sent)" });
        dryRunCount += 1;
      } else {
        let response;
        if (transport === "cashu") {
          paymentToken = paymentTokens[paymentIndex++];
          response = await sendCashuEmail(opts.api, sender.sessionCookie, message, paymentToken);
        } else {
          response = await sendSmtpEmail(smtp.transporter, message, smtp.config.from);
        }
        ledger[key] = {
          ok: true,
          transport,
          ...(paymentToken ? { paymentFingerprint: sha256(paymentToken) } : {}),
          ...(response?.id ? { deliveryRef: String(response.id).slice(0, 200) } : {}),
          fingerprint: row.fingerprint,
          sentAt: new Date().toISOString(),
        };
        writeLedger(opts.ledger, ledger);
        results.push({ master: row.master, ok: true, detail: "sent", ...(response?.id ? { ref: String(response.id).slice(0, 200) } : {}) });
        sentCount += 1;
        if (sentCount % 5 === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      }
    } catch (error) {
      const detail = publicFailure(error);
      results.push({ master: row.master, ok: false, detail });
      failCount += 1;
      if (error?.deliveryUnknown) {
        ledger[key] = {
          ok: false,
          fingerprint: row.fingerprint,
          transport,
          ...(paymentToken ? { paymentFingerprint: sha256(paymentToken) } : {}),
          deliveryUnknown: true,
          attemptedAt: new Date().toISOString(),
        };
        writeLedger(opts.ledger, ledger);
      }
      if (error?.fatal) {
        writeResults(opts.results, results);
        const stopped = new Error(`The ${transport} email batch stopped early. Resolve the reported delivery/authentication/payment problem before resuming with the same ledger.`);
        stopped.results = results;
        throw stopped;
      }
    }
  }

  writeResults(opts.results, results);
  console.log(`\nDone: ${sentCount} sent via ${transport}, ${dryRunCount} prepared by dry-run, ${skipCount} skipped (already-sent), ${failCount} failed of ${rows.length}.`);
  if (opts.results) console.log(`Results CSV -> ${opts.results}`);
  if (opts.ledger) console.log(`Ledger      -> ${opts.ledger}`);
  if (sender?.pubkey) console.log(`Sender pubkey: ${sender.pubkey}`);
  return { sentCount, dryRunCount, skipCount, failCount, results };
}

function usage() {
  return `Usage: node scripts/otp-send-email.mjs --transport <cashu|smtp> --csv <admission-bundle.csv> [options]

The CSV must contain
masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url.
Use the bundle downloaded from Resident email admission. Codes are delivered
exactly as generated and registered by the voting application.

Options:
  --transport <name>   cashu (default) or smtp
  --nsec <key>         cashu sender Nostr secret key; prefer NOMAIN_NSEC in the environment
  --csv <path>         Admission bundle CSV (required)
  --subject <text>     Override the generated questionnaire-specific subject
  --api <url>          cashu.email base (default: ${API_DEFAULT})
  --ledger <path>      Resume ledger (recommended; contains no codes or addresses)
  --results <path>     Results CSV (default: admission-results.csv)
  --cashu-token <token> One 100-sat token for a one-recipient Cashu send
  --cashu-tokens-file <path> One unused 100-sat Cashu token per line
  --dry-run            Validate without authentication or sending
  --retry-unknown      Deliberately retry sends whose previous delivery is unknown
  --help               Show this help

SMTP environment:
  SMTP_HOST, SMTP_PORT (587), SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
  Use an app password and keep it out of shell history/source control. One
  message is sent per recipient; address lists are never placed in Bcc.

cashu.email environment:
  NOMAIN_NSEC or --nsec supplies the sender key; CASHU_TOKEN supplies one token,
  and CASHU_TOKENS_FILE supplies one token per line for a batch.

Resume with the same bundle, transport and ledger. Never reuse a ledger for a
different questionnaire or changed admission details.`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.csv) throw new Error(usage());
  opts.transport = opts.transport || "cashu";
  if (!TRANSPORTS.has(opts.transport)) throw new Error(`--transport must be cashu or smtp, got "${opts.transport}".`);
  opts.nsec = opts.nsec || process.env.NOMAIN_NSEC;
  opts.cashuToken = opts["cashu-token"] || process.env.CASHU_TOKEN;
  opts.api = opts.api || API_DEFAULT;
  opts.results = opts.results || "admission-results.csv";
  if (!opts.dryRun && opts.transport === "cashu" && !opts.nsec) {
    throw new Error("A cashu sender key is required. Set NOMAIN_NSEC or use --dry-run.");
  }
  if (!opts.dryRun && opts.transport === "smtp") smtpConfigFromEnv(process.env);
  await runBatch(opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : "Email batch failed."}`);
    process.exit(1);
  });
}
