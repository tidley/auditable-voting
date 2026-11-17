#!/usr/bin/env node
/**
 * Optional OpenBao KV v2 SMTP credential loader for the email relay.
 *
 * The relay calls this before a batch. When OpenBao is configured it fails
 * closed: a missing token or an unreadable secret stops the send rather than
 * falling back to a stale environment value.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

const DEFAULT_SECRET_PATH = "secret/data/email/strato";
const DEFAULT_CACHE_SECONDS = 60;

export function openBaoConfigured(env = process.env) {
  return Boolean((env.OPENBAO_ADDR ?? "").trim());
}

function readToken(env) {
  const direct = (env.OPENBAO_TOKEN ?? "").trim();
  if (direct) return direct;
  const file = (env.OPENBAO_TOKEN_FILE ?? "").trim();
  if (!file) throw new Error("OPENBAO_TOKEN or OPENBAO_TOKEN_FILE is required when OPENBAO_ADDR is set.");
  if (!existsSync(file)) throw new Error(`OpenBao token file not found: ${file}`);
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`OpenBao token file must not be group/world readable (mode ${mode.toString(8)}).`);
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error("OpenBao token file is empty.");
  return token;
}

export function smtpEnvFromOpenBaoData(data, baseEnv = {}) {
  if (!data || typeof data !== "object") throw new Error("OpenBao returned no secret data.");
  const pick = (...names) => {
    for (const name of names) {
      const value = data[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const host = pick("host", "hostname");
  const user = pick("user", "username");
  const pass = pick("password", "pass");
  const from = pick("from", "sender");
  const port = pick("port");
  const secure = pick("secure");
  if (!host || !from) throw new Error("OpenBao SMTP secret must include host and from.");
  if (Boolean(user) !== Boolean(pass)) throw new Error("OpenBao SMTP secret must include both user and password, or neither.");
  return {
    ...baseEnv,
    SMTP_HOST: host,
    ...(port ? { SMTP_PORT: port } : {}),
    ...(secure ? { SMTP_SECURE: secure } : {}),
    ...(user ? { SMTP_USER: user } : {}),
    ...(pass ? { SMTP_PASS: pass } : {}),
    SMTP_FROM: from,
  };
}

export function createOpenBaoSmtpEnvProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const cacheMs = Math.max(0, Number(options.cacheSeconds ?? env.OPENBAO_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS) * 1000);
  let cached = null;
  let expiresAt = 0;

  return async function loadSmtpEnv() {
    if (!openBaoConfigured(env)) return env;
    if (cached && now() < expiresAt) return cached;
    const address = String(env.OPENBAO_ADDR).trim().replace(/\/+$/, "");
    const secretPath = String(env.OPENBAO_SECRET_PATH ?? DEFAULT_SECRET_PATH).replace(/^\/+/, "");
    const token = readToken(env);
    let response;
    try {
      response = await fetchImpl(`${address}/v1/${secretPath}`, {
        headers: {
          "X-Vault-Token": token,
          accept: "application/json",
        },
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(`OpenBao could not be reached: ${error instanceof Error ? error.message : "network error"}`);
    }
    if (!response.ok) throw new Error(`OpenBao secret read failed (HTTP ${response.status}).`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("OpenBao returned malformed JSON.");
    }
    const data = payload?.data?.data ?? payload?.data;
    cached = smtpEnvFromOpenBaoData(data, env);
    expiresAt = now() + cacheMs;
    return cached;
  };
}
