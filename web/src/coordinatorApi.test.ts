import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  USE_MOCK: false,
  MINT_URL: "http://mint.example",
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn() as typeof fetch;
});

describe("issuance coordinator API", () => {
  it("starts issuance tracking and returns request id", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
      request_id: "req-123",
      status_url: "http://coordinator/issuance/req-123"
    }), { status: 200 }));

    const { startIssuanceTracking } = await import("./coordinatorApi");
    const response = await startIssuanceTracking({
      npub: "npub1abc",
      quoteId: "quote-1",
      electionId: "e-1",
      httpApi: "http://coordinator"
    });

    expect(response.request_id).toBe("req-123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://coordinator/issuance/start",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("awaits issuance completion using status endpoint", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
      status: "issued",
      issued: true,
      quote_state: "PAID"
    }), { status: 200 }));

    const { awaitIssuanceStatus } = await import("./coordinatorApi");
    const response = await awaitIssuanceStatus({
      requestId: "req-123",
      httpApi: "http://coordinator",
      timeoutMs: 1000,
    });

    expect(response.issued).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://coordinator/issuance/req-123?timeout_ms=1000",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("throws for non-ok responses", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({ error: "not eligible" }), { status: 403 }));
    const { startIssuanceTracking } = await import("./coordinatorApi");

    await expect(startIssuanceTracking({
      npub: "npub1abc",
      quoteId: "quote-1",
      electionId: "e-1",
      httpApi: "http://coordinator"
    })).rejects.toThrow("not eligible");
  });

  it("uses default timeout when awaiting issuance", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
      status: "timeout",
      issued: false,
      quote_state: "UNPAID"
    }), { status: 200 }));

    const { awaitIssuanceStatus } = await import("./coordinatorApi");
    const response = await awaitIssuanceStatus({ requestId: "req-xyz", httpApi: "http://coordinator" });

    expect(response.status).toBe("timeout");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://coordinator/issuance/req-xyz?timeout_ms=30000",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("propagates backend errors from await endpoint", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unknown issuance request" }), { status: 404 }));

    const { awaitIssuanceStatus } = await import("./coordinatorApi");
    await expect(awaitIssuanceStatus({ requestId: "missing", httpApi: "http://coordinator", timeoutMs: 5 }))
      .rejects.toThrow("Unknown issuance request");
  });
});
