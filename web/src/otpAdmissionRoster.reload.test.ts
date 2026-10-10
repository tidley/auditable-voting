// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  hasPersistedResidentOtpAdmission,
  recordResidentNpubBinding,
  saveIssuedOtpRoster,
  type IssuedOtpRecord,
} from "./otpAdmissionRoster";

const ELECTION_A = "election-a";
const ELECTION_B = "election-b";

function issuedRecord(overrides: Partial<IssuedOtpRecord> = {}): IssuedOtpRecord {
  return {
    mastersListNumber: 101,
    saltHash: "pbkdf2-sha256$600000$00112233445566778899aabbccddeeff$fffffffffffffffffffffffff",
    issuedAt: 1_700_000_000_000,
    electionId: ELECTION_A,
    ...overrides,
  };
}

/**
 * C4 — restore the voter's resident-admission state across a reload.
 *
 * Redemption is device-local, so a persisted resident→npub binding (written only
 * by a *verified* redemption) is the honest, security-preserving evidence that a
 * reload should restore the admitted ballot/private-invite panel for.
 */
describe("resident OTP admission across reload (C4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("never admits when no voter npub is known", () => {
    saveIssuedOtpRoster(ELECTION_A, [issuedRecord()]);
    recordResidentNpubBinding({
      mastersListNumber: 101,
      npub: "npub1voter",
      boundAt: 1_700_000_000_000,
      electionId: ELECTION_A,
    });
    expect(hasPersistedResidentOtpAdmission(undefined)).toBe(false);
    expect(hasPersistedResidentOtpAdmission("  ")).toBe(false);
  });

  it("does not admit when nothing has been redeemed on this device", () => {
    saveIssuedOtpRoster(ELECTION_A, [issuedRecord()]);
    expect(hasPersistedResidentOtpAdmission("npub1voter")).toBe(false);
  });

  it("admits a voter whose redemption was persisted on this device", () => {
    saveIssuedOtpRoster(ELECTION_A, [issuedRecord()]);
    recordResidentNpubBinding({
      mastersListNumber: 101,
      npub: "npub1voter",
      boundAt: 1_700_000_000_000,
      electionId: ELECTION_A,
    });
    expect(hasPersistedResidentOtpAdmission("npub1voter")).toBe(true);
  });

  it("finds the persisted admission across any issued election", () => {
    saveIssuedOtpRoster(ELECTION_B, [issuedRecord({ electionId: ELECTION_B, mastersListNumber: 202 })]);
    recordResidentNpubBinding({
      mastersListNumber: 202,
      npub: "npub1voter",
      boundAt: 1_700_000_000_000,
      electionId: ELECTION_B,
    });
    expect(hasPersistedResidentOtpAdmission("npub1voter")).toBe(true);
  });

  it("does not admit a different voter identity", () => {
    saveIssuedOtpRoster(ELECTION_A, [issuedRecord()]);
    recordResidentNpubBinding({
      mastersListNumber: 101,
      npub: "npub1voter",
      boundAt: 1_700_000_000_000,
      electionId: ELECTION_A,
    });
    expect(hasPersistedResidentOtpAdmission("npub1someoneelse")).toBe(false);
  });
});
