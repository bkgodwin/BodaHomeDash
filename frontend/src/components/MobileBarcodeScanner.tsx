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
      const reader = new BrowserMultiFormatReader();
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Photo format could not be read"));
        image.src = url;
      });
      const crops = [
        [0, 0, 1, 1],
        [0.08, 0.08, 0.84, 0.84],
        [0, 0.18, 1, 0.64],
        [0, 0, 1, 0.58],
        [0, 0.42, 1, 0.58]
      ];
      const attempts = crops.flatMap((crop) => [
        { crop, rotation: 0, enhanced: false },
        { crop, rotation: 0, enhanced: true },
        { crop, rotation: 90, enhanced: false },
        { crop, rotation: 270, enhanced: false }
      ]);
      let result: ReturnType<typeof reader.decodeFromCanvas> | null = null;
      const canvas = document.createElement("canvas");
      for (let index = 0; index < attempts.length && !result; index += 1) {
        const { crop, rotation, enhanced } = attempts[index];
        setMessage(`Reading barcode from photo… ${index + 1}/${attempts.length}`);
        const [left, top, width, height] = crop;
        const sourceWidth = image.naturalWidth * width;
        const sourceHeight = image.naturalHeight * height;
        const scale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight));
        const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
        canvas.width = rotation === 90 || rotation === 270 ? targetHeight : targetWidth;
        canvas.height = rotation === 90 || rotation === 270 ? targetWidth : targetHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) continue;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.filter = enhanced ? "grayscale(1) contrast(1.7)" : "none";
        if (rotation === 90) {
          context.translate(canvas.width, 0);
          context.rotate(Math.PI / 2);
        } else if (rotation === 270) {
          context.translate(0, canvas.height);
          context.rotate(-Math.PI / 2);
        }
        context.drawImage(
          image,
          image.naturalWidth * left,
          image.naturalHeight * top,
          sourceWidth,
          sourceHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );
        try {
          result = reader.decodeFromCanvas(canvas);
        } catch {
          // Try another crop, orientation, or contrast treatment.
        }
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve())
        );
      }
      if (!result) throw new Error("No barcode found");
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
