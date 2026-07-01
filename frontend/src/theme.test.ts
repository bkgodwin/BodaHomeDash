import { describe, expect, it } from "vitest";
import { backgroundAtmosphere, blend, timeOfDayTheme } from "./theme";

describe("time-of-day theme", () => {
  it("blends colors smoothly", () => {
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("uses a light daytime palette", () => {
    expect(timeOfDayTheme(new Date(2026, 5, 29, 12), null)).toEqual([
      "#438fc6",
      "#79b4d8"
    ]);
  });

  it("uses a dark nighttime palette", () => {
    expect(timeOfDayTheme(new Date(2026, 5, 29, 2), null)).toEqual([
      "#06152d",
      "#102b50"
    ]);
  });

  it("can hold a night preview with the moon visible", () => {
    const preview = backgroundAtmosphere(
      "night",
      new Date(2026, 5, 30, 12),
      null
    );
    expect(preview.now.getHours()).toBe(23);
    expect(preview.isDay).toBe(false);
    expect(preview.code).toBe(0);
    expect(timeOfDayTheme(preview.now, preview.weather)).toEqual([
      "#06152d",
      "#102b50"
    ]);
  });

  it("previews weather without changing the current day or night", () => {
    const weather = {
      current: { is_day: 0, weather_code: 0, cloud_cover: 0 },
      hourly: {},
      daily: {},
      units: { temperature: "°F", wind: "mph" },
      attribution: "test"
    };
    const preview = backgroundAtmosphere(
      "rain",
      new Date(2026, 5, 30, 23),
      weather
    );
    expect(preview.isDay).toBe(false);
    expect(preview.code).toBe(63);
    expect(preview.cloudCover).toBe(95);
  });
});
