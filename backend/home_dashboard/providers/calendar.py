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
    shared: bool = False
    read_only: bool = True


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
