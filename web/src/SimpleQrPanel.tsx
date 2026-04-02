import { useEffect, useState } from "react";
import QRCode from "qrcode";

export default function SimpleQrPanel({
  value,
  title,
  description,
  copyLabel = "Copy value",
}: {
  value: string;
  title: string;
  description?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!value.trim()) {
      setQrSrc(null);
      return;
    }

    void QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 224,
      color: {
        dark: "#0b0c0c",
        light: "#ffffff",
      },
    }).then((nextValue: string) => {
      if (!cancelled) {
        setQrSrc(nextValue);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrSrc(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [value]);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  if (!value.trim()) {
    return null;
  }

  return (
    <div className="simple-qr-panel">
      <div className="simple-qr-copy">
        <h3 className="simple-voter-question">{title}</h3>
        {description ? <p className="simple-voter-question">{description}</p> : null}
        <code className="simple-identity-code">{value}</code>
        <button type="button" className="simple-voter-secondary" onClick={copyValue}>
          {copied ? "Copied" : copyLabel}
        </button>
      </div>
      <div className="simple-qr-image-wrap">
        {qrSrc ? (
          <img className="simple-qr-image" src={qrSrc} alt={`${title} QR code`} />
        ) : (
          <div className="simple-qr-image simple-identity-qr-fallback" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
