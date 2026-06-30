export interface NutritionFact {
  label: string;
  value: string;
  basis: string;
}

export type NutritionBasis = "serving" | "container" | "100g";
export type NutritionFilter = "zero-calorie" | "zero-sugar" | "high-fiber" | "low-sodium";

function title(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatNutrientAmount(raw: number, unit: string): { value: string; unit: string } {
  let value = raw;
  let outputUnit = unit || "";
  if (outputUnit === "g" && Math.abs(value) > 0 && Math.abs(value) < 1) {
    value *= 1000;
    outputUnit = "mg";
  } else if (outputUnit === "mg" && Math.abs(value) > 0 && Math.abs(value) < 0.1) {
    value *= 1000;
    outputUnit = "µg";
  }
  const digits = Math.abs(value) >= 10 ? 0 : Math.abs(value) >= 1 ? 1 : 2;
  return { value: Number(value.toFixed(digits)).toLocaleString(), unit: outputUnit };
}

function grams(value = ""): number | null {
  const match = value.match(/([\d.]+)\s*(kg|g|mg|ml|l|fl\s*oz|oz)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase().replace(/\s/g, "");
  if (unit === "kg" || unit === "l") return amount * 1000;
  if (unit === "mg") return amount / 1000;
  if (unit === "oz") return amount * 28.3495;
  if (unit === "floz") return amount * 29.5735;
  return amount;
}

export function availableNutritionBases(
  nutrition: Record<string, number | string>,
  servingSize = "",
  packageSize = ""
): NutritionBasis[] {
  const bases: NutritionBasis[] = ["100g"];
  if (Object.keys(nutrition).some((key) => key.endsWith("_serving")) || grams(servingSize)) bases.unshift("serving");
  if (grams(packageSize)) bases.unshift("container");
  return [...new Set(bases)];
}

export function nutritionFacts(
  nutrition: Record<string, number | string>,
  basis: NutritionBasis = "100g",
  servingSize = "",
  packageSize = ""
): NutritionFact[] {
  const preferredSuffix = basis === "serving" ? "_serving" : "_100g";
  const scale =
    basis === "container"
      ? (grams(packageSize) || 100) / 100
      : basis === "serving" && !Object.keys(nutrition).some((key) => key.endsWith("_serving"))
        ? (grams(servingSize) || 100) / 100
        : 1;
  const label =
    basis === "container"
      ? `per container (${packageSize})`
      : basis === "serving"
        ? `per serving${servingSize ? ` (${servingSize})` : ""}`
        : "per 100 g";
  return Object.entries(nutrition)
    .filter(([key, value]) => key.endsWith(preferredSuffix) && Number.isFinite(Number(value)))
    .map(([key, raw]) => {
      const base = key.slice(0, -preferredSuffix.length);
      const unit = String(nutrition[`${base}_unit`] || "") || (base.includes("energy-kcal") ? "kcal" : "g");
      const amount = formatNutrientAmount(Number(raw) * scale, unit);
      return {
        label: title(base.replace(/^energy-kcal$/, "energy")),
        value: `${amount.value} ${amount.unit}`.trim(),
        basis: label
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function nutrient(nutrition: Record<string, number | string> | undefined, name: string): number | null {
  if (!nutrition) return null;
  for (const suffix of ["_serving", "_100g"]) {
    const value = Number(nutrition[`${name}${suffix}`]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function matchesNutritionFilter(
  nutrition: Record<string, number | string> | undefined,
  filter: NutritionFilter
): boolean {
  if (filter === "zero-calorie") return (nutrient(nutrition, "energy-kcal") ?? Infinity) <= 0.5;
  if (filter === "zero-sugar") return (nutrient(nutrition, "sugars") ?? Infinity) <= 0.5;
  if (filter === "high-fiber") return (nutrient(nutrition, "fiber") ?? -Infinity) >= 5;
  return (nutrient(nutrition, "sodium") ?? Infinity) <= 0.14;
}
