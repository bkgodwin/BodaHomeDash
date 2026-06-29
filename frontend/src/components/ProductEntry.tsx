import { useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "./Modal";
import { NumberPad, TouchKeyboard } from "./TouchKeyboard";

export interface ProductSeed {
  product_id?: number;
  barcode?: string;
  name?: string;
  brand?: string;
  category?: string;
  package_size?: string;
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
    notes: ""
  });
  const [active, setActive] = useState<keyof typeof fields>("name");
  const [quantity, setQuantity] = useState(1);
  const [step, setStep] = useState<"details" | "expiration">("details");
  const [dateDigits, setDateDigits] = useState("");
  const [saving, setSaving] = useState(false);

  const setActiveValue = (value: string) =>
    setFields((current) => ({ ...current, [active]: value }));

  const formattedDate = () => {
    const digits = dateDigits.slice(0, 8);
    return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)]
      .filter(Boolean)
      .join("/");
  };

  const expirationValue = (): string | null => {
    if (dateDigits.length !== 8) return null;
    const month = Number(dateDigits.slice(0, 2));
    const day = Number(dateDigits.slice(2, 4));
    const year = Number(dateDigits.slice(4, 8));
    const value = new Date(year, month - 1, day);
    if (
      value.getFullYear() !== year ||
      value.getMonth() !== month - 1 ||
      value.getDate() !== day
    ) {
      return null;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

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
        <p class="hint">Enter MM/DD/YYYY, or skip if no date is available.</p>
        <NumberPad
          value={dateDigits}
          display={formattedDate()}
          onChange={(value) => setDateDigits(value.slice(0, 8))}
          onConfirm={() => {
            const value = expirationValue();
            if (!value) {
              alert("Enter a valid date in MM/DD/YYYY format.");
              return;
            }
            save(value);
          }}
          onSkip={() => save(null)}
        />
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
            ["notes", "Notes"]
          ] as [keyof typeof fields, string][]
        ).map(([key, label]) => (
          <button
            class={`touch-field ${active === key ? "active" : ""}`}
            onClick={() => setActive(key)}
          >
            <small>{label}</small>
            <span>{fields[key] || `Enter ${label.toLowerCase()}`}</span>
          </button>
        ))}
        <div class="quantity-control">
          <span>Quantity</span>
          <button onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button>
          <strong>{quantity}</strong>
          <button onClick={() => setQuantity(Math.min(999, quantity + 1))}>+</button>
        </div>
      </div>
      <TouchKeyboard
        value={fields[active]}
        onChange={setActiveValue}
        onConfirm={() =>
          destination === "pantry" ? setStep("expiration") : save()
        }
      />
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
