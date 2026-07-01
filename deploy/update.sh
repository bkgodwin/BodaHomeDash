#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/home-dashboard"
DATA_DIR="/var/lib/home-dashboard"
STATUS="$DATA_DIR/update-status.json"
REMOTE="https://github.com/bkgodwin/BodaHomeDash.git"

write_status() {
  local state="$1"
  local message="$2"
  UPDATE_STATE="$state" UPDATE_MESSAGE="$message" UPDATE_STATUS="$STATUS" \
    python3 - <<'PY'
import json
import os
from datetime import datetime

with open(os.environ["UPDATE_STATUS"], "w", encoding="utf-8") as output:
    json.dump(
        {
            "state": os.environ["UPDATE_STATE"],
            "message": os.environ["UPDATE_MESSAGE"],
            "updated_at": datetime.now().astimezone().isoformat(),
        },
        output,
    )
    output.write("\n")
PY
  chmod 0644 "$STATUS"
}

failed() {
  local code="$?"
  local line="${1:-unknown}"
  local command="${2:-unknown command}"
  trap - ERR
  write_status "error" \
    "Update failed at line $line while running: $command (exit $code). Check journalctl -u home-dashboard-update.service"
  exit "$code"
}
trap 'failed "$LINENO" "$BASH_COMMAND"' ERR

exec 9>/run/lock/bodahomedash-update.lock
flock -n 9 || exit 0
write_status "running" "Downloading the latest main branch…"

cd "$APP_DIR"
if [[ ! -d .git ]]; then
  git init
  git remote add origin "$REMOTE"
fi
git -c safe.directory="$APP_DIR" fetch --prune origin main
git -c safe.directory="$APP_DIR" reset --hard origin/main
install -m 0755 "$APP_DIR/deploy/update.sh" /usr/local/lib/home-dashboard/update.sh
install -m 0644 "$APP_DIR/deploy/home-dashboard-update.service" \
  /etc/systemd/system/home-dashboard-update.service
KIOSK_USER="$(systemctl show home-dashboard.service --property=User --value)"
if [[ -n "$KIOSK_USER" && "$KIOSK_USER" != "root" ]]; then
  KIOSK_UID="$(id -u "$KIOSK_USER")"
  KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
  if [[ -n "$KIOSK_HOME" && -d "$KIOSK_HOME/.local/bin" ]]; then
    KIOSK_LAUNCHER="$KIOSK_HOME/.local/bin/home-dashboard-kiosk"
    install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0755 \
      "$APP_DIR/deploy/launch-kiosk.sh" \
      "$KIOSK_LAUNCHER.new"
    mv -f "$KIOSK_LAUNCHER.new" "$KIOSK_LAUNCHER"
  fi
  sed \
    -e "s|@USER@|$KIOSK_USER|g" \
    -e "s|@UID@|$KIOSK_UID|g" \
    -e "s|@HOME@|$KIOSK_HOME|g" \
    "$APP_DIR/deploy/home-dashboard.service.in" \
    >/etc/systemd/system/home-dashboard.service
fi
systemctl daemon-reload

write_status "running" "Updating application dependencies…"
"$APP_DIR/.venv/bin/pip" install --disable-pip-version-check --upgrade "$APP_DIR[pi]"
if ! command -v wlopm >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y wlopm || true
fi

if [[ ! -f "$APP_DIR/frontend/dist/index.html" ]]; then
  write_status "error" "The downloaded release is missing the web application build."
  exit 1
fi

chown -R root:root "$APP_DIR"
write_status "complete" "Update complete. Restarting BodaHomeDash…"
systemctl restart home-dashboard.service
