import { describe, expect, it } from "vitest";
import { expirationDateValue } from "./components/ExpirationDatePad";
import {
  availableNutritionBases,
  formatNutrientAmount,
  matchesNutritionFilter,
  nutritionFacts
} from "./nutrition";

describe("expiration date entry", () => {
  it("uses the current year when only month and day are entered", () => {
    expect(expirationDateValue("0704", 2026)).toBe("2026-07-04");
  });

  it("accepts an explicit two-digit 20xx year", () => {
    expect(expirationDateValue("123127", 2026)).toBe("2027-12-31");
  });

  it("rejects impossible dates", () => {
    expect(expirationDateValue("023126", 2026)).toBeNull();
  });
});

describe("nutrition presentation", () => {
  it("converts small gram values to milligrams", () => {
    expect(formatNutrientAmount(0.025, "g")).toEqual({
      value: "25",
      unit: "mg"
    });
  });

  it("keeps all numeric per-100g nutrients and their units", () => {
    const facts = nutritionFacts({
      calcium_100g: 0.12,
      calcium_unit: "g",
      proteins_100g: 4.234,
      proteins_unit: "g",
      proteins_value: 99
    });
    expect(facts).toHaveLength(2);
    expect(facts[0].label).toBe("Calcium");
    expect(facts[0].value).toBe("120 mg");
  });

  it("uses provider serving values and can scale a container", () => {
    const nutrition = {
      "energy-kcal_100g": 50,
      "energy-kcal_serving": 75,
      "energy-kcal_unit": "kcal"
    };
    expect(availableNutritionBases(nutrition, "150 g", "300 g")).toEqual([
      "container",
      "serving",
      "100g"
    ]);
    expect(nutritionFacts(nutrition, "serving", "150 g")[0].value).toBe("75 kcal");
    expect(nutritionFacts(nutrition, "container", "", "300 g")[0].value).toBe("150 kcal");
  });

  it("matches pantry nutrition shortcuts", () => {
    const nutrition = {
      sugars_serving: 0,
      fiber_serving: 6,
      sodium_serving: 0.1
    };
    expect(matchesNutritionFilter(nutrition, "zero-sugar")).toBe(true);
    expect(matchesNutritionFilter(nutrition, "high-fiber")).toBe(true);
    expect(matchesNutritionFilter(nutrition, "low-sodium")).toBe(true);
  });
});
