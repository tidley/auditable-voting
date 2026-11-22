import { describe, expect, it } from "vitest";
import { deriveIssuerReadiness, isLoopbackVoterUrl, ISSUER_HEARTBEAT_STALE_MS } from "./issuerStatus";

const now = Date.parse("2026-11-22T01:00:00Z");

describe("issuer readiness", () => {
  it("warns for Browser only and blocks a stale summary Guardian", () => {
    expect(deriveIssuerReadiness({ mode: "browser_only" }, now).level).toBe("amber");
    expect(deriveIssuerReadiness({ mode: "browser_only", summaryIssuerNpub: "npub1worker" }, now)).toMatchObject({
      level: "red",
      title: "Active Guardian still routes voters",
    });
  });

  it("blocks Guardian mode without an active delegation or with a mismatch", () => {
    expect(deriveIssuerReadiness({ mode: "delegated_worker" }, now).level).toBe("red");
    expect(deriveIssuerReadiness({
      mode: "delegated_worker",
      workerNpub: "npub1a",
      delegationId: "delegation_1",
      summaryIssuerNpub: "npub1b",
      heartbeatAt: new Date(now - 1000).toISOString(),
    }, now).title).toBe("Guardian routing mismatch");
  });

  it("requires a fresh heartbeat", () => {
    expect(deriveIssuerReadiness({
      mode: "delegated_worker",
      workerNpub: "npub1a",
      delegationId: "delegation_1",
      summaryIssuerNpub: "npub1a",
    }, now).title).toBe("Guardian has no heartbeat");
    expect(deriveIssuerReadiness({
      mode: "delegated_worker",
      workerNpub: "npub1a",
      delegationId: "delegation_1",
      summaryIssuerNpub: "npub1a",
      heartbeatAt: new Date(now - ISSUER_HEARTBEAT_STALE_MS - 1).toISOString(),
    }, now).title).toBe("Guardian heartbeat is stale");
    expect(deriveIssuerReadiness({
      mode: "delegated_worker",
      workerNpub: "npub1a",
      delegationId: "delegation_1",
      summaryIssuerNpub: "npub1a",
      heartbeatAt: new Date(now - ISSUER_HEARTBEAT_STALE_MS + 1000).toISOString(),
    }, now).level).toBe("green");
  });

  it("detects loopback voter links", () => {
    expect(isLoopbackVoterUrl("http://127.0.0.1:5174/?role=voter")).toBe(true);
    expect(isLoopbackVoterUrl("http://localhost:5174/?role=voter")).toBe(true);
    expect(isLoopbackVoterUrl("https://tidley.github.io/auditable-voting/?role=voter")).toBe(false);
    expect(isLoopbackVoterUrl("not a url")).toBe(false);
  });
});
