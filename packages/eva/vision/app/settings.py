from __future__ import annotations

from pathlib import Path

from dynaconf import Dynaconf

BASE_DIR = Path(__file__).resolve().parent.parent

settings = Dynaconf(
    settings_files=[
        str(BASE_DIR / "settings.yaml"),
        str(BASE_DIR / "settings.local.yaml"),
    ],
    merge_enabled=True,
    environments=False,
    load_dotenv=False,
)
