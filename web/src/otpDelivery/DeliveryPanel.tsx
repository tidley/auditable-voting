import { useRef, useState, type ChangeEvent } from "react";
import type { QuestionnaireDefinition } from "../questionnaireProtocol";
import type { QuestionnaireOptionACoordinatorRuntime } from "../questionnaireOptionARuntime";
import {
  createPaperBallotAdmissionSheet,
  formatPaperBallotCode,
  paperBallotExpiryToIsoUtc,
  type PrintablePaperBallotAdmission,
} from "../paperBallotAdmission";
import { parseResidentCsv, type ResidentEntry } from "../residentRegister";
import { tryWriteClipboard } from "../clipboard";
import { useTransientCopiedLabel } from "../useTransientCopiedLabel";
import {
  buildEmailDeliveryBundleCsv,
  buildResidentCsv,
  escapeCsvField,
} from "./csv";
import UiDateTimeField from "../ui/UiDateTimeField";
import { resolveLocalised } from "../i18n/resolveLocale";

interface IssuedEmailAdmission {
  resident: ResidentEntry;
  admission: PrintablePaperBallotAdmission;
}

interface DraftResident {
  id: string;
  mastersListNumber: string;
  name: string;
  email: string;
  phone: string;
}

interface DeliveryPanelProps {
  electionId: string;
  definition: QuestionnaireDefinition | null;
  runtime: QuestionnaireOptionACoordinatorRuntime | null;
  voterUrl: string;
  onAdmissionsChanged?: () => void;
}

export function batchDefaultExpiry(now = new Date()): string {
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${expiry.getFullYear()}-${pad(expiry.getMonth() + 1)}-${pad(expiry.getDate())}T${pad(expiry.getHours())}:${pad(expiry.getMinutes())}`;
}

function csvHeader(csv: string): string[] {
  const first = csv.split(/\r?\n/).find((line) => line.trim());
  return (first ?? "").replace(/^\uFEFF/, "").split(",").map((value) => value.trim().toLowerCase());
}

function draftFromResident(resident: ResidentEntry, id: string): DraftResident {
  return {
    id,
    mastersListNumber: String(resident.mastersListNumber),
    name: resident.name ?? "",
    email: resident.email,
    phone: resident.phone ?? "",
  };
}

export function emailVoterUrl(voterUrl: string): string {
  try {
    const url = new URL(voterUrl);
    url.searchParams.delete("request_ballot");
    url.searchParams.delete("auto_request");
    return url.toString().replace(/\?$/, "");
  } catch {
    return voterUrl;
  }
}

export default function DeliveryPanel(props: DeliveryPanelProps) {
  const [rows, setRows] = useState<DraftResident[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [issued, setIssued] = useState<IssuedEmailAdmission[]>([]);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [status, setStatus] = useState("");
  const generating = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const nextRowId = useRef(0);
  const { isCopied, showCopied } = useTransientCopiedLabel();

  function newRowId() {
    nextRowId.current += 1;
    return `resident-row-${nextRowId.current}`;
  }

  function updateRow(id: string, field: keyof Omit<DraftResident, "id">, value: string) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
    setCsvErrors([]);
  }

  function validateRows() {
    const populated = rows.filter((row) => [row.mastersListNumber, row.name, row.email, row.phone].some((value) => value.trim()));
    if (!populated.length) {
      return { residents: [] as ResidentEntry[], errors: ["Add at least one resident."], populated };
    }
    const csv = [
      "masters_list_number,email,phone,name",
      ...populated.map((row) => [row.mastersListNumber, row.email, row.phone, row.name].map(escapeCsvField).join(",")),
    ].join("\n");
    const result = parseResidentCsv(csv);
    return { ...result, populated };
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const header = csvHeader(text);
      if (header.includes("code") || header.includes("expires_at") || header.includes("vote_url")) {
        setStatus("Import a resident contact CSV, not an existing email bundle.");
      } else if (header.includes("masters_list_number")) {
        if (issued.length) {
          setStatus("Codes have already been generated. The roster cannot be replaced.");
        } else {
          const result = parseResidentCsv(text);
          if (result.errors.length) {
            setCsvErrors(result.errors);
            setStatus("");
          } else {
            setRows(result.residents.map((resident) => draftFromResident(resident, newRowId())));
            setRevealed(new Set());
            setCsvErrors([]);
            setStatus(`${result.residents.length} resident${result.residents.length === 1 ? "" : "s"} imported.`);
          }
        }
      } else {
        setStatus("This CSV type is not recognised. Use a resident roster file.");
      }
    } catch {
      setStatus("The CSV could not be read.");
    }
    event.target.value = "";
  }

  function addRow() {
    setRows((current) => [...current, { id: newRowId(), mastersListNumber: "", name: "", email: "", phone: "" }]);
    setStatus("");
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
    setCsvErrors([]);
  }

  function applyDefaults() {
    setExpiresAt(batchDefaultExpiry());
    setStatus("Default expiry set to 24 hours from now.");
  }

  async function generate() {
    if (generating.current) return;
    if (issued.length) {
      setStatus("Codes have already been generated. Export the existing bundle; do not issue replacements.");
      return;
    }
    if (!props.runtime || !props.definition || props.definition.questionnaireId !== props.electionId || !props.voterUrl) {
      setStatus("Open and publish the questionnaire before generating resident email admissions.");
      return;
    }
    const expiry = paperBallotExpiryToIsoUtc(expiresAt);
    if (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) {
      setStatus("Code expiry must be in the future.");
      return;
    }
    const validation = validateRows();
    if (validation.errors.length) {
      setCsvErrors(validation.errors);
      setStatus("");
      return;
    }
    generating.current = true;
    try {
      const sheet = await createPaperBallotAdmissionSheet({
        electionId: props.electionId,
        masterlistNumbers: validation.residents.map((resident) => String(resident.mastersListNumber)),
        expiresAt: expiry,
      });
      if (sheet.length !== validation.residents.length) {
        setStatus("Check the expiry and resident details. No codes were generated.");
        return;
      }
      const canonicalRows = validation.populated.map((row, index) => draftFromResident(validation.residents[index], row.id));
      setRows(canonicalRows);
      sheet.forEach((entry) => props.runtime?.addPaperBallotAdmission(entry.admission));
      props.onAdmissionsChanged?.();
      setIssued(sheet.map((admission, index) => ({ admission, resident: validation.residents[index] })));
      setCsvErrors([]);
      setStatus(`${sheet.length} admission code${sheet.length === 1 ? "" : "s"} saved. Export the bundle now; plaintext codes are not retained after reload.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not generate admission codes.");
    } finally {
      generating.current = false;
    }
  }

  function toggleReveal(master: number) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(master)) next.delete(master);
      else next.add(master);
      return next;
    });
  }

  function download(csv: string, filename: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function buildIssuedBundle() {
    if (!issued.length || !props.voterUrl) return "";
    return buildEmailDeliveryBundleCsv(issued.map(({ resident, admission }) => ({
      mastersListNumber: String(resident.mastersListNumber),
      email: resident.email,
      phone: resident.phone,
      name: resident.name ?? "",
      code: admission.code,
      expiresAt: admission.admission.expiresAt,
      questionnaireTitle: resolveLocalised(props.definition?.title ?? "", "en").trim() || "Auditable voting questionnaire",
      voteUrl: emailVoterUrl(props.voterUrl),
    })));
  }

  function exportCsv() {
    const safeElectionId = props.electionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    if (issued.length) {
      const csv = buildIssuedBundle();
      if (!csv) {
        setStatus("Reopen the published questionnaire before exporting the admission bundle.");
        return;
      }
      download(csv, `resident-admission-emails-${safeElectionId}.csv`);
      setStatus("Admission bundle exported. It contains contact details and plaintext codes; keep it private.");
      return;
    }
    const validation = validateRows();
    if (validation.errors.length) {
      setCsvErrors(validation.errors);
      setStatus("");
      return;
    }
    download(buildResidentCsv(validation.residents.map((resident) => ({
      mastersListNumber: String(resident.mastersListNumber),
      email: resident.email,
      phone: resident.phone,
      name: resident.name,
    }))), `resident-contacts-${safeElectionId}.csv`);
    setStatus("Resident CSV exported.");
  }

  const hasRows = rows.some((row) => [row.mastersListNumber, row.name, row.email, row.phone].some((value) => value.trim()));

  return <section className="simple-voter-section simple-delivery-panel" aria-label="Resident email admission">
    <p className="simple-voter-note">Generate paper-compatible admission codes and export them for delivery.</p>
    <details className="simple-organiser-disclosure">
      <summary>Storage and privacy</summary>
      <p className="simple-voter-note">Contact details and codes stay in this browser until export and never enter public voting events. Reload discards plaintext codes but not issued admissions. Exported files are sensitive; delete them after use.</p>
    </details>

    <div className="simple-voter-action-row simple-voter-action-row-inline" aria-label="Resident table actions">
      <button type="button" className="simple-voter-secondary" disabled={Boolean(issued.length)} onClick={applyDefaults}>Set defaults</button>
      <button type="button" className="simple-voter-secondary" onClick={() => importRef.current?.click()}>Import</button>
      <button type="button" className="simple-voter-secondary" disabled={!hasRows} onClick={exportCsv}>Export</button>
      <button type="button" className="simple-voter-secondary" disabled={Boolean(issued.length)} onClick={addRow}>Add row</button>
      <input ref={importRef} type="file" accept=".csv,text/csv" hidden aria-label="Import resident CSV" onChange={(event) => void handleImport(event)} />
    </div>

    {rows.length ? <div className="simple-resident-table-wrap">
      <table className="simple-resident-table" aria-label="Residents">
      <thead><tr>
        <th scope="col">Number</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Code</th><th scope="col"><span aria-hidden="true">Remove</span></th>
      </tr></thead>
      <tbody>{rows.map((resident) => {
        const master = resident.mastersListNumber.trim();
        const entry = issued.find((candidate) => String(candidate.resident.mastersListNumber) === master);
        const isRevealed = entry ? revealed.has(entry.resident.mastersListNumber) : false;
        const copyKey = `email-admission-${master}`;
        const copied = isCopied(copyKey);
        return <tr key={resident.id}>
          <td><input className="simple-voter-input" aria-label={`Master-list number for row ${resident.id}`} value={resident.mastersListNumber} disabled={Boolean(issued.length)} onChange={(event) => updateRow(resident.id, "mastersListNumber", event.target.value)} /></td>
          <td><input className="simple-voter-input" aria-label={`Name for row ${resident.id}`} value={resident.name} disabled={Boolean(issued.length)} onChange={(event) => updateRow(resident.id, "name", event.target.value)} /></td>
          <td><input type="email" className="simple-voter-input" aria-label={`Email for row ${resident.id}`} value={resident.email} disabled={Boolean(issued.length)} onChange={(event) => updateRow(resident.id, "email", event.target.value)} /></td>
          <td><input type="tel" className="simple-voter-input" aria-label={`Phone for row ${resident.id}`} value={resident.phone} disabled={Boolean(issued.length)} onChange={(event) => updateRow(resident.id, "phone", event.target.value)} /></td>
          <td>{entry ? <div className="simple-voter-action-row simple-voter-action-row-inline" aria-label={`Code for resident ${master}`}>
            <code>{isRevealed ? formatPaperBallotCode(entry.admission.code) : "•••••-•••••"}</code>
            <button type="button" className="simple-voter-secondary" aria-label={`${isRevealed ? "Hide" : "Reveal"} code for resident ${master}`} onClick={() => toggleReveal(entry.resident.mastersListNumber)}>{isRevealed ? "Hide" : "Reveal"}</button>
            {isRevealed ? <button type="button" className="simple-voter-secondary" aria-label={`${copied ? "Copied" : "Copy"} code for resident ${master}`} onClick={() => void (async () => {
              const copiedToClipboard = await tryWriteClipboard(formatPaperBallotCode(entry.admission.code));
              if (copiedToClipboard) showCopied(copyKey);
              else setStatus("Clipboard access was unavailable. Keep the code revealed and copy it manually.");
            })()}>{copied ? "Copied" : "Copy"}</button> : null}
          </div> : <span className="simple-voter-note">Not generated</span>}</td>
          <td><button type="button" className="simple-voter-secondary" aria-label={`Remove resident row ${resident.id}`} disabled={Boolean(issued.length)} onClick={() => removeRow(resident.id)}>Remove</button></td>
        </tr>;
      })}</tbody>
      </table>
    </div> : <p className="simple-voter-note">No residents yet. Import a CSV or add a row.</p>}

    {csvErrors.length ? <div className="simple-voter-note" role="alert" aria-label="Resident CSV errors">
      <ul>{csvErrors.map((error) => <li key={error}>{error}</li>)}</ul>
    </div> : null}

    <UiDateTimeField label="Code expiry" value={expiresAt} onChange={setExpiresAt} isDisabled={Boolean(issued.length)} />
    <p className="simple-voter-note">Local time; included in UTC in each exported bundle.</p>
    <div className="simple-voter-action-row simple-voter-action-row-inline">
      {!issued.length ? <button type="button" className="simple-voter-secondary" disabled={!expiresAt || !hasRows} onClick={() => void generate()}>Generate admission codes</button> : null}
    </div>
    {status ? <p className="simple-voter-note" role="status">{status}</p> : null}
  </section>;
}
