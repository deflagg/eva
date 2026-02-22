from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .settings import settings

TrackingBusyPolicy = Literal["drop", "latest"]


@dataclass(slots=True)
class TrackingSettings:
    enabled: bool
    persist: bool
    tracker: str
    busy_policy: TrackingBusyPolicy


_tracking_settings: TrackingSettings | None = None


def _as_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False

    return default


def _as_busy_policy(value: Any, *, default: TrackingBusyPolicy) -> TrackingBusyPolicy:
    if value is None:
        return default

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "drop":
            return "drop"
        if lowered == "latest":
            return "latest"

    raise RuntimeError("Vision config error: tracking.busy_policy must be one of {'drop', 'latest'}")


def load_tracking_settings() -> TrackingSettings:
    global _tracking_settings

    if _tracking_settings is not None:
        return _tracking_settings

    enabled = _as_bool(settings.get("tracking.enabled", default=False), default=False)
    persist = _as_bool(settings.get("tracking.persist", default=True), default=True)

    raw_tracker = settings.get("tracking.tracker", default="bytetrack.yaml")
    if not isinstance(raw_tracker, str) or not raw_tracker.strip():
        raise RuntimeError("Vision config error: tracking.tracker must be a non-empty string")

    busy_policy = _as_busy_policy(settings.get("tracking.busy_policy", default="latest"), default="latest")

    _tracking_settings = TrackingSettings(
        enabled=enabled,
        persist=persist,
        tracker=raw_tracker.strip(),
        busy_policy=busy_policy,
    )
    return _tracking_settings


def should_use_latest_pending_slot(config: TrackingSettings) -> bool:
    return config.enabled and config.busy_policy == "latest"
