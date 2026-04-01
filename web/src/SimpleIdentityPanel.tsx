import { useEffect, useState } from "react";
import QRCode from "qrcode";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";

export default function SimpleIdentityPanel({
  npub,
  nsec,
  title = "Identity",
}: {
  npub: string;
  nsec: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!npub) {
      setQrSrc(null);
      return;
    }

    void QRCode.toDataURL(npub, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 168,
      color: {
        dark: "#0b0c0c",
        light: "#ffffff",
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
  }, [npub]);

  async function copyNpub() {
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  if (!npub || !nsec) {
    return null;
  }

  return (
    <SimpleCollapsibleSection title={title}>
      <div className="simple-identity-grid">
        <div className="simple-identity-fields">
          <div className="simple-identity-field">
            <div className="simple-identity-label">Public key</div>
            <code className="simple-identity-code">{npub}</code>
            <button type="button" className="simple-voter-secondary" onClick={copyNpub}>
              {copied ? "Copied" : "Copy npub"}
            </button>
          </div>
          <div className="simple-identity-field">
            <div className="simple-identity-label">Private key</div>
            <code className="simple-identity-code">{nsec}</code>
          </div>
        </div>
        <div className="simple-identity-qr-wrap">
          {qrSrc ? (
            <img className="simple-identity-qr" src={qrSrc} alt="QR code for npub" />
          ) : (
            <div className="simple-identity-qr simple-identity-qr-fallback" aria-hidden="true" />
          )}
        </div>
      </div>
    </SimpleCollapsibleSection>
  );
}
