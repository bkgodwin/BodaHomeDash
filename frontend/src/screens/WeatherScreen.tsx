import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Weather, WeatherAlert } from "../types";
import {
  centeredHourlyIndices,
  isNightAt,
  roundTemperature,
  weatherGradient
} from "../weatherPresentation";

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

export function WeatherScreen({
  refreshToken,
  onToast
}: {
  refreshToken: number;
  onToast: (message: string) => void;
}) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
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
  const hourlyIndices = centeredHourlyIndices(weather, new Date(), 18);
  const today = new Date().toISOString().slice(0, 10);
  const dailyIndices = (weather.daily.time || [])
    .map((_, index) => index)
    .filter((index) => String(weather.daily.time[index]) >= today)
    .slice(0, 7);
  return (
    <main class="page-screen glass">
      <header class="page-header">
        <div>
          <h1>Weather</h1>
          <p>{weather.attribution}</p>
        </div>
        <div class="weather-hero">
          <b>{symbol(Number(weather.current.weather_code))}</b>
          <strong>
            {roundTemperature(weather.current.temperature_2m)}
            {weather.units.temperature}
          </strong>
        </div>
      </header>
      {alerts.map((alert) => (
        <article class={`alert-card severity-${alert.severity.toLowerCase()}`}>
          <h2>{alert.event}</h2>
          <p>{alert.headline}</p>
          <small>Expires {new Date(alert.expires_at).toLocaleString()}</small>
        </article>
      ))}
      <h2>Hourly forecast</h2>
      <div class="weather-detail-grid">
        {hourlyIndices.map((index) => {
          const time = String(weather.hourly.time[index]);
          const code = Number(weather.hourly.weather_code[index]);
          return (
          <article
            style={{
              background: weatherGradient(code, {
                night: isNightAt(weather, time),
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
            <small>{weather.hourly.precipitation_probability[index]}% rain</small>
          </article>
        )})}
      </div>
      <h2>Seven-day forecast</h2>
      <div class="daily-detail-list">
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
            <small>{weather.daily.precipitation_probability_max[index]}%</small>
          </article>
        )})}
      </div>
    </main>
  );
}
