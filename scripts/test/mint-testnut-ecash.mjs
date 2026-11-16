#!/usr/bin/env node
/**
 * Opt-in local fixture: mint a small testnut Cashu token for manual email
 * delivery checks. Never runs in CI and never prints the token.
 *
 * Requires the Nutshell `cashu` CLI on PATH (or CASHU_CLI), and LIVE_ALLOW=1.
 * The token is written with mode 0600 to --out. The default testnut mint is
 * automatic and has no monetary value.
 *
 * Known provider caveat (November 2026): cashu.email rejects the standard CBOR
 * V4 token emitted by current Nutshell releases before sending. This fixture
 * proves mint/token generation only; see issue #44 and docs/otp-delivery.md.
 *
 * Usage:
 *   LIVE_ALLOW=1 node scripts/test/mint-testnut-ecash.mjs \
 *     --out /secure/temp/testnut-token.txt
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

if (process.env.LIVE_ALLOW !== "1") {
  console.log("SKIP: set LIVE_ALLOW=1 to mint a testnut token.");
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    mint: { type: "string", default: "https://testnut.cashu.space" },
    amount: { type: "string", default: "100" },
  },
});
if (!values.out) throw new Error("--out <secure-token-file> is required.");
const amount = Number(values.amount);
if (!Number.isInteger(amount) || amount <= 0) throw new Error("--amount must be a positive integer.");
const cli = process.env.CASHU_CLI || "cashu";
const wallet = mkdtempSync(join(tmpdir(), "av-testnut-wallet-"));

function run(args) {
  const result = spawnSync(cli, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`cashu command failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return result.stdout;
}

try {
  run(["-h", values.mint, "-w", wallet, "invoice", String(amount)]);
  const output = run(["-h", values.mint, "-w", wallet, "send", String(amount)]);
  const token = (output.match(/cashu[AB]\S+/) || [""])[0];
  if (!token) throw new Error("cashu send did not return a cashuB token.");
  const out = resolve(values.out);
  writeFileSync(out, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Testnut token written to ${out}. Keep it private; it is single-use.`);
} finally {
  rmSync(wallet, { recursive: true, force: true });
}
