// Offline tests for the loopback coordinator email companion.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { createEmailSenderServer, validHostHeader, validOrigin } from "../email-sender.mjs";

const VOTE_URL = "https://example.test/vote/?role=voter&q=q_companion&coordinator=npub1test";
const BUNDLE = [
  "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url",
  `101,alice@example.test,,Alice Archer,ABCD1234EF,2099-01-01T00:00:00.000Z,Community Vote,${VOTE_URL}`,
].join("\n");

let server;
let base;
let stateDir;
let lastDeliveryOptions;
const deliveryResults = { sentCount: 1, skipCount: 0, failCount: 0, results: [{ master: "101", ok: true, detail: "sent", ref: "smtp-1" }] };

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "email-companion-"));
  const distDir = join(root, "dist");
  stateDir = join(root, "state");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Companion app</title>");
  const created = createEmailSenderServer({
    distDir,
    stateDir,
    env: { SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_FROM: "coordinator@example.test", NOMAIN_NSEC: "sender-secret" },
    runDelivery: async (options) => {
      lastDeliveryOptions = options;
      return deliveryResults;
    },
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("host and origin checks only accept loopback", () => {
  assert.equal(validHostHeader("127.0.0.1:4319"), true);
  assert.equal(validHostHeader("localhost:4319"), true);
  assert.equal(validHostHeader("evil.example:4319"), false);
  assert.equal(validHostHeader("127.0.0.1.evil.example"), false);
  assert.equal(validOrigin("http://127.0.0.1:4319"), true);
  assert.equal(validOrigin("http://localhost:4319"), true);
  assert.equal(validOrigin("https://tidley.github.io"), false);
  assert.equal(validOrigin("https://evil.example"), false);
});

test("health reports only configured transports and no credentials", async () => {
  const response = await fetch(`${base}/__email/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    service: "auditable-voting-email-sender",
    version: 1,
    transports: ["smtp", "cashu"],
    maxRecipients: 1000,
  });
  const text = JSON.stringify(body);
  assert.ok(!text.includes("sender-secret"));
  assert.ok(!text.includes("smtp.example.test"));
});

test("serves the built app on the same loopback origin", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Companion app/);
  const traversal = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(traversal.status, 404);
  assert.ok(!(await traversal.text()).includes("root:"));
});

test("rejects untrusted browser origins", async () => {
  const response = await fetch(`${base}/__email/send`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ transport: "smtp", bundleCsv: BUNDLE }),
  });
  assert.equal(response.status, 403);
});

test("accepts a validated same-origin batch and returns redacted per-recipient results", async () => {
  const response = await fetch(`${base}/__email/send`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ transport: "smtp", bundleCsv: BUNDLE }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    sent: 1,
    skipped: 0,
    failed: 0,
    results: [{ master: "101", ok: true, detail: "sent", ref: "smtp-1" }],
  });
  assert.equal(lastDeliveryOptions.transport, "smtp");
  assert.ok(lastDeliveryOptions.ledger.startsWith(stateDir));
  assert.ok(!JSON.stringify(body).includes("alice@example.test"));
  assert.ok(!JSON.stringify(body).includes("ABCD1234EF"));
});

test("rejects unconfigured transports, malformed packages and unsupported content types", async () => {
  let response = await fetch(`${base}/__email/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transport: "carrier-pigeon", bundleCsv: BUNDLE }),
  });
  assert.equal(response.status, 400);

  response = await fetch(`${base}/__email/send`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not json",
  });
  assert.equal(response.status, 415);

  response = await fetch(`${base}/__email/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transport: "smtp", bundleCsv: "masters_list_number,email" }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /missing the required/);
});

test("same-origin companion send reaches a real SMTP socket with recipient instructions", async () => {
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
          socket.write("250 queued\r\n");
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
          socket.write("354 end data\r\n");
          break;
        }
        if (/^QUIT$/i.test(line)) {
          socket.end("221 bye\r\n");
          break;
        }
        socket.write("250 ok\r\n");
        index = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise((resolve) => smtpServer.listen(0, "127.0.0.1", resolve));
  const smtpPort = smtpServer.address().port;
  const root = mkdtempSync(join(tmpdir(), "email-companion-smtp-"));
  const distDir = join(root, "dist");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>SMTP companion</title>");
  const { server: companion } = createEmailSenderServer({
    distDir,
    stateDir: join(root, "state"),
    env: {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpPort),
      SMTP_SECURE: "false",
      SMTP_FROM: "coordinator@example.test",
    },
  });
  await new Promise((resolve) => companion.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${companion.address().port}`;
  try {
    const response = await fetch(`${origin}/__email/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ transport: "smtp", bundleCsv: BUNDLE }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sent, 1);
    assert.equal(body.results[0].detail, "sent");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /To: alice@example\.test/i);
    assert.match(messages[0], /Admission code: ABCD1-234EF/);
    assert.match(messages[0], /Request your ballot/);
  } finally {
    await new Promise((resolve) => companion.close(resolve));
    await new Promise((resolve) => smtpServer.close(resolve));
  }
});
