from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .protocol import EventEntry
from .roi import RoiSettings, load_roi_settings, point_in_region
from .settings import settings

TRACK_STATE_TTL_MS = 30_000
PERSON_CLASS_NAME = "person"


@dataclass(slots=True)
class AbandonedSettings:
    enabled: bool
    object_classes: set[str]
    associate_max_distance_px: float
    associate_min_ms: int
    abandon_delay_ms: int
    stationary_max_move_px: float | None
    roi: str | None
    event_cooldown_ms: int


@dataclass(slots=True)
class AbandonedSample:
    track_id: int
    class_name: str
    point: tuple[float, float]


@dataclass(slots=True)
class ObjectTrackState:
    class_name: str
    last_seen_ts_ms: int = 0
    last_point: tuple[float, float] | None = None
    association_candidate_person_id: int | None = None
    association_candidate_since_ms: int | None = None
    associated_person_id: int | None = None
    associated_since_ms: int | None = None
    abandon_started_ts_ms: int | None = None
    abandon_person_id: int | None = None
    abandon_reference_point: tuple[float, float] | None = None
    abandoned_emitted: bool = False
    last_event_ts_ms: int | None = None


_abandoned_settings: AbandonedSettings | None = None


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
        parsed = float(value)
        if parsed < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")
        return parsed

    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError as exc:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number") from exc

        if parsed < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")

        return parsed

    raise RuntimeError(f"Vision config error: {key} must be a non-negative number")


def _as_optional_non_negative_float(value: Any, *, key: str) -> float | None:
    if value is None:
        return None

    return _as_non_negative_float(value, key=key, default=0.0)


def _normalize_class_name(value: Any, *, key: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Vision config error: {key} must be a non-empty string")

    return value.strip().lower()


def _as_object_classes(value: Any) -> set[str]:
    if value is None:
        raw_classes: Sequence[Any] = ["backpack", "suitcase", "handbag"]
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        raw_classes = value
    else:
        raise RuntimeError("Vision config error: abandoned.object_classes must be a list of class names")

    object_classes: set[str] = set()

    for index, raw_class_name in enumerate(raw_classes):
        class_name = _normalize_class_name(raw_class_name, key=f"abandoned.object_classes[{index}]")
        object_classes.add(class_name)

    if not object_classes:
        raise RuntimeError("Vision config error: abandoned.object_classes must contain at least one class")

    if PERSON_CLASS_NAME in object_classes:
        raise RuntimeError("Vision config error: abandoned.object_classes must not include 'person'")

    return object_classes


def _as_optional_roi_name(value: Any) -> str | None:
    if value is None:
        return None

    roi_name = _normalize_class_name(value, key="abandoned.roi")
    roi_settings = load_roi_settings()

    if roi_name not in roi_settings.regions:
        raise RuntimeError(f"Vision config error: abandoned.roi references unknown region '{roi_name}'")

    return roi_name


def load_abandoned_settings() -> AbandonedSettings:
    global _abandoned_settings

    if _abandoned_settings is not None:
        return _abandoned_settings

    enabled = _as_bool(settings.get("abandoned.enabled", default=True), default=True)
    object_classes = _as_object_classes(settings.get("abandoned.object_classes", default=["backpack", "suitcase", "handbag"]))
    associate_max_distance_px = _as_non_negative_float(
        settings.get("abandoned.associate_max_distance_px", default=120.0),
        key="abandoned.associate_max_distance_px",
        default=120.0,
    )
    associate_min_ms = _as_non_negative_int(
        settings.get("abandoned.associate_min_ms", default=1000),
        key="abandoned.associate_min_ms",
        default=1000,
    )
    abandon_delay_ms = _as_non_negative_int(
        settings.get("abandoned.abandon_delay_ms", default=5000),
        key="abandoned.abandon_delay_ms",
        default=5000,
    )
    stationary_max_move_px = _as_optional_non_negative_float(
        settings.get("abandoned.stationary_max_move_px", default=None),
        key="abandoned.stationary_max_move_px",
    )
    roi_name = _as_optional_roi_name(settings.get("abandoned.roi", default=None))
    event_cooldown_ms = _as_non_negative_int(
        settings.get("abandoned.event_cooldown_ms", default=10000),
        key="abandoned.event_cooldown_ms",
        default=10000,
    )

    _abandoned_settings = AbandonedSettings(
        enabled=enabled,
        object_classes=object_classes,
        associate_max_distance_px=associate_max_distance_px,
        associate_min_ms=associate_min_ms,
        abandon_delay_ms=abandon_delay_ms,
        stationary_max_move_px=stationary_max_move_px,
        roi=roi_name,
        event_cooldown_ms=event_cooldown_ms,
    )
    return _abandoned_settings


def _distance_px(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


class AbandonedEventEngine:
    def __init__(self, abandoned_settings: AbandonedSettings, roi_settings: RoiSettings):
        self._settings = abandoned_settings
        self._roi_settings = roi_settings
        self._objects: dict[int, ObjectTrackState] = {}

    def process_samples(self, *, ts_ms: int, samples: list[AbandonedSample]) -> list[EventEntry]:
        if not self._settings.enabled:
            return []

        events: list[EventEntry] = []
        person_samples = [sample for sample in samples if sample.class_name.strip().lower() == PERSON_CLASS_NAME]

        for sample in samples:
            if not self._is_candidate_object(sample):
                continue

            if not self._is_inside_configured_roi(sample):
                self._objects.pop(sample.track_id, None)
                continue

            state = self._objects.get(sample.track_id)
            if state is None:
                state = ObjectTrackState(class_name=sample.class_name.strip().lower())
                self._objects[sample.track_id] = state

            state.class_name = sample.class_name.strip().lower()
            state.last_seen_ts_ms = ts_ms
            state.last_point = sample.point

            nearest_person_id, nearest_distance_px = self._find_nearest_person(sample, person_samples)
            has_near_person = (
                nearest_person_id is not None
                and nearest_distance_px is not None
                and nearest_distance_px <= self._settings.associate_max_distance_px
            )

            if has_near_person and nearest_person_id is not None:
                self._handle_association_candidate(state=state, person_track_id=nearest_person_id, ts_ms=ts_ms)
                self._reset_abandonment(state)
                continue

            state.association_candidate_person_id = None
            state.association_candidate_since_ms = None

            if state.associated_person_id is not None and state.abandon_started_ts_ms is None:
                state.abandon_started_ts_ms = ts_ms
                state.abandon_person_id = state.associated_person_id
                state.abandon_reference_point = sample.point

            state.associated_person_id = None
            state.associated_since_ms = None

            if state.abandon_started_ts_ms is None:
                continue

            if state.abandon_reference_point is not None and self._settings.stationary_max_move_px is not None:
                movement_px = _distance_px(sample.point, state.abandon_reference_point)
                if movement_px > self._settings.stationary_max_move_px:
                    self._reset_abandonment(state)
                    continue

            abandon_ms = max(ts_ms - state.abandon_started_ts_ms, 0)
            if abandon_ms < self._settings.abandon_delay_ms:
                continue

            if state.abandoned_emitted:
                continue

            if not self._can_emit(state=state, ts_ms=ts_ms):
                continue

            events.append(
                EventEntry(
                    name="abandoned_object",
                    ts_ms=ts_ms,
                    severity="high",
                    track_id=sample.track_id,
                    data={
                        "object_track_id": sample.track_id,
                        "object_class": state.class_name,
                        "person_track_id": state.abandon_person_id,
                        "roi": self._settings.roi,
                        "abandon_ms": abandon_ms,
                    },
                )
            )
            state.abandoned_emitted = True
            state.last_event_ts_ms = ts_ms

        self.evict_stale(now_ts_ms=ts_ms)
        return events

    def evict_stale(self, *, now_ts_ms: int) -> None:
        stale_track_ids = [
            track_id
            for track_id, state in self._objects.items()
            if now_ts_ms - state.last_seen_ts_ms > TRACK_STATE_TTL_MS
        ]

        for track_id in stale_track_ids:
            del self._objects[track_id]

    def _is_candidate_object(self, sample: AbandonedSample) -> bool:
        class_name = sample.class_name.strip().lower()
        return class_name in self._settings.object_classes

    def _is_inside_configured_roi(self, sample: AbandonedSample) -> bool:
        if self._settings.roi is None:
            return True

        region = self._roi_settings.regions.get(self._settings.roi)
        if region is None:
            return False

        return point_in_region(sample.point, region)

    def _find_nearest_person(
        self,
        sample: AbandonedSample,
        person_samples: list[AbandonedSample],
    ) -> tuple[int | None, float | None]:
        nearest_person_id: int | None = None
        nearest_distance_px: float | None = None

        for person_sample in person_samples:
            if person_sample.track_id == sample.track_id:
                continue

            distance_px = _distance_px(sample.point, person_sample.point)
            if nearest_distance_px is None or distance_px < nearest_distance_px:
                nearest_distance_px = distance_px
                nearest_person_id = person_sample.track_id

        return nearest_person_id, nearest_distance_px

    def _handle_association_candidate(self, *, state: ObjectTrackState, person_track_id: int, ts_ms: int) -> None:
        if state.associated_person_id == person_track_id:
            return

        if state.association_candidate_person_id != person_track_id:
            state.association_candidate_person_id = person_track_id
            state.association_candidate_since_ms = ts_ms
            return

        if state.association_candidate_since_ms is None:
            state.association_candidate_since_ms = ts_ms
            return

        associated_ms = ts_ms - state.association_candidate_since_ms
        if associated_ms < self._settings.associate_min_ms:
            return

        state.associated_person_id = person_track_id
        state.associated_since_ms = state.association_candidate_since_ms
        state.association_candidate_person_id = None
        state.association_candidate_since_ms = None
        state.abandoned_emitted = False

    def _reset_abandonment(self, state: ObjectTrackState) -> None:
        state.abandon_started_ts_ms = None
        state.abandon_person_id = None
        state.abandon_reference_point = None
        state.abandoned_emitted = False

    def _can_emit(self, *, state: ObjectTrackState, ts_ms: int) -> bool:
        cooldown_ms = self._settings.event_cooldown_ms
        if cooldown_ms <= 0:
            return True

        if state.last_event_ts_ms is None:
            return True

        return (ts_ms - state.last_event_ts_ms) >= cooldown_ms
