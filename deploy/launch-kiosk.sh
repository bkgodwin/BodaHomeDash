#!/usr/bin/env bash
set -euo pipefail

URL="${HOME_DASHBOARD_URL:-http://127.0.0.1:8765}"
EXIT_FILE="${HOME_DASHBOARD_DATA:-/var/lib/home-dashboard}/kiosk-exit-requested"
BROWSER_PID=""

# A prior desktop-exit request must never survive a new login or reboot.
rm -f "$EXIT_FILE"

stop_kiosk() {
  if [[ -n "$BROWSER_PID" ]]; then
    kill "$BROWSER_PID" >/dev/null 2>&1 || true
  fi
  exit 0
}
trap stop_kiosk TERM INT

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
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform,OverlayScrollbar \
    --disable-features=OverscrollHistoryNavigation \
    --touch-events=enabled \
    --start-maximized &
  BROWSER_PID=$!
  wait "$BROWSER_PID" || true
  BROWSER_PID=""
  if [[ -f "$EXIT_FILE" ]]; then
    rm -f "$EXIT_FILE"
    exit 0
  fi
  sleep 2
done
