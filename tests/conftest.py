import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(ROOT))

# Keep tests deterministic: re-read main.html on each request.
os.environ.setdefault("SVG_RECOLOR_DEV", "1")


def fixture_svg(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def python_svg() -> str:
    return fixture_svg("python.svg")


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    from server.ratelimit import limiter

    limiter.reset()
    yield
