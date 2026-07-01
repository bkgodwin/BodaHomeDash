#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this installer with sudo: sudo ./deploy/install.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_USER="${SUDO_USER:-${HOME_DASHBOARD_USER:-}}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "Could not determine the Raspberry Pi desktop user." >&2
  echo "Run with: sudo HOME_DASHBOARD_USER=yourname ./deploy/install.sh" >&2
  exit 1
fi
if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "User '$TARGET_USER' does not exist." >&2
  exit 1
fi

TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"

echo "[1/8] Installing Raspberry Pi packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  python3 python3-venv python3-pip python3-dev build-essential \
  chromium curl git rsync swig wlr-randr alsa-utils pipewire-bin network-manager \
  liblgpio-dev
# Raspberry Pi OS Trixie provides wlopm; older Bookworm images still use
# wlr-randr, so keep this enhancement optional.
DEBIAN_FRONTEND=noninteractive apt-get install -y wlopm || true

echo "[2/8] Installing Home Dashboard..."
install -d -m 0755 /opt/home-dashboard
rsync -a --delete \
  --exclude '.venv' \
  --exclude 'frontend/node_modules' \
  --exclude 'data' \
  "$SOURCE_DIR/" /opt/home-dashboard/

if [[ ! -f /opt/home-dashboard/frontend/dist/index.html ]]; then
  echo "The release does not include the compiled frontend." >&2
  echo "Build frontend/dist before running the installer." >&2
  exit 1
fi

python3 -m venv /opt/home-dashboard/.venv
/opt/home-dashboard/.venv/bin/pip install --upgrade pip
/opt/home-dashboard/.venv/bin/pip install "/opt/home-dashboard[pi]"

echo "[3/8] Creating persistent data storage..."
install -d -o "$TARGET_USER" -g "$TARGET_USER" -m 0750 /var/lib/home-dashboard
chown -R root:root /opt/home-dashboard

echo "[4/8] Configuring hardware permissions..."
usermod -a -G input,gpio,audio,video,render "$TARGET_USER"
install -m 0755 /opt/home-dashboard/deploy/network-helper \
  /usr/local/lib/home-dashboard-network-helper
cat >"/etc/sudoers.d/home-dashboard" <<EOF
$TARGET_USER ALL=(root) NOPASSWD: /usr/local/lib/home-dashboard-network-helper *
$TARGET_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart home-dashboard.service
$TARGET_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block home-dashboard-update.service
EOF
chmod 0440 /etc/sudoers.d/home-dashboard

# Match the path used by the backend while retaining the more readable installed name.
install -d -m 0755 /usr/local/lib/home-dashboard
install -m 0755 /opt/home-dashboard/deploy/update.sh \
  /usr/local/lib/home-dashboard/update.sh
ln -sfn /usr/local/lib/home-dashboard-network-helper \
  /usr/local/lib/home-dashboard/network-helper

echo "[5/8] Installing the system service..."
sed \
  -e "s/@USER@/$TARGET_USER/g" \
  -e "s/@UID@/$TARGET_UID/g" \
  -e "s|@HOME@|$TARGET_HOME|g" \
  /opt/home-dashboard/deploy/home-dashboard.service.in \
  >/etc/systemd/system/home-dashboard.service
systemctl daemon-reload
install -m 0644 /opt/home-dashboard/deploy/home-dashboard-update.service \
  /etc/systemd/system/home-dashboard-update.service
systemctl daemon-reload
systemctl enable home-dashboard.service

echo "[6/8] Configuring kiosk startup..."
install -d -o "$TARGET_USER" -g "$TARGET_USER" \
  "$TARGET_HOME/.config/labwc" "$TARGET_HOME/.local/bin"
install -o "$TARGET_USER" -g "$TARGET_USER" -m 0755 \
  /opt/home-dashboard/deploy/launch-kiosk.sh \
  "$TARGET_HOME/.local/bin/home-dashboard-kiosk"
AUTOSTART="$TARGET_HOME/.config/labwc/autostart"
touch "$AUTOSTART"
chown "$TARGET_USER:$TARGET_USER" "$AUTOSTART"
if ! grep -q "home-dashboard-kiosk" "$AUTOSTART"; then
  printf '\n# Home Dashboard kiosk\n%s &\n' \
    "$TARGET_HOME/.local/bin/home-dashboard-kiosk" >>"$AUTOSTART"
fi

echo "[7/8] Configuring unattended desktop boot..."
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_boot_behaviour B4 || true
  raspi-config nonint do_blanking 1 || true
  raspi-config nonint do_onscreen_keyboard 1 || true
fi

systemctl enable NetworkManager.service >/dev/null 2>&1 || true
systemctl restart home-dashboard.service

echo "[8/8] Installation complete."
echo
echo "Reboot to open the first-run wizard:"
echo "  sudo reboot"
echo
echo "The dashboard will also be available at:"
echo "  http://$(hostname).local:8765"
