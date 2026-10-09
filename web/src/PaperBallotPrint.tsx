import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PaperBallot } from "./paperBallot";
import { DEFAULT_NOSTR_PUBLIC_RELAYS } from "./nostrRelayConfig";

interface PaperBallotPrintProps {
  ballot: PaperBallot;
}

export default function PaperBallotPrint({ ballot }: PaperBallotPrintProps) {
  const [npubQrDataUrl, setNpubQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    void QRCode.toDataURL(ballot.voterNpub, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 200,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    }).then(setNpubQrDataUrl);
  }, [ballot.voterNpub]);

  return (
    <div className="ballot-print">
      {/* Header */}
      <div className="ballot-header">
        <h1 className="ballot-title">{ballot.questionnaireTitle}</h1>
        <p className="ballot-id">Ballot ID: {ballot.questionnaireId}</p>
      </div>

      {/* Questions */}
      <div className="ballot-questions">
        {ballot.questions.map((question, index) => (
          <div key={question.questionId} className="ballot-question">
            <p className="ballot-question-prompt">
              {index + 1}. {question.prompt}
              {question.required && <span className="ballot-required">*</span>}
            </p>

            {question.type === "yes_no" && (
              <div className="ballot-yes-no">
                <label className="ballot-option">
                  <span className="ballot-checkbox">☐</span> Yes
                </label>
                <label className="ballot-option">
                  <span className="ballot-checkbox">☐</span> No
                </label>
              </div>
            )}

            {question.type === "free_text" && (
              <div className="ballot-blank-lines">
                <div className="ballot-blank-line" />
                <div className="ballot-blank-line" />
                <div className="ballot-blank-line" />
                <div className="ballot-blank-line" />
              </div>
            )}

            {question.type === "multiple_choice" && question.options && (
              <div className="ballot-options">
                {question.options.map((option) => (
                  <label key={option.optionId} className="ballot-option">
                    <span className="ballot-checkbox">☐</span> {option.label}
                  </label>
                ))}
              </div>
            )}

            {question.type === "rank" && question.options && (
              <div className="ballot-rank-options">
                {question.options.map((option, optIndex) => (
                  <label key={option.optionId} className="ballot-option ballot-rank-option">
                    <span className="ballot-rank-number">{optIndex + 1}.</span>{" "}
                    <span className="ballot-rank-line">______________</span>{" "}
                    {option.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Voter identity section */}
      <div className="ballot-voter">
        <h2 className="ballot-section-title">Voter Identity</h2>
        <div className="ballot-voter-details">
          <div className="ballot-voter-keys">
            <div className="ballot-key-row">
              <span className="ballot-key-label">nsec:</span>
              <code className="ballot-key-value">{ballot.voterNsec}</code>
            </div>
            <div className="ballot-key-row">
              <span className="ballot-key-label">npub:</span>
              <code className="ballot-key-value">{ballot.voterNpub}</code>
            </div>
          </div>
          <div className="ballot-qr-area">
            {npubQrDataUrl ? (
              <img
                src={npubQrDataUrl}
                alt="QR code for voter npub"
                className="ballot-qr-image"
              />
            ) : (
              <div className="ballot-qr-placeholder">Generating QR...</div>
            )}
          </div>
        </div>
      </div>

      {/* Invite code and relay info */}
      <div className="ballot-info">
        <h2 className="ballot-section-title">Voting Instructions</h2>
        {ballot.inviteCode && (
          <p className="ballot-invite">
            Invite Code: <code className="ballot-invite-code">{ballot.inviteCode}</code>
          </p>
        )}
        <div className="ballot-relays">
          <p className="ballot-relays-label">Relay Servers:</p>
          <ul className="ballot-relay-list">
            {DEFAULT_NOSTR_PUBLIC_RELAYS.map((relay) => (
              <li key={relay} className="ballot-relay-item">
                <code>{relay}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Generated timestamp */}
      <p className="ballot-timestamp">
        Generated: {new Date(ballot.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}