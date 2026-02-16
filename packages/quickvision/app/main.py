from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .protocol import BinaryFrameParseError, decode_binary_frame_envelope, make_error, make_hello
from .yolo import (
    FrameDecodeError,
    InferenceFrame,
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

    async def process_frame(frame: InferenceFrame) -> None:
        try:
            detections = await run_inference(frame)
            await send_payload(detections.model_dump(exclude_none=True))
        except FrameDecodeError as exc:
            await send_payload(make_error("INVALID_IMAGE", str(exc), frame_id=frame.frame_id))
        except Exception as exc:
            await send_payload(make_error("INFERENCE_ERROR", str(exc), frame_id=frame.frame_id))

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
