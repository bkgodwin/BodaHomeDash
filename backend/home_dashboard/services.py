from __future__ import annotations

import asyncio
import json
import logging
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from .backup import BackupManager
from .database import Database, utcnow
from .events import EventHub
from .hardware import AudioController, BarcodeMonitor, DisplayController, PIRMonitor
from .providers.barcode import OpenFoodFactsProvider
from .providers.calendar import ICloudCalendarProvider
from .providers.weather import NWSAlertProvider, WeatherProvider
from .security import SecretStore
from .utils import normalize_barcode, normalize_name

logger = logging.getLogger(__name__)


def is_emergency_alert(alert: dict[str, Any]) -> bool:
    return (
        alert.get("severity") == "Extreme"
        or "emergency" in str(alert.get("event", "")).casefold()
    )


class DashboardServices:
    def __init__(
        self,
        database: Database,
        secrets: SecretStore,
        backups: BackupManager,
        hub: EventHub,
    ):
        self.database = database
        self.secrets = secrets
        self.backups = backups
        self.hub = hub
        self.client = httpx.AsyncClient(follow_redirects=True)
        self.weather = WeatherProvider(self.client)
        self.alerts = NWSAlertProvider(self.client)
        self.barcode_provider = OpenFoodFactsProvider(self.client)
        self.display = DisplayController(
            self.database.setting("display_output", "HDMI-A-1")
        )
        self.audio = AudioController()
        self.tasks: list[asyncio.Task] = []
        self.pir: PIRMonitor | None = None
        self.scanner: BarcodeMonitor | None = None
        self.last_activity = datetime.now(UTC)
        self.display_asleep = False
        self._sync_locks = {
            "weather": asyncio.Lock(),
            "alerts": asyncio.Lock(),
            "calendar": asyncio.Lock(),
        }

    async def start(self) -> None:
        self.hub.loop = asyncio.get_running_loop()
        self._start_hardware()
        self.tasks = [
            asyncio.create_task(
                self._periodic("weather_current", self.sync_weather_current)
            ),
            asyncio.create_task(
                self._periodic("weather_forecast", self.sync_weather_forecast)
            ),
            asyncio.create_task(self._periodic("alerts", self.sync_alerts)),
            asyncio.create_task(self._periodic("calendar", self.sync_calendars)),
            asyncio.create_task(self._timer_loop()),
            asyncio.create_task(self._display_loop()),
            asyncio.create_task(self._backup_loop()),
        ]

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.pir:
            self.pir.stop()
        if self.scanner:
            self.scanner.stop()
        await self.client.aclose()

    def _start_hardware(self) -> None:
        if self.database.setting("motion_enabled", True):
            self.pir = PIRMonitor(
                int(self.database.setting("motion_gpio_bcm", 17)),
                bool(self.database.setting("motion_active_high", True)),
                self.motion,
            )
            self.pir.start()
        scanner_path = self.database.setting("scanner_device", "")
        if scanner_path:
            self.scanner = BarcodeMonitor(scanner_path, self.scanned)
            self.scanner.start()

    def restart_hardware(self) -> None:
        if self.pir:
            self.pir.stop()
        if self.scanner:
            self.scanner.stop()
        self.pir = None
        self.scanner = None
        self.display.output = self.database.setting("display_output", "HDMI-A-1")
        self._start_hardware()

    async def _periodic(self, kind: str, operation) -> None:
        intervals = {
            "weather_current": "weather_current_interval_seconds",
            "weather_forecast": "weather_forecast_interval_seconds",
            "alerts": "weather_alert_interval_seconds",
            "calendar": "calendar_interval_seconds",
        }
        await asyncio.sleep(
            {
                "weather_current": 2,
                "weather_forecast": 6,
                "alerts": 4,
                "calendar": 8,
            }[kind]
        )
        while True:
            try:
                await operation()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("%s synchronization failed: %s", kind, error)
                self._sync_state(kind, error=str(error))
            await asyncio.sleep(
                max(30, int(self.database.setting(intervals[kind], 300)))
            )

    def _sync_state(self, provider: str, error: str | None = None) -> None:
        now = utcnow()
        self.database.execute(
            """INSERT INTO sync_state(
                   provider, state_json, last_success_at, last_attempt_at, last_error
               ) VALUES(?,?,?,?,?)
               ON CONFLICT(provider) DO UPDATE SET
                   last_success_at=CASE WHEN excluded.last_error IS NULL
                       THEN excluded.last_success_at ELSE sync_state.last_success_at END,
                   last_attempt_at=excluded.last_attempt_at,
                   last_error=excluded.last_error""",
            (provider, "{}", None if error else now, now, error),
        )
        self.database.execute(
            """INSERT INTO sync_log(provider,status,message,attempted_at)
               VALUES(?,?,?,?)""",
            (provider, "error" if error else "success", error or "", now),
        )
        self.database.execute(
            """DELETE FROM sync_log WHERE id NOT IN (
                   SELECT id FROM sync_log ORDER BY id DESC LIMIT 200
               )"""
        )

    def record_sync_error(self, provider: str, error: Exception) -> None:
        self._sync_state(provider, error=str(error))

    async def sync_weather_forecast(self) -> dict[str, Any] | None:
        async with self._sync_locks["weather"]:
            latitude = self.database.setting("latitude")
            longitude = self.database.setting("longitude")
            if latitude is None or longitude is None:
                return None
            data = await self.weather.forecast(
                float(latitude),
                float(longitude),
                self.database.setting("temperature_unit", "fahrenheit"),
                self.database.setting("wind_unit", "mph"),
            )
            now = datetime.now(UTC)
            self.database.execute(
                """INSERT INTO weather_cache(cache_key, data_json, fetched_at, expires_at)
                   VALUES('forecast',?,?,?)
                   ON CONFLICT(cache_key) DO UPDATE SET
                   data_json=excluded.data_json, fetched_at=excluded.fetched_at,
                   expires_at=excluded.expires_at""",
                (
                    json.dumps(data),
                    now.isoformat(),
                    (now + timedelta(minutes=15)).isoformat(),
                ),
            )
            self._sync_state("weather")
            await self.hub.broadcast("weather.updated", {"fetched_at": utcnow()})
            return data

    async def sync_weather_current(self) -> dict[str, Any] | None:
        cached = self.database.one(
            """SELECT data_json FROM weather_cache
               WHERE cache_key='forecast'"""
        )
        if not cached:
            return await self.sync_weather_forecast()
        async with self._sync_locks["weather"]:
            latitude = self.database.setting("latitude")
            longitude = self.database.setting("longitude")
            if latitude is None or longitude is None:
                return None
            update = await self.weather.current(
                float(latitude),
                float(longitude),
                self.database.setting("temperature_unit", "fahrenheit"),
                self.database.setting("wind_unit", "mph"),
            )
            data = json.loads(cached["data_json"])
            data["current"] = update["current"]
            data["units"].update(update["units"])
            data["fetched_at"] = update["fetched_at"]
            now = datetime.now(UTC)
            self.database.execute(
                """UPDATE weather_cache SET data_json=?,fetched_at=?,expires_at=?
                   WHERE cache_key='forecast'""",
                (
                    json.dumps(data),
                    now.isoformat(),
                    (now + timedelta(minutes=5)).isoformat(),
                ),
            )
            self._sync_state("weather_current")
            await self.hub.broadcast(
                "weather.updated",
                {"scope": "current", "fetched_at": utcnow()},
            )
            return data

    async def sync_alerts(self) -> list[dict[str, Any]]:
        async with self._sync_locks["alerts"]:
            latitude = self.database.setting("latitude")
            longitude = self.database.setting("longitude")
            if latitude is None or longitude is None:
                return []
            alerts = await self.alerts.active(float(latitude), float(longitude))
            active_ids = {str(item["id"]) for item in alerts}
            if active_ids:
                placeholders = ",".join("?" for _ in active_ids)
                self.database.execute(
                    f"UPDATE weather_alerts SET active=0 WHERE alert_id NOT IN ({placeholders})",
                    tuple(active_ids),
                )
            else:
                self.database.execute("UPDATE weather_alerts SET active=0")

            wake_severities = set(
                self.database.setting("alert_wake_severities", ["Extreme"])
            )
            sound_severities = set(
                self.database.setting("alert_sound_severities", ["Extreme"])
            )
            new_emergency = False
            sound_emergency = False
            for item in alerts:
                existing = self.database.one(
                    "SELECT updated_at, announced FROM weather_alerts WHERE alert_id=?",
                    (str(item["id"]),),
                )
                changed = not existing or existing["updated_at"] != item["updated_at"]
                self.database.execute(
                    """INSERT INTO weather_alerts(
                        alert_id,event,headline,description,instruction,severity,
                        urgency,status,effective_at,expires_at,updated_at,raw_json,
                        active,announced
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)
                    ON CONFLICT(alert_id) DO UPDATE SET
                        event=excluded.event, headline=excluded.headline,
                        description=excluded.description,
                        instruction=excluded.instruction, severity=excluded.severity,
                        urgency=excluded.urgency, status=excluded.status,
                        effective_at=excluded.effective_at,
                        expires_at=excluded.expires_at,
                        updated_at=excluded.updated_at,
                        raw_json=excluded.raw_json, active=1,
                        announced=CASE WHEN weather_alerts.updated_at != excluded.updated_at
                            THEN 0 ELSE weather_alerts.announced END""",
                    (
                        str(item["id"]),
                        item["event"],
                        item["headline"],
                        item["description"],
                        item["instruction"],
                        item["severity"],
                        item["urgency"],
                        item["status"],
                        item["effective_at"],
                        item["expires_at"],
                        item["updated_at"],
                        json.dumps(item["raw"]),
                        0 if changed else int(existing["announced"]),
                    ),
                )
                emergency = is_emergency_alert(item)
                if changed and (
                    item["severity"] in wake_severities or emergency
                ):
                    new_emergency = True
                if changed and (
                    item["severity"] in sound_severities or emergency
                ):
                    sound_emergency = True
                if changed:
                    self.database.execute(
                        "DELETE FROM alert_dismissals WHERE alert_id=?",
                        (str(item["id"]),),
                    )
            if new_emergency:
                self.wake()
            if sound_emergency:
                self.audio.play(
                    "alert", int(self.database.setting("alert_volume", 55))
                )
            selected_severities = sound_severities | wake_severities
            if (new_emergency or sound_emergency) and selected_severities:
                self.database.execute(
                    """UPDATE weather_alerts SET announced=1
                       WHERE active=1 AND severity IN ({})""".format(
                        ",".join("?" for _ in selected_severities)
                    ),
                    tuple(selected_severities),
                )
            self._sync_state("alerts")
            await self.hub.broadcast(
                "alerts.updated",
                {"active": len(alerts), "emergency": new_emergency},
            )
            return alerts

    async def sync_calendars(self) -> None:
        async with self._sync_locks["calendar"]:
            accounts = self.database.all(
                "SELECT * FROM calendar_accounts WHERE enabled=1"
            )
            for account in accounts:
                password = self.secrets.get(f"calendar_password_{account['id']}")
                if not password:
                    continue
                provider = ICloudCalendarProvider(account["username"], password)
                await self._rediscover_account(account, provider)
                calendars = self.database.all(
                    """SELECT * FROM calendars
                       WHERE account_id=? AND enabled=1 AND available=1""",
                    (account["id"],),
                )
                starts = datetime.now(UTC) - timedelta(days=62)
                ends = datetime.now(UTC) + timedelta(days=550)
                try:
                    for calendar in calendars:
                        events = await provider.events(
                            calendar["remote_id"], starts, ends
                        )
                        with self.database.transaction() as connection:
                            connection.execute(
                                """DELETE FROM calendar_events
                                   WHERE calendar_id=? AND starts_at>=? AND starts_at<?""",
                                (
                                    calendar["id"],
                                    starts.isoformat(),
                                    ends.isoformat(),
                                ),
                            )
                            connection.executemany(
                                """INSERT OR REPLACE INTO calendar_events(
                                    calendar_id,remote_uid,recurrence_id,title,
                                    description,location,starts_at,ends_at,all_day,
                                    etag,raw_ical,updated_at
                                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                                [
                                    (
                                        calendar["id"],
                                        event["uid"],
                                        event["recurrence_id"],
                                        event["title"],
                                        event["description"],
                                        event["location"],
                                        event["starts_at"],
                                        event["ends_at"],
                                        int(event["all_day"]),
                                        event["etag"],
                                        event["raw_ical"],
                                        utcnow(),
                                    )
                                    for event in events
                                ],
                            )
                    self.database.execute(
                        """UPDATE calendar_accounts
                           SET last_sync_at=?,last_error=NULL,updated_at=? WHERE id=?""",
                        (utcnow(), utcnow(), account["id"]),
                    )
                except Exception as error:
                    self.database.execute(
                        """UPDATE calendar_accounts
                           SET last_error=?,updated_at=? WHERE id=?""",
                        (str(error), utcnow(), account["id"]),
                    )
                    raise
            self._sync_state("calendar")
            await self.hub.broadcast("calendar.updated", {"synced_at": utcnow()})

    async def rediscover_calendars(self) -> list[dict[str, Any]]:
        accounts = self.database.all(
            "SELECT * FROM calendar_accounts WHERE enabled=1"
        )
        for account in accounts:
            password = self.secrets.get(f"calendar_password_{account['id']}")
            if not password or account["provider"] != "icloud":
                continue
            await self._rediscover_account(
                account,
                ICloudCalendarProvider(account["username"], password),
            )
        return self.database.all(
            """SELECT c.*,a.display_name AS account_name,a.provider
               FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id
               ORDER BY c.available DESC,a.id,c.name"""
        )

    async def _rediscover_account(
        self,
        account: dict[str, Any],
        provider: ICloudCalendarProvider,
    ) -> None:
        remote_calendars = await provider.discover()
        existing_count = self.database.one(
            "SELECT COUNT(*) AS count FROM calendars WHERE account_id=?",
            (account["id"],),
        )["count"]
        colors = ["#6ea8fe", "#ff8a65", "#66d19e", "#c792ea", "#ffd166", "#58c4dc"]
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE calendars SET available=0 WHERE account_id=?",
                (account["id"],),
            )
            for index, item in enumerate(remote_calendars):
                connection.execute(
                    """INSERT INTO calendars(
                           account_id,remote_id,name,color,enabled,available,
                           shared,read_only
                       ) VALUES(?,?,?,?,1,1,?,?)
                       ON CONFLICT(account_id,remote_id) DO UPDATE SET
                           name=excluded.name,available=1,
                           shared=excluded.shared,read_only=excluded.read_only""",
                    (
                        account["id"],
                        item.remote_id,
                        item.name,
                        colors[(existing_count + index) % len(colors)],
                        int(item.shared),
                        int(item.read_only),
                    ),
                )

    async def lookup_barcode(self, scanned: str) -> dict[str, Any]:
        barcode = normalize_barcode(scanned)
        local = self.database.one(
            """SELECT p.*, pb.barcode FROM product_barcodes pb
               JOIN products p ON p.id=pb.product_id WHERE pb.barcode=?""",
            (barcode,),
        )
        if local:
            return {"found": True, "source": "local", "product": local}
        try:
            remote = await self.barcode_provider.lookup(barcode)
        except Exception as error:
            return {
                "found": False,
                "barcode": barcode,
                "offline": True,
                "error": str(error),
            }
        if not remote:
            return {"found": False, "barcode": barcode, "offline": False}
        now = utcnow()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """INSERT INTO products(
                    name,normalized_name,brand,category,package_size,source,
                    image_url,nutrition_json,ingredients,allergens,
                    raw_provider_json,date_added,date_last_used
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    remote["name"],
                    normalize_name(remote["name"]),
                    remote["brand"],
                    remote["category"],
                    remote["package_size"],
                    remote["source"],
                    remote["image_url"],
                    json.dumps(remote["nutrition"]),
                    remote["ingredients"],
                    remote["allergens"],
                    json.dumps(remote["raw_provider"]),
                    now,
                    now,
                ),
            )
            product_id = cursor.lastrowid
            connection.execute(
                """INSERT INTO product_barcodes(barcode,product_id,original_barcode)
                   VALUES(?,?,?)""",
                (barcode, product_id, scanned),
            )
        product = self.database.one("SELECT * FROM products WHERE id=?", (product_id,))
        return {
            "found": True,
            "source": "openfoodfacts",
            "product": {**product, "barcode": barcode},
        }

    def activity(self) -> None:
        self.last_activity = datetime.now(UTC)
        if self.display_asleep:
            self.wake()

    def motion(self) -> None:
        self.activity()
        self.hub.broadcast_threadsafe("motion.detected", {"at": utcnow()})

    def scanned(self, barcode: str) -> None:
        self.activity()
        self.hub.broadcast_threadsafe("barcode.scanned", {"barcode": barcode})

    def wake(self) -> None:
        self.display.on()
        self.display_asleep = False
        self.last_activity = datetime.now(UTC)
        self.hub.broadcast_threadsafe("display.wake", {"at": utcnow()})

    async def _display_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            if not self.database.setting("motion_enabled", True):
                continue
            timeout = int(self.database.setting("motion_timeout_seconds", 300))
            if (
                not self.display_asleep
                and datetime.now(UTC) - self.last_activity
                > timedelta(seconds=timeout)
            ):
                mode = self.database.setting("display_sleep_mode", "hdmi")
                if mode == "hdmi":
                    self.display.off()
                self.display_asleep = True
                await self.hub.broadcast("display.sleep", {"mode": mode})

    async def _timer_loop(self) -> None:
        while True:
            await asyncio.sleep(1)
            now = utcnow()
            finished = self.database.all(
                """SELECT * FROM timers
                   WHERE status='running' AND ends_at<=? AND sounded=0""",
                (now,),
            )
            for timer in finished:
                self.database.execute(
                    "UPDATE timers SET status='finished',sounded=1 WHERE id=?",
                    (timer["id"],),
                )
                self.wake()
                self.audio.play(
                    "timer", int(self.database.setting("timer_volume", 60))
                )
                await self.hub.broadcast("timer.finished", timer)

    async def _backup_loop(self) -> None:
        last_date = None
        while True:
            await asyncio.sleep(60)
            now = datetime.now()
            if (
                self.database.setting("backup_enabled", False)
                and now.hour
                == int(self.database.setting("backup_schedule_hour", 3))
                and last_date != now.date()
            ):
                password = self.secrets.get("backup_password")
                path = self.database.setting("backup_path", "")
                if password and path:
                    try:
                        output = self.backups.create(Path(path), password)
                        self.backups.prune(
                            Path(path),
                            int(self.database.setting("backup_retention", 7)),
                        )
                        last_date = now.date()
                        await self.hub.broadcast(
                            "backup.completed", {"path": str(output)}
                        )
                    except Exception as error:
                        await self.hub.broadcast(
                            "backup.failed", {"error": str(error)}
                        )
