import sys
from types import SimpleNamespace

from home_dashboard import hardware
from home_dashboard.hardware import AudioController, PIRMonitor


def test_audio_outputs_include_alsa_devices(monkeypatch):
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hardware.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=(
                "card 0: vc4hdmi0 [vc4-hdmi-0], "
                "device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]\n"
            )
        ),
    )

    outputs = AudioController.outputs()

    assert outputs[0] == {
        "id": "default",
        "name": "Desktop default (recommended)",
    }
    assert outputs[1]["id"] == "plughw:0,0"
    assert "vc4-hdmi-0" in outputs[1]["name"]


def test_audio_probe_prefers_pipewire(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hardware.shutil,
        "which",
        lambda command: f"/usr/bin/{command}" if command == "pw-play" else None,
    )
    monkeypatch.setattr(hardware.subprocess, "run", run)

    result = AudioController().probe("alert", 40)

    assert result["success"] is True
    assert result["backend"] == "pipewire"
    assert calls[0][0] == "pw-play"


def test_audio_probe_reports_player_error(monkeypatch):
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hardware.shutil, "which", lambda command: None)
    monkeypatch.setattr(
        hardware.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="audio device busy",
        ),
    )

    result = AudioController().probe("timer", 40)

    assert result["success"] is False
    assert "audio device busy" in result["last_error"]


def test_pir_monitor_reports_live_edges(monkeypatch):
    class FakeFactory:
        pass

    class FakeInput:
        instance = None

        def __init__(self, pin, **kwargs):
            self.pin = pin
            self.is_active = False
            self.pin_factory = FakeFactory()
            self.when_activated = None
            self.when_deactivated = None
            FakeInput.instance = self

        def close(self):
            pass

    motions = []
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setitem(
        sys.modules,
        "gpiozero",
        SimpleNamespace(DigitalInputDevice=FakeInput),
    )
    monitor = PIRMonitor(17, True, lambda: motions.append("motion"))

    assert monitor.start() is True
    FakeInput.instance.is_active = True
    assert monitor.poll() is True
    assert motions == ["motion"]
    assert monitor.status()["pin_factory"] == "FakeFactory"
    FakeInput.instance.is_active = False
    assert monitor.poll() is False
