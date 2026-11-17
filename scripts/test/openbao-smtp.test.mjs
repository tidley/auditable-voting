// Offline tests for the optional OpenBao SMTP credential loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenBaoSmtpEnvProvider,
  openBaoConfigured,
  smtpEnvFromOpenBaoData,
} from "../openbao-smtp.mjs";

function tokenFile(mode = 0o600) {
  const root = mkdtempSync(join(tmpdir(), "openbao-token-"));
  const path = join(root, "token");
  writeFileSync(path, "test-token\n", { mode });
  chmodSync(path, mode);
  return path;
}

test("maps OpenBao KV fields to SMTP environment", () => {
  const env = smtpEnvFromOpenBaoData({
    host: "smtp.example.org",
    port: "465",
    secure: "true",
    username: "coordinator@example.org",
    password: "secret",
    from: "coordinator@example.org",
  }, { KEEP: "yes" });
  assert.deepEqual(env, {
    KEEP: "yes",
    SMTP_HOST: "smtp.example.org",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "coordinator@example.org",
    SMTP_PASS: "secret",
    SMTP_FROM: "coordinator@example.org",
  });
  assert.throws(() => smtpEnvFromOpenBaoData({ user: "a" }), /host and from/);
  assert.throws(() => smtpEnvFromOpenBaoData({ host: "h", from: "f", user: "u" }), /both user and password/);
});

test("returns the environment unchanged when OpenBao is not configured", async () => {
  const env = { SMTP_HOST: "env.example" };
  const provider = createOpenBaoSmtpEnvProvider({ env, fetchImpl: async () => { throw new Error("should not fetch"); } });
  assert.equal(openBaoConfigured(env), false);
  assert.equal(await provider(), env);
});

test("reads a KV v2 secret and caches it", async () => {
  let calls = 0;
  let now = 1_000;
  const env = {
    OPENBAO_ADDR: "https://bao.example/",
    OPENBAO_TOKEN_FILE: tokenFile(),
    OPENBAO_SECRET_PATH: "secret/data/email/strato",
  };
  const provider = createOpenBaoSmtpEnvProvider({
    env,
    now: () => now,
    cacheSeconds: 60,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://bao.example/v1/secret/data/email/strato");
      assert.equal(init.headers["X-Vault-Token"], "test-token");
      return {
        ok: true,
        json: async () => ({
          data: {
            data: {
              host: "smtp.example",
              username: "user@example",
              password: "pass",
              from: "user@example",
            },
          },
        }),
      };
    },
  });
  const first = await provider();
  assert.equal(first.SMTP_HOST, "smtp.example");
  assert.equal(first.SMTP_USER, "user@example");
  assert.equal(first.SMTP_PASS, "pass");
  now += 30_000;
  await provider();
  assert.equal(calls, 1);
  now += 40_000;
  await provider();
  assert.equal(calls, 2);
});

test("fails closed on a missing or insecure token file", async () => {
  const missing = createOpenBaoSmtpEnvProvider({
    env: { OPENBAO_ADDR: "https://bao.example" },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(missing(), /OPENBAO_TOKEN/);

  const insecure = createOpenBaoSmtpEnvProvider({
    env: { OPENBAO_ADDR: "https://bao.example", OPENBAO_TOKEN_FILE: tokenFile(0o644) },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(insecure(), /group\/world readable/);
});

test("fails closed on an OpenBao HTTP error or malformed body", async () => {
  const env = { OPENBAO_ADDR: "https://bao.example", OPENBAO_TOKEN_FILE: tokenFile() };
  const httpError = createOpenBaoSmtpEnvProvider({
    env,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(httpError(), /HTTP 403/);

  const malformed = createOpenBaoSmtpEnvProvider({
    env,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
  });
  await assert.rejects(malformed(), /malformed JSON/);
});
