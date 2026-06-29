#!/usr/bin/env bash
set -euo pipefail

URL="${HOME_DASHBOARD_URL:-http://127.0.0.1:8765}"

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
    --start-maximized
  sleep 2
done
