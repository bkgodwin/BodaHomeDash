import { Modal } from "./Modal";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel
}: Props) {
  return (
    <Modal title={title} onClose={busy ? undefined : onCancel}>
      <div class="confirm-dialog">
        <p>{message}</p>
        <div class="confirm-actions">
          <button
            type="button"
            class="button confirm-action"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            class="button cancel-action"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
