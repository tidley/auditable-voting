// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeliveryPanel, { batchDefaultExpiry, emailVoterUrl } from "./DeliveryPanel";
import type { QuestionnaireDefinition } from "../questionnaireProtocol";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
}

vi.mock("../ui/UiDateTimeField", () => ({
  default: ({ label, value, onChange, isDisabled }: { label: string; value: string; onChange: (value: string) => void; isDisabled?: boolean }) => <label>{label}<input value={value} disabled={isDisabled} onChange={(event) => onChange(event.target.value)} /></label>,
}));

const ELECTION_ID = "election-abc";
const VOTER_URL = `https://example.test/auditable-voting/?role=voter&q=${ELECTION_ID}&coordinator=npub1test`;
const AUTO_REQUEST_INVITE_URL = `${VOTER_URL}&request_ballot=1&auto_request=1`;
const DEFINITION = { questionnaireId: ELECTION_ID, title: "Resident vote", questions: [] } as unknown as QuestionnaireDefinition;
const CSV_HEADER = "masters_list_number,email,phone,name";
const VALID_CSV = [CSV_HEADER, "101,alice@example.org,,Alice Smith", "102,bob@example.org,,Bob Jones"].join("\n");
const createObjectURL = vi.fn((_blob: Blob) => "blob:admission-bundle");

function makeProps() {
  return {
    electionId: ELECTION_ID,
    definition: DEFINITION,
    runtime: { addPaperBallotAdmission: vi.fn() },
    voterUrl: AUTO_REQUEST_INVITE_URL,
    onAdmissionsChanged: vi.fn(),
  };
}

async function importCsv(csv: string, name = "import.csv") {
  await userEvent.upload(screen.getByLabelText("Import resident CSV"), new File([csv], name, { type: "text/csv" }));
}

async function generateAdmissions() {
  fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2099-01-01T12:30" } });
  await userEvent.click(screen.getByRole("button", { name: "Generate admission codes" }));
  await screen.findByLabelText("Code for resident 101");
}

function latestCsv() {
  return (createObjectURL.mock.calls.at(-1)?.[0] as Blob).text();
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Resident email admission (export only)", () => {
  it("uses one Import control and preserves valid rows when a later CSV is rejected", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    expect(document.querySelectorAll("input[type='file']")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set defaults" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send emails" })).toBeNull();

    await importCsv(VALID_CSV);
    expect(await screen.findByText("2 residents imported.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(2);

    await importCsv([CSV_HEADER, "101,not-an-email,,Alice Smith", "101,duplicate@example.org,,Duplicate"].join("\n"));
    expect(screen.getByRole("alert").textContent).toContain("invalid email");
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(2);
    expect(props.runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
  });

  it("renders imported values as editable fields and supports adding and removing rows", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);

    const name = screen.getByLabelText("Name for row resident-row-1");
    await userEvent.clear(name);
    await userEvent.type(name, "Alicia Smith");
    expect((name as HTMLInputElement).value).toBe("Alicia Smith");

    await userEvent.click(screen.getByRole("button", { name: "Add row" }));
    const newNumber = screen.getByLabelText("Master-list number for row resident-row-3");
    await userEvent.type(newNumber, "103");
    await userEvent.type(screen.getByLabelText("Email for row resident-row-3"), "carol@example.org");
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Remove resident row resident-row-2" }));
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("sets a 24-hour batch default without deleting imported residents", async () => {
    expect(emailVoterUrl(AUTO_REQUEST_INVITE_URL)).toBe(VOTER_URL);
    expect(emailVoterUrl(`${VOTER_URL}&request_ballot=1`)).not.toContain("request_ballot");
    const now = new Date("2026-01-05T10:15:00");
    expect(batchDefaultExpiry(now)).toBe("2026-01-06T10:15");
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await userEvent.click(screen.getByRole("button", { name: "Set defaults" }));
    expect(await screen.findByText("Default expiry set to 24 hours from now.")).toBeTruthy();
    expect((screen.getByLabelText("Code expiry") as HTMLInputElement).value).not.toBe("");
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("exports the editable resident CSV before codes are generated", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await userEvent.clear(screen.getByLabelText("Name for row resident-row-1"));
    await userEvent.type(screen.getByLabelText("Name for row resident-row-1"), "Smith, Alice");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    const csv = await latestCsv();
    expect(csv).toBe([CSV_HEADER, '101,alice@example.org,,"Smith, Alice"', "102,bob@example.org,,Bob Jones"].join("\n"));
    expect(await screen.findByText("Resident CSV exported.")).toBeTruthy();
    expect(props.runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
  });

  it("registers admissions, locks identity fields, and masks codes until deliberately revealed", async () => {
    const props = makeProps();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();

    expect(props.runtime.addPaperBallotAdmission).toHaveBeenCalledTimes(2);
    expect(props.onAdmissionsChanged).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Email for row resident-row-1") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Code expiry") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Set defaults" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add row" })).toHaveProperty("disabled", true);

    const row = screen.getByLabelText("Code for resident 101");
    expect(within(row).getByText("•••••-•••••")).toBeTruthy();
    expect(within(row).queryByText(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/)).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Reveal code for resident 101" }));
    const code = within(row).getByText(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/).textContent;
    expect(screen.getByLabelText("Code for resident 102").textContent).toContain("•••••-•••••");
    await userEvent.click(within(row).getByRole("button", { name: "Copy code for resident 101" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code));
    expect(JSON.stringify(props.runtime.addPaperBallotAdmission.mock.calls)).not.toContain(code?.replace("-", ""));
    expect(JSON.stringify(window.localStorage)).not.toContain("alice@example.org");

    await importCsv([CSV_HEADER, "103,carol@example.org,,Carol"].join("\n"));
    expect(await screen.findByText(/roster cannot be replaced/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Residents" }).querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("exports the exact generated-code bundle and preserves CSV escaping", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv([CSV_HEADER, '101,alice@example.org,,"Smith, Alice"', "102,bob@example.org,,Bob Jones"].join("\n"));
    await generateAdmissions();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    const csv = await latestCsv();
    const lines = csv.split("\n");
    expect(lines[0]).toBe("masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Smith, Alice"');
    expect(lines[1]).toMatch(/101,alice@example.org,,"Smith, Alice",[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10},2099-01-01T/);
    expect(lines[1]).toContain(VOTER_URL);
    expect(lines[1]).not.toContain("request_ballot");
    expect(lines[1]).not.toContain("auto_request");
    expect(lines[1]).not.toContain("••••");
    expect(await screen.findByText(/Admission bundle exported/)).toBeTruthy();
  });

  it("rejects bundle import and does not generate without a published questionnaire or future expiry", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} definition={null} />);
    await importCsv(VALID_CSV);
    await importCsv([CSV_HEADER + ",code,expires_at,vote_url", `101,a@example.org,,A,ABCD1234EF,2099-01-01T00:00:00.000Z,${VOTER_URL}`].join("\n"), "bundle.csv");
    expect(await screen.findByText(/not an existing email bundle/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2000-01-01T12:30" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate admission codes" }));
    expect(await screen.findByText("Open and publish the questionnaire before generating resident email admissions.")).toBeTruthy();
    expect(props.runtime.addPaperBallotAdmission).not.toHaveBeenCalled();

    cleanup();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    fireEvent.change(screen.getByLabelText("Code expiry"), { target: { value: "2000-01-01T12:30" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate admission codes" }));
    expect(await screen.findByText("Code expiry must be in the future.")).toBeTruthy();
    expect(props.runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
  });
});
