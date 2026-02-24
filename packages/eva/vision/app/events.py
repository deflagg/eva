from __future__ import annotations

from dataclasses import dataclass, field

from .abandoned import AbandonedEventEngine, AbandonedSample, AbandonedSettings
from .collision import CollisionEventEngine, CollisionSample, CollisionSettings
from .motion import MotionEventEngine, MotionSettings
from .protocol import DetectionsMessage, EventEntry
from .roi import RoiSettings, box_centroid, line_side, point_in_region

TRACK_STATE_TTL_MS = 30_000


@dataclass(slots=True)
class TrackEventState:
    regions_inside: dict[str, bool] = field(default_factory=dict)
    region_enter_ts_ms: dict[str, int] = field(default_factory=dict)
    region_dwell_emitted: dict[str, bool] = field(default_factory=dict)
    region_pending_inside: dict[str, bool] = field(default_factory=dict)
    region_pending_since_ts_ms: dict[str, int] = field(default_factory=dict)
    line_side_state: dict[str, str] = field(default_factory=dict)
    last_seen_ts_ms: int = 0


class DetectionEventEngine:
    def __init__(
        self,
        roi_settings: RoiSettings,
        motion_settings: MotionSettings,
        collision_settings: CollisionSettings,
        abandoned_settings: AbandonedSettings,
    ):
        self._roi_settings = roi_settings
        self._motion_settings = motion_settings
        self._collision_settings = collision_settings
        self._abandoned_settings = abandoned_settings
        self._tracks: dict[int, TrackEventState] = {}
        self._motion_engine = MotionEventEngine(motion_settings)
        self._collision_engine = CollisionEventEngine(collision_settings)
        self._abandoned_engine = AbandonedEventEngine(abandoned_settings, roi_settings)

    def process(self, detections_message: DetectionsMessage) -> list[EventEntry]:
        if (
            not self._roi_settings.enabled
            and not self._motion_settings.enabled
            and not self._collision_settings.enabled
            and not self._abandoned_settings.enabled
        ):
            return []

        events: list[EventEntry] = []
        seen_track_ids: set[int] = set()
        collision_samples: list[CollisionSample] = []
        abandoned_samples: list[AbandonedSample] = []

        for detection in detections_message.detections:
            track_id = detection.track_id
            if track_id is None:
                continue

            if track_id in seen_track_ids:
                continue

            seen_track_ids.add(track_id)
            point = box_centroid(detection.box)

            if self._collision_settings.enabled:
                collision_samples.append(
                    CollisionSample(
                        track_id=track_id,
                        class_name=detection.name,
                        point=point,
                    )
                )

            if self._abandoned_settings.enabled:
                abandoned_samples.append(
                    AbandonedSample(
                        track_id=track_id,
                        class_name=detection.name,
                        point=point,
                    )
                )

            if self._roi_settings.enabled:
                state = self._tracks.get(track_id)
                if state is None:
                    state = TrackEventState(last_seen_ts_ms=detections_message.ts_ms)
                    self._tracks[track_id] = state

                state.last_seen_ts_ms = detections_message.ts_ms

                self._append_region_events(
                    events=events,
                    track_id=track_id,
                    ts_ms=detections_message.ts_ms,
                    point=point,
                    state=state,
                )
                self._append_line_events(
                    events=events,
                    track_id=track_id,
                    ts_ms=detections_message.ts_ms,
                    point=point,
                    state=state,
                )

            if self._motion_settings.enabled:
                events.extend(
                    self._motion_engine.process_sample(
                        track_id=track_id,
                        ts_ms=detections_message.ts_ms,
                        point=point,
                    )
                )

        if self._collision_settings.enabled:
            events.extend(
                self._collision_engine.process_samples(
                    ts_ms=detections_message.ts_ms,
                    samples=collision_samples,
                )
            )
            self._collision_engine.evict_stale(now_ts_ms=detections_message.ts_ms)

        if self._abandoned_settings.enabled:
            events.extend(
                self._abandoned_engine.process_samples(
                    ts_ms=detections_message.ts_ms,
                    samples=abandoned_samples,
                )
            )

        if self._roi_settings.enabled:
            self._evict_stale_track_state(now_ts_ms=detections_message.ts_ms)

        if self._motion_settings.enabled:
            self._motion_engine.evict_stale(now_ts_ms=detections_message.ts_ms)

        return events

    def _append_region_events(
        self,
        *,
        events: list[EventEntry],
        track_id: int,
        ts_ms: int,
        point: tuple[float, float],
        state: TrackEventState,
    ) -> None:
        min_transition_ms = self._roi_settings.transition_min_ms

        for region_name, region in self._roi_settings.regions.items():
            inside_now = point_in_region(point, region)
            committed_inside = state.regions_inside.get(region_name, False)

            if min_transition_ms <= 0:
                state.region_pending_inside.pop(region_name, None)
                state.region_pending_since_ts_ms.pop(region_name, None)

                if inside_now and not committed_inside:
                    events.append(
                        EventEntry(
                            name="roi_enter",
                            ts_ms=ts_ms,
                            severity="low",
                            track_id=track_id,
                            data={"roi": region_name},
                        )
                    )
                    state.region_enter_ts_ms[region_name] = ts_ms
                    state.region_dwell_emitted[region_name] = False
                elif committed_inside and not inside_now:
                    events.append(
                        EventEntry(
                            name="roi_exit",
                            ts_ms=ts_ms,
                            severity="low",
                            track_id=track_id,
                            data={"roi": region_name},
                        )
                    )
                    state.region_enter_ts_ms.pop(region_name, None)
                    state.region_dwell_emitted.pop(region_name, None)

                state.regions_inside[region_name] = inside_now
            else:
                if inside_now == committed_inside:
                    state.region_pending_inside.pop(region_name, None)
                    state.region_pending_since_ts_ms.pop(region_name, None)
                else:
                    pending_inside = state.region_pending_inside.get(region_name)
                    pending_since_ts_ms = state.region_pending_since_ts_ms.get(region_name)

                    if pending_inside != inside_now:
                        state.region_pending_inside[region_name] = inside_now
                        state.region_pending_since_ts_ms[region_name] = ts_ms
                    else:
                        if pending_since_ts_ms is None:
                            state.region_pending_since_ts_ms[region_name] = ts_ms
                        else:
                            elapsed_ms = max(ts_ms - pending_since_ts_ms, 0)
                            if elapsed_ms >= min_transition_ms:
                                if inside_now:
                                    events.append(
                                        EventEntry(
                                            name="roi_enter",
                                            ts_ms=ts_ms,
                                            severity="low",
                                            track_id=track_id,
                                            data={"roi": region_name},
                                        )
                                    )
                                    state.region_enter_ts_ms[region_name] = ts_ms
                                    state.region_dwell_emitted[region_name] = False
                                else:
                                    events.append(
                                        EventEntry(
                                            name="roi_exit",
                                            ts_ms=ts_ms,
                                            severity="low",
                                            track_id=track_id,
                                            data={"roi": region_name},
                                        )
                                    )
                                    state.region_enter_ts_ms.pop(region_name, None)
                                    state.region_dwell_emitted.pop(region_name, None)

                                state.regions_inside[region_name] = inside_now
                                state.region_pending_inside.pop(region_name, None)
                                state.region_pending_since_ts_ms.pop(region_name, None)

            committed_inside = state.regions_inside.get(region_name, False)
            if committed_inside:
                enter_ts_ms = state.region_enter_ts_ms.get(region_name)
                if enter_ts_ms is None:
                    enter_ts_ms = ts_ms
                    state.region_enter_ts_ms[region_name] = ts_ms

                dwell_emitted = state.region_dwell_emitted.get(region_name, False)
                dwell_threshold_ms = self._roi_settings.dwell_threshold_ms_for_region(region_name)
                dwell_ms = max(ts_ms - enter_ts_ms, 0)

                if not dwell_emitted and dwell_ms >= dwell_threshold_ms:
                    events.append(
                        EventEntry(
                            name="roi_dwell",
                            ts_ms=ts_ms,
                            severity="medium",
                            track_id=track_id,
                            data={"roi": region_name, "dwell_ms": dwell_ms},
                        )
                    )
                    state.region_dwell_emitted[region_name] = True

    def _append_line_events(
        self,
        *,
        events: list[EventEntry],
        track_id: int,
        ts_ms: int,
        point: tuple[float, float],
        state: TrackEventState,
    ) -> None:
        for line_name, line in self._roi_settings.lines.items():
            current_side = line_side(point, line)
            previous_side = state.line_side_state.get(line_name)

            if previous_side is not None and current_side is not None and previous_side != current_side:
                events.append(
                    EventEntry(
                        name="line_cross",
                        ts_ms=ts_ms,
                        severity="medium",
                        track_id=track_id,
                        data={"line": line_name, "direction": f"{previous_side}->{current_side}"},
                    )
                )

            if current_side is not None:
                state.line_side_state[line_name] = current_side

    def _evict_stale_track_state(self, *, now_ts_ms: int) -> None:
        stale_track_ids = [
            track_id
            for track_id, state in self._tracks.items()
            if now_ts_ms - state.last_seen_ts_ms > TRACK_STATE_TTL_MS
        ]

        for track_id in stale_track_ids:
            del self._tracks[track_id]
