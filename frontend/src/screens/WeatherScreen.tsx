import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { RadarMap } from "../components/RadarMap";
import { Weather, WeatherAlert } from "../types";
import { installKioskDragScroll } from "../kioskDragScroll";
import {
  forwardDailyIndices,
  centeredHourlyIndices,
  compassDirection,
  forecastWeatherCode,
  roundTemperature,
  weatherGradient
} from "../weatherPresentation";

type Tab = "conditions" | "hourly" | "week";

const symbol = (code = 0) =>
  [0, 1].includes(code)
    ? "☀"
    : [2, 3].includes(code)
      ? "⛅"
      : [71, 73, 75, 77, 85, 86].includes(code)
        ? "❄"
        : [95, 96, 99].includes(code)
          ? "⛈"
          : "🌧";

function last24HourPrecipitation(weather: Weather): number {
  const times = (weather.hourly.time || []).map(String);
  const values = weather.hourly.precipitation || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return times.reduce((sum, time, index) => {
    const stamp = new Date(time).getTime();
    return stamp >= cutoff && stamp <= Date.now()
      ? sum + Number(values[index] || 0)
      : sum;
  }, 0);
}

function formatValue(value: unknown, digits = 0): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function TropicalWeatherPanel({
  onExit,
  localDevice
}: {
  onExit: () => void;
  localDevice: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const frameScrollCleanup = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(true);
  const homeUrl = localDevice ? "/api/v1/tropical" : "/api/v1/tropical?mobile=1";
  const navigate = (direction: "back" | "forward" | "home" | "reload") => {
    const browser = frame.current;
    if (!browser) return;
    setLoading(true);
    try {
      if (direction === "back") browser.contentWindow?.history.back();
      if (direction === "forward") browser.contentWindow?.history.forward();
      if (direction === "reload") browser.contentWindow?.location.reload();
      if (direction === "home") browser.src = homeUrl;
    } catch {
      browser.src = homeUrl;
    }
  };
  useEffect(
    () => () => frameScrollCleanup.current?.(),
    []
  );
  return (
    <main class="page-screen glass tropical-weather-page">
      <header class="tropical-toolbar">
        <div>
          <h1>Tropical Weather</h1>
          <small>{loading ? "Loading National Hurricane Center…" : "Official National Hurricane Center"}</small>
        </div>
        <div class="tropical-browser-controls">
          <button onClick={() => navigate("back")} aria-label="Back">←</button>
          <button onClick={() => navigate("forward")} aria-label="Forward">→</button>
          <button onClick={() => navigate("home")}>NHC Home</button>
          <button onClick={() => navigate("reload")} aria-label="Reload">↻</button>
        </div>
        <button class="button danger tropical-exit" onClick={onExit}>Exit Tropical Weather</button>
      </header>
      <iframe
        ref={frame}
        class="tropical-frame"
        src={homeUrl}
        title="National Hurricane Center"
        sandbox="allow-same-origin allow-forms allow-downloads"
        onLoad={() => {
          setLoading(false);
          frameScrollCleanup.current?.();
          frameScrollCleanup.current = null;
          try {
            if (frame.current?.contentDocument) {
              frameScrollCleanup.current = installKioskDragScroll(
                frame.current.contentDocument
              );
            }
          } catch {
            // Navigation outside the same-origin NHC proxy disables this fallback.
          }
        }}
      />
    </main>
  );
}

function WindCompass({
  direction,
  speed,
  gust,
  unit
}: {
  direction: number;
  speed: number;
  gust: number;
  unit: string;
}) {
  return (
    <article class="wind-compass-card">
      <small>Wind</small>
      <div class="wind-compass">
        {["N", "E", "S", "W"].map((point) => <b class={`point-${point.toLowerCase()}`}>{point}</b>)}
        <i style={{ transform: `rotate(${direction}deg)` }}>▼</i>
        <span>
          <strong>{formatValue(speed)}</strong>
          <small>{unit.replace("mp/h", "mph")}</small>
        </span>
      </div>
      <p>{compassDirection(direction)} · Gusts {formatValue(gust)} {unit.replace("mp/h", "mph")}</p>
    </article>
  );
}

function TemperatureGraph({
  weather,
  indices
}: {
  weather: Weather;
  indices: number[];
}) {
  const [mode, setMode] = useState<"temperature_2m" | "apparent_temperature">("temperature_2m");
  const values = indices.map((index) => Number(weather.hourly[mode]?.[index] ?? 0));
  const low = Math.floor((Math.min(...values) - 5) / 10) * 10;
  const high = Math.ceil((Math.max(...values) + 5) / 10) * 10;
  const range = Math.max(10, high - low);
  const width = Math.max(1100, indices.length * 96);
  const height = Math.max(300, window.innerHeight - 400);
  const chartTop = 38;
  const chartBottom = height - 35;
  const plotHeight = chartBottom - chartTop;
  const points = values.map((value, index) => ({
    x: 48 + index * ((width - 80) / Math.max(1, values.length - 1)),
    y: chartTop + ((high - value) / range) * plotHeight
  }));
  const path = points.reduce(
    (result, point, index) =>
      index === 0
        ? `M ${point.x} ${point.y}`
        : `${result} Q ${(points[index - 1].x + point.x) / 2} ${points[index - 1].y}, ${point.x} ${point.y}`,
    ""
  );
  const area = `${path} L ${points.at(-1)?.x || width - 30} ${chartBottom} L ${points[0]?.x || 48} ${chartBottom} Z`;
  const lines = [];
  for (let value = low; value <= high; value += 10) lines.push(value);
  return (
    <section class="temperature-graph">
      <header>
        <strong>{mode === "temperature_2m" ? "Temperature" : "Feels like"} trend</strong>
        <button
          type="button"
          class={`graph-mode-switch ${mode === "apparent_temperature" ? "feels-like" : ""}`}
          aria-pressed={mode === "apparent_temperature"}
          onClick={() => setMode(mode === "temperature_2m" ? "apparent_temperature" : "temperature_2m")}
        >
          <span>Temperature</span><i /><span>Feels like</span>
        </button>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height }}>
        <defs>
          <linearGradient id="temperature-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,.36)" />
            <stop offset="100%" stop-color="rgba(180,220,255,.03)" />
          </linearGradient>
        </defs>
        {lines.map((value) => {
          const y = chartTop + ((high - value) / range) * plotHeight;
          return <g><line x1="40" x2={width - 20} y1={y} y2={y} /><text x="4" y={y + 5}>{value}°</text></g>;
        })}
        <path class="temperature-area" d={area} />
        <path class="temperature-line" d={path} />
        {points.map((point, index) => <g><circle cx={point.x} cy={point.y} r="3" /><text class="graph-value" x={point.x} y={point.y - 10}>{Math.round(values[index])}°</text></g>)}
      </svg>
    </section>
  );
}

export function WeatherScreen({
  refreshToken,
  onToast,
  localDevice
}: {
  refreshToken: number;
  onToast: (message: string) => void;
  localDevice: boolean;
}) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [tab, setTab] = useState<Tab>("conditions");
  const [tropicalOpen, setTropicalOpen] = useState(false);
  const currentHourRef = useRef<HTMLElement>(null);
  const currentDayRef = useRef<HTMLElement>(null);
  const dailyListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    Promise.all([
      api<Weather | null>("/weather"),
      api<WeatherAlert[]>("/weather/alerts")
    ])
      .then(([forecast, active]) => {
        setWeather(forecast);
        setAlerts(active);
      })
      .catch((error) => onToast(error.message));
  }, [refreshToken]);
  useEffect(() => {
    if (tab !== "hourly") return;
    window.requestAnimationFrame(() =>
      currentHourRef.current?.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest"
      })
    );
  }, [tab, weather?.current?.time]);
  useEffect(() => {
    if (tab !== "week") return;
    window.requestAnimationFrame(() => {
      if (dailyListRef.current) dailyListRef.current.scrollTop = 0;
    });
  }, [tab, weather?.current?.time]);
  if (!weather)
    return (
      <main class="page-screen glass">
        <p class="empty large">Configure a weather location in Settings.</p>
      </main>
    );

  const current = weather.current;
  const air = weather.air_quality?.current || {};
  const precip24 = last24HourPrecipitation(weather);
  const hourlyIndices = centeredHourlyIndices(weather, new Date(), 18);
  const today = new Date().toISOString().slice(0, 10);
  const dailyIndices = forwardDailyIndices(weather, new Date(), 10);
  const visibilityMiles =
    Number(current.visibility) /
    (weather.units.visibility === "m" ? 1609.344 : 5280);
  const todayIndex = (weather.daily.time || []).map(String).indexOf(today);
  const apparentLabel =
    Number(current.temperature_2m) >= 80
      ? "Heat index"
      : Number(current.temperature_2m) <= 50 &&
          Number(current.wind_speed_10m) > 3
        ? "Wind chill"
        : "Feels like";
  const aqiParts = [
    ["PM2.5", air.us_aqi_pm2_5],
    ["PM10", air.us_aqi_pm10],
    ["Ozone", air.us_aqi_ozone],
    ["NO₂", air.us_aqi_nitrogen_dioxide],
    ["SO₂", air.us_aqi_sulphur_dioxide],
    ["CO", air.us_aqi_carbon_monoxide]
  ].filter(([, value]) => Number.isFinite(Number(value)));
  const primaryPollutant = aqiParts.sort(
    (left, right) => Number(right[1]) - Number(left[1])
  )[0]?.[0];
  const detailCards = [
    {
      label: "Temperature",
      value: `${roundTemperature(current.temperature_2m)}${weather.units.temperature}`,
      secondary: `${apparentLabel} ${roundTemperature(current.apparent_temperature)}${weather.units.temperature}`,
      concern:
        Number(current.apparent_temperature) >= 103 ||
        Number(current.apparent_temperature) <= 0
    },
    {
      label: "Humidity",
      value: `${formatValue(current.relative_humidity_2m)}%`,
      secondary: `Dew point ${roundTemperature(current.dew_point_2m)}${weather.units.temperature}`
    },
    {
      label: "Precipitation",
      value: `${formatValue(current.precipitation, 2)} ${weather.units.precipitation || "in"}`,
      secondary: `Last 24h ${formatValue(precip24, 2)} ${weather.units.precipitation || "in"}`,
      concern: precip24 >= (weather.units.precipitation === "mm" ? 50 : 2)
    },
    {
      label: "Visibility",
      value: `${formatValue(visibilityMiles, 1)} mi`,
      secondary: `Cloud cover ${formatValue(current.cloud_cover)}%`,
      concern: visibilityMiles <= 1
    },
    {
      label: "Pressure",
      value: `${formatValue(
        weather.units.pressure?.toLowerCase().includes("in")
          ? current.pressure_msl
          : Number(current.pressure_msl) / 33.8639,
        2
      )} inHg`,
      secondary: "Mean sea-level pressure"
    },
    {
      label: "UV index",
      value: formatValue(air.uv_index ?? current.uv_index, 1),
      secondary:
        Number(air.uv_index ?? current.uv_index) >= 11
          ? "Extreme"
          : Number(air.uv_index ?? current.uv_index) >= 8
            ? "Very high"
            : Number(air.uv_index ?? current.uv_index) >= 6
              ? "High"
              : Number(air.uv_index ?? current.uv_index) >= 3
                ? "Moderate"
                : "Low",
      concern: Number(air.uv_index ?? current.uv_index) >= 8
    },
    {
      label: "Air quality",
      value: `AQI ${formatValue(air.us_aqi)}`,
      secondary: primaryPollutant
        ? primaryPollutant === "PM2.5"
          ? `Primary PM2.5 · ${formatValue(air.pm2_5, 1)} µg/m³`
          : `Primary ${primaryPollutant} · PM2.5 ${formatValue(air.pm2_5, 1)} µg/m³`
        : `PM2.5 ${formatValue(air.pm2_5, 1)} µg/m³`,
      concern: Number(air.us_aqi) >= 101
    },
    {
      label: "Sun",
      value:
        todayIndex >= 0
          ? `Sunrise ${new Date(String(weather.daily.sunrise[todayIndex])).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "—",
      secondary:
        todayIndex >= 0
          ? `Sunset ${new Date(String(weather.daily.sunset[todayIndex])).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "Sun times unavailable"
    }
  ];

  if (tropicalOpen) {
    return (
      <TropicalWeatherPanel
        localDevice={localDevice}
        onExit={() => {
          setTropicalOpen(false);
          setTab("conditions");
        }}
      />
    );
  }

  return (
    <main class="page-screen glass weather-page">
      <header class="page-header weather-page-header">
        <div>
          <h1>Weather</h1>
          <p>{weather.attribution}</p>
        </div>
        <div class="weather-tabs">
          {(
            [
              ["conditions", "Conditions & Radar"],
              ["hourly", "Hourly"],
              ["week", "10 Day"]
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              class={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
          <button class="tropical-tab" onClick={() => setTropicalOpen(true)}>
            Tropical Weather
          </button>
        </div>
        <div class="weather-hero">
          <b>{symbol(Number(current.weather_code))}</b>
          <strong>
            {roundTemperature(current.temperature_2m)}
            {weather.units.temperature}
          </strong>
        </div>
      </header>
      {alerts.map((alert) => (
        <article class={`alert-card severity-${alert.severity.toLowerCase()}`}>
          <h2>{alert.event}</h2>
          <p>{alert.headline}</p>
        </article>
      ))}
      {tab === "conditions" && (
        <div class="conditions-layout">
          <section class="condition-dashboard">
            <article class="condition-now-card">
              <span>{symbol(Number(current.weather_code))}</span>
              <div><small>Right now</small><strong>{roundTemperature(current.temperature_2m)}{weather.units.temperature}</strong><p>{apparentLabel} {roundTemperature(current.apparent_temperature)}{weather.units.temperature}</p></div>
            </article>
            <WindCompass
              direction={Number(current.wind_direction_10m)}
              speed={Number(current.wind_speed_10m)}
              gust={Number(current.wind_gusts_10m)}
              unit={weather.units.wind}
            />
            <div class="condition-card-grid">
              {detailCards.map((card) => (
                <article class={card.concern ? "condition-concern" : ""}>
                  <small>{card.label}</small>
                  <strong>{card.value}</strong>
                  <span>{card.secondary}</span>
                </article>
              ))}
            </div>
          </section>
          <section class="radar-panel">
            <header>
              <strong>Current radar</strong>
              <small>Drag to pan · pinch or use +/− to zoom</small>
            </header>
            <RadarMap
              latitude={weather.latitude}
              longitude={weather.longitude}
              isDay={Boolean(Number(current.is_day ?? 1))}
            />
          </section>
        </div>
      )}
      {tab === "hourly" && (
        <div class="hourly-weather-scroll weather-tab-content">
          <div class="weather-detail-grid">
            {hourlyIndices.map((index) => {
              const time = String(weather.hourly.time[index]);
              const code = Number(weather.hourly.weather_code[index]);
              const itemDate = new Date(time);
              const now = new Date();
              const isCurrentHour =
                itemDate.getFullYear() === now.getFullYear() &&
                itemDate.getMonth() === now.getMonth() &&
                itemDate.getDate() === now.getDate() &&
                itemDate.getHours() === now.getHours();
              return (
                <article
                  ref={isCurrentHour ? currentHourRef : undefined}
                  class={isCurrentHour ? "current-hour" : ""}
                  style={{ background: weatherGradient(code, { weather, timestamp: time, temperature: weather.hourly.temperature_2m[index], temperatureUnit: weather.units.temperature }) }}
                >
                  <span>{new Date(time).toLocaleTimeString([], { hour: "numeric" })}</span>
                  <b>{symbol(code)}</b>
                  <strong>{roundTemperature(weather.hourly.temperature_2m[index])}{weather.units.temperature}</strong>
                  <small>{weather.hourly.precipitation_probability[index]}% rain</small>
                </article>
              );
            })}
          </div>
          <TemperatureGraph weather={weather} indices={hourlyIndices} />
        </div>
      )}
      {tab === "week" && (
        <div ref={dailyListRef} class="daily-detail-list weather-tab-content">
          {dailyIndices.map((index) => {
            const time = String(weather.daily.time[index]);
            const code = forecastWeatherCode(
              Number(weather.daily.weather_code[index]),
              weather.daily.precipitation_probability_max[index]
            );
            return (
              <article
                ref={time === today ? currentDayRef : undefined}
                class={time === today ? "current-day" : ""}
                style={{
                  background: weatherGradient(code, {
                    temperature: weather.daily.temperature_2m_max[index],
                    temperatureUnit: weather.units.temperature
                  })
                }}
              >
                <strong>
                  {new Date(`${time}T12:00`).toLocaleDateString([], {
                    weekday: "long"
                  })}
                </strong>
                <b>{symbol(code)}</b>
                <span>
                  {roundTemperature(weather.daily.temperature_2m_max[index])}° /{" "}
                  {roundTemperature(weather.daily.temperature_2m_min[index])}°
                </span>
                <small>
                  {weather.daily.precipitation_probability_max[index]}%
                </small>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
