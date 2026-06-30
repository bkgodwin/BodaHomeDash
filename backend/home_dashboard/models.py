from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


class ProductInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    barcode: str | None = Field(default=None, max_length=32)
    brand: str = Field(default="", max_length=120)
    category: str = Field(default="", max_length=120)
    package_size: str = Field(default="", max_length=80)
    notes: str = Field(default="", max_length=1000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return " ".join(value.split())


class PantryAdd(ProductInput):
    product_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=999)
    expires_on: date | None = None
    lot_notes: str = Field(default="", max_length=1000)


class LotUpdate(BaseModel):
    quantity: int | None = Field(default=None, ge=1, le=999)
    expires_on: date | None = None
    notes: str | None = Field(default=None, max_length=1000)


class LotDeleteMany(BaseModel):
    lot_ids: list[int] = Field(min_length=1, max_length=100)
    add_to_shopping: bool = False


class ShoppingCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: int = Field(default=1, ge=1, le=999)
    product_id: int | None = None
    barcode: str | None = Field(default=None, max_length=32)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return " ".join(value.split())


class ShoppingUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    quantity: int | None = Field(default=None, ge=1, le=999)
    purchased: bool | None = None


class ReminderCreate(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class ReminderUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=500)
    completed: bool | None = None


class TimerCreate(BaseModel):
    seconds: int = Field(ge=1, le=86400)
    label: str = Field(default="Timer", min_length=1, max_length=80)


class PinSetup(BaseModel):
    pin: str = Field(pattern=r"^\d{4,12}$")


class LoginRequest(BaseModel):
    pin: str = Field(pattern=r"^\d{4,12}$")


class CalendarConnect(BaseModel):
    username: str = Field(min_length=3, max_length=320)
    app_password: str = Field(min_length=4, max_length=200)
    display_name: str = Field(default="iCloud", max_length=100)


class CalendarSelection(BaseModel):
    enabled_ids: list[int]
    colors: dict[int, str] = {}


class BackupConfigure(BaseModel):
    enabled: bool
    path: str = ""
    password: str | None = Field(default=None, min_length=10, max_length=200)
    retention: int = Field(default=7, ge=1, le=90)


class BackupRestore(BaseModel):
    path: str
    password: str = Field(min_length=10, max_length=200)


class WifiConnect(BaseModel):
    ssid: str = Field(min_length=1, max_length=64)
    password: str = Field(default="", max_length=128)


class HardwareTest(BaseModel):
    kind: Literal[
        "timer_audio",
        "alert_audio",
        "display_off",
        "display_on",
        "weather_advisory",
        "weather_warning",
        "weather_emergency",
    ]
