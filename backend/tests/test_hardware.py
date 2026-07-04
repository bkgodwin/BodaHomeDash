import sys
from types import SimpleNamespace

from home_dashboard import hardware
from home_dashboard.hardware import AudioController, DisplayController, PIRMonitor


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
            self.pin = SimpleNamespace(state=0)
            self.pin_factory = FakeFactory()
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
    FakeInput.instance.pin.state = 1
    assert monitor.poll() is True
    assert motions == ["motion"]
    status = monitor.status()
    assert status["pin_factory"] == "FakeFactory polling"
    assert status["raw_value"] == 1
    FakeInput.instance.pin.state = 0
    assert monitor.poll() is False


def test_pir_monitor_prefers_direct_lgpio_polling(monkeypatch):
    fake = SimpleNamespace(
        SET_PULL_NONE=0,
        value=0,
        gpiochip_open=lambda chip: 41,
        gpio_claim_input=lambda handle, pin, flags: 0,
        gpio_read=lambda handle, pin: fake.value,
        gpio_free=lambda handle, pin: 0,
        gpiochip_close=lambda handle: 0,
    )
    motions = []
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setitem(sys.modules, "lgpio", fake)
    monitor = PIRMonitor(17, True, lambda: motions.append("motion"))

    assert monitor.start() is True
    assert monitor.status()["pin_factory"] == "lgpio direct polling"
    fake.value = 1
    assert monitor.poll() is True
    assert motions == ["motion"]
    assert monitor.status()["raw_value"] == 1
    assert monitor.status()["transition_count"] == 1
    monitor.stop()


def test_display_controller_uses_wlopm_for_configured_output(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hardware.shutil,
        "which",
        lambda name: "/usr/bin/wlopm" if name == "wlopm" else None,
    )
    monkeypatch.setattr(hardware.subprocess, "run", run)
    display = DisplayController("HDMI-A-1")

    assert display.off() is True
    assert display.output == "HDMI-A-1"
    assert display.last_backend == "wlopm"
    assert calls[0] == ["/usr/bin/wlopm", "--off", "HDMI-A-1"]


def test_pipewire_system_volume_control(monkeypatch):
    def run(command, **kwargs):
        if "get-volume" in command:
            return SimpleNamespace(
                returncode=0, stdout="Volume: 0.42\n", stderr=""
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hardware.shutil,
        "which",
        lambda name: "/usr/bin/wpctl" if name == "wpctl" else None,
    )
    monkeypatch.setattr(hardware.subprocess, "run", run)

    assert AudioController.system_volume()["volume"] == 42
    assert AudioController.set_system_volume(67) == {
        "available": True,
        "volume": 67,
        "backend": "pipewire",
        "muted": False,
    }
