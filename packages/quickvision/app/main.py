from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .protocol import FrameMessage, make_error, make_hello
from .yolo import (
    FrameDecodeError,
    get_model_summary,
    is_model_loaded,
    load_model,
    run_inference,
)

app = FastAPI(title="quickvision", version="0.1.0")


@app.on_event("startup")
async def on_startup() -> None:
    """Fail fast if YOLO model config is missing/invalid."""
    try:
        load_model()
    except Exception as exc:
        raise RuntimeError(f"QuickVision startup failed: {exc}") from exc

    print(f"[quickvision] model loaded: {get_model_summary()}")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "service": "quickvision",
        "status": "ok",
        "model_loaded": is_model_loaded(),
    }


@app.websocket("/infer")
async def infer_socket(websocket: WebSocket) -> None:
    await websocket.accept()

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

    async def process_frame(frame_message: FrameMessage) -> None:
        try:
            detections = await run_inference(frame_message)
            await send_payload(detections.model_dump(exclude_none=True))
        except FrameDecodeError as exc:
            await send_payload(make_error("INVALID_IMAGE", str(exc), frame_id=frame_message.frame_id))
        except Exception as exc:
            await send_payload(make_error("INFERENCE_ERROR", str(exc), frame_id=frame_message.frame_id))

    try:
        while True:
            raw_payload = await websocket.receive_text()

            try:
                parsed_payload = json.loads(raw_payload)
            except json.JSONDecodeError:
                await send_payload(make_error("INVALID_JSON", "Expected valid JSON payload."))
                continue

            if not isinstance(parsed_payload, dict):
                await send_payload(make_error("INVALID_PAYLOAD", "Expected JSON object payload."))
                continue

            frame_id_value = parsed_payload.get("frame_id")
            frame_id = frame_id_value if isinstance(frame_id_value, str) else None

            if parsed_payload.get("type") != "frame":
                await send_payload(
                    make_error(
                        "UNSUPPORTED_TYPE",
                        "QuickVision currently expects frame messages on /infer.",
                        frame_id=frame_id,
                    )
                )
                continue

            try:
                frame_message = FrameMessage.model_validate(parsed_payload)
            except ValidationError:
                await send_payload(make_error("INVALID_FRAME", "Invalid frame payload.", frame_id=frame_id))
                continue

            if inference_task is not None and not inference_task.done():
                await send_payload(
                    make_error(
                        "BUSY",
                        "Inference is already running for this connection; frame dropped.",
                        frame_id=frame_message.frame_id,
                    )
                )
                continue

            inference_task = asyncio.create_task(process_frame(frame_message))
    except WebSocketDisconnect:
        pass
    finally:
        if inference_task and not inference_task.done():
            inference_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await inference_task
