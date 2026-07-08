from datetime import UTC, datetime

from home_dashboard.providers import calendar as calendar_module
from home_dashboard.providers.calendar import (
    GoogleCalendarAPIProvider,
    GoogleCalendarProvider,
    ICloudCalendarProvider,
)


def test_google_calendar_provider_uses_google_caldav_endpoint():
    provider = GoogleCalendarProvider("person@gmail.com", "app-password")

    assert provider.server == "https://apidata.googleusercontent.com/caldav/v2/"


def test_google_api_provider_normalizes_calendar_and_events():
    provider = GoogleCalendarAPIProvider("token")
    event = provider._normalize_event(
        {
            "id": "abc",
            "iCalUID": "ical-abc",
            "summary": "Dinner",
            "description": "Bring dessert",
            "location": "Kitchen",
            "start": {"dateTime": "2026-07-07T18:00:00-05:00"},
            "end": {"dateTime": "2026-07-07T19:00:00-05:00"},
            "originalStartTime": {"dateTime": "2026-07-07T18:00:00-05:00"},
            "etag": "etag",
        }
    )

    assert event["uid"] == "ical-abc"
    assert event["title"] == "Dinner"
    assert event["all_day"] is False
    assert event["starts_at"].startswith("2026-07-07T18:00:00")


def test_google_api_provider_normalizes_all_day_event():
    provider = GoogleCalendarAPIProvider("token")
    event = provider._normalize_event(
        {
            "id": "abc",
            "summary": "Holiday",
            "start": {"date": "2026-07-04"},
            "end": {"date": "2026-07-05"},
        }
    )

    assert event["all_day"] is True
    assert event["starts_at"].startswith("2026-07-04T00:00:00")
    assert event["ends_at"].startswith("2026-07-05T00:00:00")


def test_event_fetch_uses_discovered_icloud_shard(monkeypatch):
    created_urls = []

    class FakeClient:
        def __init__(self, *, url, username, password):
            created_urls.append(url)

    class FakeCalendar:
        def __init__(self, *, client, url):
            self.url = url

        def search(self, **_kwargs):
            return []

    monkeypatch.setattr(calendar_module.caldav, "DAVClient", FakeClient)
    monkeypatch.setattr(calendar_module.caldav, "Calendar", FakeCalendar)
    provider = ICloudCalendarProvider("person@example.com", "app-password")
    shard = "https://p162-caldav.icloud.com/123/calendars/work/"

    result = provider._events_sync(
        shard,
        datetime(2026, 1, 1, tzinfo=UTC),
        datetime(2026, 2, 1, tzinfo=UTC),
    )

    assert result == []
    assert created_urls == [shard]


def test_all_day_event_keeps_exclusive_dtend(monkeypatch):
    raw = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:vacation
DTSTART;VALUE=DATE:20260701
DTEND;VALUE=DATE:20260703
SUMMARY:Vacation
END:VEVENT
END:VCALENDAR
"""

    class FakeRemoteEvent:
        data = raw
        etag = "one"

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

    class FakeCalendar:
        def __init__(self, **_kwargs):
            pass

        def search(self, **_kwargs):
            return [FakeRemoteEvent()]

    monkeypatch.setattr(calendar_module.caldav, "DAVClient", FakeClient)
    monkeypatch.setattr(calendar_module.caldav, "Calendar", FakeCalendar)
    provider = ICloudCalendarProvider("person@example.com", "app-password")

    events = provider._events_sync(
        "https://p162-caldav.icloud.com/cal/",
        datetime(2026, 6, 1, tzinfo=UTC),
        datetime(2026, 8, 1, tzinfo=UTC),
    )

    assert events[0]["starts_at"].startswith("2026-07-01")
    assert events[0]["ends_at"].startswith("2026-07-03")
