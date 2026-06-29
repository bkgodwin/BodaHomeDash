import { useState } from "preact/hooks";
import { Modal } from "./Modal";
import { TouchKeyboard } from "./TouchKeyboard";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  placeholder?: string;
}

export function TouchInput({
  label,
  value,
  onChange,
  secret,
  placeholder
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <>
      <button
        type="button"
        class="touch-field"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <small>{label}</small>
        <span>
          {value
            ? secret
              ? "••••••••••"
              : value
            : placeholder || `Enter ${label.toLowerCase()}`}
        </span>
      </button>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)} wide>
          <div class="entry-preview">
            {secret ? "•".repeat(draft.length) : draft || placeholder}
          </div>
          <TouchKeyboard
            value={draft}
            onChange={setDraft}
            onConfirm={() => {
              onChange(draft);
              setOpen(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
