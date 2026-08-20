// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OTP_ATTEMPTS, OTP_TTL_MS } from "./otpService";

// jsdom provides crypto.getRandomValues but not crypto.subtle; otpService needs both.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

import ResidentOtpAdmission from "./ResidentOtpAdmission";

const CSV_HEADER = "masters_list_number,email,phone,name";

function makeCsv(...rows: Array<string[]>): string {
  return [CSV_HEADER, ...rows.map((row) => row.join(","))].join("\n");
}

const VALID_CSV = makeCsv(
  ["101", "alice@example.org", "020 7946 0101", "Alice Smith"],
  ["102", "bob@example.org", "", "Bob Jones"],
);

async function uploadCsv(csv: string) {
  const input = screen.getByLabelText("Residents CSV file");
  await userEvent.upload(input, new File([csv], "residents.csv", { type: "text/csv" }));
}

function getIssuedEntry(mastersListNumber: number): HTMLElement {
  const panel = screen.getByLabelText("Issued codes");
  return within(panel).getByLabelText(`Code for resident ${mastersListNumber}`);
}

async function generateFor(mastersListNumber: number) {
  await userEvent.click(screen.getByLabelText(`Generate code for resident ${mastersListNumber}`));
  await waitFor(() => getIssuedEntry(mastersListNumber));
  return within(getIssuedEntry(mastersListNumber)).getByText(/^\d{6}$/).textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ResidentOtpAdmission CSV upload", () => {
  it("renders the file input and guidance copy before any upload", () => {
    render(<ResidentOtpAdmission />);
    expect(screen.getByLabelText("Residents CSV file")).toBeTruthy();
    expect(screen.getByText(/masters_list_number,email,phone,name/)).toBeTruthy();
    expect(screen.queryByLabelText("Issued codes")).toBeNull();
  });

  it("shows a resident table with name, email and phone after a valid upload", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);

    const table = screen.getByLabelText("Residents");
    expect(within(table).getByText("Alice Smith")).toBeTruthy();
    expect(within(table).getByText("alice@example.org")).toBeTruthy();
    expect(within(table).getByText("020 7946 0101")).toBeTruthy();
    expect(within(table).getByText("101")).toBeTruthy();
    expect(within(table).getByText("Bob Jones")).toBeTruthy();
  });

  it("lists parse errors and no resident table for an invalid CSV", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(makeCsv(["201", "not-an-email", "", "Carol"]));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Row 1: invalid email");
    expect(screen.queryByLabelText("Residents")).toBeNull();
  });

  it("replaces a previous roster when a new CSV is uploaded", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    await uploadCsv(makeCsv(["301", "dave@example.org", "", "Dave"]));

    expect(screen.queryByText("Alice Smith")).toBeNull();
    expect(screen.getByText("Dave")).toBeTruthy();
  });
});

describe("ResidentOtpAdmission OTP generation", () => {
  it("shows a 6-digit code once with a copy button and issue time for a resident", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);

    const code = await generateFor(101);

    expect(code).toMatch(/^\d{6}$/);
    const entry = getIssuedEntry(101);
    expect(within(entry).getByLabelText("Copy code for resident 101")).toBeTruthy();
    expect(within(entry).getByText(/issued \d{2}:\d{2}:\d{2}/)).toBeTruthy();
    expect(within(entry).getByText(/Alice Smith/)).toBeTruthy();
  });

  it("replaces the entry when a new code is generated for the same resident", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);

    await generateFor(101);
    await userEvent.click(screen.getByLabelText("Generate code for resident 101"));
    await waitFor(() => {
      const panel = screen.getByLabelText("Issued codes");
      const entries = within(panel).getAllByLabelText(/Code for resident 101/);
      expect(entries).toHaveLength(1);
    });
  });

  it("generates codes for every resident with the batch action", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);

    await userEvent.click(screen.getByLabelText("Generate codes for all residents"));

    await waitFor(() => getIssuedEntry(101));
    await waitFor(() => getIssuedEntry(102));
  });

  it("copies the shown code to the clipboard and confirms", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    const code = await generateFor(101);

    await userEvent.click(screen.getByLabelText("Copy code for resident 101"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    await waitFor(() =>
      expect(within(getIssuedEntry(101)).getByText("Copied")).toBeTruthy(),
    );
  });
});

describe("ResidentOtpAdmission OTP verification", () => {
  it("hides the verify form until residents load, then keeps Verify disabled until fields are filled", async () => {
    render(<ResidentOtpAdmission />);
    expect(screen.queryByLabelText("Verify code")).toBeNull();

    await uploadCsv(VALID_CSV);
    expect((screen.getByLabelText("Verify code") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports when the selected resident has no issued code", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), "123456");
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "No code has been issued for this resident yet.",
      ),
    );
  });

  it("asks for a 6-digit code when the entry is incomplete", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    await generateFor(101);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), "12345");
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Enter the 6-digit code."),
    );
  });

  it("confirms a correct code", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    const code = await generateFor(101);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), code);
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified for resident 101."),
    );
  });

  it("rejects an incorrect code", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    const code = await generateFor(101);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), wrongCodeFor(code));
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Incorrect code."),
    );
  });

  it("locks the code after the maximum failed attempts", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    const code = await generateFor(101);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), wrongCodeFor(code));

    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
      await userEvent.click(screen.getByLabelText("Verify code"));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBeTruthy());
    }

    expect(screen.getByRole("status").textContent).toBe(
      "Too many failed attempts. Generate a new code to continue.",
    );
  });

  it("reports an expired code even when it is correct", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<ResidentOtpAdmission />);
    await uploadCsv(VALID_CSV);
    const code = await generateFor(101);

    vi.setSystemTime(new Date(Date.now() + OTP_TTL_MS + 60_000));

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), code);
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "This code has expired. Generate a new code.",
      ),
    );
  });
});

function wrongCodeFor(code: string): string {
  const wrong = (Number(code) + 1) % 1_000_000;
  return wrong.toString().padStart(6, "0");
}
