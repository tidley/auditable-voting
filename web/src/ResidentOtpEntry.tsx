import { useRef, useState } from "react";
import {
  ADMISSION_TTL_MS,
  MAX_OTP_ATTEMPTS,
  isOtpExpired,
  verifyOtp,
} from "./otpService";
import {
  findIssuedOtpRecord,
  isOtpRedeemed,
  markOtpRedeemed,
  recordResidentNpubBinding,
} from "./otpAdmissionRoster";

export interface ResidentOtpAdmissionResult {
  mastersListNumber: number;
  electionId: string;
}

interface ResidentOtpEntryProps {
  /**
   * The election to verify against. Omit (or pass an empty string) to search
   * every issued roster stored in this browser, which is how a resident
   * redeems a code without knowing the election id up front.
   */
  electionId?: string;
  /**
   * The voter's npub, bound to the redeemed code so the coordinator can push
   * this admission into the npub-keyed voting roster. Optional: when absent
   * the code is still redeemed and gated, but no voter identity is recorded.
   */
  voterNpub?: string;
  /**
   * Called once a code is successfully verified and marked redeemed. This is
   * the admission flag that gates ballot and private-invite access.
   */
  onAdmitted?: (result: ResidentOtpAdmissionResult) => void;
}

/**
 * Voter-side entry point for redeeming an issued one-time code.
 *
 * A resident enters their masters-list number and the 6-digit code the
 * organiser handed them out of band. Verification runs entirely in the
 * browser against the persisted issued-hash roster (`otpAdmissionRoster`):
 * no code or hash is sent anywhere. On success the code is marked redeemed
 * (so it cannot be used twice), the voter's npub is bound to the admission,
 * and `onAdmitted` reports the admission flag.
 */
export default function ResidentOtpEntry({ electionId, voterNpub, onAdmitted }: ResidentOtpEntryProps) {
  const [mastersListNumber, setMastersListNumber] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [admitted, setAdmitted] = useState<ResidentOtpAdmissionResult | null>(null);
  // Failed-attempt counts are kept in a ref (not state) because handleVerify
  // must read and increment them synchronously after an await — state reads
  // would be stale if two verifies resolve before a re-render.
  const failedAttemptsRef = useRef<Record<number, number>>({});

  function recordBindingIfKnown(mastersListNumberValue: number, electionIdValue: string) {
    if (voterNpub?.trim()) {
      recordResidentNpubBinding({
        mastersListNumber: mastersListNumberValue,
        npub: voterNpub.trim(),
        boundAt: Date.now(),
        electionId: electionIdValue,
      });
    }
  }

  async function handleVerify() {
    const mastersListNumberValue = Number(mastersListNumber.trim());
    if (!Number.isInteger(mastersListNumberValue) || mastersListNumberValue <= 0) {
      setStatus("Enter the resident's masters list number.");
      return;
    }

    const trimmedCode = code.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      setStatus("Enter the 6-digit code.");
      return;
    }

    const record = findIssuedOtpRecord(mastersListNumberValue, electionId);
    if (!record) {
      setStatus("No code has been issued for this resident.");
      return;
    }

    if (isOtpRedeemed(record.electionId, mastersListNumberValue)) {
      recordBindingIfKnown(mastersListNumberValue, record.electionId);
      setAdmitted({ mastersListNumber: mastersListNumberValue, electionId: record.electionId });
      setStatus("This code has already been redeemed.");
      onAdmitted?.({ mastersListNumber: mastersListNumberValue, electionId: record.electionId });
      return;
    }

    if (isOtpExpired(record.issuedAt, ADMISSION_TTL_MS)) {
      setStatus("This code has expired. Contact your organiser for a new one.");
      return;
    }

    const matches = await verifyOtp(trimmedCode, record.saltHash);
    if (matches) {
      failedAttemptsRef.current = { ...failedAttemptsRef.current, [mastersListNumberValue]: 0 };
      markOtpRedeemed(record.electionId, mastersListNumberValue);
      recordBindingIfKnown(mastersListNumberValue, record.electionId);
      setAdmitted({ mastersListNumber: mastersListNumberValue, electionId: record.electionId });
      setStatus("Code verified. You are admitted to vote.");
      onAdmitted?.({ mastersListNumber: mastersListNumberValue, electionId: record.electionId });
      return;
    }

    // Read and increment via the ref so two resolves landing before a
    // re-render both count (no stale-closure undercount of the lockout).
    const attempts = (failedAttemptsRef.current[mastersListNumberValue] ?? 0) + 1;
    failedAttemptsRef.current = { ...failedAttemptsRef.current, [mastersListNumberValue]: attempts };
    setStatus(attempts >= MAX_OTP_ATTEMPTS
      ? "Too many failed attempts. Contact your organiser for a new code."
      : "Incorrect code.");
  }

  const canVerify = mastersListNumber.trim() !== "" && code.trim().length > 0;

  return (
    <section className="simple-voter-section simple-resident-otp-entry" aria-label="Resident admission">
      <h3 className="simple-voter-question">Enter your one-time code</h3>
      <p className="simple-voter-note">
        Enter your masters list number and the 6-digit code your organiser
        gave you. Nothing is sent to a server; verification happens in this
        browser against the codes your organiser issued.
      </p>
      {admitted !== null ? (
        <p className="simple-voter-note" aria-label="Admission status">
          Admitted: resident {admitted.mastersListNumber} is eligible to vote.
        </p>
      ) : null}
      <form
        className="simple-resident-verify"
        onSubmit={(event) => {
          event.preventDefault();
          void handleVerify();
        }}
      >
        <div className="simple-voter-action-row simple-voter-action-row-inline">
          <input
            type="text"
            className="simple-voter-input"
            aria-label="Masters list number"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Masters list number"
            value={mastersListNumber}
            onChange={(event) => {
              setMastersListNumber(event.target.value);
              setStatus(null);
            }}
          />
          <input
            type="text"
            className="simple-voter-input"
            aria-label="One-time code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6-digit code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setStatus(null);
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
      </form>
      {status !== null ? <p className="simple-voter-note" role="status">{status}</p> : null}
    </section>
  );
}
