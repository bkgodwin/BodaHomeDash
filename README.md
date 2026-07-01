# Home Dashboard

A local-first household calendar and kitchen dashboard for a Raspberry Pi 4
Model B (2 GB) and a 1920×1080 touchscreen.

The current implementation includes:

- a full-month, read-only iCloud calendar with multiple accounts, periodic
  rediscovery, and Apple-shared calendar support;
- Louisiana/US holidays and pantry expiration markers;
- current, hourly, and daily weather from Open-Meteo, with day/night and
  condition-aware forecast styling;
- detailed conditions, CAMS air quality, and touch-controlled NOAA/NWS radar;
- NWS alerts, with emergency-only display wake and one gentle audio chime;
- barcode lookup through a local cache and Open Food Facts;
- pantry inventory with separate expiration batches;
- shared shopping lists and reminders;
- persistent kitchen timers with HDMI audio;
- live timer countdown/progress displays and a temporary keep-awake lock;
- PIR-controlled HDMI sleep or instant black-screen blanking;
- PIN-protected phone layouts on the local network;
- phone-camera barcode scanning with ZXing and a photo fallback;
- searchable TheMealDB recipes, locally cached favorites, editable custom
  recipes, and one-tap ingredient additions to the shopping list;
- a horizontally scrolling Week Planner with calendar/weather context, recipe
  meals, meal labels, color-coded recurring or one-time chores, household
  assignments, hold-to-drag scheduling, and daily notes;
- a shared autosaving formatted notepad on kiosk and phone layouts;
- a three-day pantry “use soon” strip;
- optional encrypted USB backups restorable during a fresh setup;
- an optional garbage-pickup-day reminder beside the clock;
- a touch-first setup wizard, optional full on-screen keyboard, physical
  keyboard support, and touch-native confirmation dialogs; and
- per-batch pantry notes and selection, FIFO quantity controls, and normalized
  nutrition/ingredient details.

The Windows development build supports keyboard-wedge barcode scanners and
audio through the Windows sound system. Raspberry Pi deployments use evdev for
the selected scanner and PipeWire with an ALSA fallback for HDMI audio.

## Hardware target

- Raspberry Pi 4 Model B, 2 GB RAM
- Raspberry Pi OS Desktop 64-bit
- 14-inch 1920×1080 HDMI/USB touchscreen
- HC-SR501 PIR sensor
- Tera USB hands-free barcode scanner
- 15W (5V/3A) USB-C Pi power supply
- separate monitor power supply
- high-endurance microSD card

See [Hardware](docs/HARDWARE.md) for wiring and safety notes.

## Install on Raspberry Pi

Flash Raspberry Pi OS Desktop 64-bit and use Raspberry Pi Imager to set a
desktop username, password, Wi-Fi, hostname, locale, and SSH access. Then copy
or clone this repository and run:

```bash
sudo ./deploy/install.sh
sudo reboot
```

The installer is idempotent and configures dependencies, the backend service,
desktop autologin, Chromium kiosk startup, hardware permissions, and local
network access. On the next boot, the touchscreen setup wizard opens
automatically.

See [Installation](docs/INSTALLATION.md) for the complete procedure and
[Backups](docs/BACKUPS.md) for fresh-install recovery.

## Development

Backend:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[test]"
pytest
```

Frontend:

```bash
cd frontend
pnpm install
pnpm test
pnpm build
```

Run the combined application:

```bash
HOME_DASHBOARD_DEBUG=1 home-dashboard
```

Open `http://127.0.0.1:8765`.

## Data and privacy

Household data is stored locally in SQLite. Apple app-specific passwords, the
remote-access PIN hash, and the backup recovery password are encrypted using a
device-local key. USB backup bundles use AES-GCM with a key derived from the
user's separate recovery password.

The application contacts iCloud CalDAV, Open-Meteo, the National Weather
Service, Open Food Facts, TheMealDB, and the optional IP location provider. It
does not require a cloud account of its own. Personal installations use
TheMealDB's developer key by default; a supporter key can be supplied through
the `THEMEALDB_API_KEY` environment variable.

Do not expose port 8765 directly to the internet. Use a trusted home network or
Tailscale. Tailscale HTTPS is recommended for access away from home.

## Project status

Automated backend/frontend tests and a production frontend build are included.
GPIO, HDMI sleep, touch calibration, and HDMI audio still require final
validation on the exact Raspberry Pi and attached hardware.

The full agreed specification is preserved in
[Project Plan](docs/PROJECT_PLAN.md).
