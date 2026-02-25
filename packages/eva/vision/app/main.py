from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .insights import InsightBuffer, InsightError, InsightSettings, load_insight_settings
from .protocol import (
    BinaryFrameParseError,
    CommandMessage,
    EventEntry,
    FrameEventsMessage,
    decode_binary_frame_envelope,
    make_error,
    make_hello,
)
from .scene_change import (
    SceneChangeEngine,
    SceneChangeFrameDecodeError,
    SceneChangeSettings,
    load_scene_change_settings,
)

app = FastAPI(title="vision", version="0.1.0")

_insight_settings: InsightSettings | None = None
_scene_change_settings: SceneChangeSettings | None = None


@dataclass(slots=True)
class FrameRequest:
    frame_id: str
    ts_ms: int
    width: int
    height: int
    image_bytes: bytes


@app.on_event("startup")
async def on_startup() -> None:
    """Fail fast if scene-change or insight config is missing/invalid."""
    global _insight_settings, _scene_change_settings

    try:
        _insight_settings = load_insight_settings()
    except Exception as exc:
        raise RuntimeError(f"Vision startup failed: {exc}") from exc

    try:
        _scene_change_settings = load_scene_change_settings()
    except Exception as exc:
        raise RuntimeError(f"Vision startup failed: {exc}") from exc

    print(
        "[vision] insights config: "
        f"enabled={_insight_settings.enabled} "
        f"agent_url={_insight_settings.agent_url} "
        f"assets_dir={_insight_settings.assets_dir} "
        f"max_frames={_insight_settings.max_frames} "
        f"pre_frames={_insight_settings.pre_frames} "
        f"post_frames={_insight_settings.post_frames} "
        f"insight_cooldown_ms={_insight_settings.insight_cooldown_ms} "
        f"assets_max_clips={_insight_settings.assets.max_clips} "
        f"assets_max_age_hours={_insight_settings.assets.max_age_hours} "
        f"downsample_enabled={_insight_settings.downsample.enabled} "
        f"downsample_max_dim={_insight_settings.downsample.max_dim} "
        f"downsample_jpeg_quality={_insight_settings.downsample.jpeg_quality}"
    )
    print(
        "[vision] surprise config: "
        f"enabled={_insight_settings.surprise.enabled} "
        f"threshold={_insight_settings.surprise.threshold} "
        f"cooldown_ms={_insight_settings.surprise.cooldown_ms} "
        f"weights={len(_insight_settings.surprise.weights)}"
    )
    print(
        "[vision] scene_change config: "
        f"enabled={_scene_change_settings.enabled} "
        f"downsample_max_dim={_scene_change_settings.downsample.max_dim} "
        f"ema_alpha={_scene_change_settings.ema_alpha} "
        f"pixel_threshold={_scene_change_settings.pixel_threshold} "
        f"cell_px={_scene_change_settings.cell_px} "
        f"cell_active_ratio={_scene_change_settings.cell_active_ratio} "
        f"min_blob_cells={_scene_change_settings.min_blob_cells} "
        f"score_threshold={_scene_change_settings.score_threshold} "
        f"min_persist_frames={_scene_change_settings.min_persist_frames} "
        f"cooldown_ms={_scene_change_settings.cooldown_ms} "
        f"medium_score={_scene_change_settings.severity.medium_score} "
        f"high_score={_scene_change_settings.severity.high_score}"
    )


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "service": "vision",
        "status": "ok",
        "insights_enabled": _insight_settings.enabled if _insight_settings is not None else False,
        "insight_assets_dir": str(_insight_settings.assets_dir) if _insight_settings is not None else None,
        "insight_assets_max_clips": _insight_settings.assets.max_clips if _insight_settings is not None else 0,
        "insight_assets_max_age_hours": _insight_settings.assets.max_age_hours if _insight_settings is not None else 0,
        "insight_cooldown_ms": _insight_settings.insight_cooldown_ms if _insight_settings is not None else 0,
        "insight_downsample_enabled": _insight_settings.downsample.enabled if _insight_settings is not None else False,
        "insight_downsample_max_dim": _insight_settings.downsample.max_dim if _insight_settings is not None else 0,
        "insight_downsample_jpeg_quality": _insight_settings.downsample.jpeg_quality if _insight_settings is not None else 0,
        "surprise_enabled": _insight_settings.surprise.enabled if _insight_settings is not None else False,
        "surprise_threshold": _insight_settings.surprise.threshold if _insight_settings is not None else 0,
        "surprise_cooldown_ms": _insight_settings.surprise.cooldown_ms if _insight_settings is not None else 0,
        "surprise_weights": len(_insight_settings.surprise.weights) if _insight_settings is not None else 0,
        "scene_change_enabled": _scene_change_settings.enabled if _scene_change_settings is not None else False,
        "scene_change_downsample_max_dim": _scene_change_settings.downsample.max_dim
        if _scene_change_settings is not None
        else 0,
        "scene_change_ema_alpha": _scene_change_settings.ema_alpha if _scene_change_settings is not None else 0,
        "scene_change_pixel_threshold": _scene_change_settings.pixel_threshold if _scene_change_settings is not None else 0,
        "scene_change_cell_px": _scene_change_settings.cell_px if _scene_change_settings is not None else 0,
        "scene_change_cell_active_ratio": _scene_change_settings.cell_active_ratio
        if _scene_change_settings is not None
        else 0,
        "scene_change_min_blob_cells": _scene_change_settings.min_blob_cells if _scene_change_settings is not None else 0,
        "scene_change_score_threshold": _scene_change_settings.score_threshold if _scene_change_settings is not None else 0,
        "scene_change_min_persist_frames": _scene_change_settings.min_persist_frames
        if _scene_change_settings is not None
        else 0,
        "scene_change_cooldown_ms": _scene_change_settings.cooldown_ms if _scene_change_settings is not None else 0,
        "scene_change_medium_score": _scene_change_settings.severity.medium_score
        if _scene_change_settings is not None
        else 0,
        "scene_change_high_score": _scene_change_settings.severity.high_score if _scene_change_settings is not None else 0,
    }


@app.websocket("/infer")
async def infer_socket(websocket: WebSocket) -> None:
    await websocket.accept()

    insight_settings = _insight_settings if _insight_settings is not None else load_insight_settings()
    scene_change_settings = (
        _scene_change_settings if _scene_change_settings is not None else load_scene_change_settings()
    )

    insight_buffer = InsightBuffer(insight_settings)
    scene_change_engine = SceneChangeEngine(scene_change_settings)

    send_lock = asyncio.Lock()

    async def send_payload(payload: dict[str, object]) -> bool:
        async with send_lock:
            try:
                await websocket.send_json(payload)
                return True
            except Exception:
                return False

    await send_payload(make_hello("vision"))

    pending_frame: FrameRequest | None = None
    pending_frame_event = asyncio.Event()
    inference_running = False
    manual_insight_task: asyncio.Task[None] | None = None
    auto_insight_task: asyncio.Task[None] | None = None

    async def process_frame(frame: FrameRequest) -> None:
        nonlocal auto_insight_task

        try:
            events = scene_change_engine.process_frame(
                ts_ms=frame.ts_ms,
                width=frame.width,
                height=frame.height,
                jpeg_bytes=frame.image_bytes,
            )
            frame_events = FrameEventsMessage(
                frame_id=frame.frame_id,
                ts_ms=frame.ts_ms,
                width=frame.width,
                height=frame.height,
                events=events,
            )
            await send_payload(frame_events.model_dump(exclude_none=True))

            if (
                events
                and insight_settings.enabled
                and insight_settings.surprise.enabled
                and (auto_insight_task is None or auto_insight_task.done())
            ):
                auto_insight_task = asyncio.create_task(
                    process_auto_insight(trigger_frame_id=frame_events.frame_id, events=events)
                )
        except SceneChangeFrameDecodeError as exc:
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
            print(f"[vision] auto insight skipped: {exc.code} {exc}")
        except Exception as exc:
            print(f"[vision] auto insight failed: {exc}")

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
                        "Vision expects binary frame payloads on /infer.",
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

            frame = FrameRequest(
                frame_id=envelope.meta.frame_id,
                ts_ms=envelope.meta.ts_ms,
                width=envelope.meta.width,
                height=envelope.meta.height,
                image_bytes=envelope.image_payload,
            )

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
