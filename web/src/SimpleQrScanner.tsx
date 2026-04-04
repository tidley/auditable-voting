import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

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
  prompt = "Point the camera at a QR code.",
}: {
  active: boolean;
  onDetected: (value: string) => boolean | Promise<boolean>;
  onClose: () => void;
  prompt?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
      setErrorMessage("Camera access is not available in this browser. Use HTTPS or localhost, or paste the npub manually.");
      return;
    }

    detectorRef.current = barcodeDetectorCtor
      ? new barcodeDetectorCtor({ formats: ["qr_code"] })
      : null;
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
        const canvas = canvasRef.current;

        if (!currentVideo || currentVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          animationFrameRef.current = window.requestAnimationFrame(scan);
          return;
        }

        const detectPromise = detector
          ? detector.detect(currentVideo).then((results) => (
            results.find((result) => typeof result.rawValue === "string" && result.rawValue.trim())?.rawValue?.trim() ?? null
          ))
          : Promise.resolve().then(() => {
            if (!canvas) {
              return null;
            }

            const width = currentVideo.videoWidth;
            const height = currentVideo.videoHeight;
            if (!width || !height) {
              return null;
            }

            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) {
              return null;
            }

            context.drawImage(currentVideo, 0, 0, width, height);
            const imageData = context.getImageData(0, 0, width, height);
            const result = jsQR(imageData.data, imageData.width, imageData.height);
            return result?.data?.trim() || null;
          });

        void detectPromise.then((rawValue) => {
          if (rawValue) {
            void Promise.resolve(onDetected(rawValue)).then((accepted) => {
              if (accepted) {
                onClose();
                return;
              }

              animationFrameRef.current = window.requestAnimationFrame(scan);
            }).catch(() => {
              animationFrameRef.current = window.requestAnimationFrame(scan);
            });
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
        <p className="simple-voter-question">{prompt}</p>
        <button type="button" className="simple-voter-secondary" onClick={onClose}>
          Close scanner
        </button>
      </div>
      <video ref={videoRef} className="simple-scanner-video" muted playsInline autoPlay />
      <canvas ref={canvasRef} className="simple-scanner-canvas" aria-hidden="true" />
      {status === "starting" && <p className="simple-voter-note">Starting camera...</p>}
      {status === "scanning" && <p className="simple-voter-note">Scanning for a QR code...</p>}
      {errorMessage ? <p className="simple-voter-empty">{errorMessage}</p> : null}
    </div>
  );
}
