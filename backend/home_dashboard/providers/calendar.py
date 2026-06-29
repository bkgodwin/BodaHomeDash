from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

import caldav
import recurring_ical_events
from icalendar import Calendar


@dataclass
class RemoteCalendar:
    remote_id: str
    name: str
    url: str


class ICloudCalendarProvider:
    """Small CalDAV adapter. Network calls run in a worker thread."""

    server = "https://caldav.icloud.com/"

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
        calendars = self._principal().calendars()
        result = []
        for calendar in calendars:
            properties = calendar.get_properties(
                [caldav.elements.dav.DisplayName()]
            )
            name = (
                properties.get("{DAV:}displayname")
                or str(calendar.url).rstrip("/").split("/")[-1]
            )
            result.append(
                RemoteCalendar(
                    remote_id=str(calendar.url),
                    name=str(name),
                    url=str(calendar.url),
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
        client = caldav.DAVClient(
            url=self.server, username=self.username, password=self.app_password
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
                end_value = component.decoded("DTEND", start_value)
                all_day = isinstance(start_value, date) and not isinstance(
                    start_value, datetime
                )
                starts_at = self._as_datetime(start_value, False)
                ends_at = self._as_datetime(end_value, all_day)
                recurrence = component.get("RECURRENCE-ID")
                recurrence_value = (
                    self._as_datetime(recurrence.dt, all_day).isoformat()
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
    def _as_datetime(value: date | datetime, end_of_day: bool) -> datetime:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=UTC)
            return value
        return datetime.combine(value, time.min, tzinfo=UTC) + (
            timedelta(days=1) if end_of_day else timedelta()
        )
