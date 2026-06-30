import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { RadarMap } from "../components/RadarMap";
import { Weather, WeatherAlert } from "../types";
import {
  centeredHourlyIndices,
  compassDirection,
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

export function WeatherScreen({
  refreshToken,
  onToast
}: {
  refreshToken: number;
  onToast: (message: string) => void;
}) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [tab, setTab] = useState<Tab>("conditions");
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
  const dailyIndices = (weather.daily.time || [])
    .map((_, index) => index)
    .filter((index) => String(weather.daily.time[index]) >= today)
    .slice(0, 7);
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
      label: "Wind",
      value: `${formatValue(current.wind_speed_10m)} ${weather.units.wind.replace("mp/h", "mph")} ${compassDirection(Number(current.wind_direction_10m))}`,
      secondary: `Gusts ${formatValue(current.wind_gusts_10m)} ${weather.units.wind.replace("mp/h", "mph")}`,
      concern:
        Number(current.wind_speed_10m) >= 25 ||
        Number(current.wind_gusts_10m) >= 35
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
      value: `${formatValue(current.pressure_msl)} ${weather.units.pressure || "hPa"}`,
      secondary: `UV ${formatValue(air.uv_index ?? current.uv_index, 1)}`,
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
          ? `↑ ${new Date(String(weather.daily.sunrise[todayIndex])).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "—",
      secondary:
        todayIndex >= 0
          ? `Sunset ${new Date(String(weather.daily.sunset[todayIndex])).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "Sun times unavailable"
    }
  ];

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
              ["week", "7 Day"]
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              class={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
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
          <section class="condition-card-grid">
            {detailCards.map((card) => (
              <article class={card.concern ? "condition-concern" : ""}>
                <small>{card.label}</small>
                <strong>{card.value}</strong>
                <span>{card.secondary}</span>
              </article>
            ))}
          </section>
          <section class="radar-panel">
            <header>
              <strong>Current radar</strong>
              <small>Drag to pan · pinch or use +/− to zoom</small>
            </header>
            <RadarMap
              latitude={weather.latitude}
              longitude={weather.longitude}
            />
          </section>
        </div>
      )}
      {tab === "hourly" && (
        <div class="weather-detail-grid weather-tab-content">
          {hourlyIndices.map((index) => {
            const time = String(weather.hourly.time[index]);
            const code = Number(weather.hourly.weather_code[index]);
            return (
              <article
                style={{
                  background: weatherGradient(code, {
                    weather,
                    timestamp: time,
                    temperature: weather.hourly.temperature_2m[index],
                    temperatureUnit: weather.units.temperature
                  })
                }}
              >
                <span>
                  {new Date(time).toLocaleTimeString([], { hour: "numeric" })}
                </span>
                <b>{symbol(code)}</b>
                <strong>
                  {roundTemperature(weather.hourly.temperature_2m[index])}
                  {weather.units.temperature}
                </strong>
                <small>
                  {weather.hourly.precipitation_probability[index]}% rain
                </small>
              </article>
            );
          })}
        </div>
      )}
      {tab === "week" && (
        <div class="daily-detail-list weather-tab-content">
          {dailyIndices.map((index) => {
            const time = String(weather.daily.time[index]);
            const code = Number(weather.daily.weather_code[index]);
            return (
              <article
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
