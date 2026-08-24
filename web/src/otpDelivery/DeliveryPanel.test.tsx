// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DeliveryPanel from "./DeliveryPanel";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

const ELECTION_ID = "election-abc";

const CSV_HEADER = "masters_list_number,email,phone,name";

function makeCsv(...rows: Array<string[]>): string {
  return [CSV_HEADER, ...rows.map((row) => row.join(","))].join("\n");
}

const VALID_CSV = makeCsv(
  ["101", "alice@example.org", "", "Alice Smith"],
  ["102", "bob@example.org", "", "Bob Jones"],
);

async function uploadResidents() {
  const input = screen.getByLabelText("Residents CSV file");
  await userEvent.upload(
    input,
    new File([VALID_CSV], "residents.csv", { type: "text/csv" }),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("DeliveryPanel channel selector", () => {
  it("defaults to the manual channel and shows its availability", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    const select = screen.getByLabelText("Delivery channel");
    expect((select as HTMLSelectElement).value).toBe("manual");
    await waitFor(() =>
      expect(screen.getByText(/Manual \(show codes in the app\)/)).toBeTruthy(),
    );
  });

  it("persists the selected channel per election", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    await userEvent.selectOptions(
      screen.getByLabelText("Delivery channel"),
      "email-nomail",
    );
    expect(window.localStorage.getItem("otp-delivery-channel:election-abc")).toBe(
      "email-nomail",
    );
  });

  it("shows the email-nomail descriptor reason and hint when selected", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    await userEvent.selectOptions(
      screen.getByLabelText("Delivery channel"),
      "email-nomail",
    );
    await waitFor(() =>
      expect(screen.getByText(/SameSite=Strict/)).toBeTruthy(),
    );
    expect(screen.getByText(/scripts\/otp-send-email\.mjs/)).toBeTruthy();
  });

  it("shows the SMS development reason when selected", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    await userEvent.selectOptions(
      screen.getByLabelText("Delivery channel"),
      "sms",
    );
    await waitFor(() =>
      expect(screen.getByText(/SMS service in development/)).toBeTruthy(),
    );
  });
});

describe("DeliveryPanel manual channel", () => {
  it("generates a copyable code per resident", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    await uploadResidents();
    await userEvent.click(screen.getByLabelText("Generate code for resident 101"));
    await waitFor(() =>
      expect(screen.getByLabelText("Code for resident 101")).toBeTruthy(),
    );
    const entry = screen.getByLabelText("Code for resident 101");
    expect(within(entry).getByText(/^\d{6}$/)).toBeTruthy();
    expect(within(entry).getByLabelText("Copy code for resident 101")).toBeTruthy();
  });

  it("exports a name+code CSV with proper escaping", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock");
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });

    render(<DeliveryPanel electionId={ELECTION_ID} />);
    await uploadResidents();
    await userEvent.click(screen.getByLabelText("Generate code for resident 101"));
    await waitFor(() =>
      expect(screen.getByLabelText("Code for resident 101")).toBeTruthy(),
    );
    await userEvent.click(screen.getByLabelText("Export name+code CSV"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("name,code");
    expect(lines[1]).toMatch(/^Alice Smith,\d{6}$/);
  });
});

describe("DeliveryPanel results import", () => {
  it("populates the status table from an imported results CSV", async () => {
    render(<DeliveryPanel electionId={ELECTION_ID} />);
    const input = screen.getByLabelText("Results CSV file");
    await userEvent.upload(
      input,
      new File(
        ["mastersListNumber,ok,detail,ref\n101,true,Sent,abc123\n102,false,Rejected,\n"],
        "results.csv",
        { type: "text/csv" },
      ),
    );

    await waitFor(() => expect(screen.getByLabelText("Delivery status table")).toBeTruthy());
    const table = screen.getByLabelText("Delivery status table");
    expect(within(table).getByText("101")).toBeTruthy();
    expect(within(table).getByText("102")).toBeTruthy();
    expect(within(table).getByText("Rejected")).toBeTruthy();
    expect(within(table).getByText("abc123")).toBeTruthy();
  });
});
