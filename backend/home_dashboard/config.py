from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppConfig:
    data_dir: Path
    static_dir: Path
    host: str = "0.0.0.0"
    port: int = 8765
    debug: bool = False

    @classmethod
    def from_env(cls) -> "AppConfig":
        root = Path(__file__).resolve().parents[2]
        data_dir = Path(os.getenv("HOME_DASHBOARD_DATA", root / "data")).resolve()
        static_dir = Path(
            os.getenv("HOME_DASHBOARD_STATIC", root / "frontend" / "dist")
        ).resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            data_dir=data_dir,
            static_dir=static_dir,
            host=os.getenv("HOME_DASHBOARD_HOST", "0.0.0.0"),
            port=int(os.getenv("HOME_DASHBOARD_PORT", "8765")),
            debug=os.getenv("HOME_DASHBOARD_DEBUG", "0") == "1",
        )


config = AppConfig.from_env()
