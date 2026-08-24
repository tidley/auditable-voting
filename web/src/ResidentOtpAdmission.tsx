import { useRef, useState, type ChangeEvent } from "react";
import {
  ADMISSION_TTL_MS,
  generateOtp,
  hashOtp,
  isOtpExpired,
  MAX_OTP_ATTEMPTS,
  verifyOtp,
} from "./otpService";
import { parseResidentCsv, type ResidentEntry } from "./residentRegister";
import { tryWriteClipboard } from "./clipboard";
import { useTransientCopiedLabel } from "./useTransientCopiedLabel";

interface IssuedResidentCode {
  mastersListNumber: number;
  name: string;
  code: string;
  hash: string;
  issuedAt: number;
}

export function formatOtpIssuedAt(issuedAt: number): string {
  return new Date(issuedAt).toLocaleTimeString("en-GB", { hour12: false });
}

export default function ResidentOtpAdmission() {
  const [residents, setResidents] = useState<ResidentEntry[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [issued, setIssued] = useState<IssuedResidentCode[]>([]);
  const [isIssuingAll, setIsIssuingAll] = useState(false);
  const [verifyResident, setVerifyResident] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyStatus, setVerifyStatus] = useState<string | null>(null);
  const { isCopied, showCopied } = useTransientCopiedLabel();
  // Failed-attempt counts are kept in a ref (not state) because handleVerify
  // must read and increment them synchronously after an await — state reads
  // would be stale if two verifies resolve before a re-render.
  const failedAttemptsRef = useRef<Record<number, number>>({});
  // Bumped on every roster change so in-flight batch loops and late hashOtp
  // resolutions from a previous roster are discarded.
  const rosterVersionRef = useRef(0);

  async function handleCsvChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    rosterVersionRef.current += 1;
    let result: ReturnType<typeof parseResidentCsv>;
    try {
      const text = await file.text();
      result = parseResidentCsv(text);
    } catch {
      setCsvErrors(["The file could not be read."]);
      setResidents([]);
      setIssued([]);
      failedAttemptsRef.current = {};
      setVerifyResident("");
      setVerifyCode("");
      setVerifyStatus(null);
      event.target.value = "";
      return;
    }
    setResidents(result.residents);
    setCsvErrors(result.errors);
    setIssued([]);
    failedAttemptsRef.current = {};
    setVerifyResident("");
    setVerifyCode("");
    setVerifyStatus(null);
    event.target.value = "";
  }

  async function issueCode(resident: ResidentEntry, rosterVersion: number) {
    const code = generateOtp();
    const hash = await hashOtp(code);
    if (rosterVersionRef.current !== rosterVersion) {
      return;
    }
    const issuedAt = Date.now();
    setIssued((current) => [
      ...current.filter((entry) => entry.mastersListNumber !== resident.mastersListNumber),
      { mastersListNumber: resident.mastersListNumber, name: resident.name ?? "", code, hash, issuedAt },
    ]);
    failedAttemptsRef.current = { ...failedAttemptsRef.current, [resident.mastersListNumber]: 0 };
  }

  async function issueAllCodes() {
    if (isIssuingAll) {
      return;
    }
    setIsIssuingAll(true);
    try {
      const rosterVersion = rosterVersionRef.current;
      for (const resident of residents) {
        if (rosterVersionRef.current !== rosterVersion) {
          return;
        }
        await issueCode(resident, rosterVersion);
      }
    } finally {
      setIsIssuingAll(false);
    }
  }

  async function handleVerify() {
    const mastersListNumber = Number(verifyResident);
    const record = issued.find((entry) => entry.mastersListNumber === mastersListNumber);
    if (!record) {
      setVerifyStatus("No code has been issued for this resident yet.");
      return;
    }
    const code = verifyCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setVerifyStatus("Enter the 6-digit code.");
      return;
    }
    if (isOtpExpired(record.issuedAt, ADMISSION_TTL_MS)) {
      setVerifyStatus("This code has expired. Generate a new code.");
      return;
    }
    const matches = await verifyOtp(code, record.hash);
    if (matches) {
      failedAttemptsRef.current = { ...failedAttemptsRef.current, [mastersListNumber]: 0 };
      setVerifyStatus(`Code verified for resident ${mastersListNumber}.`);
      return;
    }
    // Read and increment via the ref so two resolves landing before a
    // re-render both count (no stale-closure undercount of the lockout).
    const attempts = (failedAttemptsRef.current[mastersListNumber] ?? 0) + 1;
    failedAttemptsRef.current = { ...failedAttemptsRef.current, [mastersListNumber]: attempts };
    setVerifyStatus(attempts >= MAX_OTP_ATTEMPTS
      ? "Too many failed attempts. Generate a new code to continue."
      : "Incorrect code.");
  }

  const canVerify = residents.length > 0 && verifyResident !== "" && verifyCode.trim().length > 0;

  return (
    <section className="simple-voter-section simple-resident-admission" aria-label="Resident admission">
      <h3 className="simple-voter-question">Resident admission</h3>
      <p className="simple-voter-note">
        Upload a CSV with the header masters_list_number,email,phone,name.
        One-time codes are shown once when generated and are handed to residents
        out of band; nothing is sent to a server, and only salted hashes are kept
        for verification while this section stays mounted. This demo does not
        send codes by email or SMS.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="Residents CSV file"
        onChange={(event) => void handleCsvChange(event)}
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
      {residents.length > 0 ? (
        <div className="simple-resident-admission-body">
          <table className="simple-resident-table" aria-label="Residents">
            <thead>
              <tr>
                <th scope="col">Masters list number</th>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col">One-time code</th>
              </tr>
            </thead>
            <tbody>
              {residents.map((resident) => (
                <tr key={resident.mastersListNumber}>
                  <td>{resident.mastersListNumber}</td>
                  <td>{resident.name}</td>
                  <td>{resident.email}</td>
                  <td>{resident.phone}</td>
                  <td>
                    <button
                      type="button"
                      className="simple-voter-secondary"
                      aria-label={`Generate code for resident ${resident.mastersListNumber}`}
                      onClick={() => void issueCode(resident, rosterVersionRef.current)}
                    >
                      Generate code
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="simple-voter-action-row simple-voter-action-row-inline">
            <button
              type="button"
              className="simple-voter-secondary"
              aria-label="Generate codes for all residents"
              disabled={isIssuingAll}
              onClick={() => void issueAllCodes()}
            >
              Generate codes for all residents
            </button>
          </div>
        </div>
      ) : null}
      {issued.length > 0 ? (
        <div className="simple-resident-issued" aria-label="Issued codes">
          <h4 className="simple-voter-question">Issued codes</h4>
          <p className="simple-voter-note">Shown once — copy now and hand to the resident.</p>
          <div role="list">
            {issued.map((entry) => {
              const copyKey = `resident-otp-${entry.mastersListNumber}`;
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
                    <span className="simple-resident-issued-time">issued {formatOtpIssuedAt(entry.issuedAt)}</span>
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
      {residents.length > 0 ? (
        <form
          className="simple-resident-verify"
          onSubmit={(event) => {
            event.preventDefault();
            void handleVerify();
          }}
        >
          <h4 className="simple-voter-question">Verify a code</h4>
          <div className="simple-voter-action-row simple-voter-action-row-inline">
            <select
              className="simple-voter-input"
              aria-label="Resident to verify"
              value={verifyResident}
              onChange={(event) => {
                setVerifyResident(event.target.value);
                setVerifyStatus(null);
              }}
            >
              <option value="">Select resident…</option>
              {residents.map((resident) => (
                <option key={resident.mastersListNumber} value={String(resident.mastersListNumber)}>
                  {resident.mastersListNumber} — {resident.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="simple-voter-input"
              aria-label="One-time code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={verifyCode}
              onChange={(event) => {
                setVerifyCode(event.target.value);
                setVerifyStatus(null);
              }}
            />
            <button
              type="submit"
              className="simple-voter-secondary"
              aria-label="Verify code"
              disabled={!canVerify}
            >
              Verify
            </button>
          </div>
          {verifyStatus !== null ? <p className="simple-voter-note" role="status">{verifyStatus}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
