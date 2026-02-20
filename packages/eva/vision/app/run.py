from __future__ import annotations

import uvicorn

from .settings import settings


def _read_server_host() -> str:
    host = settings.get("server.host", default="127.0.0.1")
    if not isinstance(host, str) or not host.strip():
        raise RuntimeError("QuickVision config error: server.host must be a non-empty string")

    return host.strip()


def _read_server_port() -> int:
    raw_port = settings.get("server.port", default=8000)

    if isinstance(raw_port, bool):
        raise RuntimeError("QuickVision config error: server.port must be an integer in range 1..65535")

    if isinstance(raw_port, int):
        port = raw_port
    elif isinstance(raw_port, str) and raw_port.strip().isdigit():
        port = int(raw_port.strip())
    else:
        raise RuntimeError("QuickVision config error: server.port must be an integer in range 1..65535")

    if port < 1 or port > 65_535:
        raise RuntimeError("QuickVision config error: server.port must be an integer in range 1..65535")

    return port


def main() -> None:
    host = _read_server_host()
    port = _read_server_port()
    uvicorn.run("app.main:app", host=host, port=port)


if __name__ == "__main__":
    main()
