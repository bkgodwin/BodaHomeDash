import { Weather } from "./types";
import { blend } from "./theme";

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
    weather?: Weather | null;
    timestamp?: string;
  } = {}
): string {
  let solarTop = options.night ? "#102645" : "#5e9fc5";
  let solarBottom = options.night ? "#183455" : "#8ebbd0";
  if (options.weather && options.timestamp) {
    [solarTop, solarBottom] = solarPalette(
      options.weather,
      options.timestamp
    );
  }
  const temperature = Number(options.temperature);
  const hotThreshold = options.temperatureUnit?.includes("C") ? 35 : 95;
  let tint = "rgba(255,255,255,.04)";
  if (Number.isFinite(temperature) && temperature >= hotThreshold) {
    tint = "rgba(185,63,47,.48)";
  } else {
    switch (weatherKind(code)) {
      case "storm":
        tint = "rgba(38,27,64,.66)";
        break;
      case "snow":
        tint = "rgba(105,178,218,.46)";
        break;
      case "rain":
        tint = "rgba(35,92,132,.56)";
        break;
      case "fog":
        tint = "rgba(150,158,164,.40)";
        break;
      case "cloud":
        tint = "rgba(83,101,120,.34)";
        break;
      default:
        tint = "rgba(245,190,86,.12)";
    }
  }
  return `linear-gradient(155deg, ${tint}, rgba(0,0,0,.08)), linear-gradient(155deg, ${solarTop}, ${solarBottom})`;
}

export function solarPalette(
  weather: Weather,
  timestamp: string
): [string, string] {
  const date = timestamp.slice(0, 10);
  const index = (weather.daily.time || []).map(String).indexOf(date);
  if (index < 0) {
    return isNightAt(weather, timestamp)
      ? ["#102645", "#183455"]
      : ["#5e9fc5", "#8ebbd0"];
  }
  const value = new Date(timestamp).getTime();
  const sunrise = new Date(String(weather.daily.sunrise[index])).getTime();
  const sunset = new Date(String(weather.daily.sunset[index])).getTime();
  const transition = 90 * 60 * 1000;
  const night: [string, string] = ["#102645", "#183455"];
  const dawn: [string, string] = ["#e58a45", "#e6bd65"];
  const day: [string, string] = ["#5e9fc5", "#8ebbd0"];
  const mix = (
    left: [string, string],
    right: [string, string],
    amount: number
  ): [string, string] => [
    blend(left[0], right[0], amount),
    blend(left[1], right[1], amount)
  ];
  if (value < sunrise - transition) return night;
  if (value < sunrise) {
    return mix(night, dawn, (value - (sunrise - transition)) / transition);
  }
  if (value < sunrise + transition) {
    return mix(dawn, day, (value - sunrise) / transition);
  }
  if (value < sunset - transition) return day;
  if (value < sunset) {
    return mix(day, dawn, (value - (sunset - transition)) / transition);
  }
  if (value < sunset + transition) {
    return mix(dawn, night, (value - sunset) / transition);
  }
  return night;
}

export function compassDirection(degrees: number): string {
  if (!Number.isFinite(degrees)) return "—";
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(degrees / 45) % 8];
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

export function centeredDailyIndices(
  weather: Weather | null,
  now = new Date(),
  radius = 4
): number[] {
  const dates = (weather?.daily.time || []).map(String);
  if (!dates.length) return [];
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  let current = dates.indexOf(today);
  if (current < 0) current = dates.findIndex((date) => date >= today);
  if (current < 0) current = dates.length - 1;
  const start = Math.max(0, current - radius);
  const end = Math.min(dates.length, current + radius + 1);
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}
