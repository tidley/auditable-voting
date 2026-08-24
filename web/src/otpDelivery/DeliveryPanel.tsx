import { useMemo, useState, type ChangeEvent } from "react";
import { generateOtp, hashOtp } from "../otpService";
import { parseResidentCsv, type ResidentEntry } from "../residentRegister";
import { tryWriteClipboard } from "../clipboard";
import { useTransientCopiedLabel } from "../useTransientCopiedLabel";
import { DELIVERY_CHANNELS } from "./channels";
import { buildNameCodeCsv, parseResultsCsv, type DeliveryResultRow } from "./csv";
import { loadSelectedChannel, saveSelectedChannel } from "./selectorStorage";
import type { DeliveryChannel, Recipient } from "./types";

interface IssuedCode {
  mastersListNumber: number;
  name: string;
  code: string;
  hash: string;
  issuedAt: number;
}

interface DeliveryPanelProps {
  electionId: string;
}

export default function DeliveryPanel({ electionId }: DeliveryPanelProps) {
  const [selectedChannelId, setSelectedChannelId] = useState<DeliveryChannel["id"]>(
    () => loadSelectedChannel(electionId),
  );
  const [residents, setResidents] = useState<ResidentEntry[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [issued, setIssued] = useState<IssuedCode[]>([]);
  const [results, setResults] = useState<DeliveryResultRow[]>([]);
  const { isCopied, showCopied } = useTransientCopiedLabel();

  const selectedChannel = useMemo(
    () => DELIVERY_CHANNELS.find((c) => c.id === selectedChannelId) ?? DELIVERY_CHANNELS[0],
    [selectedChannelId],
  );

  const [availability, setAvailability] = useState<{ ok: boolean; reason?: string; hint?: string } | null>(null);

  function handleChannelChange(event: ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value as DeliveryChannel["id"];
    setSelectedChannelId(id);
    saveSelectedChannel(electionId, id);
    setAvailability(null);
    const channel = DELIVERY_CHANNELS.find((c) => c.id === id) ?? DELIVERY_CHANNELS[0];
    void channel.available().then(setAvailability);
  }

  async function handleResidentsCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const result = parseResidentCsv(text);
      setResidents(result.residents);
      setCsvErrors(result.errors);
      setIssued([]);
    } catch {
      setCsvErrors(["The file could not be read."]);
      setResidents([]);
      setIssued([]);
    }
    event.target.value = "";
  }

  async function issueCode(resident: ResidentEntry) {
    const code = generateOtp();
    const hash = await hashOtp(code);
    const issuedAt = Date.now();
    setIssued((current) => [
      ...current.filter((entry) => entry.mastersListNumber !== resident.mastersListNumber),
      { mastersListNumber: resident.mastersListNumber, name: resident.name ?? "", code, hash, issuedAt },
    ]);
  }

  function handleResultsImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    void file.text().then((text) => {
      setResults(parseResultsCsv(text));
    });
    event.target.value = "";
  }

  function handleExport() {
    const pairs = issued.map((entry) => ({ name: entry.name, code: entry.code }));
    const csv = buildNameCodeCsv(pairs);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `otp-codes-${electionId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const recipients: Recipient[] = residents.map((resident) => ({
    ...resident,
    mastersListNumber: resident.mastersListNumber,
  }));

  return (
    <section className="simple-voter-section simple-delivery-panel" aria-label="OTP delivery">
      <h4 className="simple-voter-question">Delivery</h4>
      <p className="simple-voter-note">
        Choose how one-time codes are handed to residents. Batch sending runs on
        the coordinator machine, not in this tab.
      </p>
      <div className="simple-voter-action-row simple-voter-action-row-inline">
        <label htmlFor="delivery-channel-select">Delivery channel</label>
        <select
          id="delivery-channel-select"
          className="simple-voter-input"
          aria-label="Delivery channel"
          value={selectedChannelId}
          onChange={handleChannelChange}
        >
          {DELIVERY_CHANNELS.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.label}
            </option>
          ))}
        </select>
      </div>
      {availability && !availability.ok ? (
        <div className="simple-voter-note" role="status" aria-label="Channel availability">
          <p>{availability.reason}</p>
          {availability.hint ? <p>{availability.hint}</p> : null}
        </div>
      ) : null}

      <div className="simple-delivery-residents">
        <h4 className="simple-voter-question">Residents</h4>
        <p className="simple-voter-note">
          Upload a CSV with the header masters_list_number,email,phone,name.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Residents CSV file"
          onChange={(event) => void handleResidentsCsv(event)}
        />
        {csvErrors.length > 0 ? (
          <div className="simple-voter-note" role="alert" aria-label="Residents CSV errors">
            <p>The CSV could not be read:</p>
            <ul>
              {csvErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {selectedChannel.id === "manual" && residents.length > 0 ? (
        <div className="simple-delivery-manual">
          <div className="simple-voter-action-row simple-voter-action-row-inline">
            <button
              type="button"
              className="simple-voter-secondary"
              aria-label="Generate codes for all residents"
              onClick={() => void Promise.all(recipients.map((r) => issueCode(r)))}
            >
              Generate codes for all residents
            </button>
            <button
              type="button"
              className="simple-voter-secondary"
              aria-label="Export name+code CSV"
              disabled={issued.length === 0}
              onClick={handleExport}
            >
              Export name+code CSV
            </button>
          </div>
          <table className="simple-resident-table" aria-label="Residents">
            <thead>
              <tr>
                <th scope="col">Masters list number</th>
                <th scope="col">Name</th>
                <th scope="col">One-time code</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((resident) => (
                <tr key={resident.mastersListNumber}>
                  <td>{resident.mastersListNumber}</td>
                  <td>{resident.name}</td>
                  <td>
                    <button
                      type="button"
                      className="simple-voter-secondary"
                      aria-label={`Generate code for resident ${resident.mastersListNumber}`}
                      onClick={() => void issueCode(resident)}
                    >
                      Generate code
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {issued.length > 0 ? (
            <div className="simple-resident-issued" aria-label="Issued codes">
              <p className="simple-voter-note">
                Shown once — copy now and hand to the resident. The exported
                name+code CSV is sensitive; delete it after distribution.
              </p>
              <div role="list">
                {issued.map((entry) => {
                  const copyKey = `delivery-otp-${entry.mastersListNumber}`;
                  const copied = isCopied(copyKey);
                  return (
                    <div
                      key={entry.mastersListNumber}
                      role="listitem"
                      className="simple-resident-issued-row"
                      aria-label={`Code for resident ${entry.mastersListNumber}`}
                    >
                      <span className="simple-resident-issued-copy">
                        <span className="simple-resident-issued-primary">
                          {entry.mastersListNumber} — {entry.name}
                        </span>
                        <code>{entry.code}</code>
                      </span>
                      <button
                        type="button"
                        className="simple-voter-secondary"
                        aria-label={`Copy code for resident ${entry.mastersListNumber}`}
                        onClick={() => void (async () => {
                          const copiedToClipboard = await tryWriteClipboard(entry.code);
                          if (copiedToClipboard) {
                            showCopied(copyKey);
                          }
                        })()}
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="simple-delivery-results">
        <h4 className="simple-voter-question">Delivery status</h4>
        <p className="simple-voter-note">
          Import the results CSV produced by the coordinator batch script
          (columns mastersListNumber, ok, detail, ref).
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Results CSV file"
          onChange={handleResultsImport}
        />
        {results.length > 0 ? (
          <table className="simple-resident-table" aria-label="Delivery status table">
            <thead>
              <tr>
                <th scope="col">Masters list number</th>
                <th scope="col">Status</th>
                <th scope="col">Detail</th>
                <th scope="col">Ref</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.mastersListNumber}>
                  <td>{row.mastersListNumber}</td>
                  <td>{row.ok ? "Sent" : "Failed"}</td>
                  <td>{row.detail}</td>
                  <td>{row.ref ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
