from __future__ import annotations

import uvicorn

from .config import load_app_config


def main() -> None:
    config = load_app_config()
    uvicorn.run("app.main:app", host=config.server.host, port=config.server.port)


if __name__ == "__main__":
    main()
