# Agreed product specification

## Platform

- Raspberry Pi 4 Model B, 2 GB RAM.
- Raspberry Pi OS Desktop 64-bit.
- 14-inch Showscren 16:9 HDMI/USB touchscreen.
- HC-SR501 PIR on a configurable BCM GPIO, initially BCM 17.
- Tera hands-free USB barcode scanner.
- Full-screen Chromium kiosk launched automatically after desktop autologin.
- 1920×1080 layout with no main-page scrolling.

## Calendar and home

- The month calendar is the main visual element.
- iCloud is the first provider; events are read-only.
- Multiple iCloud calendars can be selected and colored.
- Provider boundaries preserve a future path for other calendar sources and
  calendar writes.
- Month arrows and swipe gestures navigate through time.
- Display sleep/wake returns the user to the current month.
- Day details contain events, US/Louisiana holidays, and expiring food.
- Pantry expiration is represented by a brown day marker.
- Weather, reminder, and shopping widgets remain visible below the calendar and
  scroll internally.
- The footer includes the clock, manual refresh, running timers, and an optional
  softly pulsing green garbage-pickup reminder for a configured weekday.

## Synchronization

- Calendar: five minutes.
- Current weather: two minutes.
- Forecast: ten-minute display expectation; the first implementation fetches
  forecast data with current conditions and can split caching later.
- NWS alerts: one minute.
- Phone edits: immediate WebSocket notification.
- Manual refresh beside the clock.
- Changed components update in place without clearing the whole calendar.

## Weather and alerts

- Open-Meteo for conditions and forecasts.
- Automatic approximate IP location or manual city/ZIP selection.
- National Weather Service alerts for the configured Louisiana location.
- Emergency events and Extreme-severity alerts wake the display and play one
  gentle chime.
- Other alerts appear on the next normal display wake without sound.
- Alerts remain until dismissed, canceled, or expired.
- Settings contain separate timer and emergency-alert sound tests.

## Pantry, barcode, and shopping

- Local SQLite lookup is authoritative.
- Missing barcodes are queried through Open Food Facts and cached locally.
- Offline/manual entry remains available.
- Pantry purchases form separate inventory batches with individual expirations,
  displayed as one aggregated product.
- Pantry is searchable and alphabetized with A–Z navigation.
- Expired items are red; product details include available nutrition data.
- Long press supports deletion or deletion plus shopping-list addition.
- Shopping items have quantities and purchased state.
- A pantry barcode, linked product, or exact normalized name can mark a
  shopping item purchased.
- Kiosk and authenticated phone users can edit pantry, shopping, and reminders.

## Timers, motion, and display

- Multiple persistent kitchen timers with the requested presets and custom
  entry.
- Timer completion wakes the display, plays HDMI audio, and shows a dismiss
  dialog.
- PIR inactivity timeout defaults to five minutes.
- Display mode is either HDMI output off or an instant black overlay.
- Touch, scanner activity, timers, and emergency alerts wake the display.

## Security and durability

- Remote phone access is optional and protected by an Argon2id-hashed PIN.
- Sensitive settings are only available from loopback/the physical kiosk.
- Tailscale HTTPS is recommended for access away from home.
- SQLite uses WAL, full synchronization, foreign keys, and immediate
  transactions.
- Optional encrypted USB backups include data, configuration, and credentials.
- The backup recovery password is created only when backups are enabled.
- Fresh-install restore is available from the first setup screen.
- Application and OS updates remain manual.
