import { describe, expect, it } from "vitest";
import {
  centeredHourlyIndices,
  roundTemperature,
  weatherGradient,
  weatherKind
} from "./weatherPresentation";
import { Weather } from "./types";

function weather(times: string[]): Weather {
  return {
    current: {},
    hourly: { time: times },
    daily: {
      time: ["2026-06-29"],
      sunrise: ["2026-06-29T06:00"],
      sunset: ["2026-06-29T20:00"]
    },
    units: { temperature: "°F", wind: "mph" },
    attribution: ""
  };
}

describe("weather presentation", () => {
  it("rounds displayed temperatures", () => {
    expect(roundTemperature(87.6)).toBe("88");
    expect(roundTemperature(undefined)).toBe("—");
  });

  it("classifies precipitation and severe weather", () => {
    expect(weatherKind(95)).toBe("storm");
    expect(weatherKind(71)).toBe("snow");
    expect(weatherKind(61)).toBe("rain");
    expect(weatherGradient(95)).toContain("43,43,62");
  });

  it("centers an hourly window around the current hour", () => {
    const times = Array.from(
      { length: 48 },
      (_, index) => `2026-06-${index < 24 ? "29" : "30"}T${String(index % 24).padStart(2, "0")}:00`
    );
    const indices = centeredHourlyIndices(
      weather(times),
      new Date("2026-06-29T12:20:00"),
      3
    );
    expect(indices).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });
});
