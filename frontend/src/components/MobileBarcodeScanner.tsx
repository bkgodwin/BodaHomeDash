import { useEffect, useRef, useState } from "preact/hooks";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
  onScan: (barcode: string) => void;
}

export function MobileBarcodeScanner({ onClose, onScan }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopped = useRef(false);
  const delivered = useRef(false);
  const [message, setMessage] = useState("Starting the rear camera…");

  useEffect(() => {
    let controls: { stop: () => void } | undefined;
    stopped.current = false;
    delivered.current = false;

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMessage(
          "Live scanning needs a secure HTTPS connection. Use Take a photo below on this connection."
        );
        return;
      }
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (stopped.current || !videoRef.current) return;
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          },
          videoRef.current,
          (result) => {
            if (!result || delivered.current) return;
            delivered.current = true;
            controls?.stop();
            onScan(result.getText());
          }
        );
        setMessage("Center a UPC or EAN barcode inside the frame.");
      } catch (error: any) {
        setMessage(
          error?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access or use Take a photo."
            : "Live camera scanning is unavailable here. Use Take a photo below."
        );
      }
    };

    start();
    return () => {
      stopped.current = true;
      controls?.stop();
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const decodePhoto = async (file?: File) => {
    if (!file) return;
    setMessage("Reading barcode from photo…");
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      if (!delivered.current) {
        delivered.current = true;
        onScan(result.getText());
      }
    } catch {
      setMessage("No barcode was found. Try again with the barcode sharp and well lit.");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <Modal title="Scan with phone camera" onClose={onClose}>
      <div class="mobile-scanner">
        <div class="camera-viewport">
          <video ref={videoRef} muted playsInline aria-label="Barcode camera preview" />
          <span class="camera-target" aria-hidden="true" />
        </div>
        <p class="camera-message" role="status">{message}</p>
        <label class="button secondary camera-photo-button">
          Take a photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => decodePhoto(event.currentTarget.files?.[0])}
          />
        </label>
        <button type="button" class="button cancel-action" onClick={onClose}>
          Cancel scanning
        </button>
      </div>
    </Modal>
  );
}
