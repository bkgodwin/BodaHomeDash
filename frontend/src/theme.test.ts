import { describe, expect, it } from "vitest";
import { blend, timeOfDayTheme } from "./theme";

describe("time-of-day theme", () => {
  it("blends colors smoothly", () => {
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("uses a light daytime palette", () => {
    expect(timeOfDayTheme(new Date(2026, 5, 29, 12), null)).toEqual([
      "#5daee8",
      "#91c8e9"
    ]);
  });

  it("uses a dark nighttime palette", () => {
    expect(timeOfDayTheme(new Date(2026, 5, 29, 2), null)).toEqual([
      "#06152d",
      "#102b50"
    ]);
  });
});
