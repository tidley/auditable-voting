// Offline integration tests for resident admission email delivery. No network,
// real Nostr secret, or paid postage is used.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import {
  buildAdmissionEmail,
  cashuCapUsage,
  formatAdmissionCode,
  parseAdmissionBundle,
  runBatch,
  sanitiseProviderMessage,
} from "../otp-send-email.mjs";

const SCRIPT = new URL("../otp-send-email.mjs", import.meta.url).pathname;
const TEST_NSEC = "0000000000000000000000000000000000000000000000000000000000000001";
const VOTE_URL = "https://tidley.github.io/auditable-voting/?role=voter&q=q_email_test&coordinator=npub1test";
const EXPIRY = "2099-01-01T00:00:00.000Z";
const BUNDLE = [
  "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url",
  `101,alice@example.test,5550101,"Alice, A.",ABCD1234EF,${EXPIRY},Community Vote,${VOTE_URL}`,
  `102,bob@example.test,5550102,Bob,GHJK5678MN,${EXPIRY},Community Vote,${VOTE_URL}`,
  `103,carol@example.test,5550103,Carol,PQRS9TVWX0,${EXPIRY},Community Vote,${VOTE_URL}`,
].join("\n");
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STUB = process.env.TEST_API_STUB;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "admission-email-"));
  const csv = join(dir, "bundle.csv");
  writeFileSync(csv, BUNDLE);
  return {
    dir,
    csv,
    results: join(dir, "results.csv"),
    ledger: join(dir, "ledger.json"),
    tokens: join(dir, "tokens.txt"),
  };
}

function runScript(args, envPatch = {}) {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envPatch, TEST_API_STUB: "1" },
  });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

afterEach(() => {
  if (ORIGINAL_STUB === undefined) delete process.env.TEST_API_STUB;
  else process.env.TEST_API_STUB = ORIGINAL_STUB;
  globalThis.fetch = ORIGINAL_FETCH;
});

test("bundle parsing and email composition preserve exact registered admission details", () => {
  const { rows, bundleScope } = parseAdmissionBundle(BUNDLE);
  assert.equal(rows.length, 3);
  assert.match(bundleScope, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].name, "Alice, A.");
  assert.equal(rows[0].code, "ABCD1234EF");
  assert.equal(formatAdmissionCode(rows[0].code), "ABCD1-234EF");
  const message = buildAdmissionEmail(rows[0]);
  assert.equal(message.to, "alice@example.test");
  assert.match(message.text, /Master-list number: 101/);
  assert.match(message.text, /Admission code: ABCD1-234EF/);
  assert.match(message.text, /Select "Use admission code"/);
  assert.match(message.text, /This code expires at .* UTC/);
  assert.match(message.text, /not included in your anonymous ballot/);
  assert.match(message.text, /Do not forward this email/);
  assert.ok(message.text.includes(VOTE_URL));
  assert.ok(message.html.includes(`href="${VOTE_URL.replace(/&/g, "&amp;")}"`));
  assert.match(message.html, /ABCD1-234EF/);
  assert.equal(message.subject, "Voting access code for Community Vote");
  assert.ok(!message.text.toUpperCase().includes("#INVITE_CODE"));

  const dangerous = buildAdmissionEmail({
    ...rows[0],
    name: "<script>alert(1)</script>",
    questionnaireTitle: "A & B",
  });
  assert.ok(!dangerous.html.includes("<script>alert(1)</script>"));
  assert.match(dangerous.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(dangerous.html, /A &amp; B/);
});

test("SMTP transport sends the exact generated code with recipient instructions and resumes safely", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  const sent = [];
  const smtpTransport = {
    verify: async () => true,
    sendMail: async (message) => {
      sent.push(message);
      return { messageId: `smtp-${sent.length}@example.test` };
    },
  };
  const options = {
    transport: "smtp",
    csv: paths.csv,
    ledger: paths.ledger,
    results: paths.results,
    smtpEnv: { SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "coordinator@example.test", SMTP_PASS: "secret", SMTP_FROM: "coordinator@example.test" },
    smtpTransport,
  };
  await runBatch(options);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].from, "coordinator@example.test");
  assert.equal(sent[0].to, "alice@example.test");
  assert.match(sent[0].text, /Admission code: ABCD1-234EF/);
  assert.match(sent[0].text, /Open this link on your device/);
  assert.match(sent[0].html, /Use admission code/);
  assert.deepEqual(sent.map((message) => message.to), ["alice@example.test", "bob@example.test", "carol@example.test"]);
  const ledger = readFileSync(paths.ledger, "utf8");
  assert.ok(!ledger.includes("alice@example.test"));
  assert.ok(!ledger.includes("ABCD1234EF"));
  assert.ok(!ledger.includes("secret"));
  assert.ok(ledger.includes('"transport": "smtp"'));

  const beforeResume = sent.length;
  const resumed = await runBatch({ ...options, results: join(paths.dir, "smtp-resumed.csv") });
  assert.equal(resumed.skipCount, 3);
  assert.equal(sent.length, beforeResume);
});

test("SMTP recipient rejection is recorded while later recipients continue", async () => {  delete process.env.TEST_API_STUB;
  const paths = fixture();
  let attempts = 0;
  const sent = [];
  const smtpTransport = {
    verify: async () => true,
    sendMail: async (message) => {
      attempts += 1;
      if (attempts === 2) throw Object.assign(new Error("raw provider detail"), { responseCode: 550 });
      sent.push(message.to);
      return { messageId: `smtp-${attempts}` };
    },
  };
  const result = await runBatch({
    transport: "smtp",
    csv: paths.csv,
    ledger: paths.ledger,
    results: paths.results,
    smtpEnv: { SMTP_HOST: "smtp.example.test", SMTP_FROM: "coordinator@example.test" },
    smtpTransport,
  });
  assert.equal(result.sentCount, 2);
  assert.equal(result.failCount, 1);
  const results = readFileSync(paths.results, "utf8");
  assert.match(results, /SMTP rejected the message or recipient/);
  assert.ok(!results.includes("raw provider detail"));
  assert.deepEqual(sent, ["alice@example.test", "carol@example.test"]);
});

test("SMTP authentication failure stops before claiming delivery", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  let sends = 0;
  await assert.rejects(runBatch({
    transport: "smtp",
    csv: paths.csv,
    ledger: paths.ledger,
    results: paths.results,
    smtpEnv: { SMTP_HOST: "smtp.example.test", SMTP_FROM: "coordinator@example.test" },
    smtpTransport: {
      verify: async () => true,
      sendMail: async () => {
        sends += 1;
        throw Object.assign(new Error("authentication detail"), { responseCode: 535 });
      },
    },
  }), /stopped early/);
  assert.equal(sends, 1);
  const failed = JSON.parse(readFileSync(paths.ledger, "utf8"));
  assert.equal(Object.values(failed)[0].pending, false);
  assert.equal(Object.values(failed)[0].failed, true);
  assert.equal(Object.values(failed)[0].deliveryUnknown, undefined);
  const results = readFileSync(paths.results, "utf8");
  assert.match(results, /SMTP authentication failed/);
  assert.ok(!results.includes("authentication detail"));
});

test("the real SMTP adapter sends a recipient message over a local SMTP socket", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.csv, BUNDLE.split("\n").slice(0, 2).join("\n"));
  const messages = [];
  const smtpServer = createTcpServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost test SMTP\r\n");
    let buffer = "";
    let inData = false;
    let data = "";
    socket.on("data", (chunk) => {
      if (inData) {
        data += chunk;
        const end = data.indexOf("\r\n.\r\n");
        if (end >= 0) {
          messages.push(data.slice(0, end));
          inData = false;
          data = data.slice(end + 5);
          socket.write("250 2.0.0 queued\r\n");
        }
        return;
      }
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          break;
        }
        if (/^QUIT$/i.test(line)) {
          socket.end("221 Bye\r\n");
          break;
        }
        socket.write("250 2.0.0 OK\r\n");
        index = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise((resolve) => smtpServer.listen(0, "127.0.0.1", resolve));
  const port = smtpServer.address().port;
  try {
    const result = await runBatch({
      transport: "smtp",
      csv: paths.csv,
      ledger: paths.ledger,
      results: paths.results,
      smtpEnv: { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_FROM: "coordinator@example.test" },
    });
    assert.equal(result.sentCount, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /To: alice@example\.test/i);
    assert.match(messages[0], /Subject: Voting access code for Community Vote/i);
    assert.match(messages[0], /ABCD1-234EF/);
    assert.match(messages[0], /Use admission code/);
    assert.match(messages[0], /Open the voter page/);
  } finally {
    await new Promise((resolve) => smtpServer.close(resolve));
  }
});

test("malformed or unsafe bundles fail before any send", () => {
  assert.throws(() => parseAdmissionBundle("masters_list_number,email\n101,alice@example.test"), /missing the required name column/);
  assert.throws(() => parseAdmissionBundle(BUNDLE.replace("ABCD1234EF", "123456")), /invalid admission code/);
  assert.throws(() => parseAdmissionBundle(BUNDLE.replaceAll("q=q_email_test", "q=q_email_test&code=ABCD1234EF")), /without an admission code/);
  assert.throws(() => parseAdmissionBundle(BUNDLE.replace("PQRS9TVWX0", "ABCD1234EF").replace("103,carol", "101,carol")), /duplicate master-list number/);
  assert.throws(() => parseAdmissionBundle(BUNDLE.replaceAll(EXPIRY, "2000-01-01T00:00:00.000Z")), /unexpired ISO UTC timestamp/);
});

test("dry-run validates without credentials, marks nothing sent, and redacts output", () => {
  const paths = fixture();
  const result = runScript(["--csv", paths.csv, "--ledger", paths.ledger, "--results", paths.results, "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(paths.ledger), false);
  const results = readFileSync(paths.results, "utf8");
  assert.equal(results.trim().split("\n").length - 1, 3);
  assert.ok(results.trim().split("\n").every((line, index) => index === 0 || line.includes("dry-run (not sent)")));
  for (const secret of ["ABCD1234EF", "GHJK5678MN", "PQRS9TVWX0", "alice@example.test", "bob@example.test"]) {
    assert.ok(!results.includes(secret));
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
  }
});

test("live-shaped transport sends exact codes, uses session cookie and distinct tokens, then resumes idempotently", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.tokens, "cashuBtest-one\ncashuBtest-two\ncashuBtest-three\n");
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ url: String(url), headers: init.headers || {}, body });
    if (String(url).endsWith("/api/auth/challenge")) {
      return new Response(JSON.stringify({ nonce: "deterministic-test-nonce" }), { status: 200 });
    }
    if (String(url).endsWith("/api/auth/verify")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "set-cookie": "__Host-session=test-cookie; Path=/; Secure; HttpOnly; SameSite=Strict" } });
    }
    if (String(url).endsWith("/api/send")) {
      return new Response(JSON.stringify({ ok: true, id: `send-${requests.length}` }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const options = {
    nsec: TEST_NSEC,
    csv: paths.csv,
    api: "https://email.test",
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  };
  await runBatch(options);
  assert.equal(requests.filter((request) => request.url.endsWith("/api/auth/verify")).length, 1);
  const sends = requests.filter((request) => request.url.endsWith("/api/send"));
  assert.equal(sends.length, 3);
  assert.deepEqual(sends.map((send) => send.body.to), ["alice@example.test", "bob@example.test", "carol@example.test"]);
  assert.deepEqual(sends.map((send) => send.body.cashuToken), ["cashuBtest-one", "cashuBtest-two", "cashuBtest-three"]);
  assert.ok(sends.every((send) => send.headers.cookie === "__Host-session=test-cookie"));
  assert.match(sends[0].body.text, /Admission code: ABCD1-234EF/);
  assert.ok(!sends[0].body.text.includes("123456"));

  const ledger = readFileSync(paths.ledger, "utf8");
  const results = readFileSync(paths.results, "utf8");
  for (const secret of ["ABCD1234EF", "GHJK5678MN", "PQRS9TVWX0", "alice@example.test", "bob@example.test", "carol@example.test", "cashuBtest", "test-nonce", "test-cookie"]) {
    assert.ok(!ledger.includes(secret), `ledger leaked ${secret}`);
    assert.ok(!results.includes(secret), `results leaked ${secret}`);
  }

  const beforeResume = requests.length;
  const resumed = await runBatch({ ...options, results: join(paths.dir, "results-resumed.csv") });
  assert.equal(resumed.skipCount, 3);
  assert.equal(requests.length, beforeResume);
  assert.ok(readFileSync(join(paths.dir, "results-resumed.csv"), "utf8").includes("already-sent (skipped)"));
});

test("payment/auth failures stop the batch instead of silently claiming delivery", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.tokens, "cashuBtest-one\ncashuBtest-two\ncashuBtest-three\n");
  let sendAttempts = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test" } });
    if (value.endsWith("/api/send")) {
      sendAttempts += 1;
      return new Response(JSON.stringify({ ok: false }), { status: 402 });
    }
    throw new Error("unexpected request");
  };
  await assert.rejects(runBatch({
    nsec: TEST_NSEC,
    csv: paths.csv,
    api: "https://email.test",
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  }), /stopped early/);
  assert.equal(sendAttempts, 1);
  assert.equal(existsSync(paths.ledger), true);
  assert.equal(Object.values(JSON.parse(readFileSync(paths.ledger, "utf8")))[0].failed, true);
  assert.ok(readFileSync(paths.results, "utf8").includes("send failed (HTTP 402)"));
});

test("partial-send resume skips delivered residents and previously used payment tokens", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.tokens, "cashuBtest-one\ncashuBtest-two\ncashuBtest-three\n");
  let sendAttempts = 0;
  const sendTokens = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test" } });
    if (value.endsWith("/api/send")) {
      sendTokens.push(JSON.parse(init.body).cashuToken);
      sendAttempts += 1;
      if (sendAttempts === 2) return new Response("{}", { status: 402 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const options = {
    nsec: TEST_NSEC,
    csv: paths.csv,
    api: "https://email.test",
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  };
  await assert.rejects(runBatch(options), /stopped early/);
  assert.deepEqual(sendTokens, ["cashuBtest-one", "cashuBtest-two"]);
  const secondRunTokens = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n2" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test2" } });
    if (value.endsWith("/api/send")) {
      secondRunTokens.push(JSON.parse(init.body).cashuToken);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const resumed = await runBatch({ ...options, results: join(paths.dir, "resumed.csv") });
  assert.equal(resumed.skipCount, 1);
  assert.equal(resumed.sentCount, 2);
  assert.deepEqual(secondRunTokens, ["cashuBtest-two", "cashuBtest-three"]);
  assert.ok(!readFileSync(paths.ledger, "utf8").includes("cashuBtest"));
});

test("unknown delivery requires an explicit retry decision and a fresh payment token", async () => {
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.tokens, "cashuBtest-one\n");
  const original = BUNDLE.split("\n").slice(0, 2).join("\n");
  writeFileSync(paths.csv, original);
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test" } });
    if (value.endsWith("/api/send")) throw new Error("simulated interrupted transport");
    throw new Error("unexpected request");
  };
  const options = {
    nsec: TEST_NSEC,
    csv: paths.csv,
    api: "https://email.test",
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  };
  await assert.rejects(runBatch(options), /stopped early/);
  assert.ok(readFileSync(paths.results, "utf8").includes("delivery-unknown"));
  assert.equal(JSON.parse(readFileSync(paths.ledger, "utf8"))[Object.keys(JSON.parse(readFileSync(paths.ledger, "utf8")))[0]].deliveryUnknown, true);
  await assert.rejects(runBatch(options), /did not record confirmed delivery/);
  writeFileSync(paths.tokens, "cashuBtest-one\ncashuBtest-fresh\n");
  let sentBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n2" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test2" } });
    if (value.endsWith("/api/send")) {
      sentBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const retried = await runBatch({ ...options, "retry-unknown": true });
  assert.equal(retried.sentCount, 1);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].cashuToken, "cashuBtest-fresh");
  assert.ok(sentBodies[0].text.includes("Admission code: ABCD1-234EF"));
});

test("provider failure hints are shown with recipient, token and key redaction", async () => {
  assert.equal(
    sanitiseProviderMessage(
      "Daily limit reached for alice@example.test",
      "Top up cashuBsecret with nsec1verysecret or retry",
    ),
    "Email service: Daily limit reached for [redacted recipient] — Top up [redacted token] with [redacted key] or retry",
  );
  delete process.env.TEST_API_STUB;
  const paths = fixture();
  writeFileSync(paths.csv, BUNDLE.split("\n").slice(0, 2).join("\n"));
  writeFileSync(paths.tokens, "cashuBtest-one\n");
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/auth/challenge")) return new Response(JSON.stringify({ nonce: "n" }), { status: 200 });
    if (value.endsWith("/api/auth/verify")) return new Response("{}", { status: 200, headers: { "set-cookie": "session=test" } });
    if (value.endsWith("/api/send")) {
      return new Response("{}", {
        status: 429,
        headers: {
          "x-reason": "Daily limit reached for alice@example.test",
          "x-hint": "Top up cashuBsecret or retry",
        },
      });
    }
    throw new Error("unexpected request");
  };
  await assert.rejects(runBatch({
    nsec: TEST_NSEC,
    csv: paths.csv,
    api: "https://email.test",
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  }), /stopped early/);
  const results = readFileSync(paths.results, "utf8");
  const ledger = readFileSync(paths.ledger, "utf8");
  for (const output of [results, ledger]) {
    assert.match(output, /Daily limit reached for \[redacted recipient\]/);
    assert.ok(!output.includes("alice@example.test"));
    assert.ok(!output.includes("cashuBsecret"));
  }
});

test("cashu batches stop at the local daily cap and report remaining work", async () => {
  process.env.TEST_API_STUB = "1";
  const paths = fixture();
  const now = new Date().toISOString();
  const previous = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [
    `previous:${index}`,
    { ok: true, transport: "cashu", sentAt: now },
  ]));
  writeFileSync(paths.ledger, JSON.stringify(previous));
  assert.deepEqual(cashuCapUsage(previous), { used: 99, remaining: 1, cap: 100 });
  const result = await runBatch({
    transport: "cashu",
    nsec: TEST_NSEC,
    csv: paths.csv,
    ledger: paths.ledger,
    results: paths.results,
  });
  assert.equal(result.sentCount, 1);
  assert.equal(result.notAttemptedCount, 2);
  assert.equal(result.failCount, 0);
  assert.equal(result.satsSpent, 100);
  assert.equal(result.capUsedToday, 100);
  assert.equal(result.capRemaining, 0);
  const results = readFileSync(paths.results, "utf8");
  assert.match(results, /not attempted: cashu daily send limit reached/);
});

test("a pending ledger entry from an interrupted process blocks automatic retry", async () => {
  const paths = fixture();
  const { rows, bundleScope } = parseAdmissionBundle(BUNDLE);
  writeFileSync(paths.ledger, JSON.stringify({
    [`${bundleScope}:${rows[0].master}`]: {
      ok: false,
      pending: true,
      fingerprint: rows[0].fingerprint,
      transport: "cashu",
      attemptedAt: new Date().toISOString(),
    },
  }));
  await assert.rejects(runBatch({
    nsec: TEST_NSEC,
    csv: paths.csv,
    ledger: paths.ledger,
    results: paths.results,
    "cashu-tokens-file": paths.tokens,
  }), /did not record confirmed delivery/);
});