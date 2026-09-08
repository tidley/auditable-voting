// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashOtp, ADMISSION_TTL_MS, MAX_OTP_ATTEMPTS } from "./otpService";
import { isOtpRedeemed, loadResidentNpubBindings, upsertIssuedOtpRecord } from "./otpAdmissionRoster";

// jsdom provides crypto.getRandomValues but not crypto.subtle; otpService needs both.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

import ResidentOtpEntry from "./ResidentOtpEntry";

const ELECTION_A = "election-a";

async function seedIssuedCode(mastersListNumber: number, code: string, issuedAt = Date.now()) {
  const saltHash = await hashOtp(code);
  upsertIssuedOtpRecord({
    mastersListNumber,
    saltHash,
    issuedAt,
    electionId: ELECTION_A,
  });
  return saltHash;
}

async function submitEntry(mastersListNumber: string, code: string) {
  await userEvent.type(screen.getByLabelText("Masters list number"), mastersListNumber);
  await userEvent.type(screen.getByLabelText("One-time code"), code);
  await userEvent.click(screen.getByLabelText("Verify code"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ResidentOtpEntry rendering", () => {
  it("renders the masters-list number and code inputs with guidance", () => {
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    expect(screen.getByLabelText("Masters list number")).toBeTruthy();
    expect(screen.getByLabelText("One-time code")).toBeTruthy();
    expect(screen.getByLabelText("Verify code")).toBeTruthy();
  });

  it("keeps Verify enabled once both fields are non-empty", async () => {
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    expect((screen.getByLabelText("Verify code") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Masters list number"), "101");
    await userEvent.type(screen.getByLabelText("One-time code"), "123456");
    expect((screen.getByLabelText("Verify code") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ResidentOtpEntry verification outcomes", () => {
  it("reports when no code has been issued for the resident", async () => {
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    await submitEntry("404", "123456");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "No code has been issued for this resident.",
      ),
    );
  });

  it("asks for a 6-digit code when the entry is incomplete", async () => {
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    await userEvent.type(screen.getByLabelText("Masters list number"), "101");
    await userEvent.type(screen.getByLabelText("One-time code"), "12345");
    await userEvent.click(screen.getByLabelText("Verify code"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Enter the 6-digit code."),
    );
  });

  it("admits the resident and marks the code redeemed for a correct code", async () => {
    const onAdmitted = vi.fn();
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry electionId={ELECTION_A} onAdmitted={onAdmitted} />);
    await submitEntry("101", "424242");

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified. You are admitted to vote."),
    );
    expect(isOtpRedeemed(ELECTION_A, 101)).toBe(true);
    expect(onAdmitted).toHaveBeenCalledWith({ mastersListNumber: 101, electionId: ELECTION_A });
  });

  it("records the redeeming voter npub when one is supplied", async () => {
    const onAdmitted = vi.fn();
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry electionId={ELECTION_A} voterNpub="npub1test" onAdmitted={onAdmitted} />);
    await submitEntry("101", "424242");

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified. You are admitted to vote."),
    );
    expect(loadResidentNpubBindings(ELECTION_A)).toEqual([
      expect.objectContaining({ mastersListNumber: 101, npub: "npub1test" }),
    ]);
    expect(onAdmitted).toHaveBeenCalledWith({ mastersListNumber: 101, electionId: ELECTION_A });
  });

  it("does not record a binding when no voter npub is supplied", async () => {
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    await submitEntry("101", "424242");

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified. You are admitted to vote."),
    );
    expect(loadResidentNpubBindings(ELECTION_A)).toEqual([]);
  });

  it("rejects an incorrect code", async () => {
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    await submitEntry("101", "000000");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Incorrect code."),
    );
    expect(isOtpRedeemed(ELECTION_A, 101)).toBe(false);
  });

  it("locks after the maximum failed attempts", async () => {
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    await userEvent.type(screen.getByLabelText("Masters list number"), "101");
    await userEvent.type(screen.getByLabelText("One-time code"), "000000");

    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt += 1) {
      await userEvent.click(screen.getByLabelText("Verify code"));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBeTruthy());
    }

    expect(screen.getByRole("status").textContent).toBe(
      "Too many failed attempts. Contact your organiser for a new code.",
    );
  });

  it("reports an expired code even when it is correct", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    await seedIssuedCode(101, "424242", now);
    render(<ResidentOtpEntry electionId={ELECTION_A} />);
    vi.setSystemTime(new Date(now + ADMISSION_TTL_MS + 60_000));
    await submitEntry("101", "424242");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "This code has expired. Contact your organiser for a new one.",
      ),
    );
  });

  it("finds and redeems a code issued for a different election when none is given", async () => {
    const onAdmitted = vi.fn();
    await seedIssuedCode(101, "424242");
    render(<ResidentOtpEntry onAdmitted={onAdmitted} />);
    await submitEntry("101", "424242");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified. You are admitted to vote."),
    );
    expect(onAdmitted).toHaveBeenCalledWith({ mastersListNumber: 101, electionId: ELECTION_A });
  });
});
