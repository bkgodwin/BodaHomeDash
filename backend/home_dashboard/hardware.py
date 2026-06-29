from __future__ import annotations

import math
import os
import platform
import json
import struct
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Callable


class DisplayController:
    def __init__(self, output: str = "HDMI-A-1"):
        self.output = output

    def off(self) -> bool:
        return self._run("--off")

    def on(self) -> bool:
        return self._run("--on")

    def _run(self, action: str) -> bool:
        if platform.system() != "Linux":
            return True
        environment = os.environ.copy()
        environment.setdefault("WAYLAND_DISPLAY", "wayland-1")
        try:
            subprocess.run(
                ["wlr-randr", "--output", self.output, action],
                env=environment,
                timeout=8,
                check=True,
                capture_output=True,
            )
            return True
        except Exception:
            return False


class AudioController:
    def play(self, kind: str = "timer", volume: int = 60) -> bool:
        frequency = 660 if kind == "timer" else 523
        notes = [(frequency, 0.20), (frequency * 1.25, 0.24)]
        path = self._tone(notes, volume)
        if platform.system() == "Windows":
            try:
                threading.Thread(
                    target=self._play_windows, args=(path,), daemon=True
                ).start()
                return True
            except Exception:
                path.unlink(missing_ok=True)
                return False
        if platform.system() != "Linux":
            path.unlink(missing_ok=True)
            return False
        try:
            process = subprocess.Popen(
                ["aplay", "-q", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            threading.Thread(
                target=self._cleanup_tone, args=(process, path), daemon=True
            ).start()
            return True
        except Exception:
            path.unlink(missing_ok=True)
            return False

    @staticmethod
    def _play_windows(path: Path) -> None:
        try:
            import winsound

            winsound.PlaySound(
                str(path), winsound.SND_FILENAME | winsound.SND_NODEFAULT
            )
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def _cleanup_tone(process: subprocess.Popen, path: Path) -> None:
        try:
            process.wait(timeout=30)
        except Exception:
            process.kill()
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def _tone(notes: list[tuple[float, float]], volume: int) -> Path:
        rate = 44100
        amplitude = int(32767 * min(max(volume, 0), 100) / 100 * 0.28)
        samples: list[int] = []
        for frequency, duration in notes:
            count = int(rate * duration)
            for index in range(count):
                envelope = min(index / 800, (count - index) / 1200, 1)
                samples.append(
                    int(
                        amplitude
                        * max(envelope, 0)
                        * math.sin(2 * math.pi * frequency * index / rate)
                    )
                )
            samples.extend([0] * int(rate * 0.08))
        handle, filename = tempfile.mkstemp(suffix=".wav")
        os.close(handle)
        path = Path(filename)
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
        return path


class PIRMonitor:
    def __init__(
        self,
        pin: int,
        active_high: bool,
        on_motion: Callable[[], None],
    ):
        self.pin = pin
        self.active_high = active_high
        self.on_motion = on_motion
        self.sensor = None

    def start(self) -> bool:
        if platform.system() != "Linux":
            return False
        try:
            if self.active_high:
                from gpiozero import MotionSensor

                self.sensor = MotionSensor(
                    self.pin,
                    queue_len=3,
                    sample_rate=10,
                )
                self.sensor.when_motion = self.on_motion
            else:
                from gpiozero import Button

                self.sensor = Button(self.pin, pull_up=True, bounce_time=0.1)
                self.sensor.when_pressed = self.on_motion
            return True
        except Exception:
            return False

    def stop(self) -> None:
        if self.sensor:
            self.sensor.close()
            self.sensor = None


class BarcodeMonitor:
    def __init__(self, device: str, on_scan: Callable[[str], None]):
        self.device = device
        self.on_scan = on_scan
        self.thread: threading.Thread | None = None
        self.stopping = threading.Event()

    @staticmethod
    def devices() -> list[dict[str, str]]:
        if platform.system() == "Windows":
            return BarcodeMonitor._windows_devices()
        if platform.system() != "Linux":
            return []
        try:
            from evdev import InputDevice, list_devices

            devices = []
            for path in list_devices():
                name = InputDevice(path).name
                devices.append(
                    {
                        "path": path,
                        "name": name,
                        "platform": "linux",
                        "selectable": "true",
                        "candidate": (
                            "true"
                            if any(
                                word in name.casefold()
                                for word in ("barcode", "bar code", "scanner")
                            )
                            else "false"
                        ),
                    }
                )
            return devices
        except Exception:
            return []

    @staticmethod
    def _windows_devices() -> list[dict[str, str]]:
        command = (
            "Get-CimInstance Win32_PnPEntity | "
            "Where-Object { $_.Present -eq $true -and "
            "$_.PNPClass -in @('Keyboard','HIDClass') } | "
            "Select-Object Name,DeviceID,PNPClass | ConvertTo-Json -Compress"
        )
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
            if not result.stdout.strip():
                return []
            payload = json.loads(result.stdout)
            rows = payload if isinstance(payload, list) else [payload]
            devices = [
                {
                    "path": str(item.get("DeviceID") or ""),
                    "name": str(item.get("Name") or "USB input device"),
                    "platform": "windows",
                    "selectable": "false",
                    "candidate": (
                        "true"
                        if any(
                            word in str(item.get("Name") or "").casefold()
                            for word in ("barcode", "bar code", "scanner")
                        )
                        else "false"
                    ),
                }
                for item in rows
                if item.get("DeviceID")
            ]
            return sorted(
                devices,
                key=lambda item: (
                    item["candidate"] != "true",
                    item["name"].casefold(),
                    item["path"].casefold(),
                ),
            )
        except Exception:
            return []

    def start(self) -> bool:
        if not self.device or platform.system() != "Linux":
            return False
        self.thread = threading.Thread(target=self._listen, daemon=True)
        self.thread.start()
        return True

    def stop(self) -> None:
        self.stopping.set()

    def _listen(self) -> None:
        try:
            from evdev import InputDevice, categorize, ecodes

            device = InputDevice(self.device)
            digits = {
                ecodes.KEY_0: "0",
                ecodes.KEY_1: "1",
                ecodes.KEY_2: "2",
                ecodes.KEY_3: "3",
                ecodes.KEY_4: "4",
                ecodes.KEY_5: "5",
                ecodes.KEY_6: "6",
                ecodes.KEY_7: "7",
                ecodes.KEY_8: "8",
                ecodes.KEY_9: "9",
                ecodes.KEY_KP0: "0",
                ecodes.KEY_KP1: "1",
                ecodes.KEY_KP2: "2",
                ecodes.KEY_KP3: "3",
                ecodes.KEY_KP4: "4",
                ecodes.KEY_KP5: "5",
                ecodes.KEY_KP6: "6",
                ecodes.KEY_KP7: "7",
                ecodes.KEY_KP8: "8",
                ecodes.KEY_KP9: "9",
            }
            buffer = ""
            last = time.monotonic()
            for event in device.read_loop():
                if self.stopping.is_set():
                    break
                if event.type != ecodes.EV_KEY or event.value != 1:
                    continue
                now = time.monotonic()
                if now - last > 0.3:
                    buffer = ""
                last = now
                if event.code in digits:
                    buffer += digits[event.code]
                elif event.code in (ecodes.KEY_ENTER, ecodes.KEY_KPENTER):
                    if buffer:
                        self.on_scan(buffer)
                    buffer = ""
        except Exception:
            return
