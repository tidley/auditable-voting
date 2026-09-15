/**
 * nomail.name / cashu.email API client (AV-DELIVERY-1b).
 *
 * PURE MODULE: no DOM, no globals, no network of its own. Every function
 * takes its dependencies explicitly (`{ fetch, jar?, baseUrl?, now? }`) so the
 * coordinator script can inject a real fetch plus a cookie jar, and the tests
 * can inject a stub. The browser bundle deliberately imports NOTHING from this
 * module — the nomail session cookie is SameSite=Strict HttpOnly, so
 * cross-origin browser auth is impossible by design (see `emailNomail.ts`).
 *
 * API shape (verified against the service reference):
 *   POST /api/auth/challenge        -> { nonce }
 *   POST /api/auth/verify  {event}  -> { pubkey } + __Host-session cookie (30d)
 *   POST /api/send/quote            -> { invoice, quoteId, expiry, amount }
 *   GET  /api/send/quote/:id/status -> { status: unpaid|paid|consumed }
 *   POST /api/send  {to,subject,text,cashuToken|paidQuoteId} -> { ok, from }
 *
 * Failures carry `X-Reason` (short cause) and `X-Hint` (one-line fix); both are
 * parsed by {@link parseError} and surfaced through {@link NomailApiError}.
 */

/** Minimal structural response shape — satisfied by the real `Response`. */
export interface NomailResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** Minimal structural request/response shape — satisfied by global `fetch`. */
export type NomailFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<NomailResponse>;

export interface CookieJar {
  store(setCookie: string | null | undefined): void;
  header(): string;
  clear(): void;
}

export interface NomailDeps {
  fetch: NomailFetch;
  /** Optional cookie jar. Without one, auth cannot persist across calls. */
  jar?: CookieJar;
  baseUrl?: string;
  now?: () => number;
}

export interface NomailErrorInfo {
  reason: string;
  hint?: string;
}

export interface SendRequest {
  to: string;
  subject: string;
  text: string;
  /** Cashu token covering the 100-sat postage. */
  cashuToken?: string;
  /** Alternative to `cashuToken`: a paid Lightning quote from {@link sendQuote}. */
  paidQuoteId?: string;
}

export const DEFAULT_BASE_URL = "https://nomail.name";

/** Error raised for any non-2xx response, carrying the service's reason/hint. */
export class NomailApiError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly hint?: string;

  constructor(status: number, info: NomailErrorInfo) {
    super(
      `nomail API error ${status}: ${info.reason}${info.hint ? ` (${info.hint})` : ""}`,
    );
    this.name = "NomailApiError";
    this.status = status;
    this.reason = info.reason;
    this.hint = info.hint;
  }
}

/**
 * A single-cookie jar for the `__Host-session` cookie.
 *
 * Node's fetch (undici) does NOT persist cookies, so the coordinator script
 * has to carry the session explicitly. Only the `name=value` pair is kept —
 * `Path`/`Secure`/`HttpOnly`/`SameSite` attributes are the service's policy and
 * are irrelevant to a non-browser client.
 */
export function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();

  return {
    store(setCookie: string | null | undefined): void {
      if (!setCookie) {
        return;
      }
      // A Set-Cookie header may carry several cookies separated by commas that
      // are followed by another `name=`. Splitting on the first ';' and taking
      // the pair before it is correct for the single-cookie case here.
      const pair = setCookie.split(";")[0];
      const equals = pair.indexOf("=");
      if (equals <= 0) {
        return;
      }
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (!name || !value) {
        return;
      }
      cookies.set(name, value);
    },
    header(): string {
      return Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    clear(): void {
      cookies.clear();
    },
  };
}

function readHeader(response: NomailResponse, name: string): string | undefined {
  const raw =
    response.headers.get(name) ??
    response.headers.get(name.toLowerCase()) ??
    response.headers.get(name.toUpperCase());
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

async function readBodyError(response: NomailResponse): Promise<string | undefined> {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error.trim().length > 0) {
        return error.trim();
      }
    }
  } catch {
    // Non-JSON (or already-consumed) body — fall back to the status code.
  }
  return undefined;
}

/**
 * Extract `X-Reason` / `X-Hint` from a failed response. Falls back to the JSON
 * `error` field and finally to `HTTP <status>` so a caller always has a reason
 * to record in the results ledger.
 */
export async function parseError(response: NomailResponse): Promise<NomailErrorInfo> {
  const hint = readHeader(response, "x-hint");
  const headerReason = readHeader(response, "x-reason");
  const reason = headerReason ?? (await readBodyError(response)) ?? `HTTP ${response.status}`;
  return { reason, hint };
}

/**
 * True when a failure means "this account has used its 100 emails for today".
 * The script uses it to stop cleanly instead of burning through the roster.
 */
export function isDailyLimitError(error: unknown): boolean {
  if (error instanceof NomailApiError) {
    if (error.status === 429) {
      return true;
    }
    return /daily limit|day limit|too many/i.test(error.reason);
  }
  return false;
}

function resolveBaseUrl(deps: NomailDeps): string {
  return (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Perform one authenticated-or-public API call, attaching the jar cookie when
 * present and absorbing any `Set-Cookie` the response carries.
 */
async function call(
  deps: NomailDeps,
  path: string,
  init: { method: string; body?: unknown },
): Promise<NomailResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  const cookie = deps.jar?.header() ?? "";
  if (cookie) {
    headers.Cookie = cookie;
  }

  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const response = await deps.fetch(`${resolveBaseUrl(deps)}${path}`, {
    method: init.method,
    headers,
    body,
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    deps.jar?.store(setCookie);
  }

  return response;
}

async function readJson(response: NomailResponse): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through to the empty object below
  }
  return {};
}

/** Convert a non-2xx response into a NomailApiError. */
async function ensureOk(response: NomailResponse): Promise<void> {
  if (!response.ok) {
    throw new NomailApiError(response.status, await parseError(response));
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** POST /api/auth/challenge — returns the nonce to sign. */
export async function challenge(deps: NomailDeps): Promise<{ nonce: string }> {
  const response = await call(deps, "/api/auth/challenge", { method: "POST" });
  await ensureOk(response);
  const nonce = asString((await readJson(response)).nonce);
  if (!nonce) {
    throw new Error("nomail auth challenge returned no nonce");
  }
  return { nonce };
}

/**
 * POST /api/auth/verify — exchanges a signed kind-1 (or 27235) Nostr event for
 * a session cookie, which is stored in `deps.jar`.
 */
export async function verify(
  deps: NomailDeps,
  signedEvent: unknown,
): Promise<{ pubkey: string }> {
  const response = await call(deps, "/api/auth/verify", {
    method: "POST",
    body: { event: signedEvent },
  });
  await ensureOk(response);
  const pubkey = asString((await readJson(response)).pubkey);
  if (!pubkey) {
    throw new Error("nomail auth verify returned no pubkey");
  }
  return { pubkey };
}

/** POST /api/send/quote — creates the Lightning invoice for one email. */
export async function sendQuote(deps: NomailDeps): Promise<{
  invoice: string;
  quoteId: string;
  expiry: number;
  amount: number;
}> {
  const response = await call(deps, "/api/send/quote", { method: "POST", body: {} });
  await ensureOk(response);
  const body = await readJson(response);
  const invoice = asString(body.invoice);
  const quoteId = asString(body.quoteId);
  if (!invoice || !quoteId) {
    throw new Error("nomail send quote response was incomplete (need invoice and quoteId)");
  }
  return {
    invoice,
    quoteId,
    expiry: asNumber(body.expiry),
    amount: asNumber(body.amount),
  };
}

/** GET /api/send/quote/:id/status — unpaid | paid | consumed. */
export async function quoteStatus(
  deps: NomailDeps,
  quoteId: string,
): Promise<{ status: string }> {
  const response = await call(
    deps,
    `/api/send/quote/${encodeURIComponent(quoteId)}/status`,
    { method: "GET" },
  );
  await ensureOk(response);
  const status = asString((await readJson(response)).status);
  if (!status) {
    throw new Error("nomail quote status response was incomplete");
  }
  return { status };
}

/**
 * POST /api/send — sends one email for 100 sats of postage.
 *
 * Exactly one payment method must be supplied (`cashuToken` or `paidQuoteId`);
 * the check happens before any network call so a mis-wired batch cannot spend
 * postage or half-send.
 */
export async function send(
  deps: NomailDeps,
  request: SendRequest,
): Promise<{ ok: true; from?: string }> {
  const to = request.to?.trim() ?? "";
  const subject = request.subject ?? "";
  const text = request.text ?? "";
  const cashuToken = request.cashuToken?.trim() ?? "";
  const paidQuoteId = request.paidQuoteId?.trim() ?? "";

  if (!to) {
    throw new Error("nomail send: `to` is required");
  }
  if (!subject.trim()) {
    throw new Error("nomail send: `subject` is required");
  }
  if (!text.trim()) {
    throw new Error("nomail send: `text` is required");
  }
  if (!cashuToken && !paidQuoteId) {
    throw new Error(
      "nomail send: a payment method is required (cashuToken or paidQuoteId)",
    );
  }
  if (cashuToken && paidQuoteId) {
    throw new Error(
      "nomail send: exactly one payment method is allowed (cashuToken or paidQuoteId)",
    );
  }

  const body: Record<string, string> = { to, subject, text };
  if (cashuToken) {
    body.cashuToken = cashuToken;
  } else {
    body.paidQuoteId = paidQuoteId;
  }

  const response = await call(deps, "/api/send", { method: "POST", body });
  await ensureOk(response);
  const from = asString((await readJson(response)).from);
  return from ? { ok: true, from } : { ok: true };
}
