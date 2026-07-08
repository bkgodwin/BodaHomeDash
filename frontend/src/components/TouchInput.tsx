import { useRef, useState } from "preact/hooks";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import { Modal } from "./Modal";
import { TouchKeyboard } from "./TouchKeyboard";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  placeholder?: string;
  multiline?: boolean;
  autocomplete?: string;
  revealable?: boolean;
}

export function TouchInput({
  label,
  value,
  onChange,
  secret,
  placeholder,
  multiline = false,
  autocomplete = "off",
  revealable = false
}: Props) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const modalInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const openKeyboard = () => {
    if (onScreenKeyboardEnabled.value) setOpen(true);
  };
  const common = {
    value,
    placeholder: placeholder || `Enter ${label.toLowerCase()}`,
    onInput: (
      event: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }
    ) => onChange(event.currentTarget.value),
    onFocus: openKeyboard
  };
  return (
    <>
      <label class="touch-field native-touch-field">
        <small>{label}</small>
        {multiline ? (
          <textarea
            {...common}
            ref={inputRef as { current: HTMLTextAreaElement | null }}
            rows={3}
          />
        ) : (
          <div class="touch-input-row">
            <input
              {...common}
              ref={inputRef as { current: HTMLInputElement | null }}
              type={secret && !revealed ? "password" : "text"}
              autocomplete={autocomplete}
            />
            {secret && revealable && (
              <button
                type="button"
                class="inline-reveal-button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRevealed(!revealed);
                }}
              >
                {revealed ? "Hide" : "Show"}
              </button>
            )}
          </div>
        )}
      </label>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)} wide>
          {multiline ? (
            <textarea
              ref={modalInputRef as { current: HTMLTextAreaElement | null }}
              class="entry-native-input multiline"
              value={value}
              placeholder={placeholder}
              autofocus
              rows={3}
              onInput={(event) =>
                onChange(
                  (event.currentTarget as HTMLTextAreaElement).value
                )
              }
            />
          ) : (
            <div class="modal-input-row">
              <input
                ref={modalInputRef as { current: HTMLInputElement | null }}
                class="entry-native-input"
                type={secret && !revealed ? "password" : "text"}
                value={value}
                placeholder={placeholder}
                autocomplete={autocomplete}
                autofocus
                onInput={(event) =>
                  onChange((event.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") setOpen(false);
                }}
              />
              {secret && revealable && (
                <button
                  type="button"
                  class="button secondary modal-reveal-button"
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? "Hide" : "Show"}
                </button>
              )}
            </div>
          )}
          <TouchKeyboard
            value={value}
            onChange={onChange}
            targetRef={modalInputRef}
            onConfirm={() => setOpen(false)}
          />
        </Modal>
      )}
    </>
  );
}
