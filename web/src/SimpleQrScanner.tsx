import { useEffect, useRef, useState } from "react";

type BarcodeDetectorResultLike = {
  rawValue?: string;
};

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<BarcodeDetectorResultLike[]>;
};

type BarcodeDetectorConstructorLike = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

type ScannerStatus = "idle" | "starting" | "scanning" | "error";

function getBarcodeDetectorConstructor(): BarcodeDetectorConstructorLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructorLike }).BarcodeDetector;
  return candidate ?? null;
}

export default function SimpleQrScanner({
  active,
  onDetected,
  onClose,
}: {
  active: boolean;
  onDetected: (value: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      stopScanner();
      setStatus("idle");
      setErrorMessage(null);
      return;
    }

    let cancelled = false;
    const barcodeDetectorCtor = getBarcodeDetectorConstructor();

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage("Camera access is not available in this browser.");
      return;
    }

    if (!barcodeDetectorCtor) {
      setStatus("error");
      setErrorMessage("QR scanning is not available in this browser. Paste the voting package instead.");
      return;
    }

    detectorRef.current = new barcodeDetectorCtor({ formats: ["qr_code"] });
    setStatus("starting");
    setErrorMessage(null);

    void navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    }).then(async (stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      video.srcObject = stream;

      try {
        await video.play();
      } catch {
        setStatus("error");
        setErrorMessage("Camera started, but the preview could not be opened.");
        return;
      }

      if (cancelled) {
        return;
      }

      setStatus("scanning");

      const scan = () => {
        const detector = detectorRef.current;
        const currentVideo = videoRef.current;

        if (!detector || !currentVideo || currentVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          animationFrameRef.current = window.requestAnimationFrame(scan);
          return;
        }

        void detector.detect(currentVideo).then((results) => {
          const rawValue = results.find((result) => typeof result.rawValue === "string" && result.rawValue.trim())?.rawValue?.trim();
          if (rawValue) {
            onDetected(rawValue);
            onClose();
            return;
          }

          animationFrameRef.current = window.requestAnimationFrame(scan);
        }).catch(() => {
          animationFrameRef.current = window.requestAnimationFrame(scan);
        });
      };

      animationFrameRef.current = window.requestAnimationFrame(scan);
    }).catch(() => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage("Camera permission was denied or the camera could not be opened.");
      }
    });

    return () => {
      cancelled = true;
      stopScanner();
      setStatus("idle");
    };
  }, [active, onClose, onDetected]);

  function stopScanner() {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }

  if (!active) {
    return null;
  }

  return (
    <div className="simple-scanner-shell">
      <div className="simple-scanner-head">
        <p className="simple-voter-question">Point the camera at a coordinator voting-package QR code.</p>
        <button type="button" className="simple-voter-secondary" onClick={onClose}>
          Close scanner
        </button>
      </div>
      <video ref={videoRef} className="simple-scanner-video" muted playsInline autoPlay />
      {status === "starting" && <p className="simple-voter-note">Starting camera...</p>}
      {status === "scanning" && <p className="simple-voter-note">Scanning for a QR code...</p>}
      {errorMessage ? <p className="simple-voter-empty">{errorMessage}</p> : null}
    </div>
  );
}
