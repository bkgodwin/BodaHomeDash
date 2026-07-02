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
    def __init__(self, output: str = "*"):
        self.output = os.environ.get("HOME_DASHBOARD_DISPLAY_OUTPUT") or output or "*"
        self.last_backend = ""
        self.last_error = ""
        self.last_command = ""
        self.last_environment = ""
        self.powered = True
        self.last_change_at = 0.0
        self._lock = threading.Lock()

    def off(self) -> bool:
        return self._run(False)

    def on(self) -> bool:
        return self._run(True)

    def status(self) -> dict[str, object]:
        return {
            "output": self.output,
            "backend": self.last_backend,
            "last_error": self.last_error,
            "last_command": self.last_command,
            "last_environment": self.last_environment,
            "powered": self.powered,
            "last_change_at": self.last_change_at,
        }

    def _find_executable(self, name: str) -> str | None:
        found = shutil.which(name)
        if found:
            return found

        for candidate in (
            f"/usr/bin/{name}",
            f"/usr/local/bin/{name}",
            f"/bin/{name}",
        ):
            if Path(candidate).exists():
                return candidate

        return None

    def _display_environment(self) -> dict[str, str]:
        environment = os.environ.copy()

        runtime_dir = environment.get("XDG_RUNTIME_DIR")
        if not runtime_dir:
            try:
                runtime_dir = f"/run/user/{os.getuid()}"
            except Exception:
                runtime_dir = "/run/user/1000"

        wayland_display = environment.get("WAYLAND_DISPLAY") or "wayland-0"

        environment["XDG_RUNTIME_DIR"] = runtime_dir
        environment["WAYLAND_DISPLAY"] = wayland_display
        environment.setdefault(
            "DBUS_SESSION_BUS_ADDRESS",
            f"unix:path={runtime_dir}/bus",
        )

        return environment

    def _run_command(self, backend: str, command: list[str]) -> bool:
        environment = self._display_environment()

        self.last_command = " ".join(command)
        self.last_environment = (
            f"XDG_RUNTIME_DIR={environment.get('XDG_RUNTIME_DIR')}; "
            f"WAYLAND_DISPLAY={environment.get('WAYLAND_DISPLAY')}; "
            f"DBUS_SESSION_BUS_ADDRESS={environment.get('DBUS_SESSION_BUS_ADDRESS')}"
        )

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
                self.last_backend = backend
                self.last_error = ""
                return True

            detail = (result.stderr or result.stdout).strip()
            self.last_error = (
                f"{backend} failed with exit {result.returncode}: "
                f"{detail or 'no output'}; "
                f"{self.last_environment}; "
                f"command={self.last_command}"
            )
            return False

        except Exception as error:
            self.last_error = (
                f"{backend} exception: {error}; "
                f"{self.last_environment}; "
                f"command={self.last_command}"
            )
            return False

    def _run(self, turn_on: bool) -> bool:
        if platform.system() != "Linux":
            self.powered = turn_on
            self.last_change_at = time.time()
            return True

        with self._lock:
            # Avoid repeated identical calls too close together.
            now = time.time()
            if self.powered == turn_on and now - self.last_change_at < 1.0:
                return True

            action = "--on" if turn_on else "--off"
            errors: list[str] = []

            wlopm = self._find_executable("wlopm")
            if wlopm:
                if self._run_command("wlopm", [wlopm, action, self.output]):
                    self.powered = turn_on
                    self.last_change_at = time.time()
                    return True

                errors.append(self.last_error)

                if self.output != "*":
                    if self._run_command("wlopm-all", [wlopm, action, "*"]):
                        self.output = "*"
                        self.powered = turn_on
                        self.last_change_at = time.time()
                        return True

                    errors.append(self.last_error)
            else:
                errors.append("wlopm was not found")

            wlr_randr = self._find_executable("wlr-randr")
            if wlr_randr and self.output != "*":
                if self._run_command(
                    "wlr-randr",
                    [wlr_randr, "--output", self.output, action],
                ):
                    self.powered = turn_on
                    self.last_change_at = time.time()
                    return True

                errors.append(self.last_error)

            vcgencmd = self._find_executable("vcgencmd")
            if vcgencmd:
                try:
                    result = subprocess.run(
                        [vcgencmd, "display_power", "1" if turn_on else "0"],
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
                        self.last_command = " ".join([vcgencmd, "display_power"])
                        self.last_environment = "vcgencmd fallback"
                        self.powered = turn_on
                        self.last_change_at = time.time()
                        return True

                    errors.append(
                        f"vcgencmd failed: "
                        f"{(result.stderr or result.stdout).strip() or result.returncode}"
                    )
                except Exception as error:
                    errors.append(f"vcgencmd exception: {error}")

            self.last_error = "; ".join(item for item in errors if item)
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

            self.active = bool(self.sensor.is_active)
            self.pin_factory = self.sensor.pin_factory.__class__.__name__
            self.running = True
            self.error = ""

            # Important:
            # Do NOT call on_motion() just because the PIR is already active at boot.
            # Otherwise the app can start in a permanently awake state.
            if self.active:
                self.last_motion_at = time.time()

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
        self.active = True
        self.last_motion_at = time.time()
        self.on_motion()

    def _deactivated(self) -> None:
        self.active = False

    def read_active(self) -> bool:
        """
        Read the sensor state without firing on_motion().

        This is safe to call from status endpoints, polling loops, or UI refreshes.
        """
        if not self.sensor:
            return False

        try:
            detected = bool(self.sensor.is_active)
            self.active = detected
            return detected
        except Exception as error:
            self.error = str(error)
            return False

    def poll(self) -> bool:
        """
        Backward-compatible poll method.

        Important: this no longer calls on_motion(). It only reads state.
        Motion callbacks should come from gpiozero's when_activated event.
        """
        return self.read_active()

    def status(self) -> dict[str, object]:
        return {
            "enabled": True,
            "running": self.running,
            "active": self.read_active() if self.running else False,
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
