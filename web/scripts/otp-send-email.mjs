#!/usr/bin/env node
/**
 * AV-DELIVERY-1b — coordinator-machine email sender for resident admission codes.
 *
 * RUN IT WITH tsx (it imports the app's TypeScript modules):
 *
 *   cd web
 *   npx tsx scripts/otp-send-email.mjs --csv ~/otp-codes.csv --roster ~/residents.csv \
 *       --nsec-file ~/.nomail-nsec --cashu-token-file ~/.nomail-ecash
 *
 * Why a script and not the browser: nomail.name / cashu.email authenticates with
 * a SameSite=Strict HttpOnly cookie, which a cross-origin browser context can
 * never set (see docs/otp-delivery.md and src/otpDelivery/emailNomail.ts).
 *
 * The results CSV is the LEDGER: every attempt is appended as it happens, and a
 * re-run skips recipients whose row is already `ok=true`. That makes the batch
 * resumable, which is what a 100-emails/day cap needs: 100 voters is exactly one
 * full day, so any leftover rolls over to the next day and is resent then.
 *
 * Exit codes: 0 = every planned recipient sent; 1 = partial batch (some failed or
 * were not attempted — re-run to resume); 2 = fatal (config, auth, wallet, cap).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { parseResidentCsv } from "../src/residentRegister.ts";
import { ADMISSION_TTL_MS, generateOtp } from "../src/otpService.ts";
import { escapeCsvField } from "../src/otpDelivery/csv.ts";
import {
  DAILY_SEND_CAP,
  EMAIL_COST_SATS,
  buildLedgerCsv,
  capStatus,
  countSentToday,
  parseCodeCsv,
  parseLedgerCsv,
  planSends,
  summarizeBatch,
} from "../src/otpDelivery/sendLedger.ts";
import {
  DEFAULT_BASE_URL,
  NomailApiError,
  challenge,
  createCookieJar,
  isDailyLimitError,
  quoteStatus,
  send,
  sendQuote,
  verify,
} from "../src/otpDelivery/nomailClient.ts";

const MINT_ALIASES = {
  testnut: "https://testnut.cashu.space",
  testnut2: "https://nofees.testnut.cashu.space",
};

const ADMISSION_TTL_HOURS = ADMISSION_TTL_MS / (60 * 60 * 1000);

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    "Usage: npx tsx scripts/otp-send-email.mjs --csv <codes.csv> [options]",
    "",
    "Required:",
    "  --csv <path>              codes CSV exported by the coordinator UI",
    "                            (name,code from AV-DELIVERY-1a, or the keyed",
    "                            masters_list_number,email,name,code[,issued_at])",
    "",
    "Options:",
    "  --roster <path>           residents CSV (masters_list_number,email,phone,name);",
    "                            needed to resolve a name,code CSV to recipients",
    "  --nsec-file <path>        file holding the sender nsec (mode 600). Required",
    "                            unless --dry-run. Never printed, never committed.",
    "  --results <path>          results ledger CSV (default <csv>.results.csv)",
    "  --pay-with cashu|lightning  payment rail (default cashu)",
    "  --cashu-token-file <path> pre-funded ecash token to spend (cashu rail)",
    "  --mint <testnut|url>      fund ecash from a mint instead of a token file",
    "                            (testnut.cashu.space auto-pays its invoices)",
    "  --election <label>        election name used in the email body",
    "  --limit <n>               send at most n emails this run",
    "  --base-url <url>          API base URL (default " + DEFAULT_BASE_URL + ")",
    "  --mint-wait <seconds>     how long to wait for a mint invoice (default 300)",
    "  --quote-wait <seconds>    how long to wait for a Lightning quote (default 300)",
    "  --ignore-local-cap        start even when the ledger already shows a full day",
    "  --dry-run                 print the plan and exit; no network, no payment",
    "  --help                    show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    csv: undefined,
    roster: undefined,
    nsecFile: undefined,
    results: undefined,
    payWith: "cashu",
    cashuTokenFile: undefined,
    mint: undefined,
    election: undefined,
    limit: undefined,
    baseUrl: DEFAULT_BASE_URL,
    mintWaitSeconds: 300,
    quoteWaitSeconds: 300,
    ignoreLocalCap: false,
    dryRun: false,
    help: false,
  };

  const valueFlags = new Map([
    ["--csv", "csv"],
    ["--roster", "roster"],
    ["--nsec-file", "nsecFile"],
    ["--results", "results"],
    ["--pay-with", "payWith"],
    ["--cashu-token-file", "cashuTokenFile"],
    ["--mint", "mint"],
    ["--election", "election"],
    ["--limit", "limit"],
    ["--base-url", "baseUrl"],
    ["--mint-wait", "mintWaitSeconds"],
    ["--quote-wait", "quoteWaitSeconds"],
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--ignore-local-cap") {
      options.ignoreLocalCap = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) {
      throw new CliError(`unknown argument "${arg}"\n\n${usage()}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`argument "${arg}" needs a value\n\n${usage()}`);
    }
    i += 1;
    if (key === "limit" || key === "mintWaitSeconds" || key === "quoteWaitSeconds") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliError(`argument "${arg}" must be a positive integer`);
      }
      options[key] = parsed;
    } else {
      options[key] = value;
    }
  }

  if (options.payWith !== "cashu" && options.payWith !== "lightning") {
    throw new CliError(`--pay-with must be "cashu" or "lightning"`);
  }
  return options;
}

function readTextFile(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new CliError(`${label} not found: ${absolute}`);
  }
  return { absolute, content: readFileSync(absolute, "utf8") };
}

/** Load the sender nsec, warning if the file is readable by anyone else. */
function loadSenderKey(path) {
  const absolute = resolve(path);
  const stat = statSync(absolute);
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(
      `WARNING: ${absolute} is mode ${mode.toString(8)} — chmod 600 it. The nsec is the sender identity and must never be committed.`,
    );
  }
  const raw = readFileSync(absolute, "utf8").trim();
  let decoded;
  try {
    decoded = nip19.decode(raw);
  } catch (error) {
    throw new CliError(`could not decode the nsec in ${absolute}: ${error.message}`);
  }
  if (decoded.type !== "nsec") {
    throw new CliError(`${absolute} does not contain an nsec (found ${decoded.type})`);
  }
  const secretKey = decoded.data;
  return { secretKey, npub: nip19.npubEncode(getPublicKey(secretKey)) };
}

function buildEmail({ name, code, electionLabel }) {
  const greeting = name ? `Hello ${name},` : "Hello,";
  const subject = "Your voter admission code";
  const text = [
    greeting,
    "",
    `Your admission code for ${electionLabel} is:`,
    "",
    `    ${code}`,
    "",
    `It is valid for ${ADMISSION_TTL_HOURS} hours from the moment it was issued.`,
    "Enter it in the admission form to confirm that you are on the residents' register.",
    "",
    "Do not forward this email: anyone who has the code can use it.",
    "",
    "If you were not expecting this message, you can ignore it.",
  ].join("\n");
  return { subject, text };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function formatError(error) {
  if (error instanceof NomailApiError) {
    return error.hint ? `${error.reason} [${error.hint}]` : error.reason;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function authenticate({ fetchImpl, jar, baseUrl, secretKey }) {
  const deps = { fetch: fetchImpl, jar, baseUrl, now: () => Date.now() };
  const { nonce } = await challenge(deps);
  const signed = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", nonce]],
      content: nonce,
    },
    secretKey,
  );
  const { pubkey } = await verify(deps, signed);
  return { pubkey, deps };
}

async function loadCashuModule() {
  try {
    return await import("@cashu/cashu-ts");
  } catch (error) {
    throw new CliError(
      `@cashu/cashu-ts is needed for the cashu rail (npm install) — ${error.message}`,
    );
  }
}

async function fundEcashFromMint({ cashu, wallet, amountSats, waitSeconds, log }) {
  const quote = await wallet.createMintQuoteBolt11(amountSats);
  log(`Mint quote ${quote.quote} for ${amountSats} sats. Pay this Lightning invoice:`);
  log(`  ${quote.request}`);
  log(`Waiting up to ${waitSeconds}s for payment (testnut.cashu.space pays its own invoices)...`);

  const deadline = Date.now() + waitSeconds * 1000;
  let state = quote.state;
  while (state === "UNPAID" && Date.now() < deadline) {
    await delay(2000);
    const refreshed = await wallet.checkMintQuoteBolt11(quote.quote);
    state = refreshed.state;
  }
  if (state === "UNPAID") {
    throw new CliError(
      `mint quote ${quote.quote} was still unpaid after ${waitSeconds}s — pay the invoice and re-run`,
    );
  }
  return wallet.ops.mintBolt11(amountSats, quote).run();
}

/**
 * Cashu rail: pre-funded ecash is spent 100 sats at a time. `includeFees(true)`
 * makes the sender cover the receiver's future spend fee, so the service never
 * sees less than 100 sats of postage.
 */
async function createCashuRail({ tokenFile, mintUrl, amountSats, waitSeconds, log }) {
  const cashu = await loadCashuModule();
  const wallet = new cashu.Wallet(mintUrl, { unit: "sat" });
  await wallet.loadMint();

  let proofs;
  if (tokenFile) {
    const { absolute, content } = readTextFile(tokenFile, "cashu token file");
    if (!content.trim()) {
      throw new CliError(`cashu token file ${absolute} is empty`);
    }
    log(`Receiving ecash from ${absolute}...`);
    proofs = await wallet.receive(content.trim());
  } else {
    proofs = await fundEcashFromMint({ cashu, wallet, amountSats, waitSeconds, log });
  }

  let remaining = proofs;
  return {
    kind: "cashu",
    balance: () => cashu.sumProofs(remaining).toNumber(),
    async payOne() {
      const { send: sendProofs, keep } = await wallet.ops
        .send(EMAIL_COST_SATS, remaining)
        .includeFees(true)
        .run();
      remaining = keep;
      return {
        cashuToken: cashu.getEncodedToken({ mint: mintUrl, proofs: sendProofs, unit: "sat" }),
      };
    },
  };
}

/**
 * Lightning rail: one nomail quote per email, paid by hand while the script
 * polls. Slower than ecash (one payment per recipient) but needs no Cashu
 * wallet — useful for a handful of stragglers.
 */
function createLightningRail({ deps, waitSeconds, log }) {
  return {
    kind: "lightning",
    balance: () => null,
    async payOne() {
      const quote = await sendQuote(deps);
      log(`  Lightning invoice for ${quote.amount || EMAIL_COST_SATS} sats (quote ${quote.quoteId}):`);
      log(`  ${quote.invoice}`);
      const deadline = Date.now() + waitSeconds * 1000;
      let status = "unpaid";
      while (status === "unpaid" && Date.now() < deadline) {
        await delay(3000);
        status = (await quoteStatus(deps, quote.quoteId)).status;
      }
      if (status === "unpaid") {
        throw new CliError(
          `Lightning quote ${quote.quoteId} was still unpaid after ${waitSeconds}s — pay it and re-run`,
        );
      }
      return { paidQuoteId: quote.quoteId };
    },
  };
}

function writeRegeneratedCodes(path, entries) {
  const header = "masters_list_number,email,name,code,issued_at";
  const rows = entries.map((entry) =>
    [
      escapeCsvField(entry.mastersListNumber),
      escapeCsvField(entry.email),
      escapeCsvField(entry.name),
      escapeCsvField(entry.code),
      String(entry.issuedAt),
    ].join(","),
  );
  writeFileSync(path, `${[header, ...rows].join("\n")}\n`, { mode: 0o600 });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.csv) {
    throw new CliError(`--csv <path> is required\n\n${usage()}`);
  }

  const now = Date.now();
  const codesFile = readTextFile(options.csv, "codes CSV");
  const resultsPath =
    options.results ??
    resolve(dirname(codesFile.absolute), `${codesFile.absolute.split("/").pop()}.results.csv`);

  const codeRows = parseCodeCsv(codesFile.content);
  if (codeRows.length === 0) {
    throw new CliError(`no codes found in ${codesFile.absolute}`);
  }

  const ledger = existsSync(resultsPath)
    ? parseLedgerCsv(readFileSync(resultsPath, "utf8"))
    : [];

  let roster = [];
  if (options.roster) {
    const rosterFile = readTextFile(options.roster, "roster CSV");
    const parsed = parseResidentCsv(rosterFile.content);
    if (parsed.errors.length > 0) {
      throw new CliError(
        `roster CSV ${rosterFile.absolute} has errors:\n  ${parsed.errors.join("\n  ")}`,
      );
    }
    roster = parsed.residents;
  } else {
    const unkeyed = codeRows.filter((row) => !row.mastersListNumber || !row.email).length;
    if (unkeyed > 0) {
      throw new CliError(
        `${unkeyed} code row(s) carry no masters_list_number/email — pass --roster <residents.csv> to resolve them by name`,
      );
    }
  }

  const plan = planSends({ codeRows, roster, ledger, now });
  const sentToday = countSentToday(ledger, now);
  const cap = capStatus(sentToday);
  const defaultLimit = Math.max(0, DAILY_SEND_CAP - sentToday);
  const limit = options.limit ?? defaultLimit;

  console.log(`Codes:    ${codesFile.absolute}`);
  if (options.roster) {
    console.log(`Roster:   ${resolve(options.roster)} (${roster.length} residents)`);
  }
  console.log(`Ledger:   ${resultsPath} (${ledger.length} previous row(s))`);
  console.log(
    `Plan:     ${plan.sends.length} to send, ${plan.skipped.length} skipped ` +
      `(${plan.skipped.filter((skip) => skip.kind === "already-sent").length} already sent, ` +
      `${plan.skipped.filter((skip) => skip.kind === "unresolved").length} unresolved)`,
  );
  for (const note of plan.notes) {
    console.log(`Note:     ${note}`);
  }
  for (const skip of plan.skipped) {
    console.log(`Skip:     ${skip.mastersListNumber ?? "-"} ${skip.reason}`);
  }
  console.log(
    `Cost:     ${plan.sends.length} x ${EMAIL_COST_SATS} sats = ${plan.sends.length * EMAIL_COST_SATS} sats`,
  );
  console.log(
    `Day cap:  ${sentToday}/${DAILY_SEND_CAP} used today (this run: ${Math.min(limit, plan.sends.length)})`,
  );

  if (options.dryRun) {
    for (const item of plan.sends) {
      console.log(
        `  would send -> ${item.mastersListNumber} ${item.email} ` +
          (item.reuseCsvCode ? "(reusing CSV code)" : "(regenerating code)"),
      );
    }
    console.log("[dry run] no network calls, no payments, no ledger writes.");
    return 0;
  }

  if (!options.nsecFile) {
    throw new CliError("--nsec-file <path> is required (unless --dry-run)");
  }
  if (plan.sends.length === 0) {
    console.log("Nothing to send — every recipient in the plan is already accounted for.");
    return 0;
  }
  if (cap.blocked && !options.ignoreLocalCap) {
    throw new CliError(
      `${cap.warning}\nThe ledger already shows a full day of sends. Re-run tomorrow, or pass --ignore-local-cap to try anyway (the service enforces the real cap).`,
    );
  }
  if (cap.warning) {
    console.log(`WARNING: ${cap.warning}`);
  }
  if (limit === 0) {
    throw new CliError("nothing can be sent today: the local day cap is exhausted");
  }

  const fetchImpl = (url, init) => fetch(url, init);
  const jar = createCookieJar();
  const key = loadSenderKey(options.nsecFile);
  console.log(`Auth:     authenticating as ${key.npub}...`);
  const { deps } = await authenticate({
    fetchImpl,
    jar,
    baseUrl: options.baseUrl,
    secretKey: key.secretKey,
  });
  console.log("Auth:     session established (30-day cookie).");

  const pending = Math.min(limit, plan.sends.length);
  let rail;
  if (options.payWith === "cashu") {
    const mintUrl = options.mint
      ? (MINT_ALIASES[options.mint] ?? options.mint)
      : undefined;
    if (!mintUrl) {
      throw new CliError(
        "--pay-with cashu needs --mint <testnut|url> or --cashu-token-file <path>",
      );
    }
    rail = await createCashuRail({
      tokenFile: options.cashuTokenFile,
      mintUrl,
      amountSats: pending * EMAIL_COST_SATS,
      waitSeconds: options.mintWaitSeconds,
      log: (line) => console.log(line),
    });
    const balance = rail.balance();
    console.log(`Wallet:   ${balance} sats on ${mintUrl}`);
    if (balance < pending * EMAIL_COST_SATS) {
      throw new CliError(
        `wallet holds ${balance} sats but ${pending} emails need ${pending * EMAIL_COST_SATS} sats — fund the token file and re-run`,
      );
    }
  } else {
    rail = createLightningRail({
      deps,
      waitSeconds: options.quoteWaitSeconds,
      log: (line) => console.log(line),
    });
    console.log("Wallet:   Lightning quotes (one invoice per email, paid by hand)");
  }

  const electionLabel = options.election ?? "the residents' register";
  const results = [];
  const regenerated = [];
  let stopReason = null;

  for (const [index, item] of plan.sends.entries()) {
    if (results.length >= limit) {
      console.log(`Limit reached (${limit}); ${plan.sends.length - results.length} recipient(s) remain for the next run.`);
      break;
    }
    const position = `[${index + 1}/${plan.sends.length}]`;
    const code = item.code ?? generateOtp();
    if (!item.code) {
      regenerated.push({
        mastersListNumber: item.mastersListNumber,
        email: item.email,
        name: item.name,
        code,
        issuedAt: Date.now(),
      });
    }

    let row;
    try {
      const payment = await rail.payOne();
      const { subject, text } = buildEmail({ name: item.name, code, electionLabel });
      const response = await send(deps, { to: item.email, subject, text, ...payment });
      row = {
        mastersListNumber: item.mastersListNumber,
        ok: true,
        detail: item.reuseCsvCode ? "Sent" : "Sent (code regenerated)",
        ref: response.from ?? payment.paidQuoteId ?? "",
        sentAt: Date.now(),
      };
      console.log(`${position} ${item.mastersListNumber} ${item.email} sent${item.reuseCsvCode ? "" : " (regenerated code)"}`);
    } catch (error) {
      row = {
        mastersListNumber: item.mastersListNumber,
        ok: false,
        detail: formatError(error),
        sentAt: Date.now(),
      };
      console.error(`${position} ${item.mastersListNumber} ${item.email} FAILED: ${row.detail}`);

      if (isDailyLimitError(error)) {
        stopReason = "the service reported its 100/day limit";
      } else if (error instanceof CliError || !(error instanceof NomailApiError)) {
        stopReason = `transport/payment error: ${formatError(error)}`;
      }
    }

    results.push(row);
    ledger.push(row);
    writeFileSync(resultsPath, buildLedgerCsv(ledger), { mode: 0o600 });

    if (stopReason) {
      console.error(`Stopping: ${stopReason}`);
      break;
    }
  }

  const accounting = summarizeBatch({ plan, results, sentTodayBefore: sentToday });
  console.log("");
  console.log(`Ledger written to ${resultsPath}`);
  console.log(`Summary: ${accounting.summaryLine}`);
  console.log(
    `Outstanding: ${plan.sends.length - accounting.sent} recipient(s) still need a code — re-run to resume.`,
  );

  if (regenerated.length > 0) {
    const regeneratedPath = `${resultsPath}.regenerated.csv`;
    writeRegeneratedCodes(regeneratedPath, regenerated);
    console.log("");
    console.log(`Regenerated codes written to ${regeneratedPath}`);
    console.log(
      "IMPORTANT: those codes did not exist in the coordinator UI, so they must be imported/registered there before residents can verify them (see docs/otp-delivery.md).",
    );
  }

  if (accounting.partial) {
    return 1;
  }
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof CliError) {
      console.error(`error: ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      console.error(error);
      process.exitCode = 2;
    }
  });
