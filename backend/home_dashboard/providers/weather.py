from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx


class WeatherProvider:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def locate_by_ip(self) -> dict[str, Any]:
        response = await self.client.get("https://ipwho.is/", timeout=8)
        response.raise_for_status()
        data = response.json()
        if not data.get("success", True):
            raise ValueError(data.get("message", "Automatic location failed"))
        return {
            "name": ", ".join(
                part for part in [data.get("city"), data.get("region")] if part
            ),
            "latitude": data["latitude"],
            "longitude": data["longitude"],
            "timezone": (data.get("timezone") or {}).get("id"),
        }

    async def geocode(self, query: str) -> list[dict[str, Any]]:
        response = await self.client.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": query, "count": 8, "language": "en", "format": "json"},
            timeout=10,
        )
        response.raise_for_status()
        return [
            {
                "name": ", ".join(
                    str(part)
                    for part in [
                        item.get("name"),
                        item.get("admin1"),
                        item.get("country"),
                    ]
                    if part
                ),
                "latitude": item["latitude"],
                "longitude": item["longitude"],
                "timezone": item.get("timezone"),
            }
            for item in response.json().get("results", [])
        ]

    async def forecast(
        self,
        latitude: float,
        longitude: float,
        temperature_unit: str = "fahrenheit",
        wind_unit: str = "mph",
    ) -> dict[str, Any]:
        response = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "timezone": "auto",
                "temperature_unit": temperature_unit,
                "wind_speed_unit": wind_unit,
                "precipitation_unit": "inch"
                if temperature_unit == "fahrenheit"
                else "mm",
                "forecast_days": 5,
                "past_days": 4,
                "current": ",".join(
                    [
                        "temperature_2m",
                        "apparent_temperature",
                        "relative_humidity_2m",
                        "precipitation",
                        "weather_code",
                        "cloud_cover",
                        "wind_speed_10m",
                        "wind_direction_10m",
                        "wind_gusts_10m",
                        "dew_point_2m",
                        "pressure_msl",
                        "visibility",
                        "is_day",
                        "uv_index",
                    ]
                ),
                "hourly": ",".join(
                    [
                        "temperature_2m",
                        "precipitation_probability",
                        "weather_code",
                        "wind_speed_10m",
                        "wind_direction_10m",
                        "wind_gusts_10m",
                        "relative_humidity_2m",
                        "dew_point_2m",
                        "apparent_temperature",
                        "precipitation",
                        "rain",
                        "showers",
                        "snowfall",
                        "pressure_msl",
                        "visibility",
                        "cloud_cover",
                        "uv_index",
                    ]
                ),
                "daily": ",".join(
                    [
                        "weather_code",
                        "temperature_2m_max",
                        "temperature_2m_min",
                        "precipitation_probability_max",
                        "sunrise",
                        "sunset",
                    ]
                ),
            },
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "latitude": data.get("latitude"),
            "longitude": data.get("longitude"),
            "timezone": data.get("timezone"),
            "units": {
                "temperature": data.get("current_units", {}).get(
                    "temperature_2m", "°F"
                ),
                "wind": data.get("current_units", {}).get("wind_speed_10m", "mph"),
                "precipitation": data.get("current_units", {}).get(
                    "precipitation", "in"
                ),
                "pressure": data.get("current_units", {}).get(
                    "pressure_msl", "hPa"
                ),
                "visibility": data.get("current_units", {}).get(
                    "visibility", "ft"
                ),
            },
            "current": data.get("current", {}),
            "hourly": data.get("hourly", {}),
            "daily": data.get("daily", {}),
            "fetched_at": datetime.now(UTC).isoformat(),
            "attribution": "Weather data by Open-Meteo.com",
        }

    async def air_quality(
        self, latitude: float, longitude: float
    ) -> dict[str, Any]:
        response = await self.client.get(
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "timezone": "auto",
                "current": ",".join(
                    [
                        "us_aqi",
                        "us_aqi_pm2_5",
                        "us_aqi_pm10",
                        "us_aqi_ozone",
                        "us_aqi_nitrogen_dioxide",
                        "us_aqi_sulphur_dioxide",
                        "us_aqi_carbon_monoxide",
                        "pm2_5",
                        "pm10",
                        "ozone",
                        "nitrogen_dioxide",
                        "sulphur_dioxide",
                        "carbon_monoxide",
                        "uv_index",
                    ]
                ),
            },
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "current": data.get("current", {}),
            "units": data.get("current_units", {}),
            "attribution": "Air quality by CAMS and Open-Meteo.com",
        }

    async def current(
        self,
        latitude: float,
        longitude: float,
        temperature_unit: str = "fahrenheit",
        wind_unit: str = "mph",
    ) -> dict[str, Any]:
        response = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "timezone": "auto",
                "temperature_unit": temperature_unit,
                "wind_speed_unit": wind_unit,
                "precipitation_unit": "inch"
                if temperature_unit == "fahrenheit"
                else "mm",
                "current": ",".join(
                    [
                        "temperature_2m",
                        "apparent_temperature",
                        "relative_humidity_2m",
                        "precipitation",
                        "weather_code",
                        "cloud_cover",
                        "wind_speed_10m",
                        "wind_direction_10m",
                        "wind_gusts_10m",
                        "dew_point_2m",
                        "pressure_msl",
                        "visibility",
                        "is_day",
                        "uv_index",
                    ]
                ),
            },
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "current": data.get("current", {}),
            "units": {
                "temperature": data.get("current_units", {}).get(
                    "temperature_2m", "°F"
                ),
                "wind": data.get("current_units", {}).get(
                    "wind_speed_10m", "mph"
                ),
                "precipitation": data.get("current_units", {}).get(
                    "precipitation", "in"
                ),
                "pressure": data.get("current_units", {}).get(
                    "pressure_msl", "hPa"
                ),
                "visibility": data.get("current_units", {}).get(
                    "visibility", "ft"
                ),
            },
            "fetched_at": datetime.now(UTC).isoformat(),
        }


class NWSAlertProvider:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def active(self, latitude: float, longitude: float) -> list[dict[str, Any]]:
        response = await self.client.get(
            "https://api.weather.gov/alerts/active",
            params={"point": f"{latitude:.4f},{longitude:.4f}"},
            headers={
                "User-Agent": "(Home Dashboard household kiosk, local administrator)",
                "Accept": "application/geo+json",
            },
            timeout=15,
        )
        response.raise_for_status()
        alerts: list[dict[str, Any]] = []
        for feature in response.json().get("features", []):
            properties = feature.get("properties", {})
            alerts.append(
                {
                    "id": properties.get("id") or feature.get("id"),
                    "event": properties.get("event") or "Weather Alert",
                    "headline": properties.get("headline")
                    or properties.get("event")
                    or "Weather Alert",
                    "description": properties.get("description") or "",
                    "instruction": properties.get("instruction") or "",
                    "severity": properties.get("severity") or "Unknown",
                    "urgency": properties.get("urgency") or "Unknown",
                    "status": properties.get("status") or "Actual",
                    "effective_at": properties.get("effective"),
                    "expires_at": properties.get("expires")
                    or properties.get("ends"),
                    "updated_at": properties.get("sent")
                    or datetime.now(UTC).isoformat(),
                    "raw": properties,
                }
            )
        return alerts
