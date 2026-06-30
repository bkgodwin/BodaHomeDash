import { useRef } from "preact/hooks";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
}

export function expirationDateValue(
  digits: string,
  currentYear = new Date().getFullYear()
): string | null {
  if (digits.length < 4) return null;
  const month = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  const year =
    digits.length >= 6 ? 2000 + Number(digits.slice(4, 6)) : currentYear;
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function ExpirationDatePad({
  value,
  onChange,
  onConfirm,
  onSkip
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const currentYear = String(new Date().getFullYear()).slice(-2);
  const month = value.slice(0, 2).padEnd(2, "_");
  const day = value.slice(2, 4).padEnd(2, "_");
  const year = value.length > 4 ? value.slice(4, 6).padEnd(2, "_") : currentYear;
  const display = `${month} / ${day} / ${year}`;
  const append = (digit: string) =>
    onChange((value + digit).replace(/\D/g, "").slice(0, 6));

  return (
    <div class="number-entry expiration-entry">
      <label>
        <small>Expiration date</small>
        <input
          ref={input}
          class="number-entry-input expiration-date-input"
          value={display}
          inputMode="numeric"
          aria-label="Expiration date month day two digit year"
          onKeyDown={(event) => {
            if (/^\d$/.test(event.key)) {
              event.preventDefault();
              append(event.key);
            } else if (event.key === "Backspace" || event.key === "Delete") {
              event.preventDefault();
              onChange(value.slice(0, -1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            onChange(
              (event.clipboardData?.getData("text") || "")
                .replace(/\D/g, "")
                .slice(0, 6)
            );
          }}
        />
      </label>
      <p class="date-entry-help">
        Enter MM/DD. The year defaults to 20{currentYear}; type two more
        digits to replace it.
      </p>
      <div class="number-pad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => (
          <button type="button" onClick={() => append(String(number))}>
            {number}
          </button>
        ))}
        <button type="button" onClick={() => onChange(value.slice(0, -1))}>
          ⌫
        </button>
        <button type="button" onClick={() => append("0")}>0</button>
        <button type="button" class="key-confirm" onClick={onConfirm}>
          Continue
        </button>
      </div>
      <button type="button" class="button secondary" onClick={onSkip}>
        Skip expiration
      </button>
    </div>
  );
}
