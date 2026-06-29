from pathlib import Path

import pytest

from home_dashboard.backup import BackupManager
from home_dashboard.database import Database
from home_dashboard.security import AuthManager, SecretStore


def test_pin_and_session(tmp_path: Path):
    database = Database(tmp_path / "dashboard.db")
    secrets = SecretStore(database, tmp_path)
    auth = AuthManager(database, secrets)
    auth.set_pin("246810")
    assert auth.verify_pin("246810", "phone")
    assert not auth.verify_pin("000000", "phone")
    token = auth.create_session()
    assert auth.verify_session(token)
    auth.revoke(token)
    assert not auth.verify_session(token)


def test_portable_encrypted_backup(tmp_path: Path):
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    database = Database(source_dir / "dashboard.db")
    secrets = SecretStore(database, source_dir)
    database.set_setting("household_name", "Bayou Home")
    secrets.set("calendar_password_1", "private-password")
    manager = BackupManager(database, source_dir)
    destination = tmp_path / "usb"
    output = manager.create(destination, "a strong recovery password")
    assert output.exists()
    manifest = manager.validate(output, "a strong recovery password")
    assert manifest["format"] == 1
    with pytest.raises(ValueError):
        manager.validate(output, "wrong password")

    restored_dir = tmp_path / "restored"
    restored_dir.mkdir()
    restored_database = Database(restored_dir / "dashboard.db")
    restored_manager = BackupManager(restored_database, restored_dir)
    restored_manager.restore(output, "a strong recovery password")
    assert restored_database.setting("household_name") == "Bayou Home"
    restored_secrets = SecretStore(restored_database, restored_dir)
    assert restored_secrets.get("calendar_password_1") == "private-password"
