// Self-contained live cashu.email smoke — ZERO secrets.
//
// Generates a fresh ephemeral Nostr key at run time, mints fresh testnut
// ecash (via the Nutshell CLI, which produces the JSON V4 cashuB token that
// cashu.email accepts), and self-sends to the derived npub@cashu.email.
//
// cashu.email treats the npub as the address with no pre-registration, so a
// brand-new key works immediately (verified empirically). This removes the
// need for NOMAIN_NSEC / TESTNUT_MINT_CASHU_TOKEN / TEST_RECIPIENT secrets.
//
// Run (from repo root, after `pip install cashu` and `npm ci` in web/):
//   node scripts/test/live-otp-send-email.selfcontained.mjs
//
// Exactly ONE email is sent. No retry loop. 200 {ok:true} or it fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MINT = "https://testnut.cashu.space";
const POSTAGE_SATS = 100;

function freshNsecHex() {
  return randomBytes(32).toString("hex");
}

// Mint a fresh V4 cashuB token via the Nutshell CLI (JSON V4 — the format
// cashu.email accepts; cashu-ts binary V4 is rejected with 402).
function mintTokenHex() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-smoke-"));
  const wallet = join(dir, "wallet");
  execFileSync("cashu", ["-h", MINT, "-w", wallet, "invoice", String(POSTAGE_SATS)], { stdio: "pipe" });
  const out = execFileSync("cashu", ["-h", MINT, "-w", wallet, "send", String(POSTAGE_SATS)], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  // Nutshell prints the token on stdout followed by "Balance: N sat". The
  // token is the first whitespace-delimited token that starts with cashuB.
  const token = (out.match(/cashuB\S+/) || [""])[0];
  if (!token.startsWith("cashuB")) throw new Error(`mint did not produce a V4 cashuB token: ${out.slice(0, 60)}`);
  return token;
}

async function authAndSend(nsecHex, token) {
  const require = createRequire(new URL("../../web/package.json", import.meta.url).href);
  const { finalizeEvent, getPublicKey, nip19 } = require("nostr-tools");
  const skBytes = new Uint8Array(nsecHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const pubkeyHex = getPublicKey(skBytes);
  const npub = nip19.npubEncode(pubkeyHex);
  const ourAddress = `${npub}@cashu.email`;

  async function post(p, body, cookie) {
    const headers = { "content-type": "application/json", "user-agent": "curl/8" };
    if (cookie) headers.cookie = cookie;
    const res = await fetch("https://cashu.email" + p, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    return { res, data: text ? JSON.parse(text) : {}, cookie: res.headers.get("set-cookie") || "" };
  }

  const c = await post("/api/auth/challenge", {});
  const signed = finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [["challenge", c.data.nonce]], content: c.data.nonce,
  }, skBytes);
  const v = await post("/api/auth/verify", { event: signed });
  const cookie = v.cookie.split(";")[0];
  const send = await post("/api/send", {
    to: ourAddress, subject: "testnut live smoke (self-contained)",
    text: "self-contained smoke probe", cashuToken: token,
  }, cookie);
  return { send, ourAddress };
}

test("live send: fresh key + fresh testnut mint + self-send (exactly 1 email)", async () => {
  const nsecHex = freshNsecHex();
  const token = mintTokenHex();
  const { send, ourAddress } = await authAndSend(nsecHex, token);
  assert.equal(send.res.status, 200, `send HTTP ${send.res.status}: ${JSON.stringify(send.data)}`);
  assert.equal(send.data.ok, true, `expected ok:true, got ${JSON.stringify(send.data)}`);
  console.log("LIVE SEND OK:", JSON.stringify(send.data), "to", ourAddress);
});
