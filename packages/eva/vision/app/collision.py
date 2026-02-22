from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .protocol import EventEntry
from .settings import settings

PAIR_STATE_TTL_MS = 30_000


@dataclass(slots=True)
class CollisionSettings:
    enabled: bool
    pairs: set[tuple[str, str]]
    distance_px: float
    closing_speed_px_s: float
    pair_cooldown_ms: int


@dataclass(slots=True)
class CollisionSample:
    track_id: int
    class_name: str
    point: tuple[float, float]


@dataclass(slots=True)
class PairState:
    last_distance_px: float | None = None
    last_ts_ms: int | None = None
    last_event_ts_ms: int | None = None
    last_seen_ts_ms: int = 0


_collision_settings: CollisionSettings | None = None


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


def _normalize_class_name(value: Any, *, key: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Vision config error: {key} must be a non-empty string")

    return value.strip().lower()


def _canonical_class_pair(a_class: str, b_class: str) -> tuple[str, str]:
    if a_class <= b_class:
        return (a_class, b_class)

    return (b_class, a_class)


def _parse_class_pairs(value: Any) -> set[tuple[str, str]]:
    if value is None:
        raw_pairs: Sequence[Any] = [["person", "person"]]
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        raw_pairs = value
    else:
        raise RuntimeError("Vision config error: collision.pairs must be a list of [classA, classB]")

    pairs: set[tuple[str, str]] = set()

    for index, raw_pair in enumerate(raw_pairs):
        key = f"collision.pairs[{index}]"

        if not isinstance(raw_pair, Sequence) or isinstance(raw_pair, (str, bytes, bytearray)):
            raise RuntimeError(f"Vision config error: {key} must be [classA, classB]")

        if len(raw_pair) != 2:
            raise RuntimeError(f"Vision config error: {key} must contain exactly two class names")

        a_class = _normalize_class_name(raw_pair[0], key=f"{key}[0]")
        b_class = _normalize_class_name(raw_pair[1], key=f"{key}[1]")
        pairs.add(_canonical_class_pair(a_class, b_class))

    return pairs


def load_collision_settings() -> CollisionSettings:
    global _collision_settings

    if _collision_settings is not None:
        return _collision_settings

    enabled = _as_bool(settings.get("collision.enabled", default=True), default=True)
    pairs = _parse_class_pairs(settings.get("collision.pairs", default=[["person", "person"]]))
    distance_px = _as_non_negative_float(
        settings.get("collision.distance_px", default=90.0),
        key="collision.distance_px",
        default=90.0,
    )
    closing_speed_px_s = _as_non_negative_float(
        settings.get("collision.closing_speed_px_s", default=120.0),
        key="collision.closing_speed_px_s",
        default=120.0,
    )
    pair_cooldown_ms = _as_non_negative_int(
        settings.get("collision.pair_cooldown_ms", default=1500),
        key="collision.pair_cooldown_ms",
        default=1500,
    )

    _collision_settings = CollisionSettings(
        enabled=enabled,
        pairs=pairs,
        distance_px=distance_px,
        closing_speed_px_s=closing_speed_px_s,
        pair_cooldown_ms=pair_cooldown_ms,
    )
    return _collision_settings


def _pair_key(a_track_id: int, b_track_id: int) -> tuple[int, int]:
    if a_track_id <= b_track_id:
        return (a_track_id, b_track_id)

    return (b_track_id, a_track_id)


def _distance_px(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


class CollisionEventEngine:
    def __init__(self, collision_settings: CollisionSettings):
        self._settings = collision_settings
        self._pair_state: dict[tuple[int, int], PairState] = {}

    def process_samples(self, *, ts_ms: int, samples: list[CollisionSample]) -> list[EventEntry]:
        if not self._settings.enabled:
            return []

        events: list[EventEntry] = []

        for index in range(len(samples)):
            for next_index in range(index + 1, len(samples)):
                first_sample = samples[index]
                second_sample = samples[next_index]

                if first_sample.track_id == second_sample.track_id:
                    continue

                if not self._is_eligible_pair(first_sample.class_name, second_sample.class_name):
                    continue

                sample_a, sample_b = self._ordered_samples(first_sample, second_sample)
                pair_key = _pair_key(sample_a.track_id, sample_b.track_id)
                state = self._pair_state.get(pair_key)
                if state is None:
                    state = PairState(last_seen_ts_ms=ts_ms)
                    self._pair_state[pair_key] = state

                state.last_seen_ts_ms = ts_ms

                distance_px = _distance_px(sample_a.point, sample_b.point)

                closing_speed_px_s = 0.0
                if state.last_distance_px is not None and state.last_ts_ms is not None:
                    dt_ms = ts_ms - state.last_ts_ms
                    if dt_ms > 0:
                        closing_speed_px_s = (state.last_distance_px - distance_px) / (dt_ms / 1000.0)

                if (
                    distance_px <= self._settings.distance_px
                    and closing_speed_px_s >= self._settings.closing_speed_px_s
                    and self._can_emit(state=state, ts_ms=ts_ms)
                ):
                    events.append(
                        EventEntry(
                            name="near_collision",
                            ts_ms=ts_ms,
                            severity="high",
                            data={
                                "a_track_id": sample_a.track_id,
                                "b_track_id": sample_b.track_id,
                                "a_class": sample_a.class_name,
                                "b_class": sample_b.class_name,
                                "distance_px": distance_px,
                                "closing_speed_px_s": closing_speed_px_s,
                            },
                        )
                    )
                    state.last_event_ts_ms = ts_ms

                state.last_distance_px = distance_px
                state.last_ts_ms = ts_ms

        return events

    def evict_stale(self, *, now_ts_ms: int) -> None:
        stale_pair_keys = [
            pair_key
            for pair_key, state in self._pair_state.items()
            if now_ts_ms - state.last_seen_ts_ms > PAIR_STATE_TTL_MS
        ]

        for pair_key in stale_pair_keys:
            del self._pair_state[pair_key]

    def _is_eligible_pair(self, a_class: str, b_class: str) -> bool:
        normalized_a_class = a_class.strip().lower()
        normalized_b_class = b_class.strip().lower()
        class_pair = _canonical_class_pair(normalized_a_class, normalized_b_class)
        return class_pair in self._settings.pairs

    def _ordered_samples(
        self,
        sample_a: CollisionSample,
        sample_b: CollisionSample,
    ) -> tuple[CollisionSample, CollisionSample]:
        if sample_a.track_id <= sample_b.track_id:
            return (sample_a, sample_b)

        return (sample_b, sample_a)

    def _can_emit(self, *, state: PairState, ts_ms: int) -> bool:
        cooldown_ms = self._settings.pair_cooldown_ms
        if cooldown_ms <= 0:
            return True

        if state.last_event_ts_ms is None:
            return True

        return (ts_ms - state.last_event_ts_ms) >= cooldown_ms
