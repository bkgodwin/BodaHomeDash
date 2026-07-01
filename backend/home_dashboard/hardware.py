from __future__ import annotations

import math
import os
import platform
import json
import re
import shutil
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
        self.last_backend = ""
        self.last_error = ""

    def off(self) -> bool:
        return self._run(False)

    def on(self) -> bool:
        return self._run(True)

    def status(self) -> dict[str, str]:
        return {
            "output": self.output,
            "backend": self.last_backend,
            "last_error": self.last_error,
        }

    def _wayland_environments(self) -> list[dict[str, str]]:
        base = os.environ.copy()
        runtime = base.get("XDG_RUNTIME_DIR") or (
            f"/run/user/{os.getuid()}" if hasattr(os, "getuid") else ""
        )
        displays = [base.get("WAYLAND_DISPLAY", ""), "wayland-0", "wayland-1"]
        if runtime and Path(runtime).is_dir():
            displays = [
                *(
                    path.name
                    for path in Path(runtime).glob("wayland-*")
                    if path.is_socket()
                ),
                *displays,
            ]
        environments: list[dict[str, str]] = []
        for display in dict.fromkeys(item for item in displays if item):
            environment = base.copy()
            if runtime:
                environment["XDG_RUNTIME_DIR"] = runtime
            environment["WAYLAND_DISPLAY"] = display
            environments.append(environment)
        return environments or [base]

    def _run(self, turn_on: bool) -> bool:
        if platform.system() != "Linux":
            return True
        action = "--on" if turn_on else "--off"
        errors: list[str] = []
        for environment in self._wayland_environments():
            commands: list[tuple[str, list[str]]] = []
            if shutil.which("wlopm"):
                commands.append(
                    ("wlopm", ["wlopm", action, self.output])
                )
                commands.append(
                    ("wlopm-all", ["wlopm", action, "*"])
                )
            if shutil.which("wlr-randr"):
                outputs = [self.output]
                try:
                    listed = subprocess.run(
                        ["wlr-randr"],
                        env=environment,
                        timeout=8,
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    outputs.extend(
                        line.split()[0]
                        for line in listed.stdout.splitlines()
                        if line and not line[0].isspace()
                    )
                except Exception:
                    pass
                commands.extend(
                    (
                        "wlr-randr",
                        ["wlr-randr", "--output", output, action],
                    )
                    for output in dict.fromkeys(outputs)
                )
            for backend, command in commands:
                try:
                    result = subprocess.run(
                        command,
                        env=environment,
                        timeout=8,
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    if result.returncode == 0:
                        if backend == "wlr-randr":
                            self.output = command[-2]
                        self.last_backend = backend
                        self.last_error = ""
                        return True
                    detail = (result.stderr or result.stdout).strip()
                    errors.append(
                        f"{backend} ({environment.get('WAYLAND_DISPLAY', '?')}): "
                        f"{detail or f'exit {result.returncode}'}"
                    )
                except Exception as error:
                    errors.append(f"{backend}: {error}")
        if shutil.which("vcgencmd"):
            try:
                result = subprocess.run(
                    ["vcgencmd", "display_power", "1" if turn_on else "0"],
                    timeout=8,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                if (
                    result.returncode == 0
                    and f"={1 if turn_on else 0}" in result.stdout
                ):
                    self.last_backend = "vcgencmd"
                    self.last_error = ""
                    return True
                errors.append((result.stderr or result.stdout).strip())
            except Exception as error:
                errors.append(f"vcgencmd: {error}")
        self.last_error = "; ".join(item for item in errors if item) or (
            "No supported Wayland display-power utility was found"
        )
        return False


class AudioController:
    def __init__(self, output: str = "default"):
        self.output = output
        self._stops: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self.last_backend = ""
        self.last_error = ""
        self.last_success_at: float | None = None

    @staticmethod
    def outputs() -> list[dict[str, str]]:
        outputs = [{"id": "default", "name": "Desktop default (recommended)"}]
        if platform.system() != "Linux":
            return outputs
        try:
            result = subprocess.run(
                ["aplay", "-l"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            pattern = re.compile(
                r"^card\s+(\d+):\s+([^\s]+)\s+\[([^\]]+)\],\s+"
                r"device\s+(\d+):\s+([^\[]+)(?:\[([^\]]+)\])?",
                re.I,
            )
            for line in result.stdout.splitlines():
                match = pattern.search(line.strip())
                if not match:
                    continue
                card, _, card_name, device, device_name, detail = match.groups()
                output_id = f"plughw:{card},{device}"
                if any(item["id"] == output_id for item in outputs):
                    continue
                label = " · ".join(
                    part.strip()
                    for part in (card_name, device_name, detail or "")
                    if part and part.strip()
                )
                outputs.append({"id": output_id, "name": label})
        except Exception:
            pass
        return outputs

    def status(self) -> dict[str, object]:
        return {
            "output": self.output,
            "backend": self.last_backend or (
                "pipewire" if platform.system() == "Linux" and shutil.which("pw-play")
                else "alsa" if platform.system() == "Linux"
                else "winsound" if platform.system() == "Windows"
                else "unavailable"
            ),
            "last_error": self.last_error,
            "last_success_at": self.last_success_at,
        }

    @staticmethod
    def system_volume() -> dict[str, object]:
        if platform.system() != "Linux":
            return {"available": False, "volume": None, "backend": ""}
        commands = []
        if shutil.which("wpctl"):
            commands.append(("pipewire", ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"]))
        if shutil.which("amixer"):
            commands.extend(
                [
                    ("alsa-master", ["amixer", "get", "Master"]),
                    ("alsa-pcm", ["amixer", "get", "PCM"]),
                ]
            )
        errors: list[str] = []
        for backend, command in commands:
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=8,
                    check=False,
                )
                output = f"{result.stdout}\n{result.stderr}"
                match = (
                    re.search(r"Volume:\s*([0-9.]+)", output)
                    if backend == "pipewire"
                    else re.search(r"\[(\d+)%\]", output)
                )
                if result.returncode == 0 and match:
                    value = (
                        round(float(match.group(1)) * 100)
                        if backend == "pipewire"
                        else int(match.group(1))
                    )
                    return {
                        "available": True,
                        "volume": min(100, max(0, value)),
                        "backend": backend,
                        "muted": "[MUTED]" in output,
                    }
                errors.append((result.stderr or result.stdout).strip())
            except Exception as error:
                errors.append(str(error))
        return {
            "available": False,
            "volume": None,
            "backend": "",
            "error": "; ".join(item for item in errors if item),
        }

    @staticmethod
    def set_system_volume(volume: int) -> dict[str, object]:
        value = min(100, max(0, int(volume)))
        commands = []
        if shutil.which("wpctl"):
            commands.append(
                (
                    "pipewire",
                    ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{value / 100:.2f}"],
                )
            )
        if shutil.which("amixer"):
            commands.extend(
                [
                    ("alsa-master", ["amixer", "sset", "Master", f"{value}%", "unmute"]),
                    ("alsa-pcm", ["amixer", "sset", "PCM", f"{value}%", "unmute"]),
                ]
            )
        errors: list[str] = []
        for backend, command in commands:
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=8,
                    check=False,
                )
                if result.returncode == 0:
                    return {
                        "available": True,
                        "volume": value,
                        "backend": backend,
                        "muted": value == 0,
                    }
                errors.append((result.stderr or result.stdout).strip())
            except Exception as error:
                errors.append(str(error))
        return {
            "available": False,
            "volume": None,
            "backend": "",
            "error": "; ".join(item for item in errors if item)
            or "No supported system mixer was found",
        }

    def probe(self, kind: str, volume: int) -> dict[str, object]:
        success = self._play_once(kind, volume)
        return {"success": success, **self.status()}

    def play(self, kind: str = "timer", volume: int = 60) -> bool:
        return self.play_bursts(kind, volume, [1])

    def repeat(
        self,
        kind: str,
        volume: int,
        key: str,
        max_seconds: float = 10,
    ) -> bool:
        return self._start_sequence(kind, volume, key, None, max_seconds)

    def play_bursts(
        self,
        kind: str,
        volume: int,
        bursts: list[int],
        key: str | None = None,
    ) -> bool:
        return self._start_sequence(
            kind,
            volume,
            key or f"once-{time.monotonic_ns()}",
            bursts,
            None,
        )

    def stop(self, key: str) -> None:
        with self._lock:
            event = self._stops.get(key)
        if event:
            event.set()

    def _start_sequence(
        self,
        kind: str,
        volume: int,
        key: str,
        bursts: list[int] | None,
        max_seconds: float | None,
    ) -> bool:
        if platform.system() not in {"Windows", "Linux"}:
            return False
        self.stop(key)
        stop = threading.Event()
        with self._lock:
            self._stops[key] = stop
        threading.Thread(
            target=self._sequence_worker,
            args=(kind, volume, key, stop, bursts, max_seconds),
            daemon=True,
        ).start()
        return True

    def _sequence_worker(
        self,
        kind: str,
        volume: int,
        key: str,
        stop: threading.Event,
        bursts: list[int] | None,
        max_seconds: float | None,
    ) -> None:
        started = time.monotonic()
        groups = bursts or [10_000]
        try:
            for group_index, count in enumerate(groups):
                for _ in range(count):
                    if stop.is_set():
                        return
                    if max_seconds is not None and time.monotonic() - started >= max_seconds:
                        return
                    self._play_once(kind, volume)
                    stop.wait(0.18)
                if group_index < len(groups) - 1:
                    stop.wait(1.0)
        finally:
            with self._lock:
                if self._stops.get(key) is stop:
                    self._stops.pop(key, None)

    def _play_once(self, kind: str, volume: int) -> bool:
        frequency = 660 if kind == "timer" else 523
        notes = [(frequency, 0.20), (frequency * 1.25, 0.24)]
        path = self._tone(notes, volume)
        try:
            if platform.system() == "Windows":
                import winsound

                winsound.PlaySound(
                    str(path), winsound.SND_FILENAME | winsound.SND_NODEFAULT
                )
                self.last_backend = "winsound"
                self.last_error = ""
                self.last_success_at = time.time()
                return True
            if platform.system() != "Linux":
                self.last_error = "No supported audio backend is available"
                return False

            commands: list[tuple[str, list[str]]] = []
            if self.output == "default":
                if shutil.which("pw-play"):
                    commands.append(("pipewire", ["pw-play", str(path)]))
                if shutil.which("paplay"):
                    commands.append(("pulseaudio", ["paplay", str(path)]))
                commands.append(("alsa", ["aplay", "-q", str(path)]))
            else:
                commands.append(
                    ("alsa", ["aplay", "-q", "-D", self.output, str(path)])
                )

            errors: list[str] = []
            environment = os.environ.copy()
            environment.setdefault(
                "PIPEWIRE_RUNTIME_DIR",
                environment.get(
                    "XDG_RUNTIME_DIR",
                    f"/run/user/{getattr(os, 'getuid', lambda: 0)()}",
                ),
            )
            for backend, command in commands:
                try:
                    result = subprocess.run(
                        command,
                        env=environment,
                        capture_output=True,
                        text=True,
                        timeout=8,
                        check=False,
                    )
                    if result.returncode == 0:
                        self.last_backend = backend
                        self.last_error = ""
                        self.last_success_at = time.time()
                        return True
                    detail = (result.stderr or result.stdout).strip()
                    errors.append(f"{backend}: {detail or f'exit {result.returncode}'}")
                except Exception as error:
                    errors.append(f"{backend}: {error}")
            self.last_error = "; ".join(errors) or "Audio playback failed"
            return False
        except Exception as error:
            self.last_error = str(error)
            return False
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def _tone(notes: list[tuple[float, float]], volume: int) -> Path:
        rate = 44100
        amplitude = int(32767 * min(max(volume, 0), 100) / 100 * 0.42)
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
        self.running = False
        self.active = False
        self.last_motion_at: float | None = None
        self.error = ""
        self.pin_factory = ""

    def start(self) -> bool:
        if platform.system() != "Linux":
            self.error = "PIR monitoring is only available on Linux"
            return False
        try:
            from gpiozero import DigitalInputDevice

            self.sensor = DigitalInputDevice(
                self.pin,
                pull_up=not self.active_high,
                bounce_time=0.05,
            )
            self.sensor.when_activated = self._activated
            self.sensor.when_deactivated = self._deactivated
            initially_active = bool(self.sensor.is_active)
            self.active = False
            self.pin_factory = self.sensor.pin_factory.__class__.__name__
            self.running = True
            self.error = ""
            if initially_active:
                self._activated()
            return True
        except Exception as error:
            self.error = str(error)
            self.running = False
            return False

    def stop(self) -> None:
        if self.sensor:
            self.sensor.close()
            self.sensor = None
        self.running = False
        self.active = False

    def _activated(self) -> None:
        was_active = self.active
        self.active = True
        if not was_active:
            self.last_motion_at = time.time()
            self.on_motion()

    def _deactivated(self) -> None:
        self.active = False

    def poll(self) -> bool:
        if not self.sensor:
            return False
        try:
            detected = bool(self.sensor.is_active)
            if detected:
                self._activated()
            else:
                self._deactivated()
            return detected
        except Exception as error:
            self.error = str(error)
            return False

    def status(self) -> dict[str, object]:
        return {
            "enabled": True,
            "running": self.running,
            "active": self.poll() if self.running else False,
            "pin": self.pin,
            "active_high": self.active_high,
            "pin_factory": self.pin_factory,
            "last_motion_at": self.last_motion_at,
            "error": self.error,
        }


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
