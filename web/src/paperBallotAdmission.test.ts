// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAPER_BALLOT_CODE_PATTERN,
  createPaperBallotCode,
  createPaperBallotAdmissionSheet,
  hashPaperBallotAdmissionKey,
  sanitisePaperBallotAdmissions,
  loadPaperBallotAdmission,
  normalisePaperBallotMasterlistNumber,
  normalisePaperBallotCode,
  paperBallotExpiryToIsoUtc,
  redeemPaperBallotAdmission,
  savePaperBallotAdmission,
  validatePaperBallotAdmission,
} from "./paperBallotAdmission";
import { buildNamespacedLocalStorageKey } from "./appStorageNamespace";

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

  it('accepts the printed 5–5 grouping without changing admission keys', async () => {
    expect(normalisePaperBallotCode(' 7k3m9-t2x4r ')).toBe('7K3M9T2X4R');
    const input = { electionId: 'election-a', masterlistNumber: '1234', code: '7K3M9T2X4R' };
    expect(await hashPaperBallotAdmissionKey({ ...input, code: '7K3M9-T2X4R' })).toBe(await hashPaperBallotAdmissionKey(input));
  });

  it("creates one printable code and opaque registry entry for each master-list record", async () => {
    const sheet = await createPaperBallotAdmissionSheet({
      electionId: "election-a",
      masterlistNumbers: [" ML-001 ", "ML-002", "ML-001"],
      expiresAt: "2030-01-01T00:00:00Z",
      randomValues: (() => {
        let value = 0;
        return () => new Uint8Array(Array.from({ length: 10 }, () => value++));
      })(),
    });

    expect(sheet).toHaveLength(2);
    expect(sheet.map((entry) => entry.masterlistNumber)).toEqual(["ML-001", "ML-002"]);
    expect(sheet.map((entry) => entry.code)).toEqual(["0123456789", "ABCDEFGHJK"]);
    expect(sheet.every((entry) => PAPER_BALLOT_CODE_PATTERN.test(entry.code))).toBe(true);
    expect(sheet.every((entry) => /^[0-9a-f]{64}$/.test(entry.admission.registryKey))).toBe(true);
    expect(sheet.every((entry) => !('masterlistKey' in entry.admission))).toBe(true);
    expect(JSON.stringify(sheet.map((entry) => entry.admission))).not.toContain("ML-001");
    expect(JSON.stringify(sheet.map((entry) => entry.admission))).not.toContain("0123456789");
  });

  it("converts a local expiry field value to an ISO UTC timestamp", () => {
    expect(paperBallotExpiryToIsoUtc("2030-01-01T12:30")).toBe(new Date("2030-01-01T12:30").toISOString());
    expect(paperBallotExpiryToIsoUtc("not-a-date")).toBe("");
  });

  it("rejects legacy roster identifiers and strips unknown metadata", () => {
    const registryKey = "a".repeat(64);
    const entry = { electionId: "election-a", registryKey, expiresAt: "2030-01-01T00:00:00Z", state: "available" };
    for (const field of ["masterlistKey", "masterlistNumber", "codeHash"]) {
      expect(sanitisePaperBallotAdmissions({ [registryKey]: { ...entry, [field]: "legacy" } })).toEqual({});
    }
    expect(sanitisePaperBallotAdmissions({ [registryKey]: { ...entry, rosterIdentifier: "ML-001" } })[registryKey]).not.toHaveProperty("rosterIdentifier");
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

  it("purges legacy and unknown metadata from storage on read", () => {
    const registryKey = "a".repeat(64);
    const storageKey = buildNamespacedLocalStorageKey("optiona:paper-ballot-admissions");
    const entry = { electionId: "election-a", registryKey, expiresAt: "2030-01-01T00:00:00Z", state: "available" };
    window.localStorage.setItem(storageKey, JSON.stringify({
      [registryKey]: { ...entry, rosterIdentifier: "ML-001" },
      ["b".repeat(64)]: { ...entry, registryKey: "b".repeat(64), masterlistKey: "c".repeat(64) },
    }));
    expect(loadPaperBallotAdmission({ registryKey })).toMatchObject(entry);
    expect(window.localStorage.getItem(storageKey)).not.toMatch(/rosterIdentifier|ML-001|masterlistKey/);
  });

  it("binds redemption to a voter, allowing bundle scopes but rejecting identity reuse", async () => {
    const registryKey = await hashPaperBallotAdmissionKey({ electionId: "election-a", masterlistNumber: "ML-001", code: "ABCD1234EF" });
    const entry = {
      electionId: "election-a",
      registryKey,
      expiresAt: "2030-01-01T00:00:00Z",
      state: "available" as const,
    };
    const redeemed = redeemPaperBallotAdmission(entry, {
      electionId: "election-a", registryKey, requestId: "request-1", invitedNpub: "voter-1", now: "2029-01-01T00:00:00Z",
    });
    savePaperBallotAdmission({ ...entry, redeemedNpub: "must-not-persist-before-redemption" });
    expect(loadPaperBallotAdmission({ registryKey })?.redeemedNpub).toBeUndefined();
    savePaperBallotAdmission(redeemed.entry!);
    expect(loadPaperBallotAdmission({ registryKey })?.redeemedNpub).toBe("voter-1");

    expect(redeemed).toMatchObject({ ok: true, replay: false, entry: { state: "redeemed", redeemedRequestId: "request-1" } });
    expect(redeemPaperBallotAdmission(redeemed.entry, {
      electionId: "election-a", registryKey, requestId: "request-2", invitedNpub: "voter-1", now: "2029-01-01T00:00:00Z",
    })).toMatchObject({ ok: true, replay: true });
    expect(redeemPaperBallotAdmission(redeemed.entry, {
      electionId: "election-a", registryKey, requestId: "request-1", invitedNpub: "voter-2", now: "2029-01-01T00:00:00Z",
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
