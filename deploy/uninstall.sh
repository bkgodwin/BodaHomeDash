#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-${HOME_DASHBOARD_USER:-}}"
systemctl disable --now home-dashboard.service 2>/dev/null || true
rm -f /etc/systemd/system/home-dashboard.service
rm -f /etc/sudoers.d/home-dashboard
rm -rf /opt/home-dashboard
rm -rf /usr/local/lib/home-dashboard
rm -f /usr/local/lib/home-dashboard-network-helper
systemctl daemon-reload

if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  rm -f "$TARGET_HOME/.local/bin/home-dashboard-kiosk"
  if [[ -f "$TARGET_HOME/.config/labwc/autostart" ]]; then
    sed -i '/# Home Dashboard kiosk/d;/home-dashboard-kiosk/d' \
      "$TARGET_HOME/.config/labwc/autostart"
  fi
fi

echo "Application removed. Household data remains at /var/lib/home-dashboard."
echo "Delete that directory manually only if you no longer need its contents."
