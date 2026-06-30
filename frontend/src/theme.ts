import { Weather } from "./types";

type Rgb = [number, number, number];

const COLORS = {
  nightTop: "#06152d",
  nightBottom: "#102b50",
  orangeTop: "#d96a44",
  orangeBottom: "#806175",
  dayTop: "#5daee8",
  dayBottom: "#91c8e9"
};

function rgb(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function hex(value: Rgb): string {
  return `#${value
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function blend(left: string, right: string, amount: number): string {
  const start = rgb(left);
  const end = rgb(right);
  const factor = Math.max(0, Math.min(1, amount));
  return hex(
    start.map(
      (channel, index) => channel + (end[index] - channel) * factor
    ) as Rgb
  );
}

function minutes(value: Date): number {
  return value.getHours() * 60 + value.getMinutes();
}

function weatherTime(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function timeOfDayTheme(
  now: Date,
  weather: Weather | null
): [string, string] {
  const sunrise = weatherTime(
    weather?.daily?.sunrise?.[0],
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 30)
  );
  const sunset = weatherTime(
    weather?.daily?.sunset?.[0],
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 30)
  );
  const current = minutes(now);
  const dawn = minutes(sunrise);
  const dusk = minutes(sunset);

  const stops = [
    { at: 0, top: COLORS.nightTop, bottom: COLORS.nightBottom },
    {
      at: Math.max(0, dawn - 60),
      top: COLORS.nightTop,
      bottom: COLORS.nightBottom
    },
    { at: dawn, top: COLORS.orangeTop, bottom: COLORS.orangeBottom },
    {
      at: Math.min(1439, dawn + 90),
      top: COLORS.dayTop,
      bottom: COLORS.dayBottom
    },
    {
      at: Math.max(dawn + 91, dusk - 90),
      top: COLORS.dayTop,
      bottom: COLORS.dayBottom
    },
    { at: dusk, top: COLORS.orangeTop, bottom: COLORS.orangeBottom },
    {
      at: Math.min(1439, dusk + 90),
      top: COLORS.nightTop,
      bottom: COLORS.nightBottom
    },
    { at: 1440, top: COLORS.nightTop, bottom: COLORS.nightBottom }
  ].sort((left, right) => left.at - right.at);

  const upperIndex = stops.findIndex((stop) => stop.at >= current);
  const upper = stops[Math.max(1, upperIndex)];
  const lower = stops[Math.max(0, upperIndex - 1)];
  const span = Math.max(1, upper.at - lower.at);
  const amount = (current - lower.at) / span;
  let result: [string, string] = [
    blend(lower.top, upper.top, amount),
    blend(lower.bottom, upper.bottom, amount)
  ];
  const code = Number(weather?.current?.weather_code || 0);
  const cloud = Number(weather?.current?.cloud_cover || 0);
  const storm = [95, 96, 99].includes(code);
  const rain = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code);
  const snow = [71, 73, 75, 77, 85, 86].includes(code);
  const fog = [45, 48].includes(code);
  if (storm) result = [blend(result[0], "#25243d", 0.48), blend(result[1], "#38354d", 0.48)];
  else if (rain) result = [blend(result[0], "#315b78", 0.35), blend(result[1], "#496a7d", 0.35)];
  else if (snow) result = [blend(result[0], "#8abbd3", 0.28), blend(result[1], "#b3d4e2", 0.28)];
  else if (fog) result = [blend(result[0], "#87959e", 0.35), blend(result[1], "#a6afb4", 0.35)];
  else if (cloud >= 70) result = [blend(result[0], "#536d82", 0.22), blend(result[1], "#718798", 0.22)];
  return result;
}
