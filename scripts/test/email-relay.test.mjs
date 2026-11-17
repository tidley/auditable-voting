// Offline tests for the authenticated email relay.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmailRelayServer, normaliseCoordinator, parseCoordinatorList } from "../email-relay.mjs";

// The relay uses nostr-tools from the web package; the test signs with it too.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const requireFromWeb = createRequire(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/package.json"));
const { finalizeEvent, generateSecretKey, getPublicKey } = requireFromWeb("nostr-tools/pure");

const ELECTION_ID = "q_relay_test";
const VOTE_URL = `https://example.test/vote/?role=voter&q=${ELECTION_ID}&coordinator=npub1test`;
const BUNDLE = [
  "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url",
  `101,alice@example.test,,Alice Archer,ABCD1234EF,2099-01-01T00:00:00.000Z,Community Vote,${VOTE_URL}`,
].join("\n");

const coordinatorSecret = generateSecretKey();
const coordinatorHex = getPublicKey(coordinatorSecret);
const outsiderSecret = generateSecretKey();

let server;
let base;
let stateDir;
let lastDeliveryOptions;
const deliveryResults = {
  sentCount: 1,
  skipCount: 0,
  failCount: 0,
  notAttemptedCount: 0,
  satsSpent: 0,
  capUsedToday: 0,
  capRemaining: 0,
  results: [{ master: "101", ok: true, detail: "sent", ref: "relay-1" }],
};

function bodyFor(electionId = ELECTION_ID, bundleCsv = BUNDLE) {
  return JSON.stringify({ electionId, bundleCsv });
}

function signedRequest(body, options = {}) {
  const url = options.url ?? `${base}/send`;
  const secret = options.secret ?? coordinatorSecret;
  const event = finalizeEvent({
    kind: 27235,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")],
      ["nonce", String(Math.random())],
    ],
    content: "",
  }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function send(body, options = {}) {
  return fetch(`${base}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: options.authorization ?? signedRequest(body, options),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body,
  });
}

async function startRelay(options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "email-relay-"));
  const created = createEmailRelayServer({
    stateDir: options.stateDir ?? join(root, "state"),
    env: { SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_FROM: "coordinator@example.test" },
    allowedCoordinators: options.allowedCoordinators ?? new Set([coordinatorHex]),
    allowedElections: options.allowedElections,
    allowedOrigins: options.allowedOrigins ?? ["https://tidley.github.io", "http://127.0.0.1:5174"],
    maxBatchesPerHour: options.maxBatchesPerHour,
    maxRecipientsPerDay: options.maxRecipientsPerDay,
    maxRecipients: options.maxRecipients,
    runDelivery: options.runDelivery ?? (async (deliveryOptions) => {
      lastDeliveryOptions = deliveryOptions;
      return deliveryResults;
    }),
  });
  await new Promise((resolvePromise) => created.server.listen(0, "127.0.0.1", resolvePromise));
  return {
    server: created.server,
    base: `http://127.0.0.1:${created.server.address().port}`,
    stateDir: created.stateDir,
  };
}

before(async () => {
  const started = await startRelay();
  server = started.server;
  base = started.base;
  stateDir = started.stateDir;
});

after(async () => {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
});

test("health is unauthenticated and exposes no credentials", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "auditable-voting-email-relay");
  assert.deepEqual(body.transports, ["smtp"]);
  assert.equal(body.maxRecipients, 1000);
  assert.equal(body.auth, "nip98");
  const text = JSON.stringify(body);
  assert.ok(!text.includes("smtp.example.test"));
  assert.ok(!text.includes("coordinator@example.test"));
});

test("cors preflight and allowed origins", async () => {
  const response = await fetch(`${base}/send`, {
    method: "OPTIONS",
    headers: { origin: "https://tidley.github.io" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://tidley.github.io");
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/);

  const denied = await fetch(`${base}/send`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(denied.status, 403);
});

test("rejects missing and invalid NIP-98 authorization", async () => {
  let response = await fetch(`${base}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyFor(),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "unauthorized");

  response = await send(bodyFor(), { authorization: "Nostr not-base64" });
  assert.equal(response.status, 401);

  const body = bodyFor();
  const wrongPayloadEvent = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", `${base}/send`],
      ["method", "POST"],
      ["payload", "0".repeat(64)],
    ],
    content: "",
  }, coordinatorSecret);
  response = await send(body, {
    authorization: `Nostr ${Buffer.from(JSON.stringify(wrongPayloadEvent)).toString("base64")}`,
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /payload hash/);
});

test("rejects an expired signed timestamp", async () => {
  const response = await send(bodyFor(), { createdAt: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "request_expired");
});

test("rejects a coordinator outside the allowlist", async () => {
  const response = await send(bodyFor(), { secret: outsiderSecret });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "coordinator_not_allowed");
});

test("rejects a replayed signed event", async () => {
  const body = bodyFor();
  const authorization = signedRequest(body);
  let response = await send(body, { authorization });
  assert.equal(response.status, 200);
  response = await send(body, { authorization });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "replayed_request");
});

test("rejects a bundle whose vote_url is for another election", async () => {
  const body = bodyFor("q_other", BUNDLE);
  const response = await send(body);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "election_mismatch");
});

test("sends a valid bundle and keeps the response redacted", async () => {
  const body = bodyFor();
  const response = await send(body, { origin: "https://tidley.github.io" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://tidley.github.io");
  const result = await response.json();
  assert.equal(result.sent, 1);
  assert.equal(result.results[0].master, "101");
  assert.ok(!JSON.stringify(result).includes("alice@example.test"));
  assert.ok(!JSON.stringify(result).includes("ABCD1234EF"));
  assert.ok(lastDeliveryOptions.ledger.includes(join("elections", ELECTION_ID, "send-ledger.json")));
  assert.ok(lastDeliveryOptions.results.includes(join("elections", ELECTION_ID, "results-")));
});

test("maps ledger conflicts to 409", async () => {
  const started = await startRelay({
    runDelivery: async () => {
      throw Object.assign(new Error("The ledger belongs to different admission details for master-list number 101."), {
        httpStatus: 409,
        code: "ledger_conflict",
      });
    },
  });
  try {
    const body = bodyFor();
    const response = await fetch(`${started.base}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signedRequest(body, { url: `${started.base}/send` }),
      },
      body,
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ledger_conflict");
  } finally {
    await new Promise((resolvePromise) => started.server.close(resolvePromise));
  }
});

test("enforces the per-coordinator batch limit", async () => {
  const started = await startRelay({ maxBatchesPerHour: 1, maxRecipientsPerDay: 10 });
  try {
    let body = bodyFor();
    let response = await fetch(`${started.base}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signedRequest(body, { url: `${started.base}/send` }),
      },
      body,
    });
    assert.equal(response.status, 200);

    body = bodyFor();
    response = await fetch(`${started.base}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signedRequest(body, { url: `${started.base}/send` }),
      },
      body,
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "rate_limited");
  } finally {
    await new Promise((resolvePromise) => started.server.close(resolvePromise));
  }
});

test("enforces an optional election allowlist", async () => {
  const started = await startRelay({ allowedElections: new Set(["q_enabled"]) });
  try {
    const body = bodyFor();
    const response = await fetch(`${started.base}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signedRequest(body, { url: `${started.base}/send` }),
      },
      body,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "election_not_allowed");
  } finally {
    await new Promise((resolvePromise) => started.server.close(resolvePromise));
  }
});

test("parses npub and hex coordinator allowlists", () => {
  const { nip19 } = requireFromWeb("nostr-tools");
  const npub = nip19.npubEncode(coordinatorHex);
  assert.equal(normaliseCoordinator(npub), coordinatorHex);
  assert.equal(normaliseCoordinator(coordinatorHex.toUpperCase()), coordinatorHex);
  assert.throws(() => normaliseCoordinator("not-a-key"));
  assert.deepEqual([...parseCoordinatorList(`${npub},${coordinatorHex}`)], [coordinatorHex]);
});
