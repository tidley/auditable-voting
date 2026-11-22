// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeliveryPanel, { batchDefaultExpiry, emailVoterUrl } from "./DeliveryPanel";
import type { QuestionnaireDefinition } from "../questionnaireProtocol";
import type { SignerService } from "../services/signerService";

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
const createObjectURL = vi.fn((_blob: Blob) => "blob:admission-email-bundle");

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
  await userEvent.upload(screen.getByLabelText("Import resident, delivery results, or exported delivery bundle CSV"), new File([csv], name, { type: "text/csv" }));
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
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Resident email admission", () => {
  it("uses one Import control and preserves valid rows when a later CSV is rejected", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    expect(document.querySelectorAll("input[type='file']")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set defaults" })).toBeTruthy();

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
    expect(await screen.findByText(/Email bundle exported/)).toBeTruthy();
  });

  it("updates the integrated Delivery column when importing results through the same control", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await importCsv("mastersListNumber,ok,detail,ref\n101,true,sent,abc123\n102,false,Rejected,\n", "results.csv");

    expect(await screen.findByText("2 delivery status rows imported.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Residents" });
    expect(within(table).getByDisplayValue("101")).toBeTruthy();
    expect(within(table).getByText("Sent")).toBeTruthy();
    expect(within(table).getByText("Failed: Rejected")).toBeTruthy();
  });

  it("loads an exported delivery bundle without registering new admissions and sends it", async () => {
    const bundle = [
      "masters_list_number,email,phone,name,code,expires_at,questionnaire_title,vote_url",
      `101,a@example.org,,Alice,ABCDE12345,2099-01-01T00:00:00.000Z,Resident vote,${VOTER_URL}`,
    ].join("\n");
    let submittedBody: { transport?: string; bundleCsv?: string } = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      submittedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sent: 1,
          skipped: 0,
          failed: 0,
          results: [{ master: "101", ok: true, detail: "sent", ref: "smtp-1" }],
        }),
      };
    }));
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(bundle, "exported-bundle.csv");
    expect(await screen.findByText(/Exported delivery bundle loaded: 1 recipient/)).toBeTruthy();
    expect(props.runtime.addPaperBallotAdmission).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Generate admission codes" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Send emails" }));
    expect(await screen.findByText("Email delivery: 1 sent, 0 already sent, 0 failed.")).toBeTruthy();
    expect(submittedBody.transport).toBe("smtp");
    expect(submittedBody.bundleCsv).toBe(bundle);
  });

  it("does not generate without a published questionnaire or future expiry", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} definition={null} />);
    await importCsv(VALID_CSV);
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

  it("sends the exact generated bundle through a discovered local sender and updates Delivery", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      if (String(input) === "/__email/send") {
        const body = JSON.parse(String(init?.body));
        expect(body.transport).toBe("smtp");
        expect(body.bundleCsv).toContain("questionnaire_title");
        expect(body.bundleCsv).toContain("Resident vote");
        expect(body.bundleCsv).toContain("alice@example.org");
        expect(body.bundleCsv).toMatch(/[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}/);
        return {
          ok: true,
          json: async () => ({
            sent: 2,
            skipped: 0,
            failed: 0,
            results: [
              { master: "101", ok: true, detail: "sent", ref: "smtp-1" },
              { master: "102", ok: true, detail: "sent", ref: "smtp-2" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByLabelText("Email sender")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send emails" }));
    expect(await screen.findByText("Email delivery: 2 sent, 0 already sent, 0 failed.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Residents" });
    expect(within(table).getAllByText("Sent")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/__email/send")).toHaveLength(1);
  });

  it("keeps export-only fallback when the local sender is unreachable", async () => {
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByText(/Local sender not connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send emails" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("shows cashu cost, daily-cap and not-attempted status from the local sender", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["cashu"], maxRecipients: 1000 }) };
      }
      return {
        ok: true,
        json: async () => ({
          sent: 1,
          skipped: 0,
          failed: 1,
          notAttempted: 1,
          satsSpent: 100,
          capUsedToday: 100,
          capRemaining: 0,
          results: [
            { master: "101", ok: true, detail: "sent", ref: "cashu-1" },
            { master: "102", ok: false, detail: "send failed (HTTP 402)" },
            { master: "103", ok: false, detail: "not attempted: cashu daily send limit reached" },
          ],
        }),
      };
    }));
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv([CSV_HEADER, "101,alice@example.org,,Alice Smith", "102,bob@example.org,,Bob Jones", "103,carol@example.org,,Carol Cruz"].join("\n"));
    await generateAdmissions();
    expect(await screen.findByLabelText("Email sender")).toHaveProperty("value", "cashu");
    await userEvent.click(screen.getByRole("button", { name: "Send emails" }));
    expect(await screen.findByText("Email delivery: 1 sent, 0 already sent, 1 failed, 1 not attempted. 100 sats; daily cap 100/100 used, 0 remaining.")).toBeTruthy();
    expect(screen.getByText("Not sent: cashu daily send limit reached")).toBeTruthy();
  });

  it("retries once through a proxy 502 and reports ledger skips", async () => {
    let sendCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      if (String(input) === "/__email/send") {
        sendCalls += 1;
        if (sendCalls === 1) return { ok: false, status: 502, json: async () => ({ error: "The local email sender is unreachable.", code: "proxy_unreachable" }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sent: 0,
            skipped: 2,
            failed: 0,
            results: [
              { master: "101", ok: true, detail: "already sent", ref: "smtp-1" },
              { master: "102", ok: true, detail: "already sent", ref: "smtp-2" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    }));
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByLabelText("Email sender")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send emails" }));
    expect(await screen.findByText("Email delivery: 0 sent, 2 already sent, 0 failed.")).toBeTruthy();
    expect(sendCalls).toBe(2);
  });

  it("shows the sender application error on 502 without retrying", async () => {
    let sendCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      sendCalls += 1;
      return {
        ok: false,
        status: 502,
        json: async () => ({
          error: "The ledger belongs to different admission details for master-list number 101.",
          code: "ledger_conflict",
        }),
      };
    }));
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    await userEvent.click(await screen.findByRole("button", { name: "Send emails" }));
    expect(await screen.findByText(/Email sending failed: The ledger belongs to different admission details/)).toBeTruthy();
    expect(sendCalls).toBe(1);
  });

  it("sends through a configured remote relay with NIP-98 authorization", async () => {
    const signer = {
      getPublicKey: vi.fn(async () => "b".repeat(64)),
      signEvent: vi.fn(async (event: Record<string, unknown>) => ({
        ...event,
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        sig: "c".repeat(128),
      })),
    } as unknown as SignerService;
    let submittedBody: Record<string, unknown> = {};
    let submittedAuthorization = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://relay.test/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-relay", version: 1, transports: ["smtp"], maxRecipients: 1000, auth: "nip98" }) };
      }
      if (String(input) === "https://relay.test/send") {
        submittedBody = JSON.parse(String(init?.body));
        submittedAuthorization = String((init?.headers as Record<string, string>)?.authorization ?? "");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sent: 2,
            skipped: 0,
            failed: 0,
            results: [
              { master: "101", ok: true, detail: "sent", ref: "relay-1" },
              { master: "102", ok: true, detail: "sent", ref: "relay-2" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    }));
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} signer={signer} />);
    fireEvent.change(screen.getByLabelText("Remote email relay URL"), { target: { value: "https://relay.test" } });
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByText(/Sending through/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send emails" }));
    expect(await screen.findByText("Email delivery: 2 sent, 0 already sent, 0 failed.")).toBeTruthy();
    expect(submittedBody.electionId).toBe(ELECTION_ID);
    expect(String(submittedBody.bundleCsv)).toContain("alice@example.org");
    expect(submittedAuthorization).toMatch(/^Nostr /);
    const signed = JSON.parse(Buffer.from(submittedAuthorization.slice("Nostr ".length), "base64").toString("utf8"));
    const tag = (name: string) => signed.tags.find((entry: string[]) => entry[0] === name)?.[1];
    expect(signed.kind).toBe(27235);
    expect(tag("method")).toBe("POST");
    expect(tag("u")).toBe("https://relay.test/send");
    expect(tag("payload")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks sending when the Guardian heartbeat is stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    }));
    const props = {
      ...makeProps(),
      issuerStatus: {
        mode: "delegated_worker" as const,
        workerNpub: "npub1worker",
        delegationId: "delegation_1",
        summaryIssuerNpub: "npub1worker",
        heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    };
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByText(/Guardian heartbeat is stale/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send emails" })).toHaveProperty("disabled", true);
  });

  it("offers a one-click Browser only recovery when the issuer is red", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    }));
    const onSwitchToBrowserOnly = vi.fn();
    const props = {
      ...makeProps(),
      onSwitchToBrowserOnly,
      issuerStatus: {
        mode: "delegated_worker" as const,
        workerNpub: "npub1worker",
        delegationId: "delegation_1",
        summaryIssuerNpub: "npub1worker",
      },
    };
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByText(/Guardian has no heartbeat/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Switch to Browser only" }));
    expect(onSwitchToBrowserOnly).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit same-machine acknowledgement for a loopback voter link", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    }));
    const props = {
      ...makeProps(),
      voterUrl: "http://127.0.0.1:5174/?role=voter&q=election-abc&coordinator=npub1test",
      issuerStatus: { mode: "browser_only" as const },
    };
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    const send = await screen.findByRole("button", { name: "Send emails" });
    expect(send).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByLabelText("This is a same-machine test"));
    await waitFor(() => expect(send).toHaveProperty("disabled", false));
  });

  it("re-checks the sender before sending and never posts when it has gone away", async () => {
    let healthCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/__email/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          return { ok: true, json: async () => ({ service: "auditable-voting-email-sender", version: 1, transports: ["smtp"], maxRecipients: 1000 }) };
        }
        throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
      }
      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = makeProps();
    render(<DeliveryPanel {...props} runtime={props.runtime as never} />);
    await importCsv(VALID_CSV);
    await generateAdmissions();
    expect(await screen.findByLabelText("Email sender")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send emails" }));
    expect(await screen.findByText(/Local email sender is not reachable/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/__email/send")).toHaveLength(0);
  });
});
