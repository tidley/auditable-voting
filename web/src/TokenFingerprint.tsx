import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  TOKEN_FINGERPRINT_PALETTE,
  tokenIdLabel,
  tokenPatternDetail,
  tokenQrPayload,
} from "./tokenIdentity";
import { UiButton } from "./ui/DesignLayer";

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
  fingerprintTitle,
  qrTitle,
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
  fingerprintTitle?: string;
  qrTitle?: string;
}) {
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [expandedPanel, setExpandedPanel] = useState<"fingerprint" | "qr" | null>(null);
  const cells = tokenPatternDetail(tokenId, size);
  const qrPayload = qrValue ?? tokenQrPayload(tokenId);

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
        dark: "#2e2218",
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
  }, [compact, qrPayload, showQr]);

  useEffect(() => {
    if (!expandedPanel) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpandedPanel(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expandedPanel]);

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
              ? `Open Colour ID for token ${tokenIdLabel(tokenId)}`
              : (label ?? `Token fingerprint ${tokenIdLabel(tokenId)}`)}
            data-tooltip={fingerprintTitle || undefined}
            style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
            onClick={() => {
              if (showQr) {
                setExpandedPanel("fingerprint");
              }
            }}
            onKeyDown={(event) => {
              if (!showQr) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpandedPanel("fingerprint");
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
            <UiButton
              icon={false}
              className='token-fingerprint-qr-shell token-fingerprint-qr-button'
              onPress={() => {
                if (qrSrc) {
                  setExpandedPanel("qr");
                }
              }}
              aria-label={`Expand QR for token ${tokenIdLabel(tokenId)}`}
              data-tooltip={qrTitle || undefined}
              isDisabled={!qrSrc}
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
            </UiButton>
          )}
        </div>
      </div>
      {expandedPanel ? (
        <div
          className='token-fingerprint-overlay'
          role='dialog'
          aria-modal='true'
          aria-label={expandedPanel === "qr"
            ? `Expanded QR for token ${tokenIdLabel(tokenId)}`
            : `Expanded Colour ID for token ${tokenIdLabel(tokenId)}`}
          onClick={() => setExpandedPanel(null)}
        >
          <UiButton
            icon='cancel'
            className='token-fingerprint-overlay-close'
            onPress={() => setExpandedPanel(null)}
            aria-label={expandedPanel === "qr" ? "Close QR preview" : "Close Colour ID preview"}
          >
            Close
          </UiButton>
          <div
            className='token-fingerprint-overlay-card'
            onClick={(event) => event.stopPropagation()}
          >
            <div className='token-fingerprint-overlay-content'>
              {expandedPanel === "fingerprint" ? (
                <div
                  className='token-fingerprint-grid token-fingerprint-overlay-grid'
                  role='img'
                  aria-label={label ?? `Token fingerprint ${tokenIdLabel(tokenId)}`}
                  style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
                >
                  {cells.map((cell, index) => (
                    <span
                      key={`overlay-${tokenId}-${index}`}
                      className={`token-fingerprint-cell${cell.filled ? ' is-filled' : ' is-empty'}`}
                      style={{
                        backgroundColor: cell.filled
                          ? TOKEN_FINGERPRINT_PALETTE[cell.colorIndex]
                          : '#efe6d6',
                      }}
                    />
                  ))}
                </div>
              ) : qrSrc ? (
                <img
                  className='token-fingerprint-overlay-qr'
                  src={qrSrc}
                  alt={`Expanded QR for token ${tokenIdLabel(tokenId)}`}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
