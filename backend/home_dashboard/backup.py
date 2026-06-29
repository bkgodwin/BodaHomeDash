from __future__ import annotations

import io
import json
import os
import shutil
import struct
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from . import __version__
from .database import Database


MAGIC = b"HDBACKUP1"
SALT_SIZE = 16
NONCE_SIZE = 12


def _derive_key(password: str, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(
        password.encode("utf-8")
    )


class BackupManager:
    def __init__(self, database: Database, data_dir: Path):
        self.database = database
        self.data_dir = data_dir

    def create(self, destination: Path, password: str) -> Path:
        destination.mkdir(parents=True, exist_ok=True)
        self.database.checkpoint()
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        output = destination / f"home-dashboard-{timestamp}.hdbak"

        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.write(self.database.path, "dashboard.db")
            key_path = self.data_dir / "device.key"
            if key_path.exists():
                bundle.write(key_path, "device.key")
            bundle.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format": 1,
                        "app_version": __version__,
                        "created_at": datetime.now(UTC).isoformat(),
                        "includes": ["database", "settings", "encrypted credentials"],
                    },
                    indent=2,
                ),
            )

        salt = os.urandom(SALT_SIZE)
        nonce = os.urandom(NONCE_SIZE)
        ciphertext = AESGCM(_derive_key(password, salt)).encrypt(
            nonce, archive.getvalue(), MAGIC
        )
        temporary = output.with_suffix(".tmp")
        with temporary.open("wb") as file:
            file.write(MAGIC)
            file.write(salt)
            file.write(nonce)
            file.write(ciphertext)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(output)
        return output

    def validate(self, source: Path, password: str) -> dict:
        archive = self._decrypt(source, password)
        with zipfile.ZipFile(io.BytesIO(archive), "r") as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            if "dashboard.db" not in bundle.namelist():
                raise ValueError("Backup does not contain a database")
            return manifest

    def restore(self, source: Path, password: str) -> dict:
        archive = self._decrypt(source, password)
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            with zipfile.ZipFile(io.BytesIO(archive), "r") as bundle:
                names = set(bundle.namelist())
                required = {"dashboard.db", "manifest.json"}
                if not required.issubset(names):
                    raise ValueError("Backup is missing required files")
                (temp / "dashboard.db").write_bytes(bundle.read("dashboard.db"))
                (temp / "manifest.json").write_bytes(bundle.read("manifest.json"))
                if "device.key" in names:
                    (temp / "device.key").write_bytes(bundle.read("device.key"))
                manifest = json.loads((temp / "manifest.json").read_text())
            replacement = temp / "dashboard.db"
            test = Database(replacement)
            integrity = test.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise ValueError("Backup database failed its integrity check")
            test.close_thread()
            self.database.checkpoint()
            self.database.close_thread()
            Path(f"{self.database.path}-wal").unlink(missing_ok=True)
            Path(f"{self.database.path}-shm").unlink(missing_ok=True)
            safety = self.database.path.with_suffix(".pre-restore.db")
            if self.database.path.exists():
                shutil.copy2(self.database.path, safety)
            shutil.copy2(replacement, self.database.path)
            if (temp / "device.key").exists():
                shutil.copy2(temp / "device.key", self.data_dir / "device.key")
            return manifest

    def prune(self, destination: Path, retention: int) -> None:
        backups = sorted(
            destination.glob("home-dashboard-*.hdbak"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for old in backups[retention:]:
            old.unlink(missing_ok=True)

    @staticmethod
    def _decrypt(source: Path, password: str) -> bytes:
        payload = source.read_bytes()
        minimum = len(MAGIC) + SALT_SIZE + NONCE_SIZE + 16
        if len(payload) < minimum or not payload.startswith(MAGIC):
            raise ValueError("Not a Home Dashboard backup")
        offset = len(MAGIC)
        salt = payload[offset : offset + SALT_SIZE]
        offset += SALT_SIZE
        nonce = payload[offset : offset + NONCE_SIZE]
        ciphertext = payload[offset + NONCE_SIZE :]
        try:
            return AESGCM(_derive_key(password, salt)).decrypt(
                nonce, ciphertext, MAGIC
            )
        except Exception as error:
            raise ValueError("Incorrect backup password or damaged backup") from error
