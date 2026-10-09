/**
 * Integration tests for the coordinator email CLI (AV-DELIVERY-1b).
 *
 * These run the real script through tsx, but only in `--dry-run`, so there is
 * no network, no payment and no ledger write. They cover the parts the pure
 * modules cannot: argument handling, the plan/cost/day-cap report and the
 * exit codes the coordinator's runbook depends on.
 *
 * The scripts are skipped (not failed) when `tsx` is not installed, so a
 * dependency-light checkout still runs the rest of the suite green.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const script = resolve(here, "otp-send-email.mjs");
const tsxBin = join(webRoot, "node_modules", ".bin", "tsx");
const hasTsx = existsSync(tsxBin);

const DAY_MS = 24 * 60 * 60 * 1000;

// Every test below spawns a fresh `tsx` process. tsx boots in ~1-2s on an idle
// machine but can take 5-10s on a loaded one, which is longer than vitest's 5s
// default timeout — the child still finishes (spawnSync allows 120s), so the
// default timeout produced load-dependent false failures. Give the spawns room.
const CLI_TIMEOUT_MS = 60_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "otp-send-email-"));
}

function runCli(args) {
  const result = spawnSync(tsxBin, [script, ...args], {
    cwd: webRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // A poisoned base URL: if anything in the dry-run path touched the
      // network it would fail loudly instead of reaching the real service.
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const CODES = [
  "name,code",
  '"Alice, A.",123456',
  "Bob,234567",
].join("\n");

const ROSTER = [
  "masters_list_number,email,phone,name",
  "101,alice@example.com,5550101,\"Alice, A.\"",
  "102,bob@example.com,5550102,Bob",
].join("\n");

describe.skipIf(!hasTsx)("otp-send-email CLI (dry run)", () => {
  it("plans the batch from a name,code CSV plus the roster, without writing a ledger", () => {
    const dir = tempDir();
    const codes = join(dir, "codes.csv");
    const roster = join(dir, "residents.csv");
    writeFileSync(codes, CODES);
    writeFileSync(roster, ROSTER);

    const { status, stdout } = runCli(["--csv", codes, "--roster", roster, "--dry-run"]);

    expect(status).toBe(0);
    expect(stdout).toContain("Plan:     2 to send, 0 skipped");
    expect(stdout).toContain("Cost:     2 x 100 sats = 200 sats");
    expect(stdout).toContain("would send -> 101 alice@example.com (reusing CSV code)");
    expect(stdout).toContain("[dry run] no network calls, no payments, no ledger writes.");
    // The ledger is only created by a real run.
    expect(existsSync(join(dir, "codes.csv.results.csv"))).toBe(false);
  }, CLI_TIMEOUT_MS);

  it("skips recipients already recorded as sent and warns about the last send of the day", () => {
    const dir = tempDir();
    const now = Date.now();
    const codes = join(dir, "codes.csv");
    const roster = join(dir, "residents.csv");
    const ledger = join(dir, "codes.csv.results.csv");
    writeFileSync(codes, CODES);
    writeFileSync(roster, ROSTER);

    const header = "mastersListNumber,ok,detail,ref,sentAt";
    const rows = Array.from({ length: 99 }, (_, index) =>
      [`${1000 + index}`, "true", "Sent", "", String(now)].join(","),
    );
    writeFileSync(ledger, `${[header, ...rows].join("\n")}\n`);

    const { status, stdout } = runCli(["--csv", codes, "--roster", roster, "--dry-run"]);

    expect(status).toBe(0);
    // 99 sends are already recorded today, so only two of the plan fit.
    expect(stdout).toContain("Day cap:  99/100 used today (this run: 1)");
    expect(stdout).toContain("Cost:     2 x 100 sats = 200 sats");
  }, CLI_TIMEOUT_MS);

  it("regenerates a code whose issued_at is older than the 24h admission TTL", () => {
    const dir = tempDir();
    const codes = join(dir, "keyed.csv");
    const stale = Date.now() - DAY_MS - 60_000;
    writeFileSync(
      codes,
      [
        "masters_list_number,email,name,code,issued_at",
        `101,alice@example.com,Alice,123456,${stale}`,
      ].join("\n"),
    );

    const { status, stdout } = runCli(["--csv", codes, "--dry-run"]);

    expect(status).toBe(0);
    expect(stdout).toContain("would send -> 101 alice@example.com (regenerating code)");
    expect(stdout).toMatch(/older than the 24h admission TTL/);
  }, CLI_TIMEOUT_MS);

  it("fails with usage guidance when --csv is missing", () => {
    const { status, stderr } = runCli(["--dry-run"]);

    expect(status).toBe(2);
    expect(stderr).toContain("--csv <path> is required");
  }, CLI_TIMEOUT_MS);
});
