from pathlib import Path

from home_dashboard.database import Database


def test_defaults_and_atomic_settings(tmp_path: Path):
    database = Database(tmp_path / "test.db")
    assert database.setting("motion_gpio_bcm") == 17
    database.set_settings({"household_name": "Test Home", "motion_timeout_seconds": 90})
    assert database.setting("household_name") == "Test Home"
    assert database.setting("motion_timeout_seconds") == 90


def test_transaction_rolls_back(tmp_path: Path):
    database = Database(tmp_path / "test.db")
    try:
        with database.transaction() as connection:
            connection.execute(
                "INSERT INTO reminders(text,created_at,updated_at) VALUES('Nope','x','x')"
            )
            raise RuntimeError("rollback")
    except RuntimeError:
        pass
    assert database.all("SELECT * FROM reminders") == []
