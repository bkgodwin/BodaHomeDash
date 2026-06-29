import { signal } from "@preact/signals";

export const scannerTestMode = signal(false);
export const scannerQuickMode = signal(false);

export interface BarcodeScanEvent {
  barcode: string;
}

export function installScannerCapture(
  onScan: (barcode: string) => void
): () => void {
  let buffer = "";
  let started = 0;
  let last = 0;

  const reset = () => {
    buffer = "";
    started = 0;
    last = 0;
  };

  const keydown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const textEntry =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable;
    const captureActive = scannerTestMode.value || scannerQuickMode.value;
    if (textEntry && !captureActive) return;

    const now = performance.now();
    if (last && now - last > 180) reset();

    if (/^\d$/.test(event.key)) {
      if (!buffer) started = now;
      buffer += event.key;
      last = now;
      if (captureActive) event.preventDefault();
      return;
    }

    if (event.key === "Enter") {
      const elapsed = Math.max(1, now - started);
      const rapid = buffer.length >= 8 && elapsed / buffer.length < 90;
      if (buffer.length >= 8 && (rapid || captureActive)) {
        event.preventDefault();
        const barcode = buffer;
        // Let the application observe the active test/quick-scan mode before
        // synchronous UI listeners clear it.
        onScan(barcode);
        window.dispatchEvent(
          new CustomEvent<BarcodeScanEvent>("dashboard:barcode", {
            detail: { barcode }
          })
        );
      }
      reset();
      return;
    }

    if (buffer) reset();
  };

  window.addEventListener("keydown", keydown, true);
  return () => window.removeEventListener("keydown", keydown, true);
}
