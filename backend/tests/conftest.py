from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


TEST_DATA = Path(tempfile.mkdtemp(prefix="home-dashboard-tests-"))
PROJECT = Path(__file__).resolve().parents[2]
os.environ["HOME_DASHBOARD_DATA"] = str(TEST_DATA)
os.environ["HOME_DASHBOARD_STATIC"] = str(PROJECT / "frontend" / "dist")

from home_dashboard.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client
