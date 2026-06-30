from types import SimpleNamespace

from home_dashboard import hardware
from home_dashboard.hardware import AudioController


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

    assert outputs[0] == {"id": "default", "name": "System default"}
    assert outputs[1]["id"] == "plughw:0,0"
    assert "vc4-hdmi-0" in outputs[1]["name"]
