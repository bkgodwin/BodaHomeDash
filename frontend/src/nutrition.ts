export interface NutritionFact {
  label: string;
  value: string;
  basis: string;
}

function title(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatNutrientAmount(
  raw: number,
  unit: string
): { value: string; unit: string } {
  let value = raw;
  let outputUnit = unit || "";
  if (outputUnit === "g" && Math.abs(value) > 0 && Math.abs(value) < 1) {
    value *= 1000;
    outputUnit = "mg";
  } else if (
    outputUnit === "mg" &&
    Math.abs(value) > 0 &&
    Math.abs(value) < 0.1
  ) {
    value *= 1000;
    outputUnit = "µg";
  }
  const digits = Math.abs(value) >= 10 ? 0 : Math.abs(value) >= 1 ? 1 : 2;
  return {
    value: Number(value.toFixed(digits)).toLocaleString(),
    unit: outputUnit
  };
}

export function nutritionFacts(
  nutrition: Record<string, number | string>
): NutritionFact[] {
  return Object.entries(nutrition)
    .filter(
      ([key, value]) =>
        key.endsWith("_100g") && Number.isFinite(Number(value))
    )
    .map(([key, raw]) => {
      const base = key.slice(0, -5);
      const unit =
        String(nutrition[`${base}_unit`] || "") ||
        (base.includes("energy-kcal") ? "kcal" : "g");
      const amount = formatNutrientAmount(Number(raw), unit);
      return {
        label: title(base.replace(/^energy-kcal$/, "energy")),
        value: `${amount.value} ${amount.unit}`.trim(),
        basis: "per 100 g"
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}
