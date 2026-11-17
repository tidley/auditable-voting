import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
  parseResultsCsv,
  type DeliveryResultRow,
} from "./csv";
import UiDateTimeField from "../ui/UiDateTimeField";
import { resolveLocalised } from "../i18n/resolveLocale";
import type { SignerService } from "../services/signerService";
import { emailSenderEndpoints, extractBundleElectionId, nip98Authorization } from "./relayAuth";

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
  signer?: SignerService | null;
  onAdmissionsChanged?: () => void;
}

type SenderTransport = "smtp" | "cashu";

interface SenderHealth {
  service: string;
  transports: SenderTransport[];
  maxRecipients: number;
}

const HEALTH_TIMEOUT_MS = 4_000;
const SEND_RETRY_DELAY_MS = 250;
const RELAY_URL_STORAGE_KEY = "app:auditable-voting:email-relay-url";

function readStoredRelayUrl(): string {
  try {
    return window.localStorage.getItem(RELAY_URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

async function probeSenderHealth(endpoints: ReturnType<typeof emailSenderEndpoints>, signal?: AbortSignal): Promise<SenderHealth> {
  const response = await fetch(endpoints.health, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Email sender unavailable.");
  const health = await response.json() as Partial<SenderHealth>;
  const expectedService = endpoints.remote ? "auditable-voting-email-relay" : "auditable-voting-email-sender";
  if (health.service !== expectedService || !Array.isArray(health.transports) || typeof health.maxRecipients !== "number") {
    throw new Error("Email sender unavailable.");
  }
  const transports = health.transports.filter((value): value is SenderTransport => value === "smtp" || value === "cashu");
  return { service: health.service, transports, maxRecipients: health.maxRecipients };
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
  const hostedOrigin = typeof window !== "undefined"
    && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  const [rows, setRows] = useState<DraftResident[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [issued, setIssued] = useState<IssuedEmailAdmission[]>([]);
  const [deliveryBundle, setDeliveryBundle] = useState<{ csv: string; count: number; fileName: string; electionId: string } | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [status, setStatus] = useState("");
  const [delivery, setDelivery] = useState<Record<string, DeliveryResultRow>>({});
  const [senderHealth, setSenderHealth] = useState<SenderHealth | null>(null);
  const [senderCheck, setSenderCheck] = useState<"checking" | "available" | "unavailable">("checking");
  const [transport, setTransport] = useState<SenderTransport>("smtp");
  const [relayUrl, setRelayUrl] = useState(readStoredRelayUrl);
  const [sending, setSending] = useState(false);
  const generating = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const nextRowId = useRef(0);
  const { isCopied, showCopied } = useTransientCopiedLabel();

  useEffect(() => {
    try {
      if (relayUrl.trim()) window.localStorage.setItem(RELAY_URL_STORAGE_KEY, relayUrl);
      else window.localStorage.removeItem(RELAY_URL_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; the field still works for this session.
    }
  }, [relayUrl]);

  useEffect(() => {
    const controller = new AbortController();
    const endpoints = emailSenderEndpoints(relayUrl);
    let active = true;
    setSenderCheck("checking");
    void probeSenderHealth(endpoints, controller.signal)
      .then((health) => {
        if (!active) return;
        setSenderHealth(health);
        setTransport((current) => health.transports.includes(current) ? current : health.transports[0] ?? "smtp");
        setSenderCheck("available");
      })
      .catch(() => {
        if (active) setSenderCheck("unavailable");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [relayUrl]);

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
      if (header.includes("code") && header.includes("expires_at") && header.includes("vote_url")) {
        if (issued.length) {
          setStatus("This page already holds a generated batch. Export or send it first, then reload before loading an exported bundle.");
        } else if (!["masters_list_number", "email", "code", "expires_at", "questionnaire_title", "vote_url"].every((name) => header.includes(name))) {
          setStatus("This is not a complete exported admission bundle. Export the bundle from Resident email admission and try again.");
        } else {
          const count = text.split(/\r?\n/).filter((line) => line.trim()).length - 1;
          if (count < 1) {
            setStatus("The exported bundle contains no recipients.");
          } else {
            setDeliveryBundle({ csv: text, count, fileName: file.name, electionId: extractBundleElectionId(text) });
            setRows([]);
            setIssued([]);
            setRevealed(new Set());
            setCsvErrors([]);
            setDelivery({});
            setStatus(`Exported delivery bundle loaded: ${count} recipient${count === 1 ? "" : "s"}. These codes are already registered; sending will not create new codes.`);
          }
        }
      } else if (header[0] === "masterslistnumber" && header.includes("ok") && header.includes("detail")) {
        const results = parseResultsCsv(text);
        if (!results.length) {
          setStatus("The delivery-results CSV contains no rows.");
        } else {
          setDelivery(Object.fromEntries(results.map((result) => [result.mastersListNumber, result])));
          setStatus(`${results.length} delivery status row${results.length === 1 ? "" : "s"} imported.`);
        }
      } else if (header.includes("masters_list_number")) {
        if (issued.length) {
          setStatus("Codes have already been generated. Delivery results can be imported, but the roster cannot be replaced.");
        } else {
          const result = parseResidentCsv(text);
          if (result.errors.length) {
            setCsvErrors(result.errors);
            setStatus("");
          } else {
            setDeliveryBundle(null);
            setRows(result.residents.map((resident) => draftFromResident(resident, newRowId())));
            setRevealed(new Set());
            setCsvErrors([]);
            setStatus(`${result.residents.length} resident${result.residents.length === 1 ? "" : "s"} imported.`);
          }
        }
      } else {
        setStatus("This CSV type is not recognised. Use a resident roster or delivery-results file.");
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
      setStatus(`${sheet.length} admission code${sheet.length === 1 ? "" : "s"} saved. Send email or export the bundle now; plaintext codes are not retained after reload.`);
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
    if (deliveryBundle) return deliveryBundle.csv;
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

  function applyDeliveryResults(results: Array<{ master: string; ok: boolean; detail: string; ref?: string }>) {
    if (!results.length) return;
    setDelivery((current) => ({
      ...current,
      ...Object.fromEntries(results.map((result) => [result.master, {
        mastersListNumber: result.master,
        ok: result.ok,
        detail: result.detail,
        ref: result.ref,
      }])),
    }));
  }

  async function sendEmails() {
    if (sending) return;
    const bundleCsv = buildIssuedBundle();
    if (!bundleCsv) {
      setStatus("Publish and open the questionnaire before sending email.");
      return;
    }
    const endpoints = emailSenderEndpoints(relayUrl);
    setSending(true);
    setStatus(endpoints.remote ? "Checking the remote email relay…" : "Checking the local email sender…");
    try {
      // The mount-time check can be minutes stale: the companion may have
      // restarted (or the dev proxy may have lost its socket) since then.
      // Re-probe immediately before the POST so an unavailable sender produces
      // an actionable message instead of an opaque 502.
      let health: SenderHealth;
      try {
        health = await probeSenderHealth(endpoints, timeoutSignal(HEALTH_TIMEOUT_MS));
        setSenderHealth(health);
        setSenderCheck("available");
      } catch {
        setSenderCheck("unavailable");
        setStatus(endpoints.remote
          ? "The remote email relay is not reachable. Check the URL, CORS and relay status."
          : 'Local email sender is not reachable. Start it with "npm --prefix web run email:dev" (it starts the sender before Vite) and retry; recipients already sent are skipped.');
        return;
      }
      if (!health.transports.includes(transport)) {
        setStatus(`The email sender has no ${transport === "smtp" ? "SMTP" : "cashu.email"} credentials configured.`);
        return;
      }
      if (endpoints.remote && !props.signer) {
        setStatus("Connect a coordinator signer before sending through a remote relay.");
        return;
      }
      const relayElectionId = deliveryBundle?.electionId || props.electionId;
      if (endpoints.remote && !relayElectionId) {
        setStatus("The bundle does not include an election ID. Select the questionnaire or load an exported bundle before using a remote relay.");
        return;
      }

      setStatus(`Sending ${deliveryBundle?.count ?? issued.length} email${(deliveryBundle?.count ?? issued.length) === 1 ? "" : "s"} through ${transport === "smtp" ? "SMTP" : "cashu.email"}…`);
      const postBatch = async () => {
        if (endpoints.remote && props.signer) {
          const body = JSON.stringify({ electionId: relayElectionId, bundleCsv });
          const authorization = await nip98Authorization(props.signer, endpoints.send, body);
          return fetch(endpoints.send, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", authorization },
            body,
          });
        }
        return fetch(endpoints.send, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ transport, bundleCsv }),
        });
      };
      const readPayload = async (response: Response) => await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        sent?: number;
        skipped?: number;
        failed?: number;
        notAttempted?: number;
        satsSpent?: number;
        capUsedToday?: number;
        capRemaining?: number;
        results?: Array<{ master: string; ok: boolean; detail: string; ref?: string }>;
      };
      const retryableStatus = (status: number) => status === 502 || status === 503 || status === 504;
      let response = await postBatch();
      let payload = await readPayload(response);
      const proxyFailure = !endpoints.remote && retryableStatus(response.status)
        && (payload.code === "proxy_unreachable" || !payload.error);
      if (proxyFailure) {
        // A proxy-level 502/503/504 means the request never reached the send
        // handler, but a response can also be lost after the handler ran. The
        // sender's ledger fingerprints every recipient, so one retry is safe:
        // anything already delivered comes back as "already sent".
        setStatus("The local sender did not answer through the dev proxy; retrying once — already-sent recipients are skipped…");
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
        response = await postBatch();
        payload = await readPayload(response);
      }
      applyDeliveryResults(payload.results ?? []);
      if (!response.ok) {
        if (payload.error) throw new Error(payload.error);
        if (!endpoints.remote && retryableStatus(response.status)) {
          throw new Error(`the dev proxy could not reach the local email sender (HTTP ${response.status}) after one retry. Start the companion with "npm --prefix web run email:dev" and retry; the ledger skips recipients already sent.`);
        }
        throw new Error(endpoints.remote ? "The relay rejected the batch." : "The local sender rejected the batch.");
      }
      const notAttempted = payload.notAttempted ?? 0;
      const capSuffix = transport === "cashu" && typeof payload.satsSpent === "number"
        ? ` ${payload.satsSpent} sats; daily cap ${payload.capUsedToday ?? 0}/100 used, ${payload.capRemaining ?? 0} remaining.`
        : "";
      setStatus(`Email delivery: ${payload.sent ?? 0} sent, ${payload.skipped ?? 0} already sent, ${payload.failed ?? 0} failed${notAttempted ? `, ${notAttempted} not attempted` : ""}.${capSuffix}`);
    } catch (error) {
      setStatus(`Email sending failed: ${error instanceof Error ? error.message : "local sender unavailable"}`);
    } finally {
      setSending(false);
    }
  }

  function exportCsv() {
    const safeElectionId = props.electionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    if (deliveryBundle) {
      download(deliveryBundle.csv, `resident-admission-emails-${safeElectionId}.csv`);
      setStatus("Delivery bundle exported again. It contains contact details and plaintext codes; keep it private.");
      return;
    }
    if (issued.length) {
      const csv = buildIssuedBundle();
      if (!csv) {
        setStatus("Reopen the published questionnaire before exporting the email bundle.");
        return;
      }
      download(csv, `resident-admission-emails-${safeElectionId}.csv`);
      setStatus("Email bundle exported. It contains contact details and plaintext codes; keep it private.");
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

  const hasBundle = Boolean(deliveryBundle);
  const hasRows = rows.some((row) => [row.mastersListNumber, row.name, row.email, row.phone].some((value) => value.trim()));
  const relayEndpoints = emailSenderEndpoints(relayUrl);

  return <section className="simple-voter-section simple-delivery-panel" aria-label="Resident email admission">
    <p className="simple-voter-note">Generate paper-compatible codes and email them from the coordinator's computer.</p>
    <details className="simple-organiser-disclosure">
      <summary>Storage and privacy</summary>
      <p className="simple-voter-note">Contact details and codes stay in this browser until export and never enter public voting events. Reload discards plaintext codes but not issued admissions. Exported files are sensitive; delete them after use.</p>
    </details>

    <details className="simple-organiser-disclosure">
      <summary>Remote email relay (optional)</summary>
      <label className="simple-voter-field">
        <span>Relay URL</span>
        <input
          className="simple-voter-input"
          aria-label="Remote email relay URL"
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.target.value)}
          placeholder="https://mail.example.org"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="simple-voter-note">Leave empty to use the local companion. A remote relay sees recipient addresses and admission codes; use only a relay you trust.</p>
    </details>

    <div className="simple-voter-action-row simple-voter-action-row-inline" aria-label="Resident table actions">
      <button type="button" className="simple-voter-secondary" disabled={Boolean(issued.length) || hasBundle} onClick={applyDefaults}>Set defaults</button>
      <button type="button" className="simple-voter-secondary" onClick={() => importRef.current?.click()}>Import</button>
      <button type="button" className="simple-voter-secondary" disabled={!(hasRows || hasBundle)} onClick={exportCsv}>Export</button>
      <button type="button" className="simple-voter-secondary" disabled={Boolean(issued.length) || hasBundle} onClick={addRow}>Add row</button>
      <input ref={importRef} type="file" accept=".csv,text/csv" hidden aria-label="Import resident, delivery results, or exported delivery bundle CSV" onChange={(event) => void handleImport(event)} />
    </div>

    {hasBundle ? <div className="simple-voter-note" role="status" aria-label="Loaded delivery bundle">
      Loaded <strong>{deliveryBundle?.count}</strong> recipient{deliveryBundle?.count === 1 ? "" : "s"} from <code>{deliveryBundle?.fileName}</code>. The codes were already generated and registered; sending will not create replacement codes. Export the bundle again before reloading.
    </div> : null}

    {rows.length ? <div className="simple-resident-table-wrap">
      <table className="simple-resident-table" aria-label="Residents">
      <thead><tr>
        <th scope="col">Number</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Code</th><th scope="col">Delivery</th><th scope="col"><span aria-hidden="true">Remove</span></th>
      </tr></thead>
      <tbody>{rows.map((resident) => {
        const master = resident.mastersListNumber.trim();
        const entry = issued.find((candidate) => String(candidate.resident.mastersListNumber) === master);
        const isRevealed = entry ? revealed.has(entry.resident.mastersListNumber) : false;
        const copyKey = `email-admission-${master}`;
        const copied = isCopied(copyKey);
        const deliveryRow = delivery[master];
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
          <td>{deliveryRow ? <span title={deliveryRow.detail}>{deliveryRow.ok ? "Sent" : deliveryRow.detail.startsWith("not attempted") ? `Not sent: ${deliveryRow.detail.slice("not attempted: ".length)}` : `Failed: ${deliveryRow.detail}`}</span> : <span>Not sent</span>}</td>
          <td><button type="button" className="simple-voter-secondary" aria-label={`Remove resident row ${resident.id}`} disabled={Boolean(issued.length)} onClick={() => removeRow(resident.id)}>Remove</button></td>
        </tr>;
      })}</tbody>
      </table>
    </div> : !hasBundle ? <p className="simple-voter-note">No residents yet. Import a CSV or add a row.</p> : null}

    {csvErrors.length ? <div className="simple-voter-note" role="alert" aria-label="Resident CSV errors">
      <ul>{csvErrors.map((error) => <li key={error}>{error}</li>)}</ul>
    </div> : null}

    {issued.length || hasBundle ? <div className="simple-voter-action-row simple-voter-action-row-inline" aria-label="Local email sender">
      {senderCheck === "checking" ? <p className="simple-voter-note">{relayEndpoints.remote ? "Checking the remote email relay…" : "Checking local email sender…"}</p> : null}
      {senderCheck === "unavailable" ? <p className="simple-voter-note">
        {relayEndpoints.remote
          ? <>The remote relay at <code>{relayEndpoints.base}</code> is not reachable. Check the URL, CORS and relay status.</>
          : hostedOrigin
            ? <>This hosted page cannot reach your local email companion. Export the bundle, open the local coordinator URL, then import the bundle here to send. Or send the exported CSV with <code>scripts/otp-send-email.mjs</code>.</>
            : <>Local sender not connected. Run <code>npm --prefix web run email:dev</code> and use its local URL to send directly. Export remains available.</>}
      </p> : null}
      {senderCheck === "available" && relayEndpoints.remote ? <p className="simple-voter-note">Sending through <code>{relayEndpoints.base}</code>. The relay will see recipient addresses and admission codes.</p> : null}
      {senderCheck === "available" && senderHealth?.transports.length ? <>
        <label htmlFor="email-sender-transport">Email sender</label>
        <select
          id="email-sender-transport"
          className="simple-voter-input simple-delivery-transport"
          aria-label="Email sender"
          value={transport}
          disabled={sending || relayEndpoints.remote}
          onChange={(event) => setTransport(event.target.value as SenderTransport)}
        >
          {senderHealth.transports.includes("smtp") ? <option value="smtp">SMTP mailbox</option> : null}
          {!relayEndpoints.remote && senderHealth.transports.includes("cashu") ? <option value="cashu">cashu.email</option> : null}
        </select>
        <button type="button" className="simple-voter-secondary" disabled={sending || (relayEndpoints.remote && !props.signer)} onClick={() => void sendEmails()}>
          {sending ? "Sending…" : "Send emails"}
        </button>
      </> : null}
      {senderCheck === "available" && !senderHealth?.transports.length ? <p className="simple-voter-note">The email sender is running but has no SMTP or cashu.email credentials configured.</p> : null}
    </div> : null}

    {!hasBundle ? <>
      <UiDateTimeField label="Code expiry" value={expiresAt} onChange={setExpiresAt} isDisabled={Boolean(issued.length)} />
      <p className="simple-voter-note">Local time; included in UTC in each email.</p>
      <div className="simple-voter-action-row simple-voter-action-row-inline">
        {!issued.length ? <button type="button" className="simple-voter-secondary" disabled={!expiresAt || !hasRows} onClick={() => void generate()}>Generate admission codes</button> : null}
      </div>
    </> : null}
    {status ? <p className="simple-voter-note" role="status">{status}</p> : null}
  </section>;
}
