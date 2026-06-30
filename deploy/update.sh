#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/home-dashboard"
DATA_DIR="/var/lib/home-dashboard"
STATUS="$DATA_DIR/update-status.json"
REMOTE="https://github.com/bkgodwin/BodaHomeDash.git"

write_status() {
  local state="$1"
  local message="$2"
  printf '{"state":"%s","message":"%s","updated_at":"%s"}\n' \
    "$state" "$message" "$(date --iso-8601=seconds)" >"$STATUS"
  chmod 0644 "$STATUS"
}

failed() {
  write_status "error" "Update failed. Check: journalctl -u home-dashboard-update.service"
}
trap failed ERR

exec 9>/run/lock/bodahomedash-update.lock
flock -n 9 || exit 0
write_status "running" "Downloading the latest main branch…"

cd "$APP_DIR"
if [[ ! -d .git ]]; then
  git init
  git remote add origin "$REMOTE"
fi
git config --global --add safe.directory "$APP_DIR"
git fetch --prune origin main
git reset --hard origin/main
install -m 0755 "$APP_DIR/deploy/update.sh" /usr/local/lib/home-dashboard/update.sh
install -m 0644 "$APP_DIR/deploy/home-dashboard-update.service" \
  /etc/systemd/system/home-dashboard-update.service
KIOSK_USER="$(systemctl show home-dashboard.service --property=User --value)"
if [[ -n "$KIOSK_USER" && "$KIOSK_USER" != "root" ]]; then
  KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
  if [[ -n "$KIOSK_HOME" && -d "$KIOSK_HOME/.local/bin" ]]; then
    install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0755 \
      "$APP_DIR/deploy/launch-kiosk.sh" \
      "$KIOSK_HOME/.local/bin/home-dashboard-kiosk"
  fi
fi
systemctl daemon-reload

write_status "running" "Updating application dependencies…"
"$APP_DIR/.venv/bin/pip" install --upgrade "$APP_DIR[pi]"

if [[ ! -f "$APP_DIR/frontend/dist/index.html" ]]; then
  write_status "error" "The downloaded release is missing the web application build."
  exit 1
fi

chown -R root:root "$APP_DIR"
write_status "complete" "Update complete. Restarting BodaHomeDash…"
systemctl restart home-dashboard.service
