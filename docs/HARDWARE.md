# Hardware and wiring

## Raspberry Pi 4

The supported baseline is a Raspberry Pi 4 Model B with 2 GB RAM. Use passive
cooling or a heatsink case for continuous kiosk operation. Use a reliable
15W/5V/3A USB-C supply.

The 14-inch monitor must use its own power supply. Do not attempt to power the
panel from the Pi's USB ports.

## Display

- Connect Pi HDMI0 to the monitor with a micro-HDMI-to-HDMI cable.
- Connect the monitor's USB touch-data lead to a Pi USB port.
- HDMI audio is used for the monitor's speakers.
- The recommended desktop audio output uses PipeWire, matching Chromium and
  Raspberry Pi OS. Direct ALSA interfaces can also be selected and tested.
- The expected Wayland output is `HDMI-A-1`, but it is configurable.

The default sleep mode runs `wlr-randr --output HDMI-A-1 --off`. Some monitors
take several seconds to reacquire HDMI. If that is distracting, select the
instant black-screen mode in Settings.

## HC-SR501 PIR

Default wiring:

| HC-SR501 | Raspberry Pi |
| --- | --- |
| VCC | 5V supply pin |
| GND | Ground |
| OUT | BCM GPIO 17 |

The HC-SR501 is powered from 5V but normally emits a roughly 3.3V output signal.
Verify the particular module before connecting it. Never apply a 5V signal to a
Pi GPIO input.

Use BCM numbering in Settings. The input is active-high by default. Allow the
sensor approximately one minute to stabilize after power-on.

Hardware settings shows the GPIO backend, initialization errors, and a live
green motion indicator. The service uses the `lgpio` GPIO Zero backend.

## Tera barcode scanner

Connect the scanner over USB and configure it for ordinary keyboard/HID output
with Enter as the scan suffix. In Settings, select the input device whose name
matches the scanner and perform a test scan.

The dashboard reads the scanner through Linux `evdev`, keeping scans separate
from touch-keyboard fields.

## USB backups

Use a dedicated USB flash drive or SSD formatted with a filesystem Raspberry Pi
OS can write. Mount it below `/media/<user>/...`, select its folder in Settings,
and safely eject it only after a backup completes.
