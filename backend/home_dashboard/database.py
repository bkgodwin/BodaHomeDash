from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator, Sequence


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_secrets (
    key TEXT PRIMARY KEY,
    value_encrypted BLOB NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'icloud',
    display_name TEXT NOT NULL,
    username TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f8cff',
    enabled INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1,
    shared INTEGER NOT NULL DEFAULT 0,
    read_only INTEGER NOT NULL DEFAULT 1,
    sync_token TEXT,
    UNIQUE(account_id, remote_id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    remote_uid TEXT NOT NULL,
    recurrence_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    raw_ical TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(calendar_id, remote_uid, recurrence_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_range
    ON calendar_events(starts_at, ends_at);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    package_size TEXT NOT NULL DEFAULT '',
    serving_size TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    image_url TEXT NOT NULL DEFAULT '',
    nutrition_json TEXT NOT NULL DEFAULT '{}',
    ingredients TEXT NOT NULL DEFAULT '',
    allergens TEXT NOT NULL DEFAULT '',
    raw_provider_json TEXT NOT NULL DEFAULT '{}',
    date_added TEXT NOT NULL,
    date_last_used TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_normalized_name ON products(normalized_name);

CREATE TABLE IF NOT EXISTS product_barcodes (
    barcode TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    original_barcode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
    expires_on TEXT,
    notes TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_expiration ON inventory_lots(expires_on);

CREATE TABLE IF NOT EXISTS shopping_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    barcode TEXT,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
    purchased INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    purchased_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shopping_active ON shopping_items(purchased, position);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    high_priority INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT 'Timer',
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    sounded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    dismissed_at TEXT
);

CREATE TABLE IF NOT EXISTS weather_cache (
    cache_key TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipes (
    recipe_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    image_data TEXT NOT NULL DEFAULT '',
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    custom INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
CREATE INDEX IF NOT EXISTS idx_recipes_favorite ON recipes(favorite, custom);

CREATE TABLE IF NOT EXISTS recipe_progress (
    recipe_id TEXT PRIMARY KEY REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    checked_ingredients_json TEXT NOT NULL DEFAULT '[]',
    checked_steps_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS household_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#A7D8F0',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planner_meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planned_date TEXT NOT NULL,
    recipe_id TEXT REFERENCES recipes(recipe_id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_planner_meals_date
    ON planner_meals(planned_date, position);

CREATE TABLE IF NOT EXISTS planner_chores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#A7D8F0',
    recurring INTEGER NOT NULL DEFAULT 1,
    weekday INTEGER,
    scheduled_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
        (recurring=1 AND weekday BETWEEN 0 AND 6) OR
        (recurring=0 AND scheduled_date IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_planner_chores_schedule
    ON planner_chores(recurring, weekday, scheduled_date);

CREATE TABLE IF NOT EXISTS planner_chore_members (
    chore_id INTEGER NOT NULL REFERENCES planner_chores(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    PRIMARY KEY(chore_id, member_id)
);

CREATE TABLE IF NOT EXISTS planner_chore_completions (
    chore_id INTEGER NOT NULL REFERENCES planner_chores(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY(chore_id, week_start)
);

CREATE TABLE IF NOT EXISTS planner_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planned_date TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_planner_notes_date ON planner_notes(planned_date);

CREATE TABLE IF NOT EXISTS shared_notepad (
    id INTEGER PRIMARY KEY CHECK(id=1),
    content_html TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_alerts (
    alert_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    headline TEXT NOT NULL,
    description TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL,
    urgency TEXT NOT NULL,
    status TEXT NOT NULL,
    effective_at TEXT,
    expires_at TEXT,
    updated_at TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    announced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alert_dismissals (
    alert_id TEXT PRIMARY KEY REFERENCES weather_alerts(alert_id) ON DELETE CASCADE,
    alert_updated_at TEXT NOT NULL,
    dismissed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    provider TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    last_success_at TEXT,
    last_attempt_at TEXT,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_log_attempted ON sync_log(attempted_at DESC);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, datetime('now'));
"""


DEFAULT_SETTINGS: dict[str, Any] = {
    "setup_complete": False,
    "household_name": "Our Home",
    "timezone": "America/Chicago",
    "week_starts_on": 0,
    "clock_24_hour": False,
    "garbage_pickup_enabled": False,
    "garbage_pickup_weekday": 1,
    "temperature_unit": "fahrenheit",
    "wind_unit": "mph",
    "location_mode": "manual",
    "location_name": "",
    "latitude": None,
    "longitude": None,
    "weather_current_interval_seconds": 120,
    "weather_forecast_interval_seconds": 600,
    "weather_alert_interval_seconds": 60,
    "calendar_interval_seconds": 300,
    "holiday_country": "US",
    "holiday_region": "LA",
    "motion_enabled": True,
    "motion_gpio_bcm": 17,
    "motion_active_high": True,
    "motion_timeout_seconds": 300,
    "display_sleep_mode": "hdmi",
    "display_sleep_without_pir": True,
    "display_output": "HDMI-A-1",
    "weather_effects": "full",
    "background_preview": "auto",
    "background_preview_effects": [],
    "reduced_motion": False,
    "onscreen_keyboard_enabled": True,
    "alert_wake_severities": ["Extreme"],
    "alert_sound_severities": ["Severe", "Extreme"],
    "alert_advisory_enabled": True,
    "alert_warning_enabled": True,
    "alert_emergency_enabled": True,
    "alert_advisory_audio": False,
    "alert_warning_audio": True,
    "alert_emergency_audio": True,
    "alert_volume": 55,
    "timer_volume": 60,
    "audio_output": "default",
    "scanner_device": "",
    "auto_purchase_match": True,
    "completed_reminders_last": True,
    "remote_access_enabled": False,
    "mobile_dash_ipv4": "",
    "backup_enabled": False,
    "backup_path": "",
    "backup_retention": 7,
    "backup_schedule_hour": 3,
}


def utcnow() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path, timeout=15, isolation_level=None, check_same_thread=False
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=15000")
        return connection

    @property
    def connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = self._connect()
            self._local.connection = connection
        return connection

    def initialize(self) -> None:
        connection = self._connect()
        try:
            connection.executescript(SCHEMA)
            calendar_columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(calendars)").fetchall()
            }
            for name, definition in {
                "available": "INTEGER NOT NULL DEFAULT 1",
                "shared": "INTEGER NOT NULL DEFAULT 0",
                "read_only": "INTEGER NOT NULL DEFAULT 1",
            }.items():
                if name not in calendar_columns:
                    connection.execute(
                        f"ALTER TABLE calendars ADD COLUMN {name} {definition}"
                    )
            lot_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(inventory_lots)"
                ).fetchall()
            }
            if "notes" not in lot_columns:
                connection.execute(
                    "ALTER TABLE inventory_lots "
                    "ADD COLUMN notes TEXT NOT NULL DEFAULT ''"
                )
            product_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(products)"
                ).fetchall()
            }
            if "serving_size" not in product_columns:
                connection.execute(
                    "ALTER TABLE products "
                    "ADD COLUMN serving_size TEXT NOT NULL DEFAULT ''"
                )
            reminder_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(reminders)"
                ).fetchall()
            }
            if "high_priority" not in reminder_columns:
                connection.execute(
                    "ALTER TABLE reminders "
                    "ADD COLUMN high_priority INTEGER NOT NULL DEFAULT 0"
                )
            chore_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(planner_chores)"
                ).fetchall()
            }
            if "color" not in chore_columns:
                connection.execute(
                    "ALTER TABLE planner_chores "
                    "ADD COLUMN color TEXT NOT NULL DEFAULT '#A7D8F0'"
                )
            now = utcnow()
            connection.executemany(
                "INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES(?,?,?)",
                [
                    (key, json.dumps(value), now)
                    for key, value in DEFAULT_SETTINGS.items()
                ],
            )
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connection
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise

    def execute(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        return self.connection.execute(sql, params)

    def executemany(
        self, sql: str, params: Sequence[Sequence[Any]]
    ) -> sqlite3.Cursor:
        return self.connection.executemany(sql, params)

    def one(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        row = self.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self.execute(sql, params).fetchall()]

    def setting(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value_json FROM settings WHERE key=?", (key,))
        return json.loads(row["value_json"]) if row else default

    def settings(self) -> dict[str, Any]:
        return {
            row["key"]: json.loads(row["value_json"])
            for row in self.all("SELECT key, value_json FROM settings")
        }

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            """INSERT INTO settings(key, value_json, updated_at) VALUES(?,?,?)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
               updated_at=excluded.updated_at""",
            (key, json.dumps(value), utcnow()),
        )

    def set_settings(self, values: dict[str, Any]) -> None:
        now = utcnow()
        with self.transaction() as connection:
            connection.executemany(
                """INSERT INTO settings(key, value_json, updated_at) VALUES(?,?,?)
                   ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
                   updated_at=excluded.updated_at""",
                [(key, json.dumps(value), now) for key, value in values.items()],
            )

    def checkpoint(self) -> None:
        self.execute("PRAGMA wal_checkpoint(FULL)")

    def close_thread(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None
