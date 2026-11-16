// Explicit opt-in live delivery smoke. Never runs in pull-request CI.
//
// This sends ONE real message through the configured local/SMTP or cashu.email
// transport. It cannot inspect the destination inbox, so after it reports
// "sent" the operator must confirm arrival and complete manual redemption checks.
//
// SMTP example:
//   LIVE_ALLOW=1 TEST_TRANSPORT=smtp TEST_RECIPIENT=you@example.org \
//   SMTP_HOST=smtp.example.org SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... \
//   SMTP_FROM=... node --test scripts/test/live-email-delivery.test.mjs
//
// cashu.email example:
//   LIVE_ALLOW=1 TEST_TRANSPORT=cashu TEST_RECIPIENT=you@example.org \
//   NOMAIN_NSEC=... CASHU_TOKEN=... \
//   node --test scripts/test/live-email-delivery.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../otp-send-email.mjs";

test("live delivery sends exactly one policy-complete admission email", async () => {
  if (process.env.LIVE_ALLOW !== "1") {
    console.log("SKIP: set LIVE_ALLOW=1 to perform one real email delivery.");
    return;
  }
  const recipient = (process.env.TEST_RECIPIENT ?? "").trim();
  assert.match(recipient, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, "TEST_RECIPIENT must be a valid email address.");
  const transport = process.env.TEST_TRANSPORT || "smtp";
  assert.ok(transport === "smtp" || transport === "cashu", "TEST_TRANSPORT must be smtp or cashu.");
  const dir = mkdtempSync(join(tmpdir(), "live-admission-email-"));
  const csv = join(dir, "bundle.csv");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(csv, [
    "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url",
    `999999,${recipient},,Live Test Resident,ABCD1234EF,${expiresAt},Live email delivery smoke,https://example.test/auditable-voting/?role=voter&q=live-email-smoke&coordinator=npub1test`,
  ].join("\n"));
  const result = await runBatch({
    transport,
    csv,
    ledger: join(dir, "ledger.json"),
    results: join(dir, "results.csv"),
  });
  assert.equal(result.sentCount, 1);
  assert.equal(result.failCount, 0);
  console.log(`Provider accepted one live ${transport} message. Confirm receipt for ${recipient} before treating delivery as verified.`);
});
