from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote

import caldav
import httpx
import recurring_ical_events
from icalendar import Calendar


@dataclass
class RemoteCalendar:
    remote_id: str
    name: str
    url: str
    shared: bool = False
    read_only: bool = True


class CalDAVCalendarProvider:
    """Small CalDAV adapter. Network calls run in a worker thread."""

    server: str = ""
    name = "CalDAV"

    def __init__(self, username: str, app_password: str):
        self.username = username
        self.app_password = app_password

    def _principal(self):
        client = caldav.DAVClient(
            url=self.server, username=self.username, password=self.app_password
        )
        return client.principal()

    async def discover(self) -> list[RemoteCalendar]:
        return await asyncio.to_thread(self._discover_sync)

    def _discover_sync(self) -> list[RemoteCalendar]:
        principal = self._principal()
        home = principal.calendar_home_set
        children = home.children(caldav.elements.cdav.Calendar.tag)
        result = []
        for calendar_url, resource_types, display_name in children:
            name = display_name or str(calendar_url).rstrip("/").split("/")[-1]
            shared = any(
                str(resource_type).endswith("}shared")
                for resource_type in resource_types
            )
            result.append(
                RemoteCalendar(
                    remote_id=str(calendar_url),
                    name=str(name),
                    url=str(calendar_url),
                    shared=shared,
                    read_only=True,
                )
            )
        return result

    async def events(
        self, calendar_url: str, starts: datetime, ends: datetime
    ) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            self._events_sync, calendar_url, starts, ends
        )

    def _events_sync(
        self, calendar_url: str, starts: datetime, ends: datetime
    ) -> list[dict[str, Any]]:
        # iCloud discovers calendars on per-account shard hosts. The caldav
        # library correctly refuses to join an absolute URL from another host,
        # so event clients must use the discovered shard URL as their base.
        client = caldav.DAVClient(
            url=calendar_url,
            username=self.username,
            password=self.app_password,
        )
        remote = caldav.Calendar(client=client, url=calendar_url)
        objects = remote.search(start=starts, end=ends, event=True, expand=False)
        result: list[dict[str, Any]] = []
        for remote_event in objects:
            raw = remote_event.data
            parsed = Calendar.from_ical(raw)
            occurrences = recurring_ical_events.of(parsed).between(starts, ends)
            for component in occurrences:
                start_value = component.decoded("DTSTART")
                has_end = component.get("DTEND") is not None
                end_value = component.decoded("DTEND", start_value)
                all_day = isinstance(start_value, date) and not isinstance(
                    start_value, datetime
                )
                starts_at = self._as_datetime(start_value)
                ends_at = self._as_datetime(end_value)
                if all_day and not has_end:
                    ends_at += timedelta(days=1)
                recurrence = component.get("RECURRENCE-ID")
                recurrence_value = (
                    self._as_datetime(recurrence.dt).isoformat()
                    if recurrence is not None
                    else ""
                )
                result.append(
                    {
                        "uid": str(component.get("UID", "")),
                        "recurrence_id": recurrence_value,
                        "title": str(component.get("SUMMARY", "Untitled event")),
                        "description": str(component.get("DESCRIPTION", "")),
                        "location": str(component.get("LOCATION", "")),
                        "starts_at": starts_at.isoformat(),
                        "ends_at": ends_at.isoformat(),
                        "all_day": all_day,
                        "etag": getattr(remote_event, "etag", None),
                        "raw_ical": raw,
                    }
                )
        return result

    @staticmethod
    def _as_datetime(value: date | datetime) -> datetime:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=UTC)
            return value
        return datetime.combine(value, time.min, tzinfo=UTC)


class ICloudCalendarProvider(CalDAVCalendarProvider):
    name = "iCloud"
    server = "https://caldav.icloud.com/"


class GoogleCalendarProvider(CalDAVCalendarProvider):
    name = "Google"
    server = "https://apidata.googleusercontent.com/caldav/v2/"


class GoogleCalendarAPIProvider:
    """Google Calendar API adapter using OAuth access tokens."""

    name = "Google"
    calendar_list_url = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
    events_url = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"

    def __init__(self, access_token: str, client: httpx.AsyncClient | None = None):
        self.access_token = access_token
        self.client = client

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.client:
            response = await self.client.get(url, params=params, headers=self.headers)
        else:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(url, params=params, headers=self.headers)
        response.raise_for_status()
        return response.json()

    async def discover(self) -> list[RemoteCalendar]:
        calendars: list[RemoteCalendar] = []
        page_token = None
        while True:
            params = {
                "minAccessRole": "reader",
                "showDeleted": "false",
                "showHidden": "true",
                "maxResults": 250,
            }
            if page_token:
                params["pageToken"] = page_token
            payload = await self._get(self.calendar_list_url, params=params)
            for item in payload.get("items", []):
                calendar_id = str(item.get("id", ""))
                if not calendar_id:
                    continue
                access_role = item.get("accessRole", "reader")
                calendars.append(
                    RemoteCalendar(
                        remote_id=calendar_id,
                        name=str(item.get("summary") or calendar_id),
                        url=calendar_id,
                        shared=not bool(item.get("primary")),
                        read_only=access_role not in {"owner", "writer"},
                    )
                )
            page_token = payload.get("nextPageToken")
            if not page_token:
                break
        return calendars

    async def events(
        self, calendar_url: str, starts: datetime, ends: datetime
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        page_token = None
        url = self.events_url.format(calendar_id=quote(calendar_url, safe=""))
        while True:
            params = {
                "timeMin": starts.isoformat().replace("+00:00", "Z"),
                "timeMax": ends.isoformat().replace("+00:00", "Z"),
                "singleEvents": "true",
                "orderBy": "startTime",
                "showDeleted": "false",
                "maxResults": 2500,
            }
            if page_token:
                params["pageToken"] = page_token
            payload = await self._get(url, params=params)
            for item in payload.get("items", []):
                parsed = self._normalize_event(item)
                if parsed:
                    events.append(parsed)
            page_token = payload.get("nextPageToken")
            if not page_token:
                break
        return events

    def _normalize_event(self, item: dict[str, Any]) -> dict[str, Any] | None:
        start_payload = item.get("start") or {}
        end_payload = item.get("end") or {}
        start_value = start_payload.get("dateTime") or start_payload.get("date")
        end_value = end_payload.get("dateTime") or end_payload.get("date") or start_value
        if not start_value:
            return None
        all_day = "date" in start_payload and "dateTime" not in start_payload
        recurrence_payload = item.get("originalStartTime") or {}
        recurrence_value = (
            recurrence_payload.get("dateTime") or recurrence_payload.get("date") or ""
        )
        return {
            "uid": str(item.get("iCalUID") or item.get("id") or ""),
            "recurrence_id": str(recurrence_value),
            "title": str(item.get("summary") or "Untitled event"),
            "description": str(item.get("description") or ""),
            "location": str(item.get("location") or ""),
            "starts_at": self._parse_google_time(start_value, all_day).isoformat(),
            "ends_at": self._parse_google_time(end_value, all_day).isoformat(),
            "all_day": all_day,
            "etag": item.get("etag"),
            "raw_ical": str(item),
        }

    @staticmethod
    def _parse_google_time(value: str, all_day: bool) -> datetime:
        if all_day:
            return datetime.combine(date.fromisoformat(value), time.min, tzinfo=UTC)
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed
