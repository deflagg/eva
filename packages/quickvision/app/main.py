from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .abandoned import AbandonedSettings, load_abandoned_settings
from .collision import CollisionSettings, load_collision_settings
from .events import DetectionEventEngine
from .insights import InsightBuffer, InsightError, InsightSettings, load_insight_settings
from .motion import MotionSettings, load_motion_settings
from .protocol import BinaryFrameParseError, CommandMessage, EventEntry, decode_binary_frame_envelope, make_error, make_hello
from .roi import RoiSettings, load_roi_settings
from .tracking import TrackingSettings, load_tracking_settings, should_use_latest_pending_slot
from .yolo import (
    FrameDecodeError,
    InferenceFrame,
    get_model_summary,
    is_model_loaded,
    load_model,
    run_inference,
)

app = FastAPI(title="quickvision", version="0.1.0")

_insight_settings: InsightSettings | None = None
_tracking_settings: TrackingSettings | None = None
_roi_settings: RoiSettings | None = None
_motion_settings: MotionSettings | None = None
_collision_settings: CollisionSettings | None = None
_abandoned_settings: AbandonedSettings | None = None


@app.on_event("startup")
async def on_startup() -> None:
    """Fail fast if YOLO/tracking/ROI/motion/collision/abandoned/insight config is missing/invalid."""
    global _insight_settings, _tracking_settings, _roi_settings, _motion_settings, _collision_settings, _abandoned_settings

    try:
        load_model()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _insight_settings = load_insight_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _tracking_settings = load_tracking_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _roi_settings = load_roi_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _motion_settings = load_motion_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _collision_settings = load_collision_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _abandoned_settings = load_abandoned_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    print(f"[quickvision] model loaded: {get_model_summary()}")
    print(
        "[quickvision] insights config: "
        f"enabled={_insight_settings.enabled} "
        f"vision_agent_url={_insight_settings.vision_agent_url} "
        f"max_frames={_insight_settings.max_frames} "
        f"pre_frames={_insight_settings.pre_frames} "
        f"post_frames={_insight_settings.post_frames} "
        f"insight_cooldown_ms={_insight_settings.insight_cooldown_ms} "
        f"downsample_enabled={_insight_settings.downsample.enabled} "
        f"downsample_max_dim={_insight_settings.downsample.max_dim} "
        f"downsample_jpeg_quality={_insight_settings.downsample.jpeg_quality}"
    )
    print(
        "[quickvision] surprise config: "
        f"enabled={_insight_settings.surprise.enabled} "
        f"threshold={_insight_settings.surprise.threshold} "
        f"cooldown_ms={_insight_settings.surprise.cooldown_ms} "
        f"weights={len(_insight_settings.surprise.weights)}"
    )
    print(
        "[quickvision] tracking config: "
        f"enabled={_tracking_settings.enabled} "
        f"persist={_tracking_settings.persist} "
        f"tracker={_tracking_settings.tracker} "
        f"busy_policy={_tracking_settings.busy_policy}"
    )
    print(
        "[quickvision] roi config: "
        f"enabled={_roi_settings.enabled} "
        f"representative_point={_roi_settings.representative_point} "
        f"regions={len(_roi_settings.regions)} "
        f"lines={len(_roi_settings.lines)} "
        f"dwell_default_threshold_ms={_roi_settings.dwell_default_threshold_ms} "
        f"dwell_region_overrides={len(_roi_settings.dwell_region_threshold_ms)}"
    )
    print(
        "[quickvision] motion config: "
        f"enabled={_motion_settings.enabled} "
        f"history_frames={_motion_settings.history_frames} "
        f"sudden_motion_speed_px_s={_motion_settings.sudden_motion_speed_px_s} "
        f"stop_speed_px_s={_motion_settings.stop_speed_px_s} "
        f"stop_duration_ms={_motion_settings.stop_duration_ms} "
        f"event_cooldown_ms={_motion_settings.event_cooldown_ms}"
    )
    print(
        "[quickvision] collision config: "
        f"enabled={_collision_settings.enabled} "
        f"pairs={len(_collision_settings.pairs)} "
        f"distance_px={_collision_settings.distance_px} "
        f"closing_speed_px_s={_collision_settings.closing_speed_px_s} "
        f"pair_cooldown_ms={_collision_settings.pair_cooldown_ms}"
    )
    print(
        "[quickvision] abandoned config: "
        f"enabled={_abandoned_settings.enabled} "
        f"object_classes={len(_abandoned_settings.object_classes)} "
        f"associate_max_distance_px={_abandoned_settings.associate_max_distance_px} "
        f"associate_min_ms={_abandoned_settings.associate_min_ms} "
        f"abandon_delay_ms={_abandoned_settings.abandon_delay_ms} "
        f"stationary_max_move_px={_abandoned_settings.stationary_max_move_px} "
        f"roi={_abandoned_settings.roi} "
        f"event_cooldown_ms={_abandoned_settings.event_cooldown_ms}"
    )


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "service": "quickvision",
        "status": "ok",
        "model_loaded": is_model_loaded(),
        "insights_enabled": _insight_settings.enabled if _insight_settings is not None else False,
        "insight_cooldown_ms": _insight_settings.insight_cooldown_ms if _insight_settings is not None else 0,
        "insight_downsample_enabled": _insight_settings.downsample.enabled if _insight_settings is not None else False,
        "insight_downsample_max_dim": _insight_settings.downsample.max_dim if _insight_settings is not None else 0,
        "insight_downsample_jpeg_quality": _insight_settings.downsample.jpeg_quality if _insight_settings is not None else 0,
        "surprise_enabled": _insight_settings.surprise.enabled if _insight_settings is not None else False,
        "surprise_threshold": _insight_settings.surprise.threshold if _insight_settings is not None else 0,
        "surprise_cooldown_ms": _insight_settings.surprise.cooldown_ms if _insight_settings is not None else 0,
        "surprise_weights": len(_insight_settings.surprise.weights) if _insight_settings is not None else 0,
        "tracking_enabled": _tracking_settings.enabled if _tracking_settings is not None else False,
        "tracking_busy_policy": _tracking_settings.busy_policy if _tracking_settings is not None else None,
        "roi_enabled": _roi_settings.enabled if _roi_settings is not None else False,
        "roi_regions": len(_roi_settings.regions) if _roi_settings is not None else 0,
        "roi_lines": len(_roi_settings.lines) if _roi_settings is not None else 0,
        "roi_dwell_default_threshold_ms": _roi_settings.dwell_default_threshold_ms if _roi_settings is not None else 0,
        "roi_dwell_region_overrides": len(_roi_settings.dwell_region_threshold_ms) if _roi_settings is not None else 0,
        "motion_enabled": _motion_settings.enabled if _motion_settings is not None else False,
        "motion_history_frames": _motion_settings.history_frames if _motion_settings is not None else 0,
        "motion_sudden_motion_speed_px_s": _motion_settings.sudden_motion_speed_px_s if _motion_settings is not None else 0,
        "motion_stop_speed_px_s": _motion_settings.stop_speed_px_s if _motion_settings is not None else 0,
        "motion_stop_duration_ms": _motion_settings.stop_duration_ms if _motion_settings is not None else 0,
        "motion_event_cooldown_ms": _motion_settings.event_cooldown_ms if _motion_settings is not None else 0,
        "collision_enabled": _collision_settings.enabled if _collision_settings is not None else False,
        "collision_pairs": len(_collision_settings.pairs) if _collision_settings is not None else 0,
        "collision_distance_px": _collision_settings.distance_px if _collision_settings is not None else 0,
        "collision_closing_speed_px_s": _collision_settings.closing_speed_px_s if _collision_settings is not None else 0,
        "collision_pair_cooldown_ms": _collision_settings.pair_cooldown_ms if _collision_settings is not None else 0,
        "abandoned_enabled": _abandoned_settings.enabled if _abandoned_settings is not None else False,
        "abandoned_object_classes": len(_abandoned_settings.object_classes) if _abandoned_settings is not None else 0,
        "abandoned_associate_max_distance_px": _abandoned_settings.associate_max_distance_px if _abandoned_settings is not None else 0,
        "abandoned_associate_min_ms": _abandoned_settings.associate_min_ms if _abandoned_settings is not None else 0,
        "abandoned_abandon_delay_ms": _abandoned_settings.abandon_delay_ms if _abandoned_settings is not None else 0,
        "abandoned_stationary_max_move_px": _abandoned_settings.stationary_max_move_px if _abandoned_settings is not None else None,
        "abandoned_roi": _abandoned_settings.roi if _abandoned_settings is not None else None,
        "abandoned_event_cooldown_ms": _abandoned_settings.event_cooldown_ms if _abandoned_settings is not None else 0,
    }


@app.websocket("/infer")
async def infer_socket(websocket: WebSocket) -> None:
    await websocket.accept()

    insight_settings = _insight_settings if _insight_settings is not None else load_insight_settings()
    tracking_settings = _tracking_settings if _tracking_settings is not None else load_tracking_settings()
    roi_settings = _roi_settings if _roi_settings is not None else load_roi_settings()
    motion_settings = _motion_settings if _motion_settings is not None else load_motion_settings()
    collision_settings = _collision_settings if _collision_settings is not None else load_collision_settings()
    abandoned_settings = _abandoned_settings if _abandoned_settings is not None else load_abandoned_settings()
    use_latest_pending_slot = should_use_latest_pending_slot(tracking_settings)

    insight_buffer = InsightBuffer(insight_settings)
    detection_event_engine = DetectionEventEngine(roi_settings, motion_settings, collision_settings, abandoned_settings)

    send_lock = asyncio.Lock()

    async def send_payload(payload: dict[str, object]) -> bool:
        async with send_lock:
            try:
                await websocket.send_json(payload)
                return True
            except Exception:
                return False

    await send_payload(make_hello("quickvision"))

    pending_frame: InferenceFrame | None = None
    pending_frame_event = asyncio.Event()
    inference_running = False
    manual_insight_task: asyncio.Task[None] | None = None
    auto_insight_task: asyncio.Task[None] | None = None

    async def process_frame(frame: InferenceFrame) -> None:
        nonlocal auto_insight_task

        try:
            detections = await run_inference(frame)
            events = detection_event_engine.process(detections)
            if events:
                detections.events = events

            await send_payload(detections.model_dump(exclude_none=True))

            if (
                events
                and insight_settings.enabled
                and insight_settings.surprise.enabled
                and (auto_insight_task is None or auto_insight_task.done())
            ):
                auto_insight_task = asyncio.create_task(
                    process_auto_insight(trigger_frame_id=detections.frame_id, events=events)
                )
        except FrameDecodeError as exc:
            await send_payload(make_error("INVALID_IMAGE", str(exc), frame_id=frame.frame_id))
        except Exception as exc:
            await send_payload(make_error("INFERENCE_ERROR", str(exc), frame_id=frame.frame_id))

    async def process_insight_test() -> None:
        try:
            insight_message = await insight_buffer.run_insight_test()
            await send_payload(insight_message.model_dump(exclude_none=True))
        except InsightError as exc:
            await send_payload(make_error(exc.code, str(exc)))
        except Exception as exc:
            await send_payload(make_error("INSIGHT_ERROR", f"Insight test failed: {exc}"))

    async def process_auto_insight(*, trigger_frame_id: str, events: list[EventEntry]) -> None:
        try:
            insight_message = await insight_buffer.run_auto_insight(
                trigger_frame_id=trigger_frame_id,
                events=events,
            )
            if insight_message is None:
                return

            await send_payload(insight_message.model_dump(exclude_none=True))
        except InsightError as exc:
            print(f"[quickvision] auto insight skipped: {exc.code} {exc}")
        except Exception as exc:
            print(f"[quickvision] auto insight failed: {exc}")

    async def inference_worker() -> None:
        nonlocal inference_running, pending_frame

        while True:
            await pending_frame_event.wait()
            pending_frame_event.clear()

            while pending_frame is not None:
                frame = pending_frame
                pending_frame = None
                inference_running = True
                try:
                    await process_frame(frame)
                finally:
                    inference_running = False

    inference_worker_task = asyncio.create_task(inference_worker())

    try:
        while True:
            ws_event = await websocket.receive()
            event_type = ws_event.get("type")

            if event_type == "websocket.disconnect":
                break

            if event_type != "websocket.receive":
                continue

            binary_payload = ws_event.get("bytes")
            text_payload = ws_event.get("text")

            if binary_payload is None:
                frame_id: str | None = None

                if isinstance(text_payload, str):
                    try:
                        parsed_payload = json.loads(text_payload)
                    except json.JSONDecodeError:
                        await send_payload(make_error("INVALID_JSON", "Expected valid JSON payload."))
                        continue

                    if isinstance(parsed_payload, dict):
                        frame_id_value = parsed_payload.get("frame_id")
                        frame_id = frame_id_value if isinstance(frame_id_value, str) else None

                        if parsed_payload.get("type") == "command":
                            try:
                                command = CommandMessage.model_validate(parsed_payload)
                            except ValidationError:
                                await send_payload(make_error("INVALID_COMMAND", "Invalid command payload."))
                                continue

                            if command.name != "insight_test":
                                await send_payload(
                                    make_error("UNSUPPORTED_COMMAND", f"Unsupported command: {command.name}")
                                )
                                continue

                            if manual_insight_task is not None and not manual_insight_task.done():
                                await send_payload(
                                    make_error(
                                        "INSIGHT_BUSY",
                                        "An insight_test command is already running for this connection.",
                                    )
                                )
                                continue

                            manual_insight_task = asyncio.create_task(process_insight_test())
                            continue

                await send_payload(
                    make_error(
                        "FRAME_BINARY_REQUIRED",
                        "QuickVision expects binary frame payloads on /infer.",
                        frame_id=frame_id,
                    )
                )
                continue

            try:
                envelope = decode_binary_frame_envelope(binary_payload)
            except BinaryFrameParseError as exc:
                await send_payload(make_error("INVALID_FRAME_BINARY", str(exc)))
                continue

            insight_buffer.add_frame(envelope.meta, envelope.image_payload)

            frame = InferenceFrame(
                frame_id=envelope.meta.frame_id,
                width=envelope.meta.width,
                height=envelope.meta.height,
                image_bytes=envelope.image_payload,
            )

            if use_latest_pending_slot:
                pending_frame = frame
                pending_frame_event.set()
                continue

            if inference_running or pending_frame is not None:
                await send_payload(
                    make_error(
                        "BUSY",
                        "Inference is already running for this connection; frame dropped.",
                        frame_id=frame.frame_id,
                    )
                )
                continue

            pending_frame = frame
            pending_frame_event.set()
    except WebSocketDisconnect:
        pass
    finally:
        if inference_worker_task and not inference_worker_task.done():
            inference_worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await inference_worker_task

        if manual_insight_task and not manual_insight_task.done():
            manual_insight_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await manual_insight_task

        if auto_insight_task and not auto_insight_task.done():
            auto_insight_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await auto_insight_task
