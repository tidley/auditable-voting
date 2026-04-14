import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import {
  TOKEN_FINGERPRINT_PALETTE,
  tokenIdLabel,
  tokenPatternDetail,
  tokenQrPayload,
} from "./tokenIdentity";

export default function TokenFingerprint({
  tokenId,
  label,
  size = 5,
  compact = false,
  large = false,
  xlarge = false,
  showQr = !compact,
  qrValue,
  hideMetadata = false,
}: {
  tokenId: string;
  label?: string;
  size?: number;
  compact?: boolean;
  large?: boolean;
  xlarge?: boolean;
  showQr?: boolean;
  qrValue?: string;
  hideMetadata?: boolean;
}) {
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const cells = tokenPatternDetail(tokenId, size);
  const qrPayload = qrValue ?? tokenQrPayload(tokenId);
  const qrDarkColor = useMemo(
    () => {
      const filled = cells.find((cell) => cell.filled);
      if (!filled) {
        return "#2e2218";
      }
      return TOKEN_FINGERPRINT_PALETTE[filled.colorIndex] ?? "#2e2218";
    },
    [cells],
  );

  useEffect(() => {
    let cancelled = false;

    if (!showQr) {
      setQrSrc(null);
      return;
    }

    void QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: compact ? 96 : (xlarge ? 432 : (large ? 288 : 144)),
      color: {
        dark: qrDarkColor,
        light: "#fffaf2",
      },
    }).then((value: string) => {
      if (!cancelled) {
        setQrSrc(value);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrSrc(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [compact, qrDarkColor, qrPayload, showQr]);

  useEffect(() => {
    if (!qrExpanded) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQrExpanded(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [qrExpanded]);

  return (
    <>
      <div
        className={`token-fingerprint${compact ? ' token-fingerprint-compact' : ''}${large ? ' token-fingerprint-large' : ''}${xlarge ? ' token-fingerprint-xlarge' : ''}`}
      >
        <div className='token-fingerprint-symbols'>
          <div
            className={`token-fingerprint-grid${showQr ? " token-fingerprint-grid-clickable" : ""}`}
            role={showQr ? "button" : "img"}
            tabIndex={showQr ? 0 : -1}
            aria-label={showQr
              ? `Expand QR for token ${tokenIdLabel(tokenId)}`
              : (label ?? `Token fingerprint ${tokenIdLabel(tokenId)}`)}
            style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
            onClick={() => {
              if (showQr && qrSrc) {
                setQrExpanded(true);
              }
            }}
            onKeyDown={(event) => {
              if (!showQr || !qrSrc) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setQrExpanded(true);
              }
            }}
          >
            {cells.map((cell, index) => (
              <span
                key={`${tokenId}-${index}`}
                className={`token-fingerprint-cell${cell.filled ? ' is-filled' : ' is-empty'}`}
                style={{
                  backgroundColor: cell.filled
                    ? TOKEN_FINGERPRINT_PALETTE[cell.colorIndex]
                    : '#efe6d6',
                }}
              />
            ))}
          </div>
          {showQr && (
            <button
              type='button'
              className='token-fingerprint-qr-shell token-fingerprint-qr-button'
              onClick={() => {
                if (qrSrc) {
                  setQrExpanded(true);
                }
              }}
              aria-label={`Expand QR for token ${tokenIdLabel(tokenId)}`}
              disabled={!qrSrc}
            >
              {qrSrc ? (
                <img
                  className='token-fingerprint-qr'
                  src={qrSrc}
                  alt={`Scannable QR for token ${tokenIdLabel(tokenId)}`}
                />
              ) : (
                <div
                  className='token-fingerprint-qr token-fingerprint-qr-fallback'
                  aria-hidden='true'
                />
              )}
            </button>
          )}
        </div>
      </div>
      {qrExpanded && qrSrc ? (
        <div
          className='token-fingerprint-overlay'
          role='dialog'
          aria-modal='true'
          aria-label={`Expanded QR for token ${tokenIdLabel(tokenId)}`}
          onClick={() => setQrExpanded(false)}
        >
          <button
            type='button'
            className='token-fingerprint-overlay-close'
            onClick={() => setQrExpanded(false)}
            aria-label='Close QR preview'
          >
            Close
          </button>
          <div
            className='token-fingerprint-overlay-card'
            onClick={(event) => event.stopPropagation()}
          >
            <img
              className='token-fingerprint-overlay-qr'
              src={qrSrc}
              alt={`Expanded QR for token ${tokenIdLabel(tokenId)}`}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
