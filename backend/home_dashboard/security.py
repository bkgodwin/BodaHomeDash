from __future__ import annotations

import hashlib
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet

from .database import Database, utcnow


PIN_KEY = "remote_pin_hash"
_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)


class SecretStore:
    def __init__(self, database: Database, data_dir: Path):
        self.database = database
        self.key_path = data_dir / "device.key"
        self._fernet = Fernet(self._load_key())

    def _load_key(self) -> bytes:
        if not self.key_path.exists():
            key = Fernet.generate_key()
            self.key_path.write_bytes(key)
            try:
                os.chmod(self.key_path, 0o600)
            except OSError:
                pass
            return key
        return self.key_path.read_bytes().strip()

    def set(self, key: str, value: str) -> None:
        encrypted = self._fernet.encrypt(value.encode("utf-8"))
        self.database.execute(
            """INSERT INTO encrypted_secrets(key, value_encrypted, updated_at)
               VALUES(?,?,?)
               ON CONFLICT(key) DO UPDATE SET
               value_encrypted=excluded.value_encrypted,
               updated_at=excluded.updated_at""",
            (key, encrypted, utcnow()),
        )

    def get(self, key: str, default: str | None = None) -> str | None:
        row = self.database.one(
            "SELECT value_encrypted FROM encrypted_secrets WHERE key=?", (key,)
        )
        if not row:
            return default
        try:
            return self._fernet.decrypt(row["value_encrypted"]).decode("utf-8")
        except Exception:
            return default

    def delete(self, key: str) -> None:
        self.database.execute("DELETE FROM encrypted_secrets WHERE key=?", (key,))


class AuthManager:
    def __init__(self, database: Database, secrets_store: SecretStore):
        self.database = database
        self.secrets = secrets_store
        self.failures: dict[str, list[datetime]] = {}

    def has_pin(self) -> bool:
        return self.secrets.get(PIN_KEY) is not None

    def set_pin(self, pin: str) -> None:
        self.secrets.set(PIN_KEY, _hasher.hash(pin))
        self.revoke_all()

    def verify_pin(self, pin: str, client: str) -> bool:
        now = datetime.now(UTC)
        recent = [
            item
            for item in self.failures.get(client, [])
            if item > now - timedelta(minutes=15)
        ]
        self.failures[client] = recent
        if len(recent) >= 8:
            return False
        encoded = self.secrets.get(PIN_KEY)
        if not encoded:
            return False
        try:
            valid = _hasher.verify(encoded, pin)
        except VerifyMismatchError:
            valid = False
        except Exception:
            valid = False
        if not valid:
            recent.append(now)
        else:
            self.failures.pop(client, None)
        return valid

    def create_session(self, days: int = 30) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = datetime.now(UTC)
        self.database.execute(
            """INSERT INTO sessions(token_hash, created_at, expires_at, last_used_at)
               VALUES(?,?,?,?)""",
            (
                token_hash,
                now.isoformat(),
                (now + timedelta(days=days)).isoformat(),
                now.isoformat(),
            ),
        )
        return token

    def verify_session(self, token: str | None) -> bool:
        if not token:
            return False
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        row = self.database.one(
            "SELECT expires_at FROM sessions WHERE token_hash=?", (token_hash,)
        )
        if not row:
            return False
        if datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
            self.database.execute(
                "DELETE FROM sessions WHERE token_hash=?", (token_hash,)
            )
            return False
        self.database.execute(
            "UPDATE sessions SET last_used_at=? WHERE token_hash=?",
            (utcnow(), token_hash),
        )
        return True

    def revoke(self, token: str | None) -> None:
        if token:
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            self.database.execute(
                "DELETE FROM sessions WHERE token_hash=?", (token_hash,)
            )

    def revoke_all(self) -> None:
        self.database.execute("DELETE FROM sessions")
