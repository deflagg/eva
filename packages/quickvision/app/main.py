from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .insights import InsightBuffer, InsightError, InsightSettings, load_insight_settings
from .protocol import BinaryFrameParseError, CommandMessage, decode_binary_frame_envelope, make_error, make_hello
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


@app.on_event("startup")
async def on_startup() -> None:
    """Fail fast if YOLO model config is missing/invalid."""
    global _insight_settings

    try:
        load_model()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    try:
        _insight_settings = load_insight_settings()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    print(f"[quickvision] model loaded: {get_model_summary()}")
    print(
        "[quickvision] insights config: "
        f"enabled={_insight_settings.enabled} "
        f"vision_agent_url={_insight_settings.vision_agent_url} "
        f"max_frames={_insight_settings.max_frames} "
        f"pre_frames={_insight_settings.pre_frames} "
        f"post_frames={_insight_settings.post_frames}"
    )


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "service": "quickvision",
        "status": "ok",
        "model_loaded": is_model_loaded(),
        "insights_enabled": _insight_settings.enabled if _insight_settings is not None else False,
    }


@app.websocket("/infer")
async def infer_socket(websocket: WebSocket) -> None:
    await websocket.accept()

    insight_settings = _insight_settings if _insight_settings is not None else load_insight_settings()
    insight_buffer = InsightBuffer(insight_settings)

    send_lock = asyncio.Lock()

    async def send_payload(payload: dict[str, object]) -> bool:
        async with send_lock:
            try:
                await websocket.send_json(payload)
                return True
            except Exception:
                return False

    await send_payload(make_hello("quickvision"))

    inference_task: asyncio.Task[None] | None = None
    insight_task: asyncio.Task[None] | None = None

    async def process_frame(frame: InferenceFrame) -> None:
        try:
            detections = await run_inference(frame)
            await send_payload(detections.model_dump(exclude_none=True))
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

                            if insight_task is not None and not insight_task.done():
                                await send_payload(
                                    make_error(
                                        "INSIGHT_BUSY",
                                        "An insight_test command is already running for this connection.",
                                    )
                                )
                                continue

                            insight_task = asyncio.create_task(process_insight_test())
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

            if inference_task is not None and not inference_task.done():
                await send_payload(
                    make_error(
                        "BUSY",
                        "Inference is already running for this connection; frame dropped.",
                        frame_id=frame.frame_id,
                    )
                )
                continue

            inference_task = asyncio.create_task(process_frame(frame))
    except WebSocketDisconnect:
        pass
    finally:
        if inference_task and not inference_task.done():
            inference_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await inference_task

        if insight_task and not insight_task.done():
            insight_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await insight_task
