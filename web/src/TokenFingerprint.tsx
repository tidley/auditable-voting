import { useEffect, useState } from "react";
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

  return (
    <div
      className={`token-fingerprint${compact ? ' token-fingerprint-compact' : ''}${large ? ' token-fingerprint-large' : ''}${xlarge ? ' token-fingerprint-xlarge' : ''}`}
    >
      <div className='token-fingerprint-symbols'>
        <div
          className='token-fingerprint-grid'
          role='img'
          aria-label={label ?? `Token fingerprint ${tokenIdLabel(tokenId)}`}
          style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
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
          <div className='token-fingerprint-qr-shell'>
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
          </div>
        )}
      </div>
    </div>
  );
}
