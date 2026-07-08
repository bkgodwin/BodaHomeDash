from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import html
import shutil
import subprocess
import threading
import time as monotonic_time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import holidays
import httpx
import psutil
import uvicorn
from fastapi import (
    Cookie,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .backup import BackupManager
from .config import config
from .database import Database, utcnow
from .events import hub
from .hardware import AudioController, BarcodeMonitor
from .models import (
    BackupConfigure,
    BackupRestore,
    CalendarConnect,
    CalendarSelection,
    DnsUpdate,
    GoogleOAuthConfig,
    GoogleOAuthStart,
    HardwareTest,
    HouseholdMemberInput,
    LoginRequest,
    LotUpdate,
    LotDeleteMany,
    PantryAdd,
    PinSetup,
    PlannerChoreInput,
    PlannerChoreMembers,
    PlannerChoreMove,
    PlannerMealInput,
    PlannerMealMove,
    PlannerNoteInput,
    PlannerNoteMove,
    ReminderCreate,
    ReminderReorder,
    ReminderUpdate,
    RecipeInput,
    RecipeProgressInput,
    SettingsUpdate,
    ShoppingCreate,
    ShoppingUpdate,
    SharedNotepadInput,
    TimerCreate,
    WifiConnect,
)
from .providers.calendar import GoogleCalendarAPIProvider, GoogleCalendarProvider, ICloudCalendarProvider
from .providers.recipes import normalize_meal
from .security import AuthManager, SecretStore
from .services import DashboardServices
from .utils import normalize_barcode, normalize_name


database = Database(config.data_dir / "dashboard.db")
secret_store = SecretStore(database, config.data_dir)
auth = AuthManager(database, secret_store)
backups = BackupManager(database, config.data_dir)
services = DashboardServices(database, secret_store, backups, hub)
logger = logging.getLogger(__name__)
_response_cache: dict[str, tuple[float, Any]] = {}
_google_oauth_states: dict[str, dict[str, Any]] = {}
GOOGLE_OAUTH_SCOPE = " ".join(
    [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/calendar.readonly",
    ]
)


def cached_value(key: str, ttl_seconds: float, factory):
    now = monotonic_time.monotonic()
    cached = _response_cache.get(key)
    if cached and now - cached[0] < ttl_seconds:
        return cached[1]
    value = factory()
    _response_cache[key] = (now, value)
    return value


def clear_cached_values(prefix: str) -> None:
    for key in list(_response_cache):
        if key.startswith(prefix):
            _response_cache.pop(key, None)


def ipv4_interfaces() -> list[dict[str, str]]:
    addresses: list[dict[str, str]] = []
    for interface, entries in psutil.net_if_addrs().items():
        for entry in entries:
            if entry.family.name == "AF_INET" and entry.address != "127.0.0.1":
                addresses.append({"interface": interface, "address": entry.address})
    return sorted(
        addresses,
        key=lambda item: (
            0 if item["address"].startswith(("192.168.", "10.", "172.")) else 1,
            item["interface"].lower(),
        ),
    )


def mobile_dash_address() -> str:
    available = ipv4_interfaces()
    selected = database.setting("mobile_dash_ipv4", "")
    if any(item["address"] == selected for item in available):
        return f"{selected}:{config.port}"
    return f"{available[0]['address']}:{config.port}" if available else f"localhost:{config.port}"


def _nmcli(args: list[str], timeout: int = 12) -> str:
    result = subprocess.run(
        ["nmcli", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    return result.stdout.strip()


def _split_nmcli_line(line: str) -> list[str]:
    values: list[str] = []
    current = []
    escaped = False
    for character in line:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == ":":
            values.append("".join(current))
            current = []
        else:
            current.append(character)
    values.append("".join(current))
    return values


def network_status_payload() -> dict[str, Any]:
    interfaces = ipv4_interfaces()
    payload: dict[str, Any] = {
        "platform": platform.system(),
        "available": platform.system() == "Linux" and shutil.which("nmcli") is not None,
        "interfaces": interfaces,
        "wifi": {
            "connected": False,
            "device": "",
            "ssid": "",
            "signal": None,
            "security": "",
            "connection": "",
        },
        "dns": {"automatic": True, "servers": [], "connection": ""},
        "gateway": "",
    }
    if platform.system() != "Linux" or shutil.which("nmcli") is None:
        return payload
    try:
        for line in _nmcli(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status"]).splitlines():
            device, device_type, state, connection, *_ = [*_split_nmcli_line(line), "", "", "", ""]
            if device_type == "wifi" and state == "connected":
                payload["wifi"].update(
                    {
                        "connected": True,
                        "device": device,
                        "connection": connection,
                    }
                )
                break
        if payload["wifi"]["device"]:
            details = _nmcli(
                [
                    "-t",
                    "-f",
                    "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS",
                    "device",
                    "show",
                    payload["wifi"]["device"],
                ]
            )
            dns_servers = []
            for line in details.splitlines():
                key, value, *_ = [*_split_nmcli_line(line), ""]
                if key.startswith("IP4.GATEWAY"):
                    payload["gateway"] = value
                elif key.startswith("IP4.DNS") and value:
                    dns_servers.append(value)
            payload["dns"]["servers"] = dns_servers
        active_wifi = _nmcli(
            ["-t", "-f", "ACTIVE,SSID,SIGNAL,SECURITY", "dev", "wifi"],
            timeout=15,
        )
        for line in active_wifi.splitlines():
            active, ssid, signal, security, *_ = [*_split_nmcli_line(line), "", "", "", ""]
            if active == "yes":
                payload["wifi"].update(
                    {
                        "ssid": ssid,
                        "signal": int(signal) if signal.isdigit() else None,
                        "security": security,
                    }
                )
                break
        connection = payload["wifi"]["connection"]
        if connection:
            payload["dns"]["connection"] = connection
            dns_settings = _nmcli(
                ["-t", "-f", "ipv4.ignore-auto-dns,ipv4.dns", "connection", "show", connection]
            ).splitlines()
            for line in dns_settings:
                key, value, *_ = [*_split_nmcli_line(line), ""]
                if key == "ipv4.ignore-auto-dns":
                    payload["dns"]["automatic"] = value.lower() not in {"yes", "true"}
                elif key == "ipv4.dns" and value:
                    payload["dns"]["configured_servers"] = [
                        item.strip() for item in value.split(",") if item.strip()
                    ]
    except Exception as error:
        payload["error"] = str(error)
    return payload


def cached_network_status_payload() -> dict[str, Any]:
    return cached_value("network_status", 3.0, network_status_payload)


def _safe_resolve(path: Path) -> str:
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def _is_writable_directory(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    probe = path / f".bodadash-write-test-{uuid.uuid4().hex}"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def _backup_files_under(root: Path, limit: int = 50) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    if not root.exists() or not root.is_dir():
        return files
    ignored_dirs = {
        "$recycle.bin",
        "system volume information",
        ".spotlight-v100",
        ".trashes",
        ".trash-1000",
    }
    visited_dirs = 0
    try:
        for directory, dirnames, filenames in os.walk(root):
            visited_dirs += 1
            if visited_dirs > 5000:
                break
            dirnames[:] = [
                name
                for name in dirnames
                if not name.startswith(".") and name.lower() not in ignored_dirs
            ]
            for filename in filenames:
                if not filename.lower().endswith(".hdbak"):
                    continue
                path = Path(directory) / filename
                try:
                    stat = path.stat()
                except OSError:
                    continue
                files.append(
                    {
                        "path": str(path),
                        "name": filename,
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    }
                )
                if len(files) >= limit * 2:
                    break
            if len(files) >= limit * 2:
                break
    except OSError:
        return files
    return sorted(files, key=lambda item: item["modified"], reverse=True)[:limit]


def _candidate_media_paths(extra_paths: list[Path] | None = None) -> list[Path]:
    candidates: list[Path] = []
    system = platform.system()

    def add(path: Path) -> None:
        if path.exists() and path.is_dir():
            candidates.append(path)

    if system == "Windows":
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            add(Path(f"{letter}:\\"))
    else:
        for base in [Path("/media"), Path("/run/media"), Path("/mnt")]:
            if not base.exists():
                continue
            try:
                children = [item for item in base.iterdir() if item.is_dir()]
            except OSError:
                continue
            for child in children:
                if child.name.startswith("."):
                    continue
                try:
                    grandchildren = [
                        item
                        for item in child.iterdir()
                        if item.is_dir() and not item.name.startswith(".")
                    ]
                except OSError:
                    grandchildren = []
                if base in {Path("/media"), Path("/run/media")} and grandchildren:
                    for grandchild in grandchildren:
                        add(grandchild)
                else:
                    add(child)
    configured = database.setting("backup_path", "")
    if configured:
        configured_path = Path(configured)
        add(configured_path if configured_path.is_dir() else configured_path.parent)
    for path in extra_paths or []:
        add(path)

    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        resolved = _safe_resolve(path)
        if resolved not in seen:
            seen.add(resolved)
            unique.append(path)
    return unique


def backup_media_candidates(extra_paths: list[Path] | None = None) -> list[dict[str, Any]]:
    media: list[dict[str, Any]] = []
    for path in _candidate_media_paths(extra_paths):
        backup_path = (
            path
            if path.name.lower() in {"bodadashbackups", "backups", "backup"}
            else path / "BodaDashBackups"
        )
        backups_found = _backup_files_under(path, limit=6)
        try:
            usage = shutil.disk_usage(str(path))
            free_bytes = usage.free
            total_bytes = usage.total
        except OSError:
            free_bytes = None
            total_bytes = None
        media.append(
            {
                "name": path.name or str(path),
                "path": str(path),
                "backup_path": str(backup_path),
                "writable": _is_writable_directory(path),
                "free_bytes": free_bytes,
                "total_bytes": total_bytes,
                "existing_backup_count": len(backups_found),
                "latest_backup": backups_found[0] if backups_found else None,
            }
        )
    return sorted(
        media,
        key=lambda item: (
            not item["writable"],
            -int(item["free_bytes"] or 0),
            item["name"].lower(),
        ),
    )


def schedule_background(coroutine, label: str) -> None:
    task = asyncio.create_task(coroutine, name=label)

    def finished(completed: asyncio.Task) -> None:
        try:
            completed.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Background task %s failed", label)

    task.add_done_callback(finished)


def is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in {"127.0.0.1", "::1", "localhost", "testclient"}


def refresh_kiosk_launcher() -> None:
    """Keep the user-session launcher current after a one-click app update."""
    if platform.system() != "Linux":
        return
    source = Path("/opt/home-dashboard/deploy/launch-kiosk.sh")
    if not source.is_file():
        return
    target = Path.home() / ".local/bin/home-dashboard-kiosk"
    temporary = target.with_name(f".{target.name}.new")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, temporary)
        temporary.chmod(0o755)
        temporary.replace(target)
    except OSError:
        logger.exception("Could not refresh the kiosk launcher")
        temporary.unlink(missing_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    refresh_kiosk_launcher()
    await services.start()
    yield
    await services.stop()
    database.close_thread()


app = FastAPI(
    title="Home Dashboard",
    version=__version__,
    docs_url="/api/docs" if config.debug else None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def access_control(request: Request, call_next):
    path = request.url.path
    public = (
        path
        in {
            "/api/v1/status",
            "/api/v1/auth/login",
            "/api/v1/auth/state",
            "/api/v1/calendar/google/callback",
        }
        or not path.startswith("/api/")
    )
    local = is_local(request)
    device_only = (
        "/api/v1/settings",
        "/api/v1/network",
        "/api/v1/hardware",
        "/api/v1/display",
        "/api/v1/backups",
        "/api/v1/system",
        "/api/v1/sync",
    )
    if path.startswith(device_only) and not local:
        return JSONResponse(
            {"detail": "Device settings are only available on the kiosk"}, status_code=403
        )
    if not public and not local:
        if not database.setting("remote_access_enabled", False):
            return JSONResponse({"detail": "Remote access is disabled"}, status_code=403)
        token = request.cookies.get("dashboard_session")
        if not auth.verify_session(token):
            return JSONResponse({"detail": "Authentication required"}, status_code=401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = (
        "SAMEORIGIN"
        if path.startswith("/api/v1/tropical")
        else "DENY"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/v1/status")
def status(request: Request) -> dict[str, Any]:
    return {
        "version": __version__,
        "setup_complete": database.setting("setup_complete", False),
        "local": is_local(request),
        "remote_access_enabled": database.setting("remote_access_enabled", False),
        "authenticated": is_local(request)
        or auth.verify_session(request.cookies.get("dashboard_session")),
        "clock_24_hour": database.setting("clock_24_hour", False),
        "garbage_pickup_enabled": database.setting(
            "garbage_pickup_enabled", False
        ),
        "garbage_pickup_weekday": database.setting(
            "garbage_pickup_weekday", 1
        ),
        "reduced_motion": database.setting("reduced_motion", False),
        "weather_effects": database.setting("weather_effects", "full"),
        "background_preview": database.setting("background_preview", "auto"),
        "background_preview_effects": database.setting(
            "background_preview_effects", []
        ),
        "display_awake_lock": services.display_awake_lock,
        "onscreen_keyboard_enabled": database.setting(
            "onscreen_keyboard_enabled", True
        ),
        "platform": platform.system(),
        "mobile_dash_address": mobile_dash_address(),
        "time": utcnow(),
    }


@app.get("/api/v1/network/interfaces")
def network_interfaces():
    selected = database.setting("mobile_dash_ipv4", "")
    available = ipv4_interfaces()
    status_payload = cached_network_status_payload()
    return {
        "interfaces": available,
        "selected": selected,
        "port": config.port,
        "listening_host": config.host,
        "selected_available": not selected
        or any(item["address"] == selected for item in available),
        "restart_required": False,
        "status": status_payload,
    }


@app.get("/api/v1/network/status")
def network_status():
    return cached_network_status_payload()


@app.get("/api/v1/auth/state")
def auth_state(request: Request) -> dict[str, bool]:
    return {
        "local": is_local(request),
        "has_pin": auth.has_pin(),
        "enabled": database.setting("remote_access_enabled", False),
        "authenticated": is_local(request)
        or auth.verify_session(request.cookies.get("dashboard_session")),
    }


@app.post("/api/v1/auth/login")
def login(payload: LoginRequest, request: Request, response: Response):
    client = request.client.host if request.client else "unknown"
    if not auth.verify_pin(payload.pin, client):
        raise HTTPException(status_code=401, detail="Incorrect PIN or temporarily locked")
    token = auth.create_session()
    response.set_cookie(
        "dashboard_session",
        token,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        max_age=30 * 86400,
    )
    return {"authenticated": True}


@app.post("/api/v1/auth/logout")
def logout(response: Response, dashboard_session: str | None = Cookie(default=None)):
    auth.revoke(dashboard_session)
    response.delete_cookie("dashboard_session")
    return {"authenticated": False}


@app.put("/api/v1/settings/pin")
def set_pin(payload: PinSetup):
    auth.set_pin(payload.pin)
    database.set_settings({"remote_access_enabled": True})
    return {"configured": True}


@app.get("/api/v1/settings")
def get_settings() -> dict[str, Any]:
    settings = database.settings()
    settings.update(
        {
            "remote_pin_configured": auth.has_pin(),
            "backup_password_configured": secret_store.get("backup_password") is not None,
            "google_oauth_client_secret_configured": secret_store.get(
                "google_oauth_client_secret"
            )
            is not None,
            "calendar_accounts": database.all(
                """SELECT id,provider,display_name,username,enabled,last_sync_at,
                          last_error,created_at,updated_at
                   FROM calendar_accounts ORDER BY id"""
            ),
            "sync_state": database.all("SELECT * FROM sync_state ORDER BY provider"),
        }
    )
    return settings


@app.patch("/api/v1/settings")
async def update_settings(payload: SettingsUpdate):
    allowed = set(database.settings()) | {
        "household_name",
        "text_scale",
        "quiet_hours_start",
        "quiet_hours_end",
    }
    unknown = set(payload.values) - allowed
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unsupported settings: {', '.join(sorted(unknown))}"
        )
    database.set_settings(payload.values)
    if any(
        key
        in {
            "motion_enabled",
            "motion_gpio_bcm",
            "motion_active_high",
            "scanner_device",
            "display_output",
            "audio_output",
        }
        for key in payload.values
    ):
        services.restart_hardware()
    await hub.broadcast("settings.updated", {"keys": list(payload.values)})
    return database.settings()


@app.get("/api/v1/calendar")
def calendar_range(
    start: date = Query(...),
    end: date = Query(...),
) -> dict[str, Any]:
    if end <= start or (end - start).days > 100:
        raise HTTPException(status_code=400, detail="Invalid calendar range")
    timezone = ZoneInfo(database.setting("timezone", "America/Chicago"))
    starts_at = datetime.combine(start, time.min, timezone).astimezone(UTC).isoformat()
    ends_at = datetime.combine(end, time.min, timezone).astimezone(UTC).isoformat()
    events = database.all(
        """SELECT ce.*,c.name AS calendar_name,c.color
           FROM calendar_events ce JOIN calendars c ON c.id=ce.calendar_id
           WHERE c.enabled=1 AND ce.starts_at<? AND ce.ends_at>?
           ORDER BY ce.starts_at""",
        (ends_at, starts_at),
    )
    holiday_items: list[dict[str, Any]] = []
    try:
        years = list(range(start.year, end.year + 1))
        region = database.setting("holiday_region", "LA")
        observed = holidays.US(years=years, subdiv=region)
        holiday_items = [
            {
                "date": day.isoformat(),
                "title": name,
                "type": "holiday",
            }
            for day, name in observed.items()
            if start <= day < end
        ]
    except Exception:
        pass
    expirations = database.all(
        """SELECT il.expires_on,p.id AS product_id,p.name,SUM(il.quantity) AS quantity
           FROM inventory_lots il JOIN products p ON p.id=il.product_id
           WHERE il.expires_on>=? AND il.expires_on<?
           GROUP BY il.expires_on,p.id,p.name ORDER BY il.expires_on,p.name""",
        (start.isoformat(), end.isoformat()),
    )
    return {
        "events": events,
        "holidays": holiday_items,
        "expirations": expirations,
    }


def _week_start(value: date) -> date:
    # Python numbers Monday as zero; the household planner is Sunday-first.
    return value - timedelta(days=(value.weekday() + 1) % 7)


def _planner_chore(chore: dict[str, Any], week: date) -> dict[str, Any]:
    planned = (
        week + timedelta(days=(int(chore["weekday"]) + 1) % 7)
        if chore["recurring"]
        else date.fromisoformat(chore["scheduled_date"])
    )
    members = database.all(
        """SELECT hm.* FROM household_members hm
           JOIN planner_chore_members pcm ON pcm.member_id=hm.id
           WHERE pcm.chore_id=? ORDER BY hm.position,hm.name COLLATE NOCASE""",
        (chore["id"],),
    )
    completion = database.one(
        """SELECT completed_at FROM planner_chore_completions
           WHERE chore_id=? AND week_start=?""",
        (chore["id"], week.isoformat()),
    )
    return {
        **chore,
        "planned_date": planned.isoformat(),
        "members": members,
        "completed": completion is not None,
        "completed_at": completion["completed_at"] if completion else None,
    }


@app.get("/api/v1/household/members")
def household_members():
    return database.all(
        "SELECT * FROM household_members ORDER BY position,name COLLATE NOCASE"
    )


@app.post("/api/v1/household/members")
async def create_household_member(payload: HouseholdMemberInput):
    now = utcnow()
    position = database.one(
        "SELECT COALESCE(MAX(position),-1)+1 AS next FROM household_members"
    )["next"]
    cursor = database.execute(
        """INSERT INTO household_members(name,color,position,created_at,updated_at)
           VALUES(?,?,?,?,?)""",
        (payload.name, payload.color, position, now, now),
    )
    await hub.broadcast("planner.updated", {"scope": "members"})
    return database.one(
        "SELECT * FROM household_members WHERE id=?", (cursor.lastrowid,)
    )


@app.put("/api/v1/household/members/{member_id}")
async def update_household_member(member_id: int, payload: HouseholdMemberInput):
    changed = database.execute(
        """UPDATE household_members SET name=?,color=?,updated_at=? WHERE id=?""",
        (payload.name, payload.color, utcnow(), member_id),
    ).rowcount
    if not changed:
        raise HTTPException(status_code=404, detail="Household member not found")
    await hub.broadcast("planner.updated", {"scope": "members"})
    return database.one("SELECT * FROM household_members WHERE id=?", (member_id,))


@app.delete("/api/v1/household/members/{member_id}", status_code=204)
async def delete_household_member(member_id: int):
    changed = database.execute(
        "DELETE FROM household_members WHERE id=?", (member_id,)
    ).rowcount
    if not changed:
        raise HTTPException(status_code=404, detail="Household member not found")
    await hub.broadcast("planner.updated", {"scope": "members"})
    return Response(status_code=204)


@app.get("/api/v1/planner/week")
def planner_week(start: date = Query(...)):
    week = _week_start(start)
    end = week + timedelta(days=7)
    current_week = _week_start(date.today())
    database.execute(
        """DELETE FROM planner_chores
           WHERE recurring=0 AND scheduled_date<?""",
        (current_week.isoformat(),),
    )
    meals = database.all(
        """SELECT pm.*,
                  COALESCE(NULLIF(r.image_data,''),NULLIF(r.image_url,''),pm.image_url)
                    AS display_image
           FROM planner_meals pm
           LEFT JOIN recipes r ON r.recipe_id=pm.recipe_id
           WHERE pm.planned_date>=? AND pm.planned_date<?
           ORDER BY pm.planned_date,pm.position,pm.id""",
        (week.isoformat(), end.isoformat()),
    )
    chore_rows = database.all(
        """SELECT * FROM planner_chores
           WHERE (recurring=1 AND substr(created_at,1,10)<?)
              OR (scheduled_date>=? AND scheduled_date<?)
           ORDER BY position,id""",
        (end.isoformat(), week.isoformat(), end.isoformat()),
    )
    chores = [_planner_chore(chore, week) for chore in chore_rows]
    notes = database.all(
        """SELECT * FROM planner_notes
           WHERE planned_date>=? AND planned_date<?
           ORDER BY planned_date,id""",
        (week.isoformat(), end.isoformat()),
    )
    return {
        "start": week.isoformat(),
        "end": end.isoformat(),
        "meals": meals,
        "chores": chores,
        "notes": notes,
    }


@app.post("/api/v1/planner/meals")
async def create_planner_meal(payload: PlannerMealInput):
    if payload.recipe_id and not database.one(
        "SELECT recipe_id FROM recipes WHERE recipe_id=?", (payload.recipe_id,)
    ):
        raise HTTPException(status_code=404, detail="Recipe is not cached")
    position = database.one(
        """SELECT COALESCE(MAX(position),-1)+1 AS next FROM planner_meals
           WHERE planned_date=?""",
        (payload.planned_date.isoformat(),),
    )["next"]
    now = utcnow()
    cursor = database.execute(
        """INSERT INTO planner_meals(
               planned_date,recipe_id,title,image_url,position,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?)""",
        (
            payload.planned_date.isoformat(),
            payload.recipe_id,
            payload.title,
            payload.image_url,
            position,
            now,
            now,
        ),
    )
    await hub.broadcast("planner.updated", {"scope": "meals"})
    return database.one("SELECT * FROM planner_meals WHERE id=?", (cursor.lastrowid,))


@app.delete("/api/v1/planner/meals/{meal_id}", status_code=204)
async def delete_planner_meal(meal_id: int):
    if not database.execute("DELETE FROM planner_meals WHERE id=?", (meal_id,)).rowcount:
        raise HTTPException(status_code=404, detail="Planned meal not found")
    await hub.broadcast("planner.updated", {"scope": "meals"})
    return Response(status_code=204)


@app.put("/api/v1/planner/meals/{meal_id}/move")
async def move_planner_meal(meal_id: int, payload: PlannerMealMove):
    meal = database.one("SELECT * FROM planner_meals WHERE id=?", (meal_id,))
    if not meal:
        raise HTTPException(status_code=404, detail="Planned meal not found")
    old_date = meal["planned_date"]
    new_date = payload.planned_date.isoformat()
    with database.transaction() as connection:
        if old_date == new_date:
            ordered = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM planner_meals
                       WHERE planned_date=? ORDER BY position,id""",
                    (old_date,),
                ).fetchall()
            ]
            ordered.remove(meal_id)
            ordered.insert(min(payload.position, len(ordered)), meal_id)
            for position, item_id in enumerate(ordered):
                connection.execute(
                    "UPDATE planner_meals SET position=?,updated_at=? WHERE id=?",
                    (position, utcnow(), item_id),
                )
        else:
            old_order = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM planner_meals
                       WHERE planned_date=? AND id<>? ORDER BY position,id""",
                    (old_date, meal_id),
                ).fetchall()
            ]
            new_order = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM planner_meals
                       WHERE planned_date=? ORDER BY position,id""",
                    (new_date,),
                ).fetchall()
            ]
            new_order.insert(min(payload.position, len(new_order)), meal_id)
            now = utcnow()
            for position, item_id in enumerate(old_order):
                connection.execute(
                    "UPDATE planner_meals SET position=?,updated_at=? WHERE id=?",
                    (position, now, item_id),
                )
            for position, item_id in enumerate(new_order):
                connection.execute(
                    """UPDATE planner_meals
                       SET planned_date=?,position=?,updated_at=? WHERE id=?""",
                    (new_date, position, now, item_id),
                )
    await hub.broadcast("planner.updated", {"scope": "meals"})
    return database.one("SELECT * FROM planner_meals WHERE id=?", (meal_id,))


@app.post("/api/v1/planner/chores")
async def create_planner_chore(payload: PlannerChoreInput):
    member_ids = sorted(set(payload.member_ids))
    if member_ids:
        placeholders = ",".join("?" for _ in member_ids)
        found = database.one(
            f"SELECT COUNT(*) AS count FROM household_members WHERE id IN ({placeholders})",
            tuple(member_ids),
        )["count"]
        if found != len(member_ids):
            raise HTTPException(status_code=400, detail="Unknown household member")
    position = database.one(
        "SELECT COALESCE(MAX(position),-1)+1 AS next FROM planner_chores"
    )["next"]
    now = utcnow()
    with database.transaction() as connection:
        cursor = connection.execute(
            """INSERT INTO planner_chores(
                   title,color,recurring,weekday,scheduled_date,position,created_at,updated_at
               ) VALUES(?,?,?,?,?,?,?,?)""",
            (
                payload.title,
                payload.color,
                int(payload.recurring),
                payload.planned_date.weekday() if payload.recurring else None,
                None if payload.recurring else payload.planned_date.isoformat(),
                position,
                now,
                now,
            ),
        )
        connection.executemany(
            "INSERT INTO planner_chore_members(chore_id,member_id) VALUES(?,?)",
            [(cursor.lastrowid, member_id) for member_id in member_ids],
        )
    week = _week_start(payload.planned_date)
    await hub.broadcast("planner.updated", {"scope": "chores"})
    chore = database.one("SELECT * FROM planner_chores WHERE id=?", (cursor.lastrowid,))
    assert chore is not None
    return _planner_chore(chore, week)


@app.put("/api/v1/planner/chores/{chore_id}/move")
async def move_planner_chore(chore_id: int, payload: PlannerChoreMove):
    chore = database.one("SELECT * FROM planner_chores WHERE id=?", (chore_id,))
    if not chore:
        raise HTTPException(status_code=404, detail="Chore not found")
    if chore["recurring"]:
        database.execute(
            "UPDATE planner_chores SET weekday=?,updated_at=? WHERE id=?",
            (payload.planned_date.weekday(), utcnow(), chore_id),
        )
    else:
        database.execute(
            "UPDATE planner_chores SET scheduled_date=?,updated_at=? WHERE id=?",
            (payload.planned_date.isoformat(), utcnow(), chore_id),
        )
    await hub.broadcast("planner.updated", {"scope": "chores"})
    updated = database.one("SELECT * FROM planner_chores WHERE id=?", (chore_id,))
    assert updated is not None
    return _planner_chore(updated, _week_start(payload.planned_date))


@app.put("/api/v1/planner/chores/{chore_id}/members")
async def set_planner_chore_members(
    chore_id: int, payload: PlannerChoreMembers
):
    chore = database.one("SELECT * FROM planner_chores WHERE id=?", (chore_id,))
    if not chore:
        raise HTTPException(status_code=404, detail="Chore not found")
    member_ids = sorted(set(payload.member_ids))
    if member_ids:
        placeholders = ",".join("?" for _ in member_ids)
        found = database.one(
            f"SELECT COUNT(*) AS count FROM household_members WHERE id IN ({placeholders})",
            tuple(member_ids),
        )["count"]
        if found != len(member_ids):
            raise HTTPException(status_code=400, detail="Unknown household member")
    with database.transaction() as connection:
        connection.execute(
            "DELETE FROM planner_chore_members WHERE chore_id=?", (chore_id,)
        )
        connection.executemany(
            "INSERT INTO planner_chore_members(chore_id,member_id) VALUES(?,?)",
            [(chore_id, member_id) for member_id in member_ids],
        )
    await hub.broadcast("planner.updated", {"scope": "chores"})
    return {"chore_id": chore_id, "member_ids": member_ids}


@app.put("/api/v1/planner/chores/{chore_id}/complete")
async def complete_planner_chore(
    chore_id: int,
    week_start: date,
    completed: bool = True,
):
    if not database.one("SELECT id FROM planner_chores WHERE id=?", (chore_id,)):
        raise HTTPException(status_code=404, detail="Chore not found")
    week = _week_start(week_start).isoformat()
    if completed:
        database.execute(
            """INSERT INTO planner_chore_completions(
                   chore_id,week_start,completed_at
               ) VALUES(?,?,?)
               ON CONFLICT(chore_id,week_start) DO UPDATE SET
                   completed_at=excluded.completed_at""",
            (chore_id, week, utcnow()),
        )
    else:
        database.execute(
            """DELETE FROM planner_chore_completions
               WHERE chore_id=? AND week_start=?""",
            (chore_id, week),
        )
    await hub.broadcast("planner.updated", {"scope": "chores"})
    return {"chore_id": chore_id, "week_start": week, "completed": completed}


@app.delete("/api/v1/planner/chores/{chore_id}", status_code=204)
async def delete_planner_chore(chore_id: int):
    if not database.execute(
        "DELETE FROM planner_chores WHERE id=?", (chore_id,)
    ).rowcount:
        raise HTTPException(status_code=404, detail="Chore not found")
    await hub.broadcast("planner.updated", {"scope": "chores"})
    return Response(status_code=204)


@app.post("/api/v1/planner/notes")
async def create_planner_note(payload: PlannerNoteInput):
    now = utcnow()
    cursor = database.execute(
        """INSERT INTO planner_notes(planned_date,text,created_at,updated_at)
           VALUES(?,?,?,?)""",
        (payload.planned_date.isoformat(), payload.text, now, now),
    )
    await hub.broadcast("planner.updated", {"scope": "notes"})
    return database.one("SELECT * FROM planner_notes WHERE id=?", (cursor.lastrowid,))


@app.put("/api/v1/planner/notes/{note_id}/move")
async def move_planner_note(note_id: int, payload: PlannerNoteMove):
    changed = database.execute(
        "UPDATE planner_notes SET planned_date=?,updated_at=? WHERE id=?",
        (payload.planned_date.isoformat(), utcnow(), note_id),
    ).rowcount
    if not changed:
        raise HTTPException(status_code=404, detail="Planner note not found")
    await hub.broadcast("planner.updated", {"scope": "notes"})
    return database.one("SELECT * FROM planner_notes WHERE id=?", (note_id,))


@app.delete("/api/v1/planner/notes/{note_id}", status_code=204)
async def delete_planner_note(note_id: int):
    if not database.execute("DELETE FROM planner_notes WHERE id=?", (note_id,)).rowcount:
        raise HTTPException(status_code=404, detail="Planner note not found")
    await hub.broadcast("planner.updated", {"scope": "notes"})
    return Response(status_code=204)


@app.get("/api/v1/notepad")
def shared_notepad():
    row = database.one("SELECT * FROM shared_notepad WHERE id=1")
    return row or {"id": 1, "content_html": "", "updated_at": None}


@app.put("/api/v1/notepad")
async def update_shared_notepad(payload: SharedNotepadInput):
    content = re.sub(
        r"<(script|style)\b[^>]*>.*?</\1>",
        "",
        payload.content_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    now = utcnow()
    database.execute(
        """INSERT INTO shared_notepad(id,content_html,updated_at) VALUES(1,?,?)
           ON CONFLICT(id) DO UPDATE SET
               content_html=excluded.content_html,
               updated_at=excluded.updated_at""",
        (content, now),
    )
    await hub.broadcast("notepad.updated", {"updated_at": now})
    return {"id": 1, "content_html": content, "updated_at": now}


@app.post("/api/v1/calendar/connect")
async def connect_calendar(payload: CalendarConnect):
    if payload.provider == "google":
        raise HTTPException(
            status_code=400,
            detail=(
                "Google no longer supports password-based CalDAV login here. "
                "Use Connect Google Calendar to authorize with your browser."
            ),
        )
    provider = (
        GoogleCalendarProvider(payload.username, payload.app_password)
        if payload.provider == "google"
        else ICloudCalendarProvider(payload.username, payload.app_password)
    )
    provider_label = "Google" if payload.provider == "google" else "iCloud"
    try:
        remote_calendars = await provider.discover()
    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=f"Could not connect to {provider_label}: {error}",
        ) from error
    now = utcnow()
    display_name = payload.display_name or provider_label
    cursor = database.execute(
        """INSERT INTO calendar_accounts(
            provider,display_name,username,created_at,updated_at
        ) VALUES(?,?,?,?,?)""",
        (payload.provider, display_name, payload.username, now, now),
    )
    account_id = cursor.lastrowid
    secret_store.set(f"calendar_password_{account_id}", payload.app_password)
    colors = ["#6ea8fe", "#ff8a65", "#66d19e", "#c792ea", "#ffd166", "#58c4dc"]
    database.executemany(
        """INSERT INTO calendars(
               account_id,remote_id,name,color,enabled,available,shared,read_only
           ) VALUES(?,?,?,?,1,1,?,?)""",
        [
            (
                account_id,
                item.remote_id,
                item.name,
                colors[index % len(colors)],
                int(item.shared),
                int(item.read_only),
            )
            for index, item in enumerate(remote_calendars)
        ],
    )
    calendars = list_calendars()
    schedule_background(services.sync_calendars(), "calendar-connect-sync")
    return {"account_id": account_id, "calendars": calendars}


@app.get("/api/v1/calendar/google/status")
def google_calendar_status():
    return {
        "client_id": database.setting("google_oauth_client_id", ""),
        "client_secret_configured": secret_store.get("google_oauth_client_secret")
        is not None,
        "accounts": database.all(
            """SELECT id,display_name,username,enabled,last_sync_at,last_error
               FROM calendar_accounts WHERE provider='google' ORDER BY id"""
        ),
    }


@app.post("/api/v1/calendar/google/config")
def configure_google_oauth(payload: GoogleOAuthConfig):
    database.set_settings({"google_oauth_client_id": payload.client_id.strip()})
    if payload.client_secret:
        secret_store.set("google_oauth_client_secret", payload.client_secret.strip())
    return google_calendar_status()


@app.post("/api/v1/calendar/google/start")
def start_google_oauth(payload: GoogleOAuthStart):
    client_id = database.setting("google_oauth_client_id", "")
    client_secret = secret_store.get("google_oauth_client_secret")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail="Enter and save the Google OAuth Client ID and Client Secret first.",
        )
    state = uuid.uuid4().hex
    _google_oauth_states[state] = {
        "created_at": monotonic_time.monotonic(),
        "display_name": payload.display_name or "Google",
        "redirect_uri": payload.redirect_uri,
    }
    # Keep the in-memory state table tidy; OAuth should complete in a few minutes.
    cutoff = monotonic_time.monotonic() - 600
    for key, value in list(_google_oauth_states.items()):
        if value.get("created_at", 0) < cutoff:
            _google_oauth_states.pop(key, None)
    params = {
        "client_id": client_id,
        "redirect_uri": payload.redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_OAUTH_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "include_granted_scopes": "true",
    }
    return {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?"
        + urlencode(params),
        "state": state,
    }


@app.get("/api/v1/calendar/google/callback")
async def google_calendar_callback(
    code: str = "",
    state: str = "",
    error: str = "",
):
    def page(title: str, message: str, ok: bool = False) -> HTMLResponse:
        color = "#8df2b1" if ok else "#ff9d9d"
        return HTMLResponse(
            f"""<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#071a2d;color:white;font-family:system-ui,sans-serif}}
main{{max-width:680px;margin:20px;padding:28px;border:1px solid #ffffff29;border-radius:24px;background:#ffffff14;box-shadow:0 20px 70px #0008}}
h1{{color:{color};margin-top:0}}p{{line-height:1.45}}button{{min-height:44px;border:0;border-radius:12px;padding:0 18px;background:#8bc7ff;color:#06213b;font-weight:700}}
</style></head><body><main>
<h1>{html.escape(title)}</h1><p>{html.escape(message)}</p>
<button onclick="window.close()">Close this window</button>
</main></body></html>"""
        )

    if error:
        return page("Google Calendar not connected", error)
    state_payload = _google_oauth_states.pop(state, None)
    if not code or not state_payload:
        return page(
            "Google Calendar not connected",
            "The authorization session expired. Return to BodaDash and try again.",
        )
    client_id = database.setting("google_oauth_client_id", "")
    client_secret = secret_store.get("google_oauth_client_secret")
    if not client_id or not client_secret:
        return page(
            "Google Calendar not connected",
            "Google OAuth credentials are not configured in BodaDash.",
        )
    token_response = await services.client.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": state_payload["redirect_uri"],
            "grant_type": "authorization_code",
        },
    )
    if token_response.status_code >= 400:
        return page(
            "Google Calendar not connected",
            f"Google rejected the authorization code: {token_response.text[:300]}",
        )
    token = token_response.json()
    access_token = token.get("access_token")
    if not access_token or not token.get("refresh_token"):
        return page(
            "Google Calendar not connected",
            "Google did not return a refresh token. Try again and approve access when prompted.",
        )
    user_response = await services.client.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    user_info = user_response.json() if user_response.status_code < 400 else {}
    username = user_info.get("email") or "Google Calendar"
    now = utcnow()
    existing = database.one(
        "SELECT id FROM calendar_accounts WHERE provider='google' AND username=?",
        (username,),
    )
    if existing:
        account_id = existing["id"]
        database.execute(
            """UPDATE calendar_accounts
               SET display_name=?,enabled=1,updated_at=?,last_error=NULL WHERE id=?""",
            (state_payload["display_name"], now, account_id),
        )
    else:
        cursor = database.execute(
            """INSERT INTO calendar_accounts(
                provider,display_name,username,created_at,updated_at
            ) VALUES('google',?,?,?,?)""",
            (state_payload["display_name"], username, now, now),
        )
        account_id = cursor.lastrowid
    token["expires_at"] = monotonic_time.time() + int(token.get("expires_in", 3600))
    secret_store.set(f"calendar_google_token_{account_id}", json.dumps(token))
    secret_store.delete(f"calendar_password_{account_id}")
    provider = GoogleCalendarAPIProvider(access_token, services.client)
    account = database.one("SELECT * FROM calendar_accounts WHERE id=?", (account_id,))
    try:
        await services._rediscover_account(account, provider)
    except Exception as discover_error:
        database.execute(
            """UPDATE calendar_accounts SET last_error=?,updated_at=? WHERE id=?""",
            (str(discover_error), utcnow(), account_id),
        )
        return page(
            "Google Calendar connected with a warning",
            f"Authorization succeeded, but calendar discovery failed: {discover_error}",
        )
    schedule_background(services.sync_calendars(), "google-calendar-connect-sync")
    await hub.broadcast("calendar.discovery.updated", {"provider": "google"})
    return page(
        "Google Calendar connected",
        "You can close this window and return to BodaDash to choose visible calendars.",
        ok=True,
    )


@app.get("/api/v1/calendar/calendars")
def list_calendars():
    return database.all(
        """SELECT c.*,a.display_name AS account_name,a.provider
           FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id
           ORDER BY c.available DESC,a.id,c.name"""
    )


@app.post("/api/v1/calendar/rediscover")
async def rediscover_calendars():
    try:
        calendars = await services.rediscover_calendars()
        await hub.broadcast(
            "calendar.discovery.updated", {"count": len(calendars)}
        )
        return calendars
    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=f"Calendar discovery failed: {error}",
        ) from error


@app.put("/api/v1/calendar/calendars")
async def select_calendars(payload: CalendarSelection):
    with database.transaction() as connection:
        connection.execute("UPDATE calendars SET enabled=0")
        if payload.enabled_ids:
            placeholders = ",".join("?" for _ in payload.enabled_ids)
            connection.execute(
                f"UPDATE calendars SET enabled=1 WHERE id IN ({placeholders})",
                tuple(payload.enabled_ids),
            )
        for calendar_id, color in payload.colors.items():
            if len(color) == 7 and color.startswith("#"):
                connection.execute(
                    "UPDATE calendars SET color=? WHERE id=?", (color, calendar_id)
                )
    schedule_background(services.sync_calendars(), "calendar-selection-sync")
    return list_calendars()


@app.delete("/api/v1/calendar/accounts/{account_id}")
async def delete_calendar_account(account_id: int):
    database.execute("DELETE FROM calendar_accounts WHERE id=?", (account_id,))
    secret_store.delete(f"calendar_password_{account_id}")
    secret_store.delete(f"calendar_google_token_{account_id}")
    await hub.broadcast("calendar.updated", {})
    return Response(status_code=204)


def pantry_rows(search: str = "") -> list[dict[str, Any]]:
    query = """
        SELECT p.*,SUM(il.quantity) AS total_quantity,
               MIN(il.expires_on) AS nearest_expiration,
               GROUP_CONCAT(DISTINCT pb.barcode) AS barcodes
        FROM products p
        JOIN inventory_lots il ON il.product_id=p.id
        LEFT JOIN product_barcodes pb ON pb.product_id=p.id
    """
    params: list[Any] = []
    if search:
        query += " WHERE p.normalized_name LIKE ? OR lower(p.brand) LIKE ? "
        term = f"%{normalize_name(search)}%"
        params.extend([term, term])
    query += " GROUP BY p.id ORDER BY p.normalized_name "
    rows = database.all(query, params)
    for row in rows:
        row["lots"] = database.all(
            "SELECT * FROM inventory_lots WHERE product_id=? ORDER BY expires_on",
            (row["id"],),
        )
        row["nutrition"] = json.loads(row.pop("nutrition_json") or "{}")
    return rows


@app.get("/api/v1/pantry")
def pantry(search: str = ""):
    return pantry_rows(search)


@app.get("/api/v1/products/{product_id}")
def product_detail(product_id: int):
    product = database.one("SELECT * FROM products WHERE id=?", (product_id,))
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    product["barcodes"] = database.all(
        "SELECT barcode,original_barcode FROM product_barcodes WHERE product_id=?",
        (product_id,),
    )
    product["lots"] = database.all(
        "SELECT * FROM inventory_lots WHERE product_id=? ORDER BY expires_on",
        (product_id,),
    )
    product["nutrition"] = json.loads(product.pop("nutrition_json") or "{}")
    return product


@app.post("/api/v1/barcodes/lookup")
async def barcode_lookup(barcode: str = Query(..., max_length=32)):
    try:
        return await services.lookup_barcode(barcode)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/v1/pantry")
async def add_pantry(payload: PantryAdd):
    now = utcnow()
    product_id = payload.product_id
    barcode = None
    if payload.barcode:
        try:
            barcode = normalize_barcode(payload.barcode)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        existing = database.one(
            "SELECT product_id FROM product_barcodes WHERE barcode=?", (barcode,)
        )
        if existing and not product_id:
            product_id = existing["product_id"]
    with database.transaction() as connection:
        if not product_id:
            cursor = connection.execute(
                """INSERT INTO products(
                    name,normalized_name,brand,category,package_size,serving_size,notes,source,
                    date_added,date_last_used
                ) VALUES(?,?,?,?,?,?,?,'manual',?,?)""",
                (
                    payload.name,
                    normalize_name(payload.name),
                    payload.brand,
                    payload.category,
                    payload.package_size,
                    payload.serving_size,
                    payload.notes,
                    now,
                    now,
                ),
            )
            product_id = cursor.lastrowid
            if barcode:
                connection.execute(
                    """INSERT INTO product_barcodes(barcode,product_id,original_barcode)
                       VALUES(?,?,?)""",
                    (barcode, product_id, payload.barcode),
                )
        else:
            exists = connection.execute(
                "SELECT id FROM products WHERE id=?", (product_id,)
            ).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="Product not found")
            connection.execute(
                "UPDATE products SET date_last_used=? WHERE id=?", (now, product_id)
            )
        lot = connection.execute(
            """INSERT INTO inventory_lots(
                product_id,quantity,expires_on,notes,added_at,updated_at
            ) VALUES(?,?,?,?,?,?)""",
            (
                product_id,
                payload.quantity,
                payload.expires_on.isoformat() if payload.expires_on else None,
                payload.lot_notes,
                now,
                now,
            ),
        )
        if database.setting("auto_purchase_match", True):
            product = connection.execute(
                "SELECT normalized_name FROM products WHERE id=?", (product_id,)
            ).fetchone()
            connection.execute(
                """UPDATE shopping_items SET purchased=1,purchased_at=?,updated_at=?
                   WHERE purchased=0 AND (
                       product_id=? OR normalized_name=? OR (? IS NOT NULL AND barcode=?)
                   )""",
                (
                    now,
                    now,
                    product_id,
                    product["normalized_name"],
                    barcode,
                    barcode,
                ),
            )
    await hub.broadcast("pantry.updated", {"product_id": product_id})
    await hub.broadcast("shopping.updated", {})
    return product_detail(product_id)


@app.patch("/api/v1/pantry/lots/{lot_id}")
async def update_lot(lot_id: int, payload: LotUpdate):
    current = database.one("SELECT * FROM inventory_lots WHERE id=?", (lot_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Inventory lot not found")
    quantity = payload.quantity if payload.quantity is not None else current["quantity"]
    expiration = (
        payload.expires_on.isoformat()
        if payload.expires_on is not None
        else current["expires_on"]
    )
    notes = payload.notes if payload.notes is not None else current["notes"]
    database.execute(
        """UPDATE inventory_lots
           SET quantity=?,expires_on=?,notes=?,updated_at=? WHERE id=?""",
        (quantity, expiration, notes, utcnow(), lot_id),
    )
    await hub.broadcast("pantry.updated", {"product_id": current["product_id"]})
    return product_detail(current["product_id"])


@app.delete("/api/v1/pantry/lots/{lot_id}")
async def delete_lot(lot_id: int, add_to_shopping: bool = False):
    lot = database.one(
        """SELECT il.*,p.name,p.normalized_name FROM inventory_lots il
           JOIN products p ON p.id=il.product_id WHERE il.id=?""",
        (lot_id,),
    )
    if not lot:
        raise HTTPException(status_code=404, detail="Inventory lot not found")
    with database.transaction() as connection:
        connection.execute("DELETE FROM inventory_lots WHERE id=?", (lot_id,))
        if add_to_shopping:
            now = utcnow()
            connection.execute(
                """INSERT INTO shopping_items(
                    name,normalized_name,product_id,quantity,created_at,updated_at
                ) VALUES(?,?,?,?,?,?)""",
                (
                    lot["name"],
                    lot["normalized_name"],
                    lot["product_id"],
                    lot["quantity"],
                    now,
                    now,
                ),
            )
    await hub.broadcast("pantry.updated", {"product_id": lot["product_id"]})
    await hub.broadcast("shopping.updated", {})
    return Response(status_code=204)


@app.post("/api/v1/pantry/lots/delete")
async def delete_lots(payload: LotDeleteMany):
    placeholders = ",".join("?" for _ in payload.lot_ids)
    lots = database.all(
        f"""SELECT il.*,p.name,p.normalized_name FROM inventory_lots il
            JOIN products p ON p.id=il.product_id
            WHERE il.id IN ({placeholders})""",
        tuple(payload.lot_ids),
    )
    if len(lots) != len(set(payload.lot_ids)):
        raise HTTPException(status_code=404, detail="One or more batches were not found")
    now = utcnow()
    with database.transaction() as connection:
        connection.execute(
            f"DELETE FROM inventory_lots WHERE id IN ({placeholders})",
            tuple(payload.lot_ids),
        )
        if payload.add_to_shopping:
            grouped: dict[int, dict[str, Any]] = {}
            for lot in lots:
                item = grouped.setdefault(
                    lot["product_id"],
                    {
                        "name": lot["name"],
                        "normalized_name": lot["normalized_name"],
                        "quantity": 0,
                    },
                )
                item["quantity"] += lot["quantity"]
            connection.executemany(
                """INSERT INTO shopping_items(
                       name,normalized_name,product_id,quantity,created_at,updated_at
                   ) VALUES(?,?,?,?,?,?)""",
                [
                    (
                        item["name"],
                        item["normalized_name"],
                        product_id,
                        item["quantity"],
                        now,
                        now,
                    )
                    for product_id, item in grouped.items()
                ],
            )
    await hub.broadcast("pantry.updated", {})
    if payload.add_to_shopping:
        await hub.broadcast("shopping.updated", {})
    return Response(status_code=204)


@app.post("/api/v1/pantry/{product_id}/consume")
async def consume_pantry(
    product_id: int,
    quantity: int = Query(default=1, ge=1, le=999),
):
    with database.transaction() as connection:
        lots = connection.execute(
            """SELECT * FROM inventory_lots WHERE product_id=?
               ORDER BY added_at ASC, id ASC""",
            (product_id,),
        ).fetchall()
        available = sum(int(lot["quantity"]) for lot in lots)
        if not available:
            raise HTTPException(status_code=404, detail="Product is not in stock")
        if available < quantity:
            raise HTTPException(
                status_code=400,
                detail=f"Only {available} item{'s' if available != 1 else ''} in stock",
            )
        remaining_to_remove = quantity
        now = utcnow()
        for lot in lots:
            if remaining_to_remove <= 0:
                break
            lot_quantity = int(lot["quantity"])
            if lot_quantity <= remaining_to_remove:
                connection.execute(
                    "DELETE FROM inventory_lots WHERE id=?", (lot["id"],)
                )
                remaining_to_remove -= lot_quantity
            else:
                connection.execute(
                    """UPDATE inventory_lots SET quantity=?,updated_at=?
                       WHERE id=?""",
                    (lot_quantity - remaining_to_remove, now, lot["id"]),
                )
                remaining_to_remove = 0
    await hub.broadcast("pantry.updated", {"product_id": product_id})
    remaining = database.one(
        "SELECT COALESCE(SUM(quantity),0) AS quantity FROM inventory_lots WHERE product_id=?",
        (product_id,),
    )
    return {"product_id": product_id, "quantity": remaining["quantity"]}


@app.get("/api/v1/shopping")
def shopping():
    return database.all(
        "SELECT * FROM shopping_items ORDER BY purchased,position,created_at"
    )


@app.post("/api/v1/shopping")
async def create_shopping(payload: ShoppingCreate):
    now = utcnow()
    normalized = normalize_name(payload.name)
    barcode = payload.barcode
    if barcode:
        try:
            barcode = normalize_barcode(barcode)
        except ValueError:
            barcode = payload.barcode
    existing = database.one(
        """SELECT * FROM shopping_items
           WHERE purchased=0 AND (
             (? IS NOT NULL AND product_id=?) OR normalized_name=? OR
             (? IS NOT NULL AND barcode=?)
           )
           ORDER BY id LIMIT 1""",
        (payload.product_id, payload.product_id, normalized, barcode, barcode),
    )
    if existing:
        database.execute(
            "UPDATE shopping_items SET quantity=quantity+?,updated_at=? WHERE id=?",
            (payload.quantity, now, existing["id"]),
        )
        row = database.one("SELECT * FROM shopping_items WHERE id=?", (existing["id"],))
        await hub.broadcast("shopping.updated", row)
        return row
    cursor = database.execute(
        """INSERT INTO shopping_items(
            name,normalized_name,product_id,barcode,quantity,position,
            created_at,updated_at
        ) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM shopping_items),?,?)""",
        (
            payload.name,
            normalized,
            payload.product_id,
            barcode,
            payload.quantity,
            now,
            now,
        ),
    )
    row = database.one("SELECT * FROM shopping_items WHERE id=?", (cursor.lastrowid,))
    await hub.broadcast("shopping.updated", row)
    return row


@app.patch("/api/v1/shopping/{item_id}")
async def update_shopping(item_id: int, payload: ShoppingUpdate):
    item = database.one("SELECT * FROM shopping_items WHERE id=?", (item_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Shopping item not found")
    name = payload.name if payload.name is not None else item["name"]
    quantity = payload.quantity if payload.quantity is not None else item["quantity"]
    purchased = (
        int(payload.purchased) if payload.purchased is not None else item["purchased"]
    )
    purchased_at = utcnow() if purchased else None
    database.execute(
        """UPDATE shopping_items SET name=?,normalized_name=?,quantity=?,
           purchased=?,purchased_at=?,updated_at=? WHERE id=?""",
        (
            name,
            normalize_name(name),
            quantity,
            purchased,
            purchased_at,
            utcnow(),
            item_id,
        ),
    )
    row = database.one("SELECT * FROM shopping_items WHERE id=?", (item_id,))
    await hub.broadcast("shopping.updated", row)
    return row


@app.delete("/api/v1/shopping/{item_id}")
async def delete_shopping(item_id: int):
    database.execute("DELETE FROM shopping_items WHERE id=?", (item_id,))
    await hub.broadcast("shopping.updated", {"deleted": item_id})
    return Response(status_code=204)


@app.delete("/api/v1/shopping")
async def clear_purchased():
    cursor = database.execute("DELETE FROM shopping_items WHERE purchased=1")
    await hub.broadcast("shopping.updated", {"cleared": cursor.rowcount})
    return {"removed": cursor.rowcount}


@app.get("/api/v1/reminders")
def reminders():
    order = (
        "completed,position,created_at"
        if database.setting("completed_reminders_last", True)
        else "position,created_at"
    )
    return database.all(
        f"SELECT * FROM reminders ORDER BY {order}"
    )


@app.post("/api/v1/reminders")
async def create_reminder(payload: ReminderCreate):
    now = utcnow()
    cursor = database.execute(
        """INSERT INTO reminders(
            text,position,created_at,updated_at
        ) VALUES(,(SELECT COALESCE(MAX(position),0)+1 FROM reminders),?,?)""".replace(
            "VALUES(,", "VALUES(?,"
        ),
        (payload.text.strip(), now, now),
    )
    row = database.one("SELECT * FROM reminders WHERE id=?", (cursor.lastrowid,))
    await hub.broadcast("reminders.updated", row)
    return row


@app.patch("/api/v1/reminders/{reminder_id}")
async def update_reminder(reminder_id: int, payload: ReminderUpdate):
    item = database.one("SELECT * FROM reminders WHERE id=?", (reminder_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Reminder not found")
    text_value = payload.text.strip() if payload.text is not None else item["text"]
    completed = (
        int(payload.completed) if payload.completed is not None else item["completed"]
    )
    high_priority = (
        int(payload.high_priority)
        if payload.high_priority is not None
        else item["high_priority"]
    )
    database.execute(
        """UPDATE reminders SET text=?,completed=?,high_priority=?,completed_at=?,updated_at=?
           WHERE id=?""",
        (
            text_value,
            completed,
            high_priority,
            utcnow() if completed else None,
            utcnow(),
            reminder_id,
        ),
    )
    row = database.one("SELECT * FROM reminders WHERE id=?", (reminder_id,))
    await hub.broadcast("reminders.updated", row)
    return row


@app.post("/api/v1/reminders/reorder")
async def reorder_reminders(payload: ReminderReorder):
    existing = {row["id"] for row in database.all("SELECT id FROM reminders")}
    if set(payload.item_ids) != existing or len(payload.item_ids) != len(existing):
        raise HTTPException(status_code=400, detail="Reminder order is incomplete")
    now = utcnow()
    with database.transaction() as connection:
        connection.executemany(
            "UPDATE reminders SET position=?,updated_at=? WHERE id=?",
            [
                (position, now, reminder_id)
                for position, reminder_id in enumerate(payload.item_ids)
            ],
        )
    await hub.broadcast("reminders.updated", {"reordered": True})
    return reminders()


@app.delete("/api/v1/reminders/{reminder_id}")
async def delete_reminder(reminder_id: int):
    database.execute("DELETE FROM reminders WHERE id=?", (reminder_id,))
    await hub.broadcast("reminders.updated", {"deleted": reminder_id})
    return Response(status_code=204)


@app.get("/api/v1/timers")
def timers():
    return database.all(
        "SELECT * FROM timers WHERE status!='dismissed' ORDER BY ends_at"
    )


@app.post("/api/v1/timers")
async def create_timer(payload: TimerCreate):
    now = datetime.now(UTC)
    cursor = database.execute(
        """INSERT INTO timers(label,ends_at,created_at)
           VALUES(?,?,?)""",
        (
            payload.label,
            (now + timedelta(seconds=payload.seconds)).isoformat(),
            now.isoformat(),
        ),
    )
    row = database.one("SELECT * FROM timers WHERE id=?", (cursor.lastrowid,))
    await hub.broadcast("timers.updated", row)
    return row


@app.delete("/api/v1/timers/{timer_id}")
async def dismiss_timer(timer_id: int):
    database.execute(
        "UPDATE timers SET status='dismissed',dismissed_at=? WHERE id=?",
        (utcnow(), timer_id),
    )
    services.audio.stop(f"timer-{timer_id}")
    await hub.broadcast("timers.updated", {"dismissed": timer_id})
    return Response(status_code=204)


@app.get("/api/v1/weather")
def weather():
    row = database.one(
        "SELECT data_json,fetched_at,expires_at FROM weather_cache WHERE cache_key='forecast'"
    )
    return (
        {**json.loads(row["data_json"]), "cache": {
            "fetched_at": row["fetched_at"], "expires_at": row["expires_at"]
        }}
        if row
        else None
    )


@app.get("/api/v1/weather/alerts")
def active_alerts():
    rows = database.all(
        """SELECT wa.*,
                  CASE WHEN ad.alert_id IS NULL THEN 0 ELSE 1 END AS dismissed
           FROM weather_alerts wa
           LEFT JOIN alert_dismissals ad ON ad.alert_id=wa.alert_id
               AND ad.alert_updated_at=wa.updated_at
           WHERE wa.active=1
           ORDER BY CASE wa.severity WHEN 'Extreme' THEN 0 WHEN 'Severe' THEN 1
               WHEN 'Moderate' THEN 2 ELSE 3 END,wa.effective_at"""
    )
    return [
        row
        for row in rows
        if database.setting(
            "alert_emergency_enabled"
            if row["severity"] == "Extreme"
            else "alert_warning_enabled"
            if row["severity"] == "Severe"
            else "alert_advisory_enabled",
            True,
        )
    ]


@app.get("/api/v1/weather/map/{layer}")
async def weather_map_proxy(layer: str, request: Request):
    if layer != "temperature":
        raise HTTPException(status_code=404, detail="Unknown weather map layer")
    query = {key.lower(): value for key, value in request.query_params.items()}
    try:
        bbox_values = [float(value) for value in query["bbox"].split(",")]
        width = min(1024, max(64, int(query.get("width", "256"))))
        height = min(1024, max(64, int(query.get("height", "256"))))
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=400, detail="Invalid map tile request") from error
    if len(bbox_values) != 4 or any(not (-3e8 <= value <= 3e8) for value in bbox_values):
        raise HTTPException(status_code=400, detail="Invalid map bounds")
    upstream = (
        "https://mapservices.weather.noaa.gov/raster/services/"
        "NDFD/NDFD_temp/MapServer/WMSServer"
    )
    params = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetMap",
        "layers": "6",
        "styles": "",
        "format": "image/png",
        "transparent": "true",
        "srs": query.get("srs", "EPSG:3857"),
        "bbox": ",".join(str(value) for value in bbox_values),
        "width": str(width),
        "height": str(height),
    }
    try:
        response = await services.client.get(upstream, params=params, timeout=15)
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="NOAA map layer unavailable") from error
    if "image" not in response.headers.get("content-type", ""):
        raise HTTPException(status_code=502, detail="NOAA returned an invalid map layer")
    return Response(
        content=response.content,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


def _sanitize_nhc_html(content: str) -> str:
    content = re.sub(r"<script\b[^>]*>.*?</script\s*>", "", content, flags=re.I | re.S)
    content = re.sub(r"<base\b[^>]*>", "", content, flags=re.I)
    content = re.sub(r"<meta\b[^>]*http-equiv\s*=\s*['\"]?refresh['\"]?[^>]*>", "", content, flags=re.I)
    content = re.sub(
        r"\s+on[a-z]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        content,
        flags=re.I,
    )
    content = re.sub(
        r"((?:href|src|action)\s*=\s*['\"])/(?!/)",
        r"\1/api/v1/tropical/",
        content,
        flags=re.I,
    )
    content = re.sub(
        r"((?:href|src|action)\s*=\s*['\"])https?://www\.nhc\.noaa\.gov/",
        r"\1/api/v1/tropical/",
        content,
        flags=re.I,
    )
    content = re.sub(
        r"((?:href|src|action)\s*=\s*['\"])//www\.nhc\.noaa\.gov/",
        r"\1/api/v1/tropical/",
        content,
        flags=re.I,
    )
    return content


def _recipe_from_row(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    result["ingredients"] = json.loads(result.pop("ingredients_json", "[]"))
    result["steps"] = json.loads(result.pop("steps_json", "[]"))
    result["favorite"] = bool(result["favorite"])
    result["custom"] = bool(result["custom"])
    return result


def _cache_recipe(recipe: dict[str, Any], *, custom: bool = False) -> dict[str, Any]:
    now = utcnow()
    database.execute(
        """INSERT INTO recipes(
               recipe_id,source,title,category,area,image_url,image_data,
               ingredients_json,steps_json,favorite,custom,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(recipe_id) DO UPDATE SET
               source=excluded.source,title=excluded.title,category=excluded.category,
               area=excluded.area,image_url=excluded.image_url,
               image_data=CASE WHEN excluded.image_data='' THEN recipes.image_data ELSE excluded.image_data END,
               ingredients_json=excluded.ingredients_json,steps_json=excluded.steps_json,
               custom=MAX(recipes.custom,excluded.custom),updated_at=excluded.updated_at""",
        (
            recipe["recipe_id"],
            recipe.get("source", "custom" if custom else "themealdb"),
            recipe["title"],
            recipe.get("category", ""),
            recipe.get("area", ""),
            recipe.get("image_url", ""),
            recipe.get("image_data", ""),
            json.dumps(recipe.get("ingredients", [])),
            json.dumps(recipe.get("steps", [])),
            int(bool(recipe.get("favorite", False))),
            int(custom or bool(recipe.get("custom", False))),
            now,
            now,
        ),
    )
    row = database.one("SELECT * FROM recipes WHERE recipe_id=?", (recipe["recipe_id"],))
    assert row is not None
    return _recipe_from_row(row)


async def _mealdb_request(endpoint: str, **params: str) -> list[dict[str, Any]]:
    api_key = os.getenv("THEMEALDB_API_KEY", "1")
    response = await services.client.get(
        f"https://www.themealdb.com/api/json/v1/{api_key}/{endpoint}",
        params=params,
        timeout=15,
    )
    response.raise_for_status()
    return list(response.json().get("meals") or [])


async def _mealdb_ingredient_recipes(ingredients: list[str]) -> list[dict[str, Any]]:
    filtered = await asyncio.gather(
        *[
            _mealdb_request("filter.php", i=ingredient.replace(" ", "_"))
            for ingredient in ingredients
        ]
    )
    if not filtered:
        return []
    matching_ids = {
        str(meal.get("idMeal"))
        for meal in filtered[0]
        if meal.get("idMeal")
    }
    for meals in filtered[1:]:
        matching_ids &= {
            str(meal.get("idMeal")) for meal in meals if meal.get("idMeal")
        }
    ordered_ids = [
        str(meal.get("idMeal"))
        for meal in filtered[0]
        if str(meal.get("idMeal")) in matching_ids
    ][:30]
    semaphore = asyncio.Semaphore(6)

    async def detail(meal_id: str) -> dict[str, Any] | None:
        cached = database.one(
            "SELECT * FROM recipes WHERE recipe_id=?", (f"mealdb:{meal_id}",)
        )
        if cached:
            return _recipe_from_row(cached)
        async with semaphore:
            meals = await _mealdb_request("lookup.php", i=meal_id)
        return _cache_recipe(normalize_meal(meals[0])) if meals else None

    return [
        recipe
        for recipe in await asyncio.gather(*[detail(meal_id) for meal_id in ordered_ids])
        if recipe is not None
    ]


@app.get("/api/v1/recipes/search")
async def search_recipes(
    query: str = Query(default="", max_length=100),
    mode: str = Query(default="name"),
):
    if mode not in {"name", "ingredient"}:
        raise HTTPException(status_code=400, detail="Unknown recipe search mode")
    cleaned = " ".join(query.split())
    local_rows = database.all(
        """SELECT * FROM recipes WHERE custom=1 OR favorite=1
           ORDER BY favorite DESC,custom DESC,title COLLATE NOCASE"""
    )
    local_recipes = [_recipe_from_row(row) for row in local_rows]
    ingredient_terms = [
        " ".join(value.split()).casefold()
        for value in cleaned.split(",")
        if value.strip()
    ]
    if len(ingredient_terms) > 6:
        raise HTTPException(status_code=400, detail="Search for up to six ingredients")
    if mode == "ingredient" and cleaned and not ingredient_terms:
        raise HTTPException(status_code=400, detail="Enter at least one ingredient")
    if not cleaned:
        recipes = local_recipes
    elif mode == "ingredient":
        recipes = [
            recipe
            for recipe in local_recipes
            if all(
                any(
                    term in str(ingredient.get("name", "")).casefold()
                    for ingredient in recipe["ingredients"]
                )
                for term in ingredient_terms
            )
        ]
    else:
        recipes = [
            recipe
            for recipe in local_recipes
            if cleaned.casefold() in recipe["title"].casefold()
        ]
    offline = False
    if cleaned:
        try:
            if mode == "ingredient":
                online_recipes = await _mealdb_ingredient_recipes(ingredient_terms)
            else:
                online_recipes = [
                    _cache_recipe(normalize_meal(meal))
                    for meal in await _mealdb_request("search.php", s=cleaned)
                ]
            for normalized in online_recipes:
                if not any(item["recipe_id"] == normalized["recipe_id"] for item in recipes):
                    recipes.append(normalized)
        except (httpx.HTTPError, ValueError):
            offline = True
    return {"recipes": recipes, "offline": offline}


@app.get("/api/v1/recipes/favorites")
def favorite_recipes():
    return [
        _recipe_from_row(row)
        for row in database.all(
            """SELECT * FROM recipes WHERE favorite=1 OR custom=1
               ORDER BY favorite DESC,custom DESC,title COLLATE NOCASE"""
        )
    ]


@app.get("/api/v1/recipes/{recipe_id}/progress")
def recipe_progress(recipe_id: str):
    if not database.one(
        "SELECT recipe_id FROM recipes WHERE recipe_id=?", (recipe_id,)
    ):
        raise HTTPException(status_code=404, detail="Recipe not found")
    row = database.one(
        "SELECT * FROM recipe_progress WHERE recipe_id=?", (recipe_id,)
    )
    if not row:
        return {"checked_ingredients": [], "checked_steps": []}
    return {
        "checked_ingredients": json.loads(row["checked_ingredients_json"]),
        "checked_steps": json.loads(row["checked_steps_json"]),
    }


@app.put("/api/v1/recipes/{recipe_id}/progress")
def save_recipe_progress(recipe_id: str, payload: RecipeProgressInput):
    if not database.one(
        "SELECT recipe_id FROM recipes WHERE recipe_id=?", (recipe_id,)
    ):
        raise HTTPException(status_code=404, detail="Recipe not found")
    database.execute(
        """INSERT INTO recipe_progress(
               recipe_id,checked_ingredients_json,checked_steps_json,updated_at
           ) VALUES(?,?,?,?)
           ON CONFLICT(recipe_id) DO UPDATE SET
               checked_ingredients_json=excluded.checked_ingredients_json,
               checked_steps_json=excluded.checked_steps_json,
               updated_at=excluded.updated_at""",
        (
            recipe_id,
            json.dumps(payload.checked_ingredients),
            json.dumps(payload.checked_steps),
            utcnow(),
        ),
    )
    return payload.model_dump()


@app.get("/api/v1/recipes/{recipe_id}")
async def recipe_detail(recipe_id: str):
    row = database.one("SELECT * FROM recipes WHERE recipe_id=?", (recipe_id,))
    if row:
        return _recipe_from_row(row)
    if not recipe_id.startswith("mealdb:"):
        raise HTTPException(status_code=404, detail="Recipe not found")
    try:
        meals = await _mealdb_request("lookup.php", i=recipe_id.split(":", 1)[1])
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Recipe provider unavailable") from error
    if not meals:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return _cache_recipe(normalize_meal(meals[0]))


@app.put("/api/v1/recipes/{recipe_id}/favorite")
async def set_recipe_favorite(recipe_id: str, favorite: bool):
    row = database.one("SELECT * FROM recipes WHERE recipe_id=?", (recipe_id,))
    if not row and recipe_id.startswith("mealdb:"):
        await recipe_detail(recipe_id)
        row = database.one("SELECT * FROM recipes WHERE recipe_id=?", (recipe_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Recipe not found")
    database.execute(
        "UPDATE recipes SET favorite=?,updated_at=? WHERE recipe_id=?",
        (int(favorite), utcnow(), recipe_id),
    )
    await hub.broadcast("recipes.updated", {"recipe_id": recipe_id})
    updated = database.one("SELECT * FROM recipes WHERE recipe_id=?", (recipe_id,))
    assert updated is not None
    return _recipe_from_row(updated)


@app.post("/api/v1/recipes/custom")
async def create_custom_recipe(payload: RecipeInput):
    recipe = {
        **payload.model_dump(),
        "recipe_id": f"custom:{uuid.uuid4()}",
        "source": "custom",
        "image_url": "",
        "custom": True,
    }
    result = _cache_recipe(recipe, custom=True)
    await hub.broadcast("recipes.updated", {"recipe_id": result["recipe_id"]})
    return result


@app.put("/api/v1/recipes/custom/{recipe_id}")
async def update_custom_recipe(recipe_id: str, payload: RecipeInput):
    full_id = recipe_id if recipe_id.startswith("custom:") else f"custom:{recipe_id}"
    existing = database.one(
        "SELECT favorite,image_data FROM recipes WHERE recipe_id=? AND custom=1",
        (full_id,),
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Custom recipe not found")
    recipe = {
        **payload.model_dump(),
        "recipe_id": full_id,
        "source": "custom",
        "image_url": "",
        "image_data": payload.image_data or existing["image_data"],
        "favorite": bool(existing["favorite"]),
        "custom": True,
    }
    result = _cache_recipe(recipe, custom=True)
    await hub.broadcast("recipes.updated", {"recipe_id": full_id})
    return result


@app.delete("/api/v1/recipes/custom/{recipe_id}", status_code=204)
async def delete_custom_recipe(recipe_id: str):
    full_id = recipe_id if recipe_id.startswith("custom:") else f"custom:{recipe_id}"
    deleted = database.execute(
        "DELETE FROM recipes WHERE recipe_id=? AND custom=1", (full_id,)
    ).rowcount
    if not deleted:
        raise HTTPException(status_code=404, detail="Custom recipe not found")
    await hub.broadcast("recipes.updated", {"recipe_id": full_id})
    return Response(status_code=204)


@app.get("/api/v1/tropical")
@app.get("/api/v1/tropical/{path:path}")
async def tropical_weather_proxy(request: Request, path: str = ""):
    if ".." in path or "\\" in path or path.startswith("//"):
        raise HTTPException(status_code=400, detail="Invalid NHC path")
    mobile_home = request.query_params.get("mobile") == "1" and not path
    upstream_path = "mobile/" if mobile_home else path.lstrip("/")
    upstream = f"https://www.nhc.noaa.gov/{upstream_path}"
    upstream_params = [
        item for item in request.query_params.multi_items() if item[0] != "mobile"
    ]
    try:
        response = await services.client.get(
            upstream,
            params=upstream_params,
            timeout=20,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("NHC proxy request failed for %s: %s", path, error)
        return Response(
            content=(
                "<!doctype html><title>NHC unavailable</title>"
                "<style>body{font:18px system-ui;padding:3rem;background:#102846;"
                "color:white}a{color:#8ed8ff}</style>"
                "<h1>National Hurricane Center temporarily unavailable</h1>"
                "<p>Check the network connection and try again shortly.</p>"
                "<a href='/api/v1/tropical'>Try again</a>"
            ),
            status_code=502,
            media_type="text/html",
        )
    if response.url.host != "www.nhc.noaa.gov":
        raise HTTPException(status_code=502, detail="NHC redirected outside its site")
    if len(response.content) > 25 * 1024 * 1024:
        raise HTTPException(status_code=502, detail="NHC resource is too large")
    content_type = response.headers.get("content-type", "application/octet-stream")
    headers = {
        "Cache-Control": response.headers.get("cache-control", "public, max-age=60"),
        "Content-Security-Policy": (
            "default-src 'self' data: https://www.nhc.noaa.gov; "
            "script-src 'none'; object-src 'none'; frame-src 'none'; "
            "style-src 'self' 'unsafe-inline' https://www.nhc.noaa.gov; "
            "img-src 'self' data: https:; form-action 'self'"
        ),
    }
    if "text/html" in content_type:
        return Response(
            content=_sanitize_nhc_html(response.text),
            media_type="text/html",
            headers=headers,
        )
    if "text/css" in content_type:
        css = re.sub(r"url\((['\"]?)/", r"url(\1/api/v1/tropical/", response.text)
        return Response(content=css, media_type="text/css", headers=headers)
    return Response(content=response.content, media_type=content_type.split(";")[0], headers=headers)


@app.post("/api/v1/weather/alerts/{alert_id:path}/dismiss")
async def dismiss_alert(alert_id: str):
    alert = database.one(
        "SELECT updated_at FROM weather_alerts WHERE alert_id=?", (alert_id,)
    )
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    database.execute(
        """INSERT INTO alert_dismissals(alert_id,alert_updated_at,dismissed_at)
           VALUES(?,?,?)
           ON CONFLICT(alert_id) DO UPDATE SET
           alert_updated_at=excluded.alert_updated_at,dismissed_at=excluded.dismissed_at""",
        (alert_id, alert["updated_at"], utcnow()),
    )
    await hub.broadcast("alerts.updated", {})
    return {"dismissed": True}


@app.get("/api/v1/location/search")
async def search_location(query: str = Query(min_length=2, max_length=100)):
    return await services.weather.geocode(query)


@app.post("/api/v1/location/automatic")
async def automatic_location():
    try:
        return await services.weather.locate_by_ip()
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/v1/refresh")
async def refresh():
    operations = {
        "weather": services.sync_weather_forecast(),
        "alerts": services.sync_alerts(),
        "calendar": services.sync_calendars(),
    }
    values = await asyncio.gather(*operations.values(), return_exceptions=True)
    providers: dict[str, dict[str, Any]] = {}
    errors = []
    for provider, result in zip(operations, values):
        if isinstance(result, Exception):
            services.record_sync_error(provider, result)
            detail = {"provider": provider, "error": str(result)}
            errors.append(detail)
            providers[provider] = {"ok": False, "error": str(result)}
        else:
            providers[provider] = {"ok": True, "error": None}
    return {
        "completed_at": utcnow(),
        "providers": providers,
        "errors": errors,
    }


@app.get("/api/v1/sync/status")
def sync_status():
    return {
        "providers": database.all(
            """SELECT provider,last_success_at,last_attempt_at,last_error
               FROM sync_state ORDER BY provider"""
        ),
        "log": database.all(
            """SELECT id,provider,status,message,attempted_at
               FROM sync_log ORDER BY id DESC LIMIT 50"""
        ),
    }


@app.post("/api/v1/activity")
def activity():
    services.activity()
    return {"awake": True}


@app.get("/api/v1/display/awake-lock")
def display_awake_lock():
    return {"enabled": services.display_awake_lock}


@app.put("/api/v1/display/awake-lock")
async def set_display_awake_lock(enabled: bool):
    return {"enabled": await services.set_display_awake_lock(enabled)}


@app.get("/api/v1/hardware/devices")
def hardware_devices():
    system = platform.system()
    return {
        "input_devices": cached_value("hardware_input_devices", 10.0, BarcodeMonitor.devices),
        "display_output": database.setting("display_output", "HDMI-A-1"),
        "pir_pin": database.setting("motion_gpio_bcm", 17),
        "platform": system,
        "scanner_capture": "evdev" if system == "Linux" else "keyboard-wedge",
        "audio_backend": "alsa" if system == "Linux" else (
            "winsound" if system == "Windows" else "browser"
        ),
        "audio_outputs": cached_value("hardware_audio_outputs", 10.0, AudioController.outputs),
        "audio_output": database.setting("audio_output", "default"),
        "audio_status": services.audio.status(),
        "system_volume": AudioController.system_volume(),
        "motion_status": services.pir_status(),
        "display_status": services.display.status(),
    }


@app.get("/api/v1/hardware/motion")
def hardware_motion_status():
    return services.pir_status()


@app.get("/api/v1/hardware/system-volume")
def hardware_system_volume():
    return AudioController.system_volume()


@app.put("/api/v1/hardware/system-volume")
def set_hardware_system_volume(volume: int = Query(ge=0, le=100)):
    result = AudioController.set_system_volume(volume)
    if not result.get("available"):
        raise HTTPException(
            status_code=503,
            detail=result.get("error") or "System volume control is unavailable",
        )
    return result


@app.post("/api/v1/hardware/test")
async def hardware_test(payload: HardwareTest):
    if payload.kind == "timer_audio":
        return services.audio.probe(
            "timer", int(database.setting("timer_volume", 60))
        )
    if payload.kind == "alert_audio":
        return services.audio.probe(
            "alert", int(database.setting("alert_volume", 55))
        )
    if payload.kind == "display_off":
        return await services.test_display_sleep()
    if payload.kind == "display_on":
        services.wake()
        return {"success": True, **services.display.status()}
    previews = {
        "weather_advisory": {
            "event": "Heat Advisory",
            "headline": "Heat index values may reach 108°F this afternoon.",
            "description": "Hot temperatures and high humidity may cause heat illness.",
            "instruction": "Drink water, limit strenuous outdoor activity, and check on vulnerable neighbors.",
            "severity": "Moderate",
        },
        "weather_warning": {
            "event": "Severe Thunderstorm Warning",
            "headline": "Damaging winds and frequent lightning are possible nearby.",
            "description": "A strong thunderstorm is moving through the area.",
            "instruction": "Move indoors and stay away from windows.",
            "severity": "Severe",
        },
        "weather_emergency": {
            "event": "Tornado Emergency",
            "headline": "A dangerous tornado is approaching the area.",
            "description": "This is a demonstration of the emergency alert display.",
            "instruction": "Go to a small interior room on the lowest floor.",
            "severity": "Extreme",
        },
    }
    if payload.kind in previews:
        severity = previews[payload.kind]["severity"]
        category = (
            "emergency"
            if severity == "Extreme"
            else "warning"
            if severity == "Severe"
            else "advisory"
        )
        audio_enabled = database.setting(
            f"alert_{category}_audio", category != "advisory"
        )
        if severity == "Extreme" and audio_enabled:
            services.audio.play_bursts(
                "alert",
                int(database.setting("alert_volume", 55)),
                [3, 3],
                key="weather-preview",
            )
        elif audio_enabled:
            services.audio.play_bursts(
                "alert",
                int(database.setting("alert_volume", 55)),
                [1],
                key="weather-preview",
            )
        await hub.broadcast(
            "weather.alert.test",
            {
                **previews[payload.kind],
                "alert_id": f"test-{payload.kind}",
                "expires_at": (
                    datetime.now(UTC) + timedelta(minutes=15)
                ).isoformat(),
                "dismissed": 0,
                "test": True,
            },
        )
        return {"success": True}
    raise HTTPException(status_code=400, detail="Unknown hardware test")


@app.get("/api/v1/network/wifi")
def wifi_networks():
    if platform.system() != "Linux":
        return []
    try:
        output = subprocess.run(
            ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"],
            capture_output=True,
            text=True,
            timeout=12,
            check=True,
        ).stdout
        seen = set()
        networks = []
        for line in output.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[0] and parts[0] not in seen:
                seen.add(parts[0])
                networks.append(
                    {"ssid": parts[0], "signal": parts[1], "security": parts[2]}
                )
        return networks
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/v1/network/wifi")
def connect_wifi(payload: WifiConnect):
    if platform.system() != "Linux":
        raise HTTPException(status_code=400, detail="Wi-Fi control is available on Pi only")
    command = ["sudo", "/usr/local/lib/home-dashboard-network-helper", "connect", payload.ssid]
    if payload.password:
        command.append(payload.password)
    try:
        subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
        clear_cached_values("network")
        return {"connected": True}
    except subprocess.CalledProcessError as error:
        raise HTTPException(status_code=400, detail=error.stderr.strip()) from error


@app.put("/api/v1/network/dns")
def update_dns(payload: DnsUpdate):
    if platform.system() != "Linux":
        raise HTTPException(status_code=400, detail="DNS control is available on Pi only")
    if not payload.automatic and not payload.servers:
        raise HTTPException(status_code=400, detail="Enter at least one DNS server")
    command = [
        "sudo",
        "/usr/local/lib/home-dashboard-network-helper",
        "dns",
        "auto" if payload.automatic else "manual",
        *payload.servers,
    ]
    try:
        subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
        clear_cached_values("network")
        return cached_network_status_payload()
    except subprocess.CalledProcessError as error:
        raise HTTPException(status_code=400, detail=error.stderr.strip()) from error


@app.post("/api/v1/backups/configure")
def configure_backup(payload: BackupConfigure):
    if payload.enabled:
        destination = Path(payload.path)
        if not payload.path:
            raise HTTPException(status_code=400, detail="Select a backup destination")
        try:
            destination.mkdir(parents=True, exist_ok=True)
            test_file = destination / ".home-dashboard-write-test"
            test_file.write_text("ok")
            test_file.unlink()
        except OSError as error:
            raise HTTPException(
                status_code=400, detail=f"Backup destination is not writable: {error}"
            ) from error
        if payload.password:
            secret_store.set("backup_password", payload.password)
        elif not secret_store.get("backup_password"):
            raise HTTPException(status_code=400, detail="Set a backup password")
    database.set_settings(
        {
            "backup_enabled": payload.enabled,
            "backup_path": payload.path,
            "backup_retention": payload.retention,
        }
    )
    return {
        "enabled": payload.enabled,
        "path": payload.path,
        "retention": payload.retention,
        "password_configured": secret_store.get("backup_password") is not None,
    }


@app.post("/api/v1/backups/run")
async def run_backup():
    password = secret_store.get("backup_password")
    path = database.setting("backup_path", "")
    if not password or not path:
        raise HTTPException(status_code=400, detail="Backups are not configured")
    try:
        output = await asyncio.to_thread(backups.create, Path(path), password)
        backups.prune(Path(path), int(database.setting("backup_retention", 7)))
        return {"path": str(output)}
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get("/api/v1/backups/media")
def backup_media():
    return backup_media_candidates()


@app.get("/api/v1/backups/discover")
def discover_backups(path: str = ""):
    if path:
        return _backup_files_under(Path(path), limit=50)
    discovered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for media in backup_media_candidates():
        for backup in _backup_files_under(Path(media["path"]), limit=20):
            if backup["path"] in seen:
                continue
            seen.add(backup["path"])
            discovered.append({**backup, "media": media["name"], "media_path": media["path"]})
    return sorted(discovered, key=lambda item: item["modified"], reverse=True)[:50]


@app.post("/api/v1/backups/restore")
def restore_backup(payload: BackupRestore):
    try:
        manifest = backups.restore(Path(payload.path), payload.password)
        return {
            "restored": True,
            "manifest": manifest,
            "restart_required": True,
        }
    except Exception as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/v1/system/restart")
def restart_service():
    if platform.system() == "Linux":
        subprocess.Popen(
            ["sudo", "systemctl", "restart", "home-dashboard.service"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return {"restarting": True}


@app.post("/api/v1/system/reboot")
def reboot_pi():
    if platform.system() != "Linux":
        raise HTTPException(
            status_code=400,
            detail="Reboot is available on Raspberry Pi installations.",
        )
    try:
        subprocess.Popen(
            ["sudo", "-n", "/usr/bin/systemctl", "reboot"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    return {"rebooting": True, "message": "Raspberry Pi reboot requested."}


@app.post("/api/v1/system/exit-kiosk")
def exit_kiosk():
    if platform.system() != "Linux":
        return {
            "supported": False,
            "message": "Exit to desktop is available on the Raspberry Pi kiosk.",
        }
    marker = config.data_dir / "kiosk-exit-requested"
    marker.write_text("exit\n", encoding="utf-8")

    def close_browser() -> None:
        # Stop the session launcher too, so this works immediately on a Pi
        # upgrading from a release whose launcher did not understand the marker.
        subprocess.run(
            ["pkill", "-TERM", "-f", "[h]ome-dashboard-kiosk"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        subprocess.run(
            ["pkill", "-TERM", "-f", "chromium.*--kiosk"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )

    timer = threading.Timer(0.4, close_browser)
    timer.daemon = True
    timer.start()
    return {
        "supported": True,
        "message": "Closing the kiosk. It will launch again after the next reboot.",
    }


@app.get("/api/v1/system/metrics")
def system_metrics():
    def collect() -> dict[str, Any]:
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage(str(config.data_dir))
        temperatures = {}
        try:
            temperatures = psutil.sensors_temperatures()
        except Exception:
            pass
        temperature = next(
            (
                reading.current
                for readings in temperatures.values()
                for reading in readings
                if reading.current is not None
            ),
            None,
        )
        return {
            "platform": platform.system(),
            "cpu_percent": psutil.cpu_percent(interval=None),
            "cpu_count": psutil.cpu_count(),
            "memory_percent": memory.percent,
            "memory_used": memory.used,
            "memory_total": memory.total,
            "memory_used_gb": round(memory.used / (1024**3), 1),
            "memory_total_gb": round(memory.total / (1024**3), 1),
            "storage_percent": disk.percent,
            "storage_used": disk.used,
            "storage_total": disk.total,
            "storage_used_gb": round(disk.used / (1024**3), 1),
            "storage_total_gb": round(disk.total / (1024**3), 1),
            "temperature_c": temperature,
            "cpu_temperature_c": temperature,
            "boot_time": datetime.fromtimestamp(psutil.boot_time(), UTC).isoformat(),
        }

    return cached_value("system_metrics", 2.0, collect)


@app.post("/api/v1/system/update")
def update_application():
    if platform.system() != "Linux":
        raise HTTPException(
            status_code=400,
            detail="One-click updates are available on Raspberry Pi installations.",
        )
    try:
        subprocess.run(
            [
                "sudo",
                "-n",
                "systemctl",
                "start",
                "--no-block",
                "home-dashboard-update.service",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise HTTPException(
            status_code=500,
            detail=error.stderr.strip() or "Could not start the update service",
        ) from error
    return {"started": True, "message": "Update started. The dashboard will restart."}


@app.get("/api/v1/system/update/status")
def update_status():
    path = config.data_dir / "update-status.json"
    if not path.exists():
        return {"state": "idle"}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"state": "unknown"}


@app.websocket("/api/v1/events")
async def websocket_events(websocket: WebSocket):
    host = websocket.client.host if websocket.client else ""
    local = host in {"127.0.0.1", "::1", "localhost"}
    token = websocket.cookies.get("dashboard_session")
    if not local and (
        not database.setting("remote_access_enabled", False)
        or not auth.verify_session(token)
    ):
        await websocket.close(code=4401)
        return
    await hub.connect(websocket)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("event") == "activity":
                services.activity()
    except WebSocketDisconnect:
        hub.disconnect(websocket)
    except Exception:
        hub.disconnect(websocket)


if config.static_dir.exists():
    assets = config.static_dir / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith("api/"):
        raise HTTPException(status_code=404)
    requested = (config.static_dir / path).resolve()
    if (
        path
        and requested.is_file()
        and config.static_dir in requested.parents
    ):
        return FileResponse(requested)
    index = config.static_dir / "index.html"
    if index.exists():
        return FileResponse(index)
    return JSONResponse(
        {
            "name": "Home Dashboard",
            "message": "Frontend has not been built. Run the frontend build.",
        }
    )


def run() -> None:
    uvicorn.run(
        "home_dashboard.main:app",
        host=config.host,
        port=config.port,
        reload=config.debug,
    )


if __name__ == "__main__":
    run()
