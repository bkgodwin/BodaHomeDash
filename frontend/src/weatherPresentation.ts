import { Weather } from "./types";

export function roundTemperature(value: number | string | undefined): string {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number)) : "—";
}

export function weatherKind(code: number): string {
  if ([95, 96, 99].includes(code)) return "storm";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([45, 48].includes(code)) return "fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return "rain";
  }
  if ([2, 3].includes(code)) return "cloud";
  return "clear";
}

export function isNightAt(weather: Weather | null, timestamp: string): boolean {
  if (!weather) return false;
  const date = timestamp.slice(0, 10);
  const dates = (weather.daily.time || []).map(String);
  const index = dates.indexOf(date);
  if (index < 0) {
    const hour = new Date(timestamp).getHours();
    return hour < 6 || hour >= 20;
  }
  const sunrise = new Date(String(weather.daily.sunrise?.[index])).getTime();
  const sunset = new Date(String(weather.daily.sunset?.[index])).getTime();
  const value = new Date(timestamp).getTime();
  return (
    !Number.isFinite(sunrise) ||
    !Number.isFinite(sunset) ||
    value < sunrise ||
    value >= sunset
  );
}

export function weatherGradient(
  code: number,
  options: {
    night?: boolean;
    temperature?: number | string;
    temperatureUnit?: string;
  } = {}
): string {
  if (options.night) {
    return "linear-gradient(155deg, rgba(15,34,66,.9), rgba(31,61,98,.62))";
  }
  const temperature = Number(options.temperature);
  const hotThreshold = options.temperatureUnit?.includes("C") ? 35 : 95;
  if (Number.isFinite(temperature) && temperature >= hotThreshold) {
    return "linear-gradient(155deg, rgba(255,255,255,.07), rgba(173,63,56,.48))";
  }
  switch (weatherKind(code)) {
    case "storm":
      return "linear-gradient(155deg, rgba(255,255,255,.05), rgba(43,43,62,.72))";
    case "snow":
      return "linear-gradient(155deg, rgba(255,255,255,.1), rgba(75,139,190,.55))";
    case "rain":
      return "linear-gradient(155deg, rgba(255,255,255,.06), rgba(66,78,91,.62))";
    case "fog":
      return "linear-gradient(155deg, rgba(255,255,255,.1), rgba(106,118,126,.46))";
    case "cloud":
      return "linear-gradient(155deg, rgba(255,255,255,.08), rgba(100,120,139,.35))";
    default:
      return "linear-gradient(155deg, rgba(255,255,255,.1), rgba(244,181,79,.22))";
  }
}

export function centeredHourlyIndices(
  weather: Weather | null,
  now = new Date(),
  radius = 18
): number[] {
  const times = (weather?.hourly.time || []).map(String);
  if (!times.length) return [];
  const target = now.getTime();
  let current = times.findIndex(
    (time) => new Date(time).getTime() >= target
  );
  if (current < 0) current = times.length - 1;
  const start = Math.max(0, current - radius);
  const end = Math.min(times.length, current + radius + 1);
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}
