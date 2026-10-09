import { describe, expect, it } from "vitest";
import {
  NomailApiError,
  challenge,
  createCookieJar,
  isDailyLimitError,
  parseError,
  quoteStatus,
  send,
  sendQuote,
  verify,
  type NomailFetch,
  type NomailResponse,
} from "./nomailClient";

/**
 * Build a structural stand-in for a fetch Response. Header lookup is
 * case-insensitive, like the real Headers object, so a test that passes
 * `X-Reason` must be readable via `get("x-reason")`.
 */
function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): NomailResponse {
  const lower = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch stub that records every call and replies via the handler. */
function stubFetch(handler: (url: string, init: RecordedCall) => NomailResponse): {
  fetch: NomailFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: NomailFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(call);
    return handler(url, call);
  };
  return { fetch, calls };
}

describe("createCookieJar", () => {
  it("stores the name=value pair and ignores cookie attributes", () => {
    const jar = createCookieJar();
    jar.store("__Host-session=abc123; Path=/; Secure; HttpOnly; SameSite=Strict");
    expect(jar.header()).toBe("__Host-session=abc123");
  });

  it("replaces an existing cookie with the same name", () => {
    const jar = createCookieJar();
    jar.store("__Host-session=first; Path=/");
    jar.store("__Host-session=second; Path=/");
    expect(jar.header()).toBe("__Host-session=second");
  });

  it("returns an empty header when nothing was stored", () => {
    expect(createCookieJar().header()).toBe("");
  });

  it("ignores empty and malformed set-cookie values", () => {
    const jar = createCookieJar();
    jar.store(null);
    jar.store("no-equals-sign");
    expect(jar.header()).toBe("");
  });
});

describe("parseError", () => {
  it("reads both X-Reason and X-Hint", async () => {
    const result = await parseError(
      response(402, { error: "Payment required" }, {
        "X-Reason": "Invalid token",
        "X-Hint": "Top up the wallet and retry",
      }),
    );
    expect(result).toEqual({
      reason: "Invalid token",
      hint: "Top up the wallet and retry",
    });
  });

  it("falls back to the JSON error field when X-Reason is absent", async () => {
    const result = await parseError(response(400, { error: "Missing fields" }));
    expect(result).toEqual({ reason: "Missing fields", hint: undefined });
  });

  it("falls back to the HTTP status when no reason is available", async () => {
    const result = await parseError(response(500, {}));
    expect(result.reason).toBe("HTTP 500");
    expect(result.hint).toBeUndefined();
  });

  it("survives a response with a non-JSON body", async () => {
    const broken: NomailResponse = {
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    };
    const result = await parseError(broken);
    expect(result.reason).toBe("HTTP 502");
  });
});

describe("challenge", () => {
  it("POSTs to /api/auth/challenge and returns the nonce", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { nonce: "deadbeef" }));
    const result = await challenge({ fetch });

    expect(result).toEqual({ nonce: "deadbeef" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://nomail.name/api/auth/challenge");
    expect(calls[0].method).toBe("POST");
  });

  it("throws a NomailApiError carrying reason and hint on failure", async () => {
    const { fetch } = stubFetch(() =>
      response(503, {}, { "X-Reason": "Upstream down", "X-Hint": "Retry in a minute" }),
    );

    const error = await challenge({ fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NomailApiError);
    expect((error as NomailApiError).status).toBe(503);
    expect((error as NomailApiError).reason).toBe("Upstream down");
    expect((error as NomailApiError).hint).toBe("Retry in a minute");
  });

  it("rejects when the response has no nonce", async () => {
    const { fetch } = stubFetch(() => response(200, {}));
    await expect(challenge({ fetch })).rejects.toThrow(/nonce/i);
  });
});

describe("verify", () => {
  const signedEvent = {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    kind: 1,
    content: "nonce-value",
    tags: [["challenge", "nonce-value"]],
    created_at: 1_700_000_000,
    sig: "c".repeat(128),
  };

  it("POSTs the signed event and captures the session cookie", async () => {
    const { fetch, calls } = stubFetch(() =>
      response(200, { pubkey: signedEvent.pubkey }, {
        "set-cookie": "__Host-session=token123; Path=/; Secure; HttpOnly; SameSite=Strict",
      }),
    );
    const jar = createCookieJar();

    const result = await verify({ fetch, jar }, signedEvent);

    expect(result).toEqual({ pubkey: signedEvent.pubkey });
    expect(calls[0].url).toBe("https://nomail.name/api/auth/verify");
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ event: signedEvent });
    expect(jar.header()).toBe("__Host-session=token123");
  });

  it("sends the stored cookie on later authenticated requests", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.endsWith("/api/auth/challenge")) {
        return response(200, { nonce: "n" });
      }
      if (url.endsWith("/api/auth/verify")) {
        return response(200, { pubkey: signedEvent.pubkey }, {
          "set-cookie": "__Host-session=session-1; Path=/; Secure; HttpOnly; SameSite=Strict",
        });
      }
      return response(200, { invoice: "lnbc1", quoteId: "q1", expiry: 3600, amount: 100 });
    });
    const jar = createCookieJar();

    await challenge({ fetch, jar });
    await verify({ fetch, jar }, signedEvent);
    await sendQuote({ fetch, jar });

    expect(calls[0].headers.Cookie).toBeUndefined();
    expect(calls[1].headers.Cookie).toBeUndefined();
    expect(calls[2].headers.Cookie).toBe("__Host-session=session-1");
  });

  it("throws with reason and hint when verification is rejected", async () => {
    const { fetch } = stubFetch(() =>
      response(401, { error: "Invalid event signature" }, {
        "X-Reason": "Invalid or expired challenge",
        "X-Hint": "Request a fresh challenge and sign it again",
      }),
    );

    await expect(verify({ fetch, jar: createCookieJar() }, signedEvent)).rejects.toThrow(
      /Invalid or expired challenge/,
    );
  });
});

describe("sendQuote", () => {
  it("returns the invoice, quote id, expiry and amount", async () => {
    const { fetch, calls } = stubFetch(() =>
      response(200, { invoice: "lnbc100n1...", quoteId: "quote-1", expiry: 3600, amount: 100 }),
    );

    const quote = await sendQuote({ fetch });

    expect(quote).toEqual({
      invoice: "lnbc100n1...",
      quoteId: "quote-1",
      expiry: 3600,
      amount: 100,
    });
    expect(calls[0].url).toBe("https://nomail.name/api/send/quote");
  });

  it("rejects when the quote response is incomplete", async () => {
    const { fetch } = stubFetch(() => response(200, { invoice: "lnbc1" }));
    await expect(sendQuote({ fetch })).rejects.toThrow(/quote/i);
  });
});

describe("quoteStatus", () => {
  it("GETs the quote status endpoint", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { status: "paid" }));
    expect(await quoteStatus({ fetch }, "quote-1")).toEqual({ status: "paid" });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://nomail.name/api/send/quote/quote-1/status");
  });
});

describe("send", () => {
  const base = { to: "resident@example.com", subject: "Your admission code", text: "code 123456" };

  it("sends with a Cashu token and returns the sender address", async () => {
    const { fetch, calls } = stubFetch(() =>
      response(200, { ok: true, from: "npub1abc@nomail.name" }),
    );

    const result = await send({ fetch }, { ...base, cashuToken: "cashuBtoken" });

    expect(result).toEqual({ ok: true, from: "npub1abc@nomail.name" });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ ...base, cashuToken: "cashuBtoken" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://nomail.name/api/send");
  });

  it("sends with a paid quote id", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { ok: true }));
    await send({ fetch }, { ...base, paidQuoteId: "quote-1" });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ ...base, paidQuoteId: "quote-1" });
  });

  it("refuses to send without a payment method, without touching the network", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { ok: true }));
    await expect(send({ fetch }, base)).rejects.toThrow(/payment/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses to send with two payment methods", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { ok: true }));
    await expect(
      send({ fetch }, { ...base, cashuToken: "cashuBtoken", paidQuoteId: "quote-1" }),
    ).rejects.toThrow(/payment/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses to send when a required field is missing", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { ok: true }));
    await expect(send({ fetch }, { ...base, to: "" , cashuToken: "t"})).rejects.toThrow(/to/i);
    expect(calls).toHaveLength(0);
  });

  it("throws a 402 NomailApiError carrying the service reason and hint", async () => {
    const { fetch } = stubFetch(() =>
      response(402, { error: "Invalid token" }, {
        "X-Reason": "Swap failed",
        "X-Hint": "Spend the token at the mint first",
      }),
    );

    const error = await send({ fetch }, { ...base, cashuToken: "cashuBtoken" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NomailApiError);
    expect((error as NomailApiError).status).toBe(402);
    expect((error as NomailApiError).reason).toBe("Swap failed");
    expect((error as NomailApiError).hint).toBe("Spend the token at the mint first");
    expect(isDailyLimitError(error)).toBe(false);
  });

  it("flags a 429 daily-limit rejection", async () => {
    const { fetch } = stubFetch(() =>
      response(429, { error: "Daily limit reached" }, {
        "X-Reason": "Daily limit reached",
        "X-Hint": "Resume tomorrow, the counter resets daily",
      }),
    );

    const error = await send({ fetch }, { ...base, cashuToken: "cashuBtoken" }).catch(
      (e: unknown) => e,
    );
    expect(isDailyLimitError(error)).toBe(true);
  });

  it("propagates network failures from the injected fetch", async () => {
    const failing: NomailFetch = async () => {
      throw new Error("Network access is disabled in tests.");
    };
    await expect(send({ fetch: failing }, { ...base, cashuToken: "t" })).rejects.toThrow(
      /Network access is disabled/,
    );
  });

  it("accepts a custom base URL", async () => {
    const { fetch, calls } = stubFetch(() => response(200, { nonce: "n" }));
    await challenge({ fetch, baseUrl: "https://staging.nomail.name" });
    expect(calls[0].url).toBe("https://staging.nomail.name/api/auth/challenge");
  });
});
