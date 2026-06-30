import { useRef, useState } from "preact/hooks";

const letterRows = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"]
];

const symbolRows = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["@", "#", "$", "%", "&", "*", "(", ")", "'", "\""],
  ["-", "_", "=", "+", "/", "\\", ":", ";", "!", "?"],
  [".", ",", "<", ">", "[", "]", "{", "}", "^", "~"]
];

type TextTarget = HTMLInputElement | HTMLTextAreaElement;
type TargetRef = { current: TextTarget | null };

interface KeyboardProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  targetRef?: TargetRef;
  compact?: boolean;
}

export function TouchKeyboard({
  value,
  onChange,
  onConfirm,
  targetRef,
  compact = false
}: KeyboardProps) {
  const [shifted, setShifted] = useState(false);
  const [symbols, setSymbols] = useState(false);

  const updateAtSelection = (replacement: string, backspace = false) => {
    const target = targetRef?.current;
    const start = target?.selectionStart ?? value.length;
    const end = target?.selectionEnd ?? value.length;
    const from = backspace && start === end ? Math.max(0, start - 1) : start;
    const next = value.slice(0, from) + replacement + value.slice(end);
    const caret = from + replacement.length;
    onChange(next);
    window.requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(caret, caret);
    });
  };

  const append = (letter: string) => {
    updateAtSelection(shifted ? letter.toUpperCase() : letter);
    if (shifted) setShifted(false);
  };

  const copy = async () => {
    const target = targetRef?.current;
    const selected =
      target && target.selectionStart !== target.selectionEnd
        ? value.slice(target.selectionStart || 0, target.selectionEnd || 0)
        : value;
    if (navigator.clipboard && selected) {
      await navigator.clipboard.writeText(selected);
    }
  };

  const paste = async () => {
    if (!navigator.clipboard) return;
    const text = await navigator.clipboard.readText();
    updateAtSelection(text);
  };

  const rows = symbols ? symbolRows : letterRows;
  return (
    <div class={`touch-keyboard ${compact ? "touch-keyboard-compact" : ""}`} aria-label="On-screen keyboard">
      {!symbols && (
        <div class="keyboard-row number-row">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map(
            (number) => (
              <button type="button" onClick={() => updateAtSelection(number)}>
                {number}
              </button>
            )
          )}
        </div>
      )}
      {rows.map((row) => (
        <div class="keyboard-row">
          {row.map((letter) => (
            <button
              type="button"
              onClick={() =>
                symbols ? updateAtSelection(letter) : append(letter)
              }
            >
              {symbols ? letter : shifted ? letter.toUpperCase() : letter}
            </button>
          ))}
        </div>
      ))}
      <div class="keyboard-row keyboard-controls">
        <button
          type="button"
          class={`key-mode ${symbols ? "active" : ""}`}
          onClick={() => {
            setSymbols(!symbols);
            setShifted(false);
          }}
        >
          {symbols ? "ABC" : "?123"}
        </button>
        {!symbols && (
          <button
            type="button"
            class={`key-shift ${shifted ? "active" : ""}`}
            aria-pressed={shifted}
            onClick={() => setShifted(!shifted)}
          >
            ⇧ Shift
          </button>
        )}
        <button type="button" class="key-clipboard" onClick={copy}>
          Copy
        </button>
        <button type="button" class="key-clipboard" onClick={paste}>
          Paste
        </button>
        <button
          type="button"
          class="key-wide"
          onClick={() => updateAtSelection(" ")}
        >
          Space
        </button>
        <button
          type="button"
          aria-label="Backspace"
          onClick={() => updateAtSelection("", true)}
        >
          ⌫
        </button>
        <button type="button" class="key-confirm" onClick={onConfirm}>
          Done
        </button>
      </div>
    </div>
  );
}

interface NumberPadProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onSkip?: () => void;
  display?: string;
  secret?: boolean;
}

export function NumberPad({
  value,
  onChange,
  onConfirm,
  onSkip,
  display,
  secret = false
}: NumberPadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setDigits = (next: string) => onChange(next.replace(/\D/g, ""));
  return (
    <div class="number-entry">
      <input
        ref={inputRef}
        class="number-entry-input"
        type={secret ? "password" : "text"}
        inputMode="numeric"
        autocomplete="off"
        value={display ?? value}
        placeholder="—"
        onInput={(event) =>
          setDigits((event.currentTarget as HTMLInputElement).value)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") onConfirm();
        }}
      />
      <div class="number-pad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => (
          <button type="button" onClick={() => setDigits(value + number)}>
            {number}
          </button>
        ))}
        <button type="button" onClick={() => setDigits(value.slice(0, -1))}>
          ⌫
        </button>
        <button type="button" onClick={() => setDigits(value + "0")}>
          0
        </button>
        <button type="button" class="key-confirm" onClick={onConfirm}>
          ✓
        </button>
      </div>
      {onSkip && (
        <button type="button" class="button secondary" onClick={onSkip}>
          Skip expiration
        </button>
      )}
    </div>
  );
}
