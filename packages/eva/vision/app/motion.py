from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .protocol import EventEntry
from .settings import settings

TRACK_STATE_TTL_MS = 30_000


@dataclass(slots=True)
class MotionSettings:
    enabled: bool
    history_frames: int
    sudden_motion_speed_px_s: float
    stop_speed_px_s: float
    stop_duration_ms: int
    event_cooldown_ms: int


@dataclass(slots=True)
class MotionSample:
    ts_ms: int
    x: float
    y: float


@dataclass(slots=True)
class MotionTrackState:
    history: deque[MotionSample]
    stop_start_ts_ms: int | None = None
    stop_emitted: bool = False
    last_event_ts_ms: dict[str, int] = field(default_factory=dict)
    last_seen_ts_ms: int = 0


_motion_settings: MotionSettings | None = None


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


def _as_positive_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a positive integer")

    if isinstance(value, int):
        if value <= 0:
            raise RuntimeError(f"Vision config error: {key} must be a positive integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        if parsed <= 0:
            raise RuntimeError(f"Vision config error: {key} must be a positive integer")
        return parsed

    raise RuntimeError(f"Vision config error: {key} must be a positive integer")


def _as_non_negative_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")

    if isinstance(value, int):
        if value < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())

    raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")


def _as_non_negative_float(value: Any, *, key: str, default: float) -> float:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a non-negative number")

    if isinstance(value, (int, float)):
        if float(value) < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")
        return float(value)

    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError as exc:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number") from exc

        if parsed < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")

        return parsed

    raise RuntimeError(f"Vision config error: {key} must be a non-negative number")


def load_motion_settings() -> MotionSettings:
    global _motion_settings

    if _motion_settings is not None:
        return _motion_settings

    enabled = _as_bool(settings.get("motion.enabled", default=True), default=True)
    history_frames = _as_positive_int(settings.get("motion.history_frames", default=8), key="motion.history_frames", default=8)
    if history_frames < 2:
        raise RuntimeError("Vision config error: motion.history_frames must be >= 2")

    sudden_motion_speed_px_s = _as_non_negative_float(
        settings.get("motion.sudden_motion_speed_px_s", default=250.0),
        key="motion.sudden_motion_speed_px_s",
        default=250.0,
    )
    stop_speed_px_s = _as_non_negative_float(
        settings.get("motion.stop_speed_px_s", default=20.0),
        key="motion.stop_speed_px_s",
        default=20.0,
    )
    stop_duration_ms = _as_non_negative_int(
        settings.get("motion.stop_duration_ms", default=1500),
        key="motion.stop_duration_ms",
        default=1500,
    )
    event_cooldown_ms = _as_non_negative_int(
        settings.get("motion.event_cooldown_ms", default=1500),
        key="motion.event_cooldown_ms",
        default=1500,
    )

    _motion_settings = MotionSettings(
        enabled=enabled,
        history_frames=history_frames,
        sudden_motion_speed_px_s=sudden_motion_speed_px_s,
        stop_speed_px_s=stop_speed_px_s,
        stop_duration_ms=stop_duration_ms,
        event_cooldown_ms=event_cooldown_ms,
    )
    return _motion_settings


def _speed_px_s(a: MotionSample, b: MotionSample) -> float | None:
    dt_ms = b.ts_ms - a.ts_ms
    if dt_ms <= 0:
        return None

    distance_px = math.hypot(b.x - a.x, b.y - a.y)
    return distance_px / (dt_ms / 1000.0)


def _latest_speed_px_s(history: deque[MotionSample]) -> float | None:
    if len(history) < 2:
        return None

    return _speed_px_s(history[-2], history[-1])


def _previous_speed_px_s(history: deque[MotionSample]) -> float | None:
    if len(history) < 3:
        return None

    return _speed_px_s(history[-3], history[-2])


class MotionEventEngine:
    def __init__(self, motion_settings: MotionSettings):
        self._settings = motion_settings
        self._tracks: dict[int, MotionTrackState] = {}

    def process_sample(self, *, track_id: int, ts_ms: int, point: tuple[float, float]) -> list[EventEntry]:
        if not self._settings.enabled:
            return []

        state = self._tracks.get(track_id)
        if state is None:
            state = MotionTrackState(history=deque(maxlen=self._settings.history_frames), last_seen_ts_ms=ts_ms)
            self._tracks[track_id] = state

        state.last_seen_ts_ms = ts_ms
        state.history.append(MotionSample(ts_ms=ts_ms, x=point[0], y=point[1]))

        speed_now = _latest_speed_px_s(state.history)
        speed_prev = _previous_speed_px_s(state.history)

        if speed_now is None:
            return []

        events: list[EventEntry] = []

        speed_delta = abs(speed_now - speed_prev) if speed_prev is not None else 0.0
        speed_threshold = self._settings.sudden_motion_speed_px_s
        if (speed_now >= speed_threshold or speed_delta >= speed_threshold) and self._can_emit(
            state=state,
            event_name="sudden_motion",
            ts_ms=ts_ms,
        ):
            events.append(
                EventEntry(
                    name="sudden_motion",
                    ts_ms=ts_ms,
                    severity="medium",
                    track_id=track_id,
                    data={"speed_px_s": speed_now},
                )
            )
            self._mark_emitted(state=state, event_name="sudden_motion", ts_ms=ts_ms)

        if speed_now <= self._settings.stop_speed_px_s:
            if state.stop_start_ts_ms is None:
                state.stop_start_ts_ms = ts_ms

            stopped_ms = max(ts_ms - state.stop_start_ts_ms, 0)
            if (
                not state.stop_emitted
                and stopped_ms >= self._settings.stop_duration_ms
                and self._can_emit(state=state, event_name="track_stop", ts_ms=ts_ms)
            ):
                events.append(
                    EventEntry(
                        name="track_stop",
                        ts_ms=ts_ms,
                        severity="low",
                        track_id=track_id,
                        data={"stopped_ms": stopped_ms},
                    )
                )
                state.stop_emitted = True
                self._mark_emitted(state=state, event_name="track_stop", ts_ms=ts_ms)
        else:
            state.stop_start_ts_ms = None
            state.stop_emitted = False

        return events

    def evict_stale(self, *, now_ts_ms: int) -> None:
        stale_track_ids = [
            track_id
            for track_id, state in self._tracks.items()
            if now_ts_ms - state.last_seen_ts_ms > TRACK_STATE_TTL_MS
        ]

        for track_id in stale_track_ids:
            del self._tracks[track_id]

    def _can_emit(self, *, state: MotionTrackState, event_name: str, ts_ms: int) -> bool:
        cooldown_ms = self._settings.event_cooldown_ms
        if cooldown_ms <= 0:
            return True

        last_ts_ms = state.last_event_ts_ms.get(event_name)
        if last_ts_ms is None:
            return True

        return (ts_ms - last_ts_ms) >= cooldown_ms

    def _mark_emitted(self, *, state: MotionTrackState, event_name: str, ts_ms: int) -> None:
        state.last_event_ts_ms[event_name] = ts_ms
