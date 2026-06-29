from home_dashboard.services import is_emergency_alert


def test_emergency_alert_classification():
    assert is_emergency_alert({"severity": "Extreme", "event": "Tornado Warning"})
    assert is_emergency_alert(
        {"severity": "Severe", "event": "Flash Flood Emergency"}
    )
    assert not is_emergency_alert(
        {"severity": "Moderate", "event": "Dense Fog Advisory"}
    )
