#!/usr/bin/env bash
set -euo pipefail

URL="${HOME_DASHBOARD_URL:-http://127.0.0.1:8765}"
EXIT_FILE="${XDG_RUNTIME_DIR:-/tmp}/home-dashboard-kiosk.exit"

# A prior desktop-exit request must never survive a new login or reboot.
rm -f "$EXIT_FILE"

until curl --silent --fail --max-time 2 "$URL/api/v1/status" >/dev/null; do
  sleep 1
done

while true; do
  chromium "$URL" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-session-crashed-bubble \
    --disable-translate \
    --autoplay-policy=no-user-gesture-required \
    --enable-features=OverlayScrollbar \
    --touch-events=enabled \
    --start-maximized
  if [[ -f "$EXIT_FILE" ]]; then
    rm -f "$EXIT_FILE"
    exit 0
  fi
  sleep 2
done
