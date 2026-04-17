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
const SCAN_INTERVAL_MS = 180;

function getBarcodeDetectorConstructor(): BarcodeDetectorConstructorLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructorLike }).BarcodeDetector;
  return candidate ?? null;
}

function describeCameraError(error: unknown): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Camera access requires HTTPS (or localhost). Open this page over https:// and try again.";
  }
  const name = typeof error === "object" && error && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access for this site in browser/app settings and retry.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera device was found.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "Camera is unavailable (possibly in use by another app). Close other camera apps and retry.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Camera constraints were not supported on this device.";
  }
  if (name === "SecurityError") {
    return "Browser security settings blocked camera access.";
  }
  return "Camera could not be opened. Check browser permissions and device camera availability.";
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
  const lastScanAtRef = useRef<number>(0);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const decodeWithJsQr = (video: HTMLVideoElement, canvas: HTMLCanvasElement | null): string | null => {
    if (!canvas) {
      return null;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    return result?.data?.trim() || null;
  };

  useEffect(() => {
    if (!active) {
      stopScanner();
      setStatus("idle");
      setErrorMessage(null);
      return;
    }

    let cancelled = false;
    const barcodeDetectorCtor = getBarcodeDetectorConstructor();

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setStatus("error");
      setErrorMessage("Camera access requires HTTPS (or localhost). Open this page over https:// and try again.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage("Camera APIs are not available in this browser. Use manual paste on this device.");
      return;
    }

    detectorRef.current = barcodeDetectorCtor
      ? new barcodeDetectorCtor({ formats: ["qr_code"] })
      : null;
    setStatus("starting");
    setErrorMessage(null);

    const cameraConstraintAttempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      {
        video: {
          facingMode: { ideal: "environment" },
        },
        audio: false,
      },
      {
        video: {
          facingMode: "environment",
        },
        audio: false,
      },
      {
        video: true,
        audio: false,
      },
    ];

    const openStream = async () => {
      let lastError: unknown = null;
      for (const constraints of cameraConstraintAttempts) {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("Unable to open camera.");
    };

    void openStream().then(async (stream) => {
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

      video.setAttribute("playsinline", "true");
      video.setAttribute("muted", "true");
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;

      try {
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(() => {
              video.removeEventListener("loadedmetadata", onMetadata);
              video.removeEventListener("loadeddata", onMetadata);
              video.removeEventListener("canplay", onMetadata);
              resolve();
            }, 2000);
            const onMetadata = () => {
              window.clearTimeout(timeout);
              video.removeEventListener("loadedmetadata", onMetadata);
              video.removeEventListener("loadeddata", onMetadata);
              video.removeEventListener("canplay", onMetadata);
              resolve();
            };
            video.addEventListener("loadedmetadata", onMetadata);
            video.addEventListener("loadeddata", onMetadata);
            video.addEventListener("canplay", onMetadata);
          });
        }
        await video.play();
      } catch (error) {
        setStatus("error");
        setErrorMessage(describeCameraError(error));
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

        const now = Date.now();
        if (now - lastScanAtRef.current < SCAN_INTERVAL_MS) {
          animationFrameRef.current = window.requestAnimationFrame(scan);
          return;
        }
        lastScanAtRef.current = now;

        const detectPromise = detector
          ? detector.detect(currentVideo).then((results) => {
            const rawValue = results.find((result) => (
              typeof result.rawValue === "string" && result.rawValue.trim()
            ))?.rawValue?.trim() ?? null;
            if (rawValue) {
              return rawValue;
            }
            return decodeWithJsQr(currentVideo, canvas);
          }).catch(() => {
            detectorRef.current = null;
            return decodeWithJsQr(currentVideo, canvas);
          })
          : Promise.resolve().then(() => decodeWithJsQr(currentVideo, canvas));

        void detectPromise.then((rawValue) => {
          if (rawValue) {
            void Promise.resolve(onDetectedRef.current(rawValue)).then((accepted) => {
              if (accepted) {
                onCloseRef.current();
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
    }).catch((error) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(describeCameraError(error));
      }
    });

    return () => {
      cancelled = true;
      stopScanner();
      setStatus("idle");
    };
  }, [active]);

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
