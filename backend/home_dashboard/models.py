from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

PLANNER_PASTELS = {
    "#F4A6A6",
    "#F7C59F",
    "#F9E79F",
    "#BFE3B4",
    "#A8E6CF",
    "#B8D8D8",
    "#A7D8F0",
    "#AFCBFF",
    "#C3B1E1",
    "#D7B4F3",
    "#F5B6D2",
    "#D3C7B8",
}


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


class ProductInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    barcode: str | None = Field(default=None, max_length=32)
    brand: str = Field(default="", max_length=120)
    category: str = Field(default="", max_length=120)
    package_size: str = Field(default="", max_length=80)
    serving_size: str = Field(default="", max_length=80)
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
    high_priority: bool | None = None


class ReminderReorder(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=500)


class TimerCreate(BaseModel):
    seconds: int = Field(ge=1, le=86400)
    label: str = Field(default="Timer", min_length=1, max_length=80)


class RecipeIngredient(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    measure: str = Field(default="", max_length=100)


class RecipeInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(default="", max_length=100)
    area: str = Field(default="", max_length=100)
    image_data: str = Field(default="", max_length=5_500_000)
    ingredients: list[RecipeIngredient] = Field(min_length=1, max_length=100)
    steps: list[str] = Field(min_length=1, max_length=100)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("image_data")
    @classmethod
    def valid_image(cls, value: str) -> str:
        if value and not value.startswith(
            ("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")
        ):
            raise ValueError("Custom recipe image must be JPEG, PNG, or WebP")
        return value


class RecipeProgressInput(BaseModel):
    checked_ingredients: list[int] = Field(default_factory=list, max_length=100)
    checked_steps: list[int] = Field(default_factory=list, max_length=100)

    @field_validator("checked_ingredients", "checked_steps")
    @classmethod
    def valid_checklist_indices(cls, values: list[int]) -> list[int]:
        if any(value < 0 or value > 999 for value in values):
            raise ValueError("Checklist positions must be non-negative")
        return sorted(set(values))


class HouseholdMemberInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#A7D8F0", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("name")
    @classmethod
    def clean_member_name(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("color")
    @classmethod
    def member_color_from_palette(cls, value: str) -> str:
        if value.upper() not in PLANNER_PASTELS:
            raise ValueError("Choose a color from the planner palette")
        return value.upper()


class PlannerMealInput(BaseModel):
    planned_date: date
    recipe_id: str | None = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    image_url: str = Field(default="", max_length=5_500_000)

    @field_validator("title")
    @classmethod
    def clean_meal_title(cls, value: str) -> str:
        return " ".join(value.split())


class PlannerMealMove(BaseModel):
    planned_date: date
    position: int = Field(default=0, ge=0)


class PlannerChoreInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    color: str = Field(default="#A7D8F0", pattern=r"^#[0-9a-fA-F]{6}$")
    recurring: bool = True
    planned_date: date
    member_ids: list[int] = Field(default_factory=list, max_length=50)

    @field_validator("title")
    @classmethod
    def clean_chore_title(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("color")
    @classmethod
    def chore_color_from_palette(cls, value: str) -> str:
        if value.upper() not in PLANNER_PASTELS:
            raise ValueError("Choose a color from the planner palette")
        return value.upper()


class PlannerChoreMove(BaseModel):
    planned_date: date


class PlannerChoreMembers(BaseModel):
    member_ids: list[int] = Field(default_factory=list, max_length=50)


class PlannerNoteInput(BaseModel):
    planned_date: date
    text: str = Field(min_length=1, max_length=1000)


class PlannerNoteMove(BaseModel):
    planned_date: date


class SharedNotepadInput(BaseModel):
    content_html: str = Field(default="", max_length=200_000)


class PinSetup(BaseModel):
    pin: str = Field(pattern=r"^\d{4,12}$")


class LoginRequest(BaseModel):
    pin: str = Field(pattern=r"^\d{4,12}$")


class CalendarConnect(BaseModel):
    provider: Literal["icloud", "google"] = "icloud"
    username: str = Field(min_length=3, max_length=320)
    app_password: str = Field(min_length=4, max_length=200)
    display_name: str = Field(default="iCloud", max_length=100)


class GoogleOAuthConfig(BaseModel):
    client_id: str = Field(min_length=20, max_length=300)
    client_secret: str | None = Field(default=None, min_length=4, max_length=300)


class GoogleOAuthStart(BaseModel):
    display_name: str = Field(default="Google", max_length=100)
    redirect_uri: str = Field(min_length=10, max_length=500)


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


class DnsUpdate(BaseModel):
    automatic: bool = True
    servers: list[str] = Field(default_factory=list, max_length=4)

    @field_validator("servers")
    @classmethod
    def clean_dns_servers(cls, values: list[str]) -> list[str]:
        cleaned = []
        for value in values:
            item = value.strip()
            if not item:
                continue
            if not re.match(r"^(?:\d{1,3}\.){3}\d{1,3}$", item):
                raise ValueError("DNS servers must be IPv4 addresses")
            parts = [int(part) for part in item.split(".")]
            if any(part > 255 for part in parts):
                raise ValueError("DNS servers must be valid IPv4 addresses")
            cleaned.append(item)
        return cleaned


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
