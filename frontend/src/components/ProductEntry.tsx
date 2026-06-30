import { useRef, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "./Modal";
import { TouchKeyboard } from "./TouchKeyboard";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import {
  ExpirationDatePad,
  expirationDateValue
} from "./ExpirationDatePad";

export interface ProductSeed {
  product_id?: number;
  barcode?: string;
  name?: string;
  brand?: string;
  category?: string;
  package_size?: string;
  serving_size?: string;
}

interface Props {
  seed?: ProductSeed;
  destination: "pantry" | "shopping";
  onClose: () => void;
  onSaved: () => void;
}

export function ProductEntry({ seed = {}, destination, onClose, onSaved }: Props) {
  const [fields, setFields] = useState({
    name: seed.name || "",
    brand: seed.brand || "",
    category: seed.category || "",
    package_size: seed.package_size || "",
    serving_size: seed.serving_size || "",
    notes: ""
  });
  const [active, setActive] = useState<keyof typeof fields>("name");
  const [quantity, setQuantity] = useState(1);
  const [step, setStep] = useState<"details" | "expiration">("details");
  const [dateDigits, setDateDigits] = useState("");
  const [nativeDate, setNativeDate] = useState("");
  const [dateError, setDateError] = useState("");
  const [saving, setSaving] = useState(false);
  const activeInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const setActiveValue = (value: string) =>
    setFields((current) => ({ ...current, [active]: value }));

  const save = async (expiration: string | null = null) => {
    if (!fields.name.trim()) return;
    setSaving(true);
    try {
      if (destination === "shopping") {
        await api("/shopping", {
          method: "POST",
          ...jsonBody({
            name: fields.name,
            quantity,
            product_id: seed.product_id,
            barcode: seed.barcode
          })
        });
      } else {
        await api("/pantry", {
          method: "POST",
          ...jsonBody({
            ...fields,
            product_id: seed.product_id,
            barcode: seed.barcode,
            quantity,
            expires_on: expiration
          })
        });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (step === "expiration") {
    return (
      <Modal title="Expiration Date" onClose={() => setStep("details")}>
        {onScreenKeyboardEnabled.value ? (
          <ExpirationDatePad
            value={dateDigits}
            onChange={(value) => setDateDigits(value.slice(0, 6))}
            onConfirm={() => {
              const value = expirationDateValue(dateDigits);
              if (!value) {
                setDateError("Enter a valid month and day.");
                return;
              }
              setDateError("");
              save(value);
            }}
            onSkip={() => save(null)}
          />
        ) : (
          <div class="native-date-entry">
            <label>
              <span>Expiration date</span>
              <input
                type="date"
                value={nativeDate}
                onChange={(event) => setNativeDate(event.currentTarget.value)}
              />
            </label>
            <div class="button-row">
              <button
                class="button primary"
                disabled={!nativeDate || saving}
                onClick={() => save(nativeDate)}
              >
                Continue
              </button>
              <button
                class="button secondary"
                disabled={saving}
                onClick={() => save(null)}
              >
                Skip expiration
              </button>
            </div>
          </div>
        )}
        {dateError && <p class="field-error" role="alert">{dateError}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title={destination === "pantry" ? "Add to Pantry" : "Add to Shopping List"}
      onClose={onClose}
      wide
    >
      {seed.barcode && <p class="barcode-label">Barcode {seed.barcode}</p>}
      <div class="product-form">
        {(
          [
            ["name", "Product name"],
            ["brand", "Brand"],
            ["category", "Category"],
            ["package_size", "Package size"],
            ["serving_size", "Serving size"],
            ["notes", "Notes"]
          ] as [keyof typeof fields, string][]
        ).map(([key, label]) => (
          <label class={`touch-field native-touch-field ${active === key ? "active" : ""}`}>
            <small>{label}</small>
            {key === "notes" ? (
              <textarea
                value={fields[key]}
                placeholder={`Enter ${label.toLowerCase()}`}
                rows={2}
                onFocus={(event) => {
                  setActive(key);
                  activeInputRef.current = event.currentTarget;
                }}
                onInput={(event) =>
                  setFields((current) => ({
                    ...current,
                    [key]: event.currentTarget.value
                  }))
                }
              />
            ) : (
              <input
                value={fields[key]}
                placeholder={`Enter ${label.toLowerCase()}`}
                autofocus={key === "name"}
                onFocus={(event) => {
                  setActive(key);
                  activeInputRef.current = event.currentTarget;
                }}
                onInput={(event) =>
                  setFields((current) => ({
                    ...current,
                    [key]: event.currentTarget.value
                  }))
                }
              />
            )}
          </label>
        ))}
        <div class="quantity-control">
          <span>Quantity</span>
          <button onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button>
          <strong>{quantity}</strong>
          <button onClick={() => setQuantity(Math.min(999, quantity + 1))}>+</button>
        </div>
      </div>
      {onScreenKeyboardEnabled.value && (
        <TouchKeyboard
          value={fields[active]}
          onChange={setActiveValue}
          targetRef={activeInputRef}
          onConfirm={() =>
            destination === "pantry" ? setStep("expiration") : save()
          }
        />
      )}
      <button
        class="button primary full-width"
        disabled={!fields.name.trim() || saving}
        onClick={() =>
          destination === "pantry" ? setStep("expiration") : save()
        }
      >
        {destination === "pantry" ? "Continue to expiration" : "Add item"}
      </button>
    </Modal>
  );
}
