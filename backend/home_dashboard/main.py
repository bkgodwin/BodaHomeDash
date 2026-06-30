from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
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
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .backup import BackupManager
from .config import config
from .database import Database, utcnow
from .events import hub
from .hardware import BarcodeMonitor
from .models import (
    BackupConfigure,
    BackupRestore,
    CalendarConnect,
    CalendarSelection,
    HardwareTest,
    LoginRequest,
    LotUpdate,
    LotDeleteMany,
    PantryAdd,
    PinSetup,
    ReminderCreate,
    ReminderReorder,
    ReminderUpdate,
    RecipeInput,
    SettingsUpdate,
    ShoppingCreate,
    ShoppingUpdate,
    TimerCreate,
    WifiConnect,
)
from .providers.calendar import ICloudCalendarProvider
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


@asynccontextmanager
async def lifespan(_: FastAPI):
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
        path in {"/api/v1/status", "/api/v1/auth/login", "/api/v1/auth/state"}
        or not path.startswith("/api/")
    )
    local = is_local(request)
    device_only = (
        "/api/v1/settings",
        "/api/v1/calendar/connect",
        "/api/v1/calendar/calendars",
        "/api/v1/calendar/accounts",
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
    return {
        "interfaces": ipv4_interfaces(),
        "selected": database.setting("mobile_dash_ipv4", ""),
        "port": config.port,
    }


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


@app.post("/api/v1/calendar/connect")
async def connect_calendar(payload: CalendarConnect):
    provider = ICloudCalendarProvider(payload.username, payload.app_password)
    try:
        remote_calendars = await provider.discover()
    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=f"Could not connect to iCloud: {error}",
        ) from error
    now = utcnow()
    cursor = database.execute(
        """INSERT INTO calendar_accounts(
            provider,display_name,username,created_at,updated_at
        ) VALUES('icloud',?,?,?,?)""",
        (payload.display_name, payload.username, now, now),
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
    calendars = database.all(
        "SELECT * FROM calendars WHERE account_id=? ORDER BY name", (account_id,)
    )
    schedule_background(services.sync_calendars(), "calendar-connect-sync")
    return {"account_id": account_id, "calendars": calendars}


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
async def consume_pantry(product_id: int):
    with database.transaction() as connection:
        lot = connection.execute(
            """SELECT * FROM inventory_lots WHERE product_id=?
               ORDER BY added_at ASC, id ASC LIMIT 1""",
            (product_id,),
        ).fetchone()
        if not lot:
            raise HTTPException(status_code=404, detail="Product is not in stock")
        if lot["quantity"] <= 1:
            connection.execute("DELETE FROM inventory_lots WHERE id=?", (lot["id"],))
        else:
            connection.execute(
                """UPDATE inventory_lots SET quantity=quantity-1,updated_at=?
                   WHERE id=?""",
                (utcnow(), lot["id"]),
            )
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
        "input_devices": BarcodeMonitor.devices(),
        "display_output": database.setting("display_output", "HDMI-A-1"),
        "pir_pin": database.setting("motion_gpio_bcm", 17),
        "platform": system,
        "scanner_capture": "evdev" if system == "Linux" else "keyboard-wedge",
        "audio_backend": "alsa" if system == "Linux" else (
            "winsound" if system == "Windows" else "browser"
        ),
    }


@app.post("/api/v1/hardware/test")
async def hardware_test(payload: HardwareTest):
    if payload.kind == "timer_audio":
        return {"success": services.audio.play("timer", database.setting("timer_volume", 60))}
    if payload.kind == "alert_audio":
        return {"success": services.audio.play("alert", database.setting("alert_volume", 55))}
    if payload.kind == "display_off":
        return {"success": services.display.off()}
    if payload.kind == "display_on":
        return {"success": services.display.on()}
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
        return {"connected": True}
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


@app.get("/api/v1/backups/discover")
def discover_backups(path: str = ""):
    root = Path(path or "/media")
    if not root.exists():
        return []
    return [
        {"path": str(item), "size": item.stat().st_size, "modified": item.stat().st_mtime}
        for item in sorted(
            root.rglob("*.hdbak"), key=lambda entry: entry.stat().st_mtime, reverse=True
        )[:50]
    ]


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


@app.get("/api/v1/system/metrics")
def system_metrics():
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
        "cpu_percent": psutil.cpu_percent(interval=0.15),
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
