// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findIssuedOtpRecord,
  findResidentNpubBinding,
  isOtpRedeemed,
  loadIssuedOtpRoster,
  loadRedeemedOtpNumbers,
  loadResidentNpubBindings,
  markOtpRedeemed,
  recordResidentNpubBinding,
  saveIssuedOtpRoster,
  upsertIssuedOtpRecord,
  type IssuedOtpRecord,
  type ResidentNpubBinding,
} from "./otpAdmissionRoster";

const ELECTION_A = "election-a";
const ELECTION_B = "election-b";

function record(overrides: Partial<IssuedOtpRecord> = {}): IssuedOtpRecord {
  return {
    mastersListNumber: 101,
    saltHash: "00112233445566778899aabbccddeeff:".padEnd(97, "0"),
    issuedAt: 1_700_000_000_000,
    electionId: ELECTION_A,
    ...overrides,
  };
}

describe("otpAdmissionRoster issued roster", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts empty for an election", () => {
    expect(loadIssuedOtpRoster(ELECTION_A)).toEqual([]);
  });

  it("round-trips a roster through localStorage", () => {
    const roster = [record(), record({ mastersListNumber: 102 })];
    saveIssuedOtpRoster(ELECTION_A, roster);
    expect(loadIssuedOtpRoster(ELECTION_A)).toEqual(roster);
  });

  it("keeps rosters for different elections independent", () => {
    saveIssuedOtpRoster(ELECTION_A, [record()]);
    saveIssuedOtpRoster(ELECTION_B, [record({ electionId: ELECTION_B, mastersListNumber: 202 })]);
    expect(loadIssuedOtpRoster(ELECTION_A)).toHaveLength(1);
    expect(loadIssuedOtpRoster(ELECTION_B)).toHaveLength(1);
  });

  it("never stores a plaintext code — only the salted hash", () => {
    const entry = record();
    saveIssuedOtpRoster(ELECTION_A, [entry]);
    const raw = window.localStorage.getItem("otp-admission-roster:election-a") ?? "";
    expect(raw).not.toContain("plaintext-code");
    expect(raw).toContain(entry.saltHash);
    // The stored shape carries no code field at all.
    expect(raw).not.toContain('"code"');
  });

  it("upserts by masters list number, replacing an existing record", () => {
    upsertIssuedOtpRecord(record());
    const replaced = record({ saltHash: "ffff".padEnd(97, "0"), issuedAt: 1_700_000_000_999 });
    upsertIssuedOtpRecord(replaced);
    const roster = loadIssuedOtpRoster(ELECTION_A);
    expect(roster).toHaveLength(1);
    expect(roster[0].saltHash).toBe(replaced.saltHash);
    expect(roster[0].issuedAt).toBe(replaced.issuedAt);
  });

  it("adds distinct masters list numbers without dropping others", () => {
    upsertIssuedOtpRecord(record());
    upsertIssuedOtpRecord(record({ mastersListNumber: 102 }));
    expect(loadIssuedOtpRoster(ELECTION_A)).toHaveLength(2);
  });

  it("finds a record within a specific election", () => {
    upsertIssuedOtpRecord(record({ mastersListNumber: 303 }));
    expect(findIssuedOtpRecord(303, ELECTION_A)?.mastersListNumber).toBe(303);
    expect(findIssuedOtpRecord(404, ELECTION_A)).toBeUndefined();
  });

  it("finds a record across all elections when no election is given", () => {
    upsertIssuedOtpRecord(record({ electionId: ELECTION_B, mastersListNumber: 505 }));
    expect(findIssuedOtpRecord(505)?.electionId).toBe(ELECTION_B);
  });

  it("ignores malformed roster entries on load", () => {
    window.localStorage.setItem(
      "otp-admission-roster:election-a",
      JSON.stringify([record(), { bogus: true }, null, "junk"]),
    );
    const roster = loadIssuedOtpRoster(ELECTION_A);
    expect(roster).toHaveLength(1);
    expect(roster[0].mastersListNumber).toBe(101);
  });
});

describe("otpAdmissionRoster redemption flags", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts with no redeemed numbers", () => {
    expect(loadRedeemedOtpNumbers(ELECTION_A)).toEqual([]);
    expect(isOtpRedeemed(ELECTION_A, 101)).toBe(false);
  });

  it("marks a number redeemed exactly once", () => {
    markOtpRedeemed(ELECTION_A, 101);
    markOtpRedeemed(ELECTION_A, 101);
    expect(loadRedeemedOtpNumbers(ELECTION_A)).toEqual([101]);
    expect(isOtpRedeemed(ELECTION_A, 101)).toBe(true);
    expect(isOtpRedeemed(ELECTION_A, 102)).toBe(false);
  });

  it("keeps redemption flags scoped to their election", () => {
    markOtpRedeemed(ELECTION_A, 101);
    expect(isOtpRedeemed(ELECTION_A, 101)).toBe(true);
    expect(isOtpRedeemed(ELECTION_B, 101)).toBe(false);
  });
});

describe("otpAdmissionRoster resident→npub bindings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  function binding(overrides: Partial<ResidentNpubBinding> = {}): ResidentNpubBinding {
    return {
      mastersListNumber: 101,
      npub: "npub1abc",
      boundAt: 1_700_000_000_000,
      electionId: ELECTION_A,
      ...overrides,
    };
  }

  it("starts with no bindings", () => {
    expect(loadResidentNpubBindings(ELECTION_A)).toEqual([]);
  });

  it("records and round-trips a resident→npub binding", () => {
    recordResidentNpubBinding(binding());
    expect(loadResidentNpubBindings(ELECTION_A)).toEqual([binding()]);
  });

  it("replaces a binding when the resident redeems again under a new npub", () => {
    recordResidentNpubBinding(binding());
    recordResidentNpubBinding(binding({ npub: "npub1def" }));
    const bindings = loadResidentNpubBindings(ELECTION_A);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].npub).toBe("npub1def");
  });

  it("adds distinct residents without dropping others", () => {
    recordResidentNpubBinding(binding());
    recordResidentNpubBinding(binding({ mastersListNumber: 102, npub: "npub2xyz" }));
    expect(loadResidentNpubBindings(ELECTION_A)).toHaveLength(2);
  });

  it("keeps bindings scoped to their election", () => {
    recordResidentNpubBinding(binding());
    expect(loadResidentNpubBindings(ELECTION_A)).toHaveLength(1);
    expect(loadResidentNpubBindings(ELECTION_B)).toEqual([]);
  });

  it("finds a binding by masters list number", () => {
    recordResidentNpubBinding(binding({ mastersListNumber: 303, npub: "npub3303" }));
    expect(findResidentNpubBinding(ELECTION_A, 303)?.npub).toBe("npub3303");
    expect(findResidentNpubBinding(ELECTION_A, 404)).toBeUndefined();
  });

  it("drops malformed binding entries from untrusted storage", () => {
    window.localStorage.setItem(
      "otp-admission-binding:election-a",
      JSON.stringify([
        binding(),
        binding({ mastersListNumber: 102, npub: "  " }),
        binding({ mastersListNumber: -1, npub: "npub2neg" }),
        { bogus: true },
        null,
        "junk",
      ]),
    );
    expect(loadResidentNpubBindings(ELECTION_A)).toEqual([binding()]);
  });
});
