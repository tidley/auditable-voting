// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  PAPER_BALLOT_CODE_PATTERN,
  createPaperBallotCode,
  hashPaperBallotAdmissionKey,
  loadPaperBallotAdmission,
  normalisePaperBallotMasterlistNumber,
  normalisePaperBallotCode,
  redeemPaperBallotAdmission,
  savePaperBallotAdmission,
  validatePaperBallotAdmission,
} from "./paperBallotAdmission";

describe("paper ballot admission", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates ten-character uppercase codes and derives a canonical admission key", async () => {
    const code = createPaperBallotCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    expect(code).toMatch(PAPER_BALLOT_CODE_PATTERN);
    expect(PAPER_BALLOT_CODE_PATTERN.test("I1L0OABCDE")).toBe(false);
    expect(normalisePaperBallotCode("il0oabcde1")).toBe("1100ABCDE1");
    expect(normalisePaperBallotMasterlistNumber(" ml-001 ")).toBe("ML-001");
    expect(await hashPaperBallotAdmissionKey({
      electionId: " election-a ", masterlistNumber: " ml-001 ", code,
    })).toBe(await hashPaperBallotAdmissionKey({
      electionId: "election-a", masterlistNumber: "ML-001", code: code.toLowerCase(),
    }));
  });

  it("accepts only an unused, unexpired code for its election and master-list number", async () => {
    const registryKey = await hashPaperBallotAdmissionKey({ electionId: "election-a", masterlistNumber: "ML-001", code: "ABCD1234EF" });
    const entry = {
      electionId: "election-a",
      registryKey,
      expiresAt: "2030-01-01T00:00:00Z",
      state: "available" as const,
    };

    expect(validatePaperBallotAdmission(entry, {
      electionId: "election-a",
      registryKey,
      now: "2029-01-01T00:00:00Z",
    })).toEqual({ ok: true });
    expect(validatePaperBallotAdmission(entry, {
      electionId: "election-b",
      registryKey,
      now: "2029-01-01T00:00:00Z",
    }).ok).toBe(false);
    expect(validatePaperBallotAdmission(entry, {
      electionId: "election-a",
      registryKey: "b".repeat(64),
      now: "2029-01-01T00:00:00Z",
    }).ok).toBe(false);
    expect(validatePaperBallotAdmission(entry, {
      electionId: "election-a",
      registryKey,
      now: "2030-01-01T00:00:00Z",
    }).ok).toBe(false);
  });

  it("persists admissions only by opaque registry key", async () => {
    const registryKey = await hashPaperBallotAdmissionKey({ electionId: "election-a", masterlistNumber: "ML-001", code: "ABCD1234EF" });
    const entry = {
      electionId: "election-a",
      registryKey,
      expiresAt: "2030-01-01T00:00:00Z",
      state: "available" as const,
    };

    savePaperBallotAdmission(entry);

    expect(loadPaperBallotAdmission({ registryKey })).toMatchObject(entry);
    expect(JSON.stringify(window.localStorage)).not.toContain("ML-001");
    expect(JSON.stringify(window.localStorage)).not.toContain("ABCD1234EF");
  });

  it("binds a redemption to one request and permits only that request to replay", async () => {
    const registryKey = await hashPaperBallotAdmissionKey({ electionId: "election-a", masterlistNumber: "ML-001", code: "ABCD1234EF" });
    const entry = {
      electionId: "election-a",
      registryKey,
      expiresAt: "2030-01-01T00:00:00Z",
      state: "available" as const,
    };
    const redeemed = redeemPaperBallotAdmission(entry, {
      electionId: "election-a", registryKey, requestId: "request-1", now: "2029-01-01T00:00:00Z",
    });

    expect(redeemed).toMatchObject({ ok: true, replay: false, entry: { state: "redeemed", redeemedRequestId: "request-1" } });
    expect(redeemPaperBallotAdmission(redeemed.entry, {
      electionId: "election-a", registryKey, requestId: "request-1", now: "2029-01-01T00:00:00Z",
    })).toMatchObject({ ok: true, replay: true });
    expect(redeemPaperBallotAdmission(redeemed.entry, {
      electionId: "election-a", registryKey, requestId: "request-2", now: "2029-01-01T00:00:00Z",
    })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("fails closed for persisted plaintext master-list records", () => {
    window.localStorage.setItem("app:auditable-voting:default:optiona:paper-ballot-admissions", JSON.stringify({
      ["a".repeat(64)]: {
        electionId: "election-a",
        codeHash: "a".repeat(64),
        masterlistNumber: "ML-001",
        expiresAt: "2030-01-01T00:00:00Z",
        state: "available",
      },
    }));

    expect(loadPaperBallotAdmission({ registryKey: "a".repeat(64) })).toBeNull();
  });
});
