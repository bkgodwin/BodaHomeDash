import { ComponentChildren } from "preact";

interface Props {
  title: string;
  children: ComponentChildren;
  onClose?: () => void;
  wide?: boolean;
  danger?: boolean;
}

export function Modal({ title, children, onClose, wide, danger }: Props) {
  return (
    <div class="modal-backdrop" role="presentation">
      <section
        class={`modal glass ${wide ? "modal-wide" : ""} ${danger ? "modal-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header class="modal-header">
          <h2>{title}</h2>
          {onClose && (
            <button class="icon-button" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </header>
        <div class="modal-body">{children}</div>
      </section>
    </div>
  );
}
