const rows = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"]
];

interface KeyboardProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
}

export function TouchKeyboard({
  value,
  onChange,
  onConfirm
}: KeyboardProps) {
  const append = (letter: string) => onChange(value + letter.toLowerCase());
  return (
    <div class="touch-keyboard" aria-label="On-screen keyboard">
      {rows.map((row) => (
        <div class="keyboard-row">
          {row.map((letter) => (
            <button onClick={() => append(letter)}>{letter}</button>
          ))}
        </div>
      ))}
      <div class="keyboard-row">
        {["@", ".", "-", "_", "/", ":"].map((symbol) => (
          <button onClick={() => onChange(value + symbol)}>{symbol}</button>
        ))}
      </div>
      <div class="keyboard-row">
        <button class="key-wide" onClick={() => onChange(value + " ")}>
          Space
        </button>
        <button onClick={() => onChange(value.slice(0, -1))}>⌫</button>
        <button class="key-confirm" onClick={onConfirm}>
          Confirm
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
}

export function NumberPad({
  value,
  onChange,
  onConfirm,
  onSkip,
  display
}: NumberPadProps) {
  return (
    <div class="number-entry">
      <output>{display ?? (value || "—")}</output>
      <div class="number-pad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => (
          <button onClick={() => onChange(value + number)}>{number}</button>
        ))}
        <button onClick={() => onChange(value.slice(0, -1))}>⌫</button>
        <button onClick={() => onChange(value + "0")}>0</button>
        <button class="key-confirm" onClick={onConfirm}>
          ✓
        </button>
      </div>
      {onSkip && (
        <button class="button secondary" onClick={onSkip}>
          Skip expiration
        </button>
      )}
    </div>
  );
}
