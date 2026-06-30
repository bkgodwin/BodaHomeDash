# Raspberry Pi installation

## 1. Prepare Raspberry Pi OS

Use Raspberry Pi Imager to install the latest Raspberry Pi OS Desktop 64-bit
image. In Imager customization:

- create a normal administrative user and password;
- configure Wi-Fi, country, keyboard, and the `America/Chicago` time zone;
- set a hostname such as `home-dashboard`;
- enable SSH, preferably with an SSH public key.

The account retains a password for administration. The installer enables
desktop autologin so no credentials are requested during normal boot.

## 2. Connect the hardware

1. Connect the monitor to the Pi 4 HDMI0 connector using micro-HDMI.
2. Connect the monitor's USB touch-data cable to the Pi.
3. Connect the Tera scanner to a USB 2.0 port.
4. Connect the HC-SR501 as described in [Hardware](HARDWARE.md).
5. Power the monitor separately.
6. Power the Pi from a reliable 5V/3A USB-C supply.

## 3. Install the dashboard

Copy or clone this complete repository onto the Pi. The compiled
`frontend/dist` directory must be present.

```bash
cd home-dashboard
sudo ./deploy/install.sh
sudo reboot
```

The installer:

- installs Python, Chromium, Wayland display tools, ALSA, NetworkManager,
  SWIG, and GPIO build dependencies;
- copies the application to `/opt/home-dashboard`;
- creates a virtual environment and installs the backend;
- creates persistent storage at `/var/lib/home-dashboard`;
- grants the desktop user input, GPIO, audio, video, and render access;
- installs the restricted Wi-Fi helper;
- installs and enables `home-dashboard.service`;
- configures Labwc to launch Chromium in kiosk mode;
- enables desktop autologin; and
- disables competing OS blanking and on-screen keyboard behavior.

It can be run again to repair or update the application. It does not delete
`/var/lib/home-dashboard`.

## 4. Complete first-run setup

The kiosk opens a guided wizard:

1. Confirm the household name.
2. Detect or search for the Louisiana location.
3. Connect iCloud with an Apple Account email and app-specific password.
4. Select visible calendars and colors.
5. Select the scanner, PIR GPIO, display sleep method, and timeout.
6. Test the timer and emergency-alert sounds.
7. Optionally enable phone access and create a numeric PIN.
8. Finish setup.

Encrypted USB backups remain optional and can be enabled later.

The Hardware settings page can select an ALSA audio output for the monitor
speakers. The System settings page can close Chromium and return to the
Raspberry Pi desktop for the current session. The kiosk starts normally again
after the next reboot.

## 5. Network access

On the home network, use:

```text
http://home-dashboard.local:8765
```

The exact hostname follows the name selected in Raspberry Pi Imager. Phone
access must be enabled from the physical kiosk first.

Do not forward this port through the router. Install Tailscale for remote access
and prefer Tailscale Serve/HTTPS so the PIN and session cookie are encrypted in
transit.

## Maintenance

Application and Raspberry Pi OS updates are intentionally manual. After
replacing the source tree with a tested version, rerun the installer and reboot.

Useful commands:

```bash
systemctl status home-dashboard.service
journalctl -u home-dashboard.service -n 200
sudo systemctl restart home-dashboard.service
```

To remove the application service while retaining an opportunity to copy the
data directory, review and run `sudo ./deploy/uninstall.sh`.
